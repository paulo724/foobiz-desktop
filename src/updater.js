const { autoUpdater } = require('electron-updater')
const log = require('electron-log')

autoUpdater.logger = log
autoUpdater.logger.transports.file.level = 'info'
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

function setupUpdater(mainWindow) {
  const send = (channel, data) => {
    if (mainWindow?.isDestroyed() === false) {
      mainWindow.webContents.send(channel, data)
    }
  }

  autoUpdater.on('checking-for-update', () => {
    send('update:checking')
  })

  autoUpdater.on('update-available', (info) => {
    log.info('Update disponível:', info.version)
    send('update:available', info)
  })

  autoUpdater.on('update-not-available', (info) => {
    send('update:not-available', info)
  })

  autoUpdater.on('download-progress', (progress) => {
    send('update:download-progress', progress)
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update baixado:', info.version)
    send('update:downloaded', info)
  })

  autoUpdater.on('error', (err) => {
    log.error('Erro no updater:', err)
    send('update:error', { message: err?.message ?? String(err) })
  })

  const { ipcMain } = require('electron')
  ipcMain.handle('update:check', () => autoUpdater.checkForUpdates())
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall()
  })

  // Verifica por updates ao iniciar e a cada 1h
  autoUpdater.checkForUpdatesAndNotify()
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 60 * 60 * 1000)
}

module.exports = { setupUpdater }
