const log = require('electron-log')
const apiClient = require('./apiClient')
const serialPrinter = require('./printers/serialPrinter')
const tcpPrinter = require('./printers/tcpPrinter')

// Resolve o driver de impressora (serial/network) a partir das opções de
// conexão de um job ou de um device pareado. Roda dentro do worker de cada
// impressora (ver printerWorker.js) — nunca no main process. Impressoras USB
// nativas (spooler do Windows) NÃO passam por aqui: printerWorkerPool.js
// intercepta connectionType 'usb' antes de despachar ao worker e chama
// koffi/winspool.drv direto no processo principal (ver ./printers/winspool.js)
// — FFI nativo dentro de worker_thread já causou crash irrecuperável do
// processo neste projeto.
function resolvePrinter({ connectionType, address, serialPort, serialBaudRate, serialRtscts }) {
  const type = connectionType || 'usb'

  if (type === 'network') {
    return tcpPrinter.build(address, {})
  }

  if (type === 'serial') {
    return serialPrinter.build(serialPort, { baudRate: serialBaudRate, rtscts: serialRtscts })
  }

  throw new Error(`resolvePrinter: connectionType '${type}' não deveria chegar ao worker (USB é resolvido no main process).`)
}

// deviceId é passado pelo chamador (startDevice conhece o device do pull em
// andamento) — usado para enfileirar no mesmo worker por impressora que a
// impressão local (printNow) usa, para as duas vias nunca escreverem na
// mesma porta ao mesmo tempo.
async function processPendingJobs(deviceId, deviceToken, { printerIdentityFallback, printOnWorker } = {}) {
  const { jobs } = await apiClient.pull(deviceToken, { limit: 5 })

  for (const job of jobs) {
    if (job.mode !== 'rawBase64' || !job.rawBase64) {
      log.error(`printBridge: job ${job.id} sem rawBase64 (mode=${job.mode})`)
      await apiClient.ack(deviceToken, job.id, { status: 'failed', error: `sem rawBase64 (mode=${job.mode})` }).catch(() => {})
      continue
    }

    const result = await printOnWorker(deviceId, {
      connectionType: job.options?.connection_type,
      address: job.options?.address,
      serialPort: job.options?.serialPort,
      serialBaudRate: job.options?.serialBaudRate,
      serialRtscts: job.options?.serialRtscts,
      printerIdentity: job.printerIdentity,
      printerIdentityFallback,
    }, job.rawBase64)

    if (result.success) {
      await apiClient.ack(deviceToken, job.id, { status: 'printed' })
    } else {
      log.error('printBridge: falha ao processar job', job.id, result.error)
      await apiClient.ack(deviceToken, job.id, { status: 'failed', error: result.error }).catch(() => {})
    }
  }

  return jobs.length
}

module.exports = { processPendingJobs, resolvePrinter }
