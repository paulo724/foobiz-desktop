const { test } = require('node:test')
const assert = require('node:assert/strict')
const { describePrinter, describeJob } = require('../src/printBridge/printers/spoolerStatus')

test('impressora pronta e sem trabalhos', () => {
  assert.deepEqual(describePrinter({ status: 0, attributes: 0, jobs: 0 }), { online: true, reason: null, jobs: 0 })
})
test('estados de problema do spooler bloqueiam o envio', () => {
  assert.equal(describePrinter({ status: 0x80 }).reason, 'Impressora offline')
  assert.equal(describePrinter({ status: 0x10 }).reason, 'Sem papel')
  assert.equal(describePrinter({ status: 0x1 }).online, false)
  assert.match(describePrinter({ attributes: 0x400 }).reason, /Usar impressora offline/)
})
test('trabalho removido da fila ou impresso é concluído', () => {
  assert.equal(describeJob(null).state, 'done')
  assert.equal(describeJob({ status: 0x80 }).state, 'done')
  assert.equal(describeJob({ status: 0x1000 }).state, 'done')
})
test('trabalho em erro continua pendente no Windows', () => {
  const r = describeJob({ status: 0x20 })
  assert.equal(r.state, 'error'); assert.match(r.reason, /fila do Windows/)
  assert.equal(describeJob({ status: 0x10 }).state, 'pending') // imprimindo
  assert.equal(describeJob({ status: 0x8 }).state, 'pending')  // em spool
})
