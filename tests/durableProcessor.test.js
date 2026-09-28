const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createDurableProcessor } = require('../src/printBridge/durableProcessor')
function fixture() {
  const rows = new Map(), calls = []; let prints = 0
  const api = { ack: async (token, id, data) => { calls.push(data); return { status: data.status === 'started' ? 'printing' : data.status } } }
  const deps = { api, journal: { get: id => rows.get(id), set: (id, row) => rows.set(id, structuredClone(row)), pending: id => [...rows.values()].filter(r => r.deviceId === id && !r.acknowledged) }, print: async () => { prints++; return { success: true } }, health: async () => ({ online: true }) }
  const job = { id: 1, attempt_id: 'a', mode: 'rawBase64', rawBase64: 'YQ==' }
  return { deps, rows, calls, job, prints: () => prints, processor: () => createDurableProcessor(deps) }
}
test('ack perdido é reenviado após reinício sem repetir impressão', async () => {
  const f = fixture(), ack = f.deps.api.ack
  f.deps.api.ack = async (...args) => { if (args[2].status === 'printed') throw new Error('offline'); return ack(...args) }
  await assert.rejects(f.processor().execute(7, 'token', f.job, {}), /offline/)
  assert.equal(f.prints(), 1); assert.equal(f.rows.get('a').status, 'printed')
  f.deps.api.ack = ack
  await f.processor().reconcile(7, 'token')
  await f.processor().execute(7, 'token', f.job, {})
  assert.equal(f.prints(), 1); assert.equal(f.rows.get('a').acknowledged, true)
})
test('crash durante envio é conciliado como incerto sem imprimir', async () => {
  const f = fixture(); f.rows.set('a', { deviceId: 7, jobId: 1, attemptId: 'a', status: 'sending' })
  await f.processor().reconcile(7, 'token')
  assert.equal(f.prints(), 0); assert.equal(f.calls[0].status, 'uncertain')
})
test('impressora offline é falha comprovada antes de enviar', async () => {
  const f = fixture(); f.deps.health = async () => ({ online: false })
  await f.processor().execute(7, 'token', f.job, {})
  assert.equal(f.prints(), 0); assert.equal(f.calls[0].before_send, true)
})
test('servidor suspendeu pedido entre retirada e envio', async () => {
  const f = fixture(); f.deps.api.ack = async () => ({ status: 'review' })
  await f.processor().execute(7, 'token', f.job, {})
  assert.equal(f.prints(), 0)
})
test('erro de escrita é resultado incerto, sem tentativa automática', async () => {
  const f = fixture(); f.deps.print = async () => ({ success: false, error: 'timeout' })
  await f.processor().execute(7, 'token', f.job, {})
  assert.equal(f.rows.get('a').status, 'uncertain'); assert.equal(f.calls.at(-1).status, 'uncertain')
})
test('executor removido durante healthcheck não inicia impressão', async () => {
  const f = fixture(); let active = true
  f.deps.isActive = () => active; f.deps.health = async () => { active = false; return { online: true } }
  await f.processor().execute(7, 'token', f.job, {})
  assert.equal(f.prints(), 0); assert.equal(f.calls.length, 0)
})
test('motivo do spooler vai para a falha antes do envio e health recebe trackSpooler', async () => {
  const f = fixture(); let seen
  f.deps.health = async (id, config) => { seen = config; return { online: false, error: 'Sem papel' } }
  await f.processor().execute(7, 'token', f.job, { connectionType: 'usb' })
  assert.equal(seen.trackSpooler, true); assert.equal(f.prints(), 0)
  assert.match(f.calls[0].error, /Sem papel/); assert.equal(f.calls[0].before_send, true)
})
