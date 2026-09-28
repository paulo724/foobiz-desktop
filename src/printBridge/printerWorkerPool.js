const path = require('path')
const { Worker } = require('worker_threads')
const log = require('electron-log')
const winspool = require('./printers/winspool')

const PRINT_TIMEOUT_MS = 8000
const HEALTH_TIMEOUT_MS = 4000
// Acompanhamento de trabalhos no spooler do Windows (jobs gerenciados).
const SPOOLER_DRAIN_MS = 10000
const SPOOLER_TRACK_MS = 20000
const SPOOLER_POLL_MS = 500
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const WORKER_PATH = path.join(__dirname, 'printerWorker.js')

const workers = new Map() // deviceId -> { worker, pending: Map<id, {resolve}> }
let nextRequestId = 1

// Impressoras USB nativas (spooler do Windows) são resolvidas via koffi
// chamando winspool.drv diretamente (ver ./printers/winspool.js) — e isso só
// pode rodar no processo principal do Electron, nunca dentro de um
// worker_thread: FFI nativo isolado em thread já causou crash irrecuperável
// do processo neste projeto. Por isso USB nunca é despachado para o Worker
// abaixo; a fila por deviceId é replicada aqui, em memória do main process,
// para manter a mesma garantia de "nunca duas escritas concorrentes na mesma
// impressora" que o worker_thread dá para serial/network.
const usbQueues = new Map() // deviceId -> Promise (tail da fila)

function enqueueUsb(deviceId, task) {
  const tail = (usbQueues.get(deviceId) || Promise.resolve()).then(task, task)
  const settled = tail.catch(() => {})
  usbQueues.set(deviceId, settled)
  return tail
}

// Códigos de erro do SO que indicam a porta serial em estado ruim (comum
// após replug/power-cycle de impressoras térmicas USB-Serial — o driver
// virtual não libera o handle antigo de forma limpa). Nesses casos, manter o
// mesmo worker vivo não ajuda: o processo do worker tende a repetir o mesmo
// erro indefinidamente até ser reiniciado, e só reinstalar o driver "resolve"
// porque força o Windows a recriar o descritor do dispositivo do zero.
// Reciclamos o worker aqui para obter o mesmo efeito sem precisar disso.
const STALE_PORT_ERROR = /\bEPERM\b|\bENOENT\b|\bEBUSY\b|\bEACCES\b/

function isStalePortError(error) {
  return STALE_PORT_ERROR.test(String(error || ''))
}

function getOrCreateWorker(deviceId) {
  let entry = workers.get(deviceId)
  if (entry) return entry

  const worker = new Worker(WORKER_PATH)
  entry = { worker, pending: new Map() }
  workers.set(deviceId, entry)

  worker.on('message', (msg) => {
    const pending = entry.pending.get(msg.id)
    if (!pending) return
    entry.pending.delete(msg.id)
    clearTimeout(pending.timer)
    if (!msg.success) {
      pending.resolve({ success: false, error: msg.error })
      return
    }
    pending.resolve(
      msg.online === undefined
        ? { success: true }
        : { success: true, online: msg.online, error: msg.error },
    )
  })

  worker.on('error', (err) => {
    log.error(`printBridge: worker do device ${deviceId} caiu`, err)
    failAllPending(entry, String(err?.message || err))
    if (workers.get(deviceId) === entry) workers.delete(deviceId)
  })

  worker.on('exit', (code) => {
    if (code !== 0) {
      failAllPending(entry, `Worker de impressão encerrou inesperadamente (code=${code}).`)
    }
    if (workers.get(deviceId) === entry) workers.delete(deviceId)
  })

  return entry
}

function failAllPending(entry, error) {
  for (const pending of entry.pending.values()) {
    clearTimeout(pending.timer)
    pending.resolve({ success: false, error })
  }
  entry.pending.clear()
}


