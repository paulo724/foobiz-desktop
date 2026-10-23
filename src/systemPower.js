const { execFile } = require('child_process')

// Desligar/reiniciar o computador a partir do app (telas touch sem teclado).
// Só Windows por enquanto; o comando é fixo e não recebe nada do renderer além da ação.
const POWER_COMMANDS = {
  shutdown: ['/s', '/t', '0'],
  restart: ['/r', '/t', '0'],
}

function isPowerControlSupported(platform = process.platform) {
  return platform === 'win32'
}

function buildPowerCommand(action, platform = process.platform) {
  if (!isPowerControlSupported(platform)) return null

  const args = POWER_COMMANDS[action]
  if (!args) return null

  return { command: 'shutdown', args: [...args] }
}

function runPowerCommand({ command, args }, run = execFile) {
  return new Promise((resolve, reject) => {
    run(command, args, { windowsHide: true }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

module.exports = { isPowerControlSupported, buildPowerCommand, runPowerCommand }
