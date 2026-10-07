const { test } = require('node:test')
const assert = require('node:assert/strict')
const { executeManagedPrint } = require('../src/printBridge/directManagedPrint')
const { createDeviceExecution } = require('../src/printBridge/deviceExecution')
function fixture() {
  const rows = new Map(), calls = []
  const journal = { get: id => rows.get(id), set: (id, row) => rows.set(id, structuredClone(row)), pending: id => [...rows.values()].filter(r => r.deviceId === id && !r.acknowledged) }
  const deps = {
    device: { deviceId: 7, deviceToken: 'token' }, jobId: 42, attemptId: 'attempt-42', payloadBase64: 'Y3Vwb20=', config: {}, journal,
    api: { ack: async (token, id, body) => { calls.push(body.status); return { status: body.status === 'started' ? 'printing' : body.status } } },
    print: async (id, config, raw) => { calls.push('bytes'); assert.equal(raw, 'Y3Vwb20='); return { success: true } },
    health: async () => ({ online: true }),
  }
  return { deps, rows, calls }
}
test('trabalho reservado imprime imediatamente pelo protocolo durável sem pull', async () => {
  const f = fixture(), result = await executeManagedPrint(f.deps)
  assert.equal(result.success, true); assert.equal(result.managedHandled, true)
  assert.deepEqual(f.calls, ['started', 'bytes', 'printed'])
  assert.equal(f.rows.get('attempt-42').acknowledged, true)
})
test('mesma tentativa por IPC não repete os bytes', async () => {
  const f = fixture()
  await executeManagedPrint(f.deps); await executeManagedPrint(f.deps)
  assert.equal(f.calls.filter(c => c === 'bytes').length, 1)
})
test('falha comprovada no healthcheck não envia nada e preserva motivo', async () => {
  const f = fixture(); f.deps.health = async () => ({ online: false, error: 'Sem papel' })
  const result = await executeManagedPrint(f.deps)
  assert.equal(result.success, false); assert.equal(result.beforeSend, true)
  assert.match(result.error, /Sem papel/); assert.deepEqual(f.calls, ['failed'])
})
test('falha na confirmação depois de imprimir só repete o ACK', async () => {
  const f = fixture(), ack = f.deps.api.ack
  f.deps.api.ack = async (...args) => { if (args[2].status === 'printed') throw new Error('Rede indisponível'); return ack(...args) }
  const result = await executeManagedPrint(f.deps)
  assert.equal(result.success, true); assert.match(result.message, /pendente/)
  f.deps.api.ack = ack
  await executeManagedPrint(f.deps)
  assert.equal(f.calls.filter(c => c === 'bytes').length, 1)
  assert.equal(f.rows.get('attempt-42').acknowledged, true)
})
test('pedido IPC sem tentativa não pode imprimir em dispositivo gerenciado', async () => {
  const f = fixture(); f.deps.attemptId = null
  const result = await executeManagedPrint(f.deps)
  assert.equal(result.success, false); assert.deepEqual(f.calls, [])
})
test('erro no envio deixa resultado incerto e nunca imprime automaticamente de novo', async () => {
  const f = fixture(); f.deps.print = async () => { f.calls.push('bytes'); return { success: false, error: 'Falha na porta' } }
  const result = await executeManagedPrint(f.deps)
  assert.equal(result.success, false); assert.equal(result.beforeSend, false)
  assert.equal(f.rows.get('attempt-42').status, 'uncertain')
  await executeManagedPrint(f.deps)
  assert.equal(f.calls.filter(c => c === 'bytes').length, 1)
})
test('pull/conciliação aguarda o envio direto na mesma impressora', async () => {
  const execute = createDeviceExecution(), calls = []
  let release
  const printing = execute(7, async () => { calls.push('print'); await new Promise(resolve => { release = resolve }); calls.push('finished') })
  const polling = execute(7, async () => { calls.push('pull') })
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(calls, ['print'])
  release(); await Promise.all([printing, polling])
  assert.deepEqual(calls, ['print', 'finished', 'pull'])
})
test('impressoras diferentes não esperam umas pelas outras', async () => {
  const execute = createDeviceExecution()
  let release
  const pending = execute(7, () => new Promise(resolve => { release = resolve }))
  await execute(8, async () => {})
  release(); await pending
})
