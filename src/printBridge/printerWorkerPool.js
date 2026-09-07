const path = require('path')
const { Worker } = require('worker_threads')
const log = require('electron-log')

const PRINT_TIMEOUT_MS = 8000
const HEALTH_TIMEOUT_MS = 4000
const WORKER_PATH = path.join(__dirname, 'printerWorker.js')

const workers = new Map() // deviceId -> { worker, pending: Map<id, {resolve}> }
let nextRequestId = 1

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
      msg.online === undefined ? { success: true } : { success: true, online: msg.online },
    )
  })

  worker.on('error', (err) => {
    log.error(`printBridge: worker do device ${deviceId} caiu`, err)
    failAllPending(entry, String(err?.message || err))
    workers.delete(deviceId)
  })

  worker.on('exit', (code) => {
    if (code !== 0) {
      failAllPending(entry, `Worker de impressão encerrou inesperadamente (code=${code}).`)
    }
    workers.delete(deviceId)
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


function printOnWorker(deviceId, printerConfig, payloadBase64) {
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
      workers.delete(deviceId)
    }, PRINT_TIMEOUT_MS)

    entry.pending.set(id, { resolve, timer })
    entry.worker.postMessage({ type: 'print', id, printerConfig, payloadBase64 })
  })
}

// Testa a porta/impressora sem imprimir nada — entra na mesma fila/worker
// que os jobs de impressão (mesmo lock por deviceId), então nunca abre a
// porta ao mesmo tempo que um job real está escrevendo nela.
function checkHealthOnWorker(deviceId, printerConfig) {
  const entry = getOrCreateWorker(deviceId)
  const id = nextRequestId++

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id)
      resolve({ success: true, online: false })
    }, HEALTH_TIMEOUT_MS)

    entry.pending.set(id, { resolve, timer })
    entry.worker.postMessage({ type: 'health', id, printerConfig })
  })
}

function stopWorker(deviceId) {
  const entry = workers.get(deviceId)
  if (!entry) return
  failAllPending(entry, 'Impressora removida/despareada.')
  entry.worker.terminate().catch(() => {})
  workers.delete(deviceId)
}

module.exports = { printOnWorker, checkHealthOnWorker, stopWorker }
