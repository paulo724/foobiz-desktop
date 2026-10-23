const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isPowerControlSupported, buildPowerCommand, runPowerCommand } = require('../src/systemPower')

test('desligar e reiniciar usam o shutdown do Windows sem espera', () => {
  assert.deepEqual(buildPowerCommand('shutdown', 'win32'), { command: 'shutdown', args: ['/s', '/t', '0'] })
  assert.deepEqual(buildPowerCommand('restart', 'win32'), { command: 'shutdown', args: ['/r', '/t', '0'] })
})
test('ação desconhecida não gera comando', () => {
  assert.equal(buildPowerCommand('logoff', 'win32'), null)
  assert.equal(buildPowerCommand(undefined, 'win32'), null)
})
test('fora do Windows o controle de energia fica indisponível', () => {
  assert.equal(isPowerControlSupported('linux'), false)
  assert.equal(buildPowerCommand('shutdown', 'linux'), null)
  assert.equal(isPowerControlSupported('win32'), true)
})
test('falha do comando chega como erro', async () => {
  const calls = []
  await runPowerCommand({ command: 'shutdown', args: ['/s'] }, (cmd, args, opts, cb) => {
    calls.push([cmd, args])
    cb(null)
  })
  assert.deepEqual(calls, [['shutdown', ['/s']]])
  await assert.rejects(
    runPowerCommand({ command: 'shutdown', args: ['/s'] }, (cmd, args, opts, cb) => cb(new Error('Acesso negado'))),
    /Acesso negado/,
  )
})
