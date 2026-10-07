// A execução direta e a conciliação/pull precisam compartilhar o mesmo bloqueio:
// conciliar uma tentativa enquanto ela imprime a marcaria como interrompida.
function createDeviceExecution() {
  const pending = new Map()
  return function execute(deviceId, task) {
    const previous = pending.get(deviceId) || Promise.resolve()
    const current = previous.catch(() => {}).then(task)
    pending.set(deviceId, current)
    return current.finally(() => { if (pending.get(deviceId) === current) pending.delete(deviceId) })
  }
}
module.exports = { createDeviceExecution }
