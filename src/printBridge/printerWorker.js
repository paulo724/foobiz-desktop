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

async function processQueue() {
  if (processing) return
  processing = true

  while (queue.length > 0) {
    const { id, printerConfig, payloadBase64 } = queue.shift()
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
  if (msg?.type !== 'print') return
  queue.push(msg)
  processQueue()
})
