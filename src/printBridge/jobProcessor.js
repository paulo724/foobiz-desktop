const log = require('electron-log')
const apiClient = require('./apiClient')
const usbPrinter = require('./printers/usbPrinter')
const tcpPrinter = require('./printers/tcpPrinter')

async function processPendingJobs(deviceToken, { printerIdentityFallback } = {}) {
  const { jobs } = await apiClient.pull(deviceToken, { limit: 5 })

  for (const job of jobs) {
    try {
      const connectionType = job.options?.connection_type || 'usb'
      const printer =
        connectionType === 'network'
          ? tcpPrinter.build(job.options.address, job.options)
          : usbPrinter.build(job.printerIdentity || printerIdentityFallback, job.options)

      if (job.mode !== 'rawBase64' || !job.rawBase64) {
        throw new Error(`Job ${job.id} sem rawBase64 (mode=${job.mode})`)
      }

      await printer.printRaw(Buffer.from(job.rawBase64, 'base64'))
      await apiClient.ack(deviceToken, job.id, { status: 'printed' })
    } catch (err) {
      log.error('printBridge: falha ao processar job', job.id, err)
      await apiClient.ack(deviceToken, job.id, { status: 'failed', error: String(err?.message || err) }).catch(() => {})
    }
  }

  return jobs.length
}

module.exports = { processPendingJobs }
