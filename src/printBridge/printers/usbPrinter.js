const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

function resolvePsScriptPath() {
  const { app } = require('electron')
  const packaged = path.join(process.resourcesPath || '', 'winraw.ps1')
  if (app.isPackaged && fs.existsSync(packaged)) return packaged
  return path.join(__dirname, '..', '..', '..', 'resources', 'winraw.ps1')
}

function build(printerName) {
  return {
    async printRaw(buffer) {
      if (process.platform !== 'win32') {
        throw new Error('Impressão USB/spooler só é suportada no Windows.')
      }

      const psScript = resolvePsScriptPath()
      if (!fs.existsSync(psScript)) {
        throw new Error(`winraw.ps1 não encontrado em ${psScript}`)
      }

      const tmpFile = path.join(os.tmpdir(), `escpos_${Date.now()}_${Math.random().toString(16).slice(2)}.bin`)
      fs.writeFileSync(tmpFile, buffer)

      try {
        const result = spawnSync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', psScript,
          '-PrinterName', printerName,
          '-FilePath', tmpFile,
        ], { encoding: 'utf8' })

        if (result.status !== 0) {
          throw new Error((result.stderr || result.stdout || '').trim() || `RAW print failed (code ${result.status})`)
        }
      } finally {
        try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
      }
    },
  }
}

module.exports = { build }
