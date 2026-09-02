const log = require('electron-log')
const apiClient = require('./apiClient')
const usbPrinter = require('./printers/usbPrinter')
const serialPrinter = require('./printers/serialPrinter')
const tcpPrinter = require('./printers/tcpPrinter')

// Resolve o driver de impressora (usb/serial/network) a partir das opções de
// conexão de um job ou de um device pareado. Roda dentro do worker de cada
// impressora (ver printerWorker.js) — nunca no main process.
function resolvePrinter({ connectionType, address, serialPort, serialBaudRate, serialRtscts, printerIdentity, printerIdentityFallback }) {
  const type = connectionType || 'usb'

  if (type === 'network') {
    return tcpPrinter.build(address, {})
  }

  if (type === 'serial') {
    return serialPrinter.build(serialPort, { baudRate: serialBaudRate, rtscts: serialRtscts })
  }

  return usbPrinter.build(printerIdentity || printerIdentityFallback)
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