// Diagnóstico: com FOOBIZ_PRINT_DUMP=1 grava cada payload recebido (ESC/POS
// já decodificado) em <userData>/print-dumps/ para inspeção byte a byte.
function dumpPayload(deviceId, payloadBase64) {
  if (!process.env.FOOBIZ_PRINT_DUMP) return
  try {
    const fs = require('fs')
    const { app } = require('electron')
    const dir = path.join(app.getPath('userData'), 'print-dumps')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Date.now()}-${deviceId}.bin`)
    fs.writeFileSync(file, Buffer.from(payloadBase64, 'base64'))
    log.info(`printBridge: payload salvo em ${file}`)
  } catch (err) {
    log.warn('printBridge: falha ao salvar dump do payload', err)
  }
}

function printOnWorker(deviceId, printerConfig, payloadBase64) {
  dumpPayload(deviceId, payloadBase64)
  if ((printerConfig?.connectionType || 'usb') === 'usb') {
    return enqueueUsb(deviceId, async () => {
      const name = printerConfig.printerIdentity || printerConfig.printerIdentityFallback
      try {
        if (printerConfig.trackSpooler) {
          const ready = await waitSpoolerIdle(name)
          if (!ready.online) return { success: false, notSubmitted: true, error: ready.reason }
        }
        const jobId = winspool.printRaw(name, Buffer.from(payloadBase64, 'base64'))
        if (!printerConfig.trackSpooler) return { success: true }
        return await trackSpoolerJob(name, jobId)
      } catch (err) {
        return { success: false, notSubmitted: !!err?.notSubmitted, error: String(err?.message || err) }
      }
    })
  }

  const entry = getOrCreateWorker(deviceId)
  const id = nextRequestId++

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id)
      resolve({
        success: false,
        error: `Impressora não respondeu em ${PRINT_TIMEOUT_MS / 1000}s (offline, sem papel ou porta ocupada).`,
      })

      entry.worker.terminate().catch(() => {})
      if (workers.get(deviceId) === entry) workers.delete(deviceId)
    }, PRINT_TIMEOUT_MS)

    entry.pending.set(id, {
      resolve: (result) => {
        if (!result.success && isStalePortError(result.error)) recycleWorker(deviceId, entry)
        resolve(result)
      },
      timer,
    })
    entry.worker.postMessage({ type: 'print', id, printerConfig, payloadBase64 })
  })
}

// Não empilha trabalhos no spooler: com a impressora em erro ou com trabalhos
// parados, o Windows aceitaria o envio e imprimiria tudo depois, fora de hora.
async function waitSpoolerIdle(name) {
  const deadline = Date.now() + SPOOLER_DRAIN_MS
  for (;;) {
    const status = winspool.getStatus(name)
    if (!status.online) return status
    if (!status.jobs) return status
    if (Date.now() >= deadline) {
      return { online: false, reason: `${status.jobs} trabalho(s) parado(s) na fila do Windows` }
    }
    await sleep(SPOOLER_POLL_MS)
  }
}

// O WritePrinter só confirma a entrega ao spooler; acompanha o trabalho até
// ele sair da fila. Erro ou demora viram resultado incerto (success=false
// depois do envio), nunca confirmação.
async function trackSpoolerJob(name, jobId) {
  const deadline = Date.now() + SPOOLER_TRACK_MS
  for (;;) {
    const job = winspool.getJob(name, jobId)
    if (job.state === 'done') return { success: true }
    if (job.state === 'error') return { success: false, error: job.reason }
    if (Date.now() >= deadline) {
      return { success: false, error: `Trabalho ainda na fila do Windows após ${SPOOLER_TRACK_MS / 1000}s` }
    }
    await sleep(SPOOLER_POLL_MS)
  }
}

// Derruba o worker após um erro de porta "travada" (EPERM/ENOENT/EBUSY/
// EACCES), desde que ainda seja o worker ativo daquele device (a checagem
// evita matar um worker novo caso outra falha já tenha reciclado antes desta
// resolver). O próximo job recria o worker do zero via getOrCreateWorker,
// forçando o SO a reabrir o handle da porta sem estado antigo.
function recycleWorker(deviceId, entry) {
  if (workers.get(deviceId) !== entry) return
  workers.delete(deviceId)
  entry.worker.terminate().catch(() => {})
}

// Testa a porta/impressora sem imprimir nada — entra na mesma fila/worker
// que os jobs de impressão (mesmo lock por deviceId), então nunca abre a
// porta ao mesmo tempo que um job real está escrevendo nela.
function checkHealthOnWorker(deviceId, printerConfig) {
  if ((printerConfig?.connectionType || 'usb') === 'usb') {
    return enqueueUsb(deviceId, async () => {
      try {
        const name = printerConfig.printerIdentity || printerConfig.printerIdentityFallback
        const status = printerConfig.trackSpooler ? await waitSpoolerIdle(name) : winspool.getStatus(name)
        return { success: true, online: status.online, error: status.reason }
      } catch (err) {
        return { success: true, online: false, error: String(err?.message || err) }
      }
    })
  }

  const entry = getOrCreateWorker(deviceId)
  const id = nextRequestId++

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id)
      recycleWorker(deviceId, entry)
      resolve({ success: true, online: false })
    }, HEALTH_TIMEOUT_MS)

    entry.pending.set(id, {
      resolve: (result) => {
        if (!result.online && isStalePortError(result.error)) recycleWorker(deviceId, entry)
        resolve(result)
      },
      timer,
    })
    entry.worker.postMessage({ type: 'health', id, printerConfig })
  })
}

function stopWorker(deviceId) {
  const queue = deviceQueues.get(deviceId)
  if (queue) queue.stopped = true
  deviceQueues.delete(deviceId)
  usbQueues.delete(deviceId)

  const entry = workers.get(deviceId)
  if (!entry) return
  failAllPending(entry, 'Impressora removida/despareada.')
  entry.worker.terminate().catch(() => {})
  workers.delete(deviceId)
}

// Serializa também o despacho, para o timeout começar quando o trabalho
// efetivamente chega ao worker, e não enquanto aguarda outro trabalho.
const deviceQueues = new Map()
function dispatch(deviceId, task) {
  let queue = deviceQueues.get(deviceId)
  if (!queue) { queue = { tail: Promise.resolve(), stopped: false }; deviceQueues.set(deviceId, queue) }
  const run = () => queue.stopped ? { success: false, online: false, error: 'Executor interrompido.' } : task()
  const result = queue.tail.then(run, run)
  queue.tail = result.catch(() => {})
  return result
}
module.exports = {
  printOnWorker: (id, config, payload) => dispatch(id, () => printOnWorker(id, config, payload)),
  checkHealthOnWorker: (id, config) => dispatch(id, () => checkHealthOnWorker(id, config)),
  stopWorker,
}
