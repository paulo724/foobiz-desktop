const log = require('electron-log')
const store = require('./store')
const { createDurableProcessor } = require('./durableProcessor')
const apiClient = require('./apiClient')
const { resolvePrinter } = require('./resolvePrinter')

// Resolve o driver de impressora (serial/network) a partir das opções de
// conexão de um job ou de um device pareado. Roda dentro do worker de cada
// impressora (ver printerWorker.js) — nunca no main process. Impressoras USB
// nativas (spooler do Windows) NÃO passam por aqui: printerWorkerPool.js
// intercepta connectionType 'usb' antes de despachar ao worker e chama
// koffi/winspool.drv direto no processo principal (ver ./printers/winspool.js)
// — FFI nativo dentro de worker_thread já causou crash irrecuperável do
// processo neste projeto.

// deviceId é passado pelo chamador (startDevice conhece o device do pull em
// andamento) — usado para enfileirar no mesmo worker por impressora que a
// impressão local (printNow) usa, para as duas vias nunca escreverem na
// mesma porta ao mesmo tempo.
async function processPendingJobs(deviceId, deviceToken, { printerIdentityFallback, printOnWorker, checkHealthOnWorker, isActive } = {}) {
  const durable = createDurableProcessor({ api: apiClient, journal: { get: store.journalGet, set: store.journalSet, pending: store.pendingJournal }, print: printOnWorker, health: checkHealthOnWorker, isActive })
  await durable.reconcile(deviceId, deviceToken)
  const { jobs } = await apiClient.pull(deviceToken, { limit: 5 })

  for (const job of jobs) {
    if (job.managed) {
      await durable.execute(deviceId, deviceToken, job, {
        connectionType: job.options?.connection_type, address: job.options?.address,
        serialPort: job.options?.serialPort, serialBaudRate: job.options?.serialBaudRate,
        serialRtscts: job.options?.serialRtscts, printerIdentity: job.printerIdentity || printerIdentityFallback,
      })
      continue
    }
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
