// Dependências injetadas permitem testar falhas de rede sem hardware/Electron.
function createDurableProcessor({ api, journal, print, health, isActive = () => true }) {
  async function confirm(token, record) {
    const response = await api.ack(token, record.jobId, {
      attempt_id: record.attemptId, status: record.status, error: record.error,
      before_send: record.beforeSend || false,
    })
    journal.set(record.attemptId, { ...record, acknowledged: true })
    return response
  }

  async function reconcile(deviceId, token) {
    for (const row of journal.pending(deviceId)) {
      const record = ['sending', 'starting'].includes(row.status)
        ? { ...row, status: 'uncertain', error: 'Aplicativo interrompido durante o envio. Confira antes de repetir.' }
        : row
      journal.set(record.attemptId, record)
      try { await confirm(token, record) } catch (err) {
        if (err.status === 409) {
          // Tentativa substituída/conciliada no servidor; nunca imprimir outra vez.
          journal.set(record.attemptId, { ...record, acknowledged: true })
        } else throw err
      }
    }
  }

  async function execute(deviceId, token, job, config) {
    const existing = journal.get(job.attempt_id)
    if (existing) {
      await reconcile(deviceId, token)
      return
    }
    let record = { deviceId, jobId: job.id, attemptId: job.attempt_id, status: 'failed', beforeSend: true }
    if (!isActive()) return
    if (job.mode !== 'rawBase64' || !job.rawBase64) {
      record.error = 'Trabalho sem conteúdo de impressão.'
      journal.set(record.attemptId, record)
      await confirm(token, record)
      return
    }
    // trackSpooler: na fila do Windows, só envia com a impressora pronta e sem
    // trabalhos parados, e acompanha o trabalho até sair do spooler.
    config = { ...config, trackSpooler: true }
    const connected = await health(deviceId, config)
    if (!connected.online) {
      record.error = connected.error ? `Impressora inacessível antes do envio: ${connected.error}.` : 'Impressora inacessível antes do envio.'
      journal.set(record.attemptId, record)
      await confirm(token, record)
      return
    }
    if (!isActive()) return
    record = { ...record, status: 'starting', beforeSend: false }
    journal.set(record.attemptId, record)
    // Sem autorização positiva do servidor, nenhum byte vai para a impressora.
    const started = await api.ack(token, job.id, { attempt_id: job.attempt_id, status: 'started' })
    if (started.status !== 'printing') {
      journal.set(record.attemptId, { ...record, acknowledged: true })
      return
    }
    if (!isActive()) return
    record.status = 'sending'
    journal.set(record.attemptId, record)
    let result
    try { result = await print(deviceId, config, job.rawBase64) }
    catch (err) { result = { success: false, error: err.message } }
    record = { ...record, status: result.success ? 'printed' : 'uncertain', error: result.error || null }
    // Persistir ANTES do ack: uma queda de rede só repete a confirmação.
    journal.set(record.attemptId, record)
    await confirm(token, record)
  }
  return { reconcile, execute }
}
module.exports = { createDurableProcessor }
