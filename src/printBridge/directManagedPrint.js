const { createDurableProcessor } = require('./durableProcessor')

// Executa a tentativa já reservada pelo PDV pelo mesmo protocolo durável da fila.
async function executeManagedPrint({ device, jobId, attemptId, payloadBase64, config, api, journal, print, health, isActive }) {
  if (!jobId || !attemptId) return { success: false, error: 'Impressora gerenciada: envie o trabalho pela fila.', beforeSend: true }
  const processor = createDurableProcessor({ api, journal, print, health, isActive })
  let error
  try {
    await processor.execute(device.deviceId, device.deviceToken, {
      id: jobId, attempt_id: attemptId, mode: 'rawBase64', rawBase64: payloadBase64,
    }, config)
  } catch (err) { error = err.message }
  const record = journal.get(attemptId)
  if (record?.status === 'printed') {
    return {
      success: true, managedHandled: true,
      message: record.acknowledged ? 'Impresso com sucesso.' : 'Cupom impresso. Confirmação pendente; o aplicativo tentará confirmar novamente.',
    }
  }
  return {
    success: false, managedHandled: true,
    beforeSend: !record || !!record.beforeSend || (record.status === 'starting' && record.acknowledged),
    error: record?.error || error || 'Impressão não autorizada ou interrompida antes do envio.',
  }
}
module.exports = { executeManagedPrint }
