// Worker thread dedicado a UMA impressora (um deviceId). Roda em isolamento
// para que uma chamada Win32/serial travada (impressora offline, sem papel,
// porta ocupada) não bloqueie a thread principal do Electron nem afete
// outras impressoras — cada worker tem sua própria fila e processa um job
// por vez, na ordem de chegada, evitando duas escritas concorrentes na
// mesma porta.
const { parentPort } = require('worker_threads')
const { resolvePrinter } = require('./jobProcessor')

const queue = []
let processing = false

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function processQueue() {
  if (processing) return
  processing = true

  let isFirst = true
  while (queue.length > 0) {
    const { id, type, printerConfig, payloadBase64 } = queue.shift()

    // Cada job serial abre e fecha a porta COM do zero. O driver virtual de
    // porta serial (USB-Serial de impressoras térmicas como Bematech) não
    // libera o handle da porta de forma instantânea ao fechar — abrir a
    // mesma porta de novo cedo demais depois de fechá-la é uma causa
    // conhecida de crash nativo no processo (fora do alcance de try/catch
    // JS, porque acontece dentro do binding N-API da porta serial). Isso só
    // se manifesta quando há MAIS DE UM job na fila para a mesma porta em
    // sequência rápida — o que só acontece aqui (fila do bridge), nunca na
    // impressão via IPC direto do card do KDS, que processa um job por vez
    // sob demanda do usuário, sem acúmulo. O healthcheck entra na MESMA fila
    // (mesmo lock) para nunca checar/abrir a porta enquanto outro job
    // imprime nela.
    if (!isFirst && printerConfig?.connectionType === 'serial') {
      await sleep(400)
    }
    isFirst = false

    if (type === 'health') {
      try {
        const printer = resolvePrinter(printerConfig)
        const online = await printer.checkHealth()
        parentPort.postMessage({ id, success: true, online: !!online })
      } catch (err) {
        parentPort.postMessage({ id, success: true, online: false, error: String(err?.message || err) })
      }
      continue
    }

    try {
      const printer = resolvePrinter(printerConfig)
      await printer.printRaw(Buffer.from(payloadBase64, 'base64'))
      parentPort.postMessage({ id, success: true })
    } catch (err) {
      parentPort.postMessage({ id, success: false, error: String(err?.message || err) })
    }
  }

  processing = false
}

parentPort.on('message', (msg) => {
  if (msg?.type !== 'print' && msg?.type !== 'health') return
  queue.push(msg)
  processQueue()
})
