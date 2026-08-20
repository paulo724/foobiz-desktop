const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron')
const path = require('path')
const log = require('electron-log')
const Store = require('electron-store')
const { setupUpdater } = require('./updater')
const { setupPrinterHandlers } = require('./printer')
const printBridge = require('./printBridge')
const directPin = require('./directPin/service')
const { SERIAL_CLIENT_VERSION } = require('./directPin/serialClient')
const plugPag = require('./plugPag/service')
const { startStaticServer } = require('./staticServer')

const appSettingsStore = new Store({ name: 'app-settings' })

log.transports.file.level = 'info'

log.info('desktop: main carregado', {
  appDir: __dirname,
  directPinSerialClientVersion: SERIAL_CLIENT_VERSION,
})

function isRecoverableSerialError(err) {
  const message = String(err?.message ?? err ?? '')

  return /Writing to COM port/i.test(message)
    || /WriteFileEx/i.test(message)
    || /Invalid handle/i.test(message)
    || err?.code === 'PLUGPAG_ERROR'
    || err?.code === 'PLUGPAG_NOT_INITIALIZED'
    || err?.code === 'PLUGPAG_BUSY'
    || err?.code === 'PLUGPAG_NO_COMPORT'
}

process.on('uncaughtException', (err) => {
  log.error('Erro não tratado no processo principal:', err)

  if (isRecoverableSerialError(err)) {
    log.warn('Erro recuperável de porta serial ignorado para manter o POS aberto.')
    return
  }

  throw err
})

process.on('unhandledRejection', (reason) => {
  log.error('Promise rejeitada no processo principal:', reason)

  if (isRecoverableSerialError(reason)) {
    log.warn('Rejeição recuperável de porta serial ignorada para manter o POS aberto.')
  }
})

// APP_TYPE: 'totem' | 'kds' | 'pdv'
// Em dev, vem da env var setada pelo script npm (cross-env FOOBIZ_APP=...).
// Em build empacotado, a env var não sobrevive ao processo do electron-builder,
// então cada config grava foobiz.appType no package.json via extraMetadata.
const APP_TYPE = process.env.FOOBIZ_APP || require('../package.json').foobiz?.appType || 'pdv'
log.info('desktop: APP_TYPE resolvido', { APP_TYPE })

const APP_CONFIG = {
  totem: {
    title: 'Foobiz Totem',
    width: 1080,
    height: 1920,
    kiosk: true,
    startPath: '/totem',
    iconFile: 'icon-totem-foobiz.png',
  },
  kds: {
    title: 'Foobiz KDS',
    width: 1280,
    height: 800,
    kiosk: false,
    startPath: '/kds',
    iconFile: 'icon-kds-foobiz.png',
  },
  pdv: {
    title: 'Foobiz PDV',
    width: 1366,
    height: 768,
    kiosk: false,
    startPath: '/pdv',
    iconFile: 'icon-pdv-foobiz.png',
  },
}

const config = APP_CONFIG[APP_TYPE] ?? APP_CONFIG.pdv
const isDev = !app.isPackaged

let mainWindow = null
let desiredKioskMode = APP_TYPE === 'totem'
  && appSettingsStore.get(`kioskMode.${APP_TYPE}`, config.kiosk === true)
const desiredFullscreenMode = appSettingsStore.get(`fullscreenMode.${APP_TYPE}`, APP_TYPE === 'pdv')
let kioskShortcutsRegistered = false
const kioskEscapeAccelerators = ['Esc', 'Escape']

function isEscapeInput(input) {
  return ['Escape', 'Esc'].includes(input?.key) || input?.code === 'Escape'
}

function enforceDesiredKiosk() {
  if (APP_TYPE !== 'totem' || !desiredKioskMode || !mainWindow) return

  mainWindow.setKiosk(true)
  mainWindow.setResizable(false)
  mainWindow.setMenuBarVisibility(false)
  mainWindow.webContents.setIgnoreMenuShortcuts(true)
}

function syncKioskShortcuts() {
  if (APP_TYPE !== 'totem') return

  if (!desiredKioskMode) {
    if (kioskShortcutsRegistered) {
      kioskEscapeAccelerators.forEach((accelerator) => {
        try { globalShortcut.unregister(accelerator) } catch {}
      })
      kioskShortcutsRegistered = false
    }
    mainWindow?.webContents?.setIgnoreMenuShortcuts(false)
    return
  }

  if (!kioskShortcutsRegistered) {
    kioskEscapeAccelerators.forEach((accelerator) => {
      try {
        globalShortcut.register(accelerator, () => {
          enforceDesiredKiosk()
        })
      } catch (err) {
        log.warn('desktop: falha ao registrar atalho de kiosk', { accelerator, message: err?.message })
      }
    })
    kioskShortcutsRegistered = true
  }
}

function getWindowIconPath() {
  if (isDev) {
    return path.join(__dirname, '../resources/icons', config.iconFile)
  }

  return path.join(process.resourcesPath, 'icons', config.iconFile)
}

let splashWindow = null

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 360,
    height: 360,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    icon: getWindowIconPath(),
    webPreferences: { sandbox: true },
  })

  const iconUrl = `file://${getWindowIconPath().replace(/\\/g, '/')}`
  const query = new URLSearchParams({ label: config.title, icon: iconUrl }).toString()
  splashWindow.loadFile(path.join(__dirname, 'splash.html'), { search: query })
  splashWindow.once('ready-to-show', () => splashWindow?.show())
  splashWindow.on('closed', () => { splashWindow = null })
}

function closeSplashWindow() {
  if (!splashWindow) return
  const toClose = splashWindow
  splashWindow = null
  toClose.close()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: config.title,
    width: config.width,
    height: config.height,
    icon: getWindowIconPath(),
    kiosk: desiredKioskMode,
    fullscreen: desiredFullscreenMode,
    resizable: !desiredKioskMode,
    autoHideMenuBar: true,
    show: isDev,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    // Em dev, carrega o servidor Vite local
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
    mainWindow.loadURL(devUrl + config.startPath)
    mainWindow.webContents.openDevTools()
  } else {
    // Em produção, serve o build estático via HTTPS local (127.0.0.1), pois
    // o cookie de sessão da estação exige Secure=true e file:// não atende.
    // O staticServer faz fallback de qualquer path para index.html (SPA com
    // createWebHistory), então navegamos direto para o path da rota.
    mainWindow.loadURL(`${staticServerOrigin}${config.startPath}`)
  }

  mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
    log.error(`Falha ao carregar [${APP_TYPE}]:`, code, desc)
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    if (APP_TYPE === 'totem' && isEscapeInput(input) && desiredKioskMode) {
      event.preventDefault()
      enforceDesiredKiosk()
      return
    }

    if (APP_TYPE === 'pdv' && isEscapeInput(input) && mainWindow?.isFullScreen()) {
      event.preventDefault()
    }
  })

  const restoreKioskSoon = () => {
    if (APP_TYPE !== 'totem' || !desiredKioskMode) return
    setTimeout(enforceDesiredKiosk, 50)
    setTimeout(enforceDesiredKiosk, 300)
  }

  mainWindow.on('leave-full-screen', restoreKioskSoon)
  mainWindow.on('blur', restoreKioskSoon)
  mainWindow.on('focus', restoreKioskSoon)
  mainWindow.on('restore', restoreKioskSoon)
  mainWindow.on('show', restoreKioskSoon)
  syncKioskShortcuts()
  restoreKioskSoon()

  // Abre links externos no browser do SO, não dentro do Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents?.send('app:fullscreen-changed', true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents?.send('app:fullscreen-changed', false)
  })

  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents?.send('app:fullscreen-changed', true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents?.send('app:fullscreen-changed', false)
  })

  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.once('ready-to-show', () => {
    closeSplashWindow()
    mainWindow?.show()
  })
}

let staticServerOrigin = ''
let staticServerInstance = null

// O certificado do staticServer é autoassinado (só existe para satisfazer o
// requisito de HTTPS do cookie Secure da estação). Aceita-o apenas para a
// origem exata do servidor local; qualquer outro host segue a verificação
// padrão do Chromium.
app.on('certificate-error', (event, _contents, url, _error, _certificate, callback) => {
  if (staticServerOrigin && url.startsWith(staticServerOrigin)) {
    event.preventDefault()
    callback(true)
    return
  }

  callback(false)
})

app.whenReady().then(async () => {
  if (!isDev) {
    createSplashWindow()

    try {
      const rootDir = path.join(__dirname, '../frontend/dist')
      const certDir = path.join(app.getPath('userData'), 'static-server-cert')
      const { server, port } = await startStaticServer(rootDir, certDir)
      staticServerInstance = server
      staticServerOrigin = `https://127.0.0.1:${port}`
    } catch (err) {
      log.error('desktop: falha ao iniciar staticServer', err)
      closeSplashWindow()
      app.quit()
      return
    }
  }

  createWindow()
  setupPrinterHandlers(ipcMain)
  setupPrintBridgeHandlers(ipcMain)
  setupDirectPinHandlers(ipcMain)
  setupPlugPagHandlers(ipcMain)
  setupAppWindowHandlers(ipcMain)
  printBridge.init().catch((err) => log.error('printBridge: falha ao inicializar', err))
  if (!isDev) setupUpdater(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function setupPrintBridgeHandlers(ipcMain) {
  ipcMain.handle('printbridge:discover', () => printBridge.discover())
  ipcMain.handle('printbridge:set-api-config', (_, cfg) => printBridge.setApiConfig(cfg))
  ipcMain.handle('printbridge:pair', (_, device) => printBridge.pairDevice(device))
  ipcMain.handle('printbridge:unpair', (_, deviceId) => printBridge.unpairDevice(deviceId))
  ipcMain.handle('printbridge:status', () => printBridge.status())
}

function setupDirectPinHandlers(ipcMain) {
  ipcMain.handle('directpin:list-ports', () => directPin.listPorts())
  ipcMain.handle('directpin:test', (_, config) => directPin.test(config))
  ipcMain.handle('directpin:transaction', (event, payload, config) => directPin.transaction(payload, config, (status) => {
    event.sender.send('directpin:status', status)
  }))
  ipcMain.handle('directpin:confirm', (_, nsu, config) => directPin.confirm(nsu, config))
  ipcMain.handle('directpin:undo', (_, nsu, config) => directPin.undo(nsu, config))
  ipcMain.handle('directpin:cancel', (event, nsu, config) => directPin.cancel(nsu, config, (status) => {
    event.sender.send('directpin:status', status)
  }))
  ipcMain.handle('directpin:abort', (_, config) => directPin.abort(config))
  ipcMain.handle('directpin:status', () => directPin.status())
  ipcMain.handle('directpin:transaction-status', (_, customerId, config) => directPin.transactionStatus(customerId, config))
  ipcMain.handle('directpin:collect', (event, payload, config) => directPin.collect(payload, config, (status) => {
    event.sender.send('directpin:status', status)
  }))
}

function setupPlugPagHandlers(ipcMain) {
  ipcMain.handle('plugpag:init', (_, config) => plugPag.init(config))
  ipcMain.handle('plugpag:test', (_, config) => plugPag.test(config))
  ipcMain.handle('plugpag:transaction', (event, payload, config) => plugPag.transaction(payload, config, (status) => {
    event.sender.send('plugpag:status', status)
  }))
  ipcMain.handle('plugpag:cancel', () => plugPag.cancel())
  ipcMain.handle('plugpag:last-status', () => plugPag.lastTransactionStatus())
  ipcMain.handle('plugpag:status', () => plugPag.status())
}

function getWindowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) || mainWindow
}

function getDisplayMode(win) {
  return {
    kiosk: Boolean(win?.isKiosk?.()),
    fullscreen: Boolean(win?.isFullScreen?.()),
    resizable: Boolean(win?.isResizable?.()),
    appType: APP_TYPE,
  }
}

function setupAppWindowHandlers(ipcMain) {
  ipcMain.handle('app:display-mode', (event) => getDisplayMode(getWindowFromEvent(event)))

  ipcMain.handle('app:toggle-fullscreen', (event) => {
    const win = getWindowFromEvent(event)
    if (!win) return
    win.setFullScreen(!win.isFullScreen())
  })

  ipcMain.handle('app:set-fullscreen-mode', (event, enabled) => {
    const win = getWindowFromEvent(event)
    if (!win) return getDisplayMode(win)

    const fullscreenEnabled = Boolean(enabled)
    appSettingsStore.set(`fullscreenMode.${APP_TYPE}`, fullscreenEnabled)
    win.setFullScreen(fullscreenEnabled)

    return getDisplayMode(win)
  })

  ipcMain.handle('app:get-open-at-login', () => {
    return app.getLoginItemSettings().openAtLogin
  })

  ipcMain.handle('app:set-open-at-login', (_, enabled) => {
    const openAtLogin = Boolean(enabled)
    app.setLoginItemSettings({ openAtLogin })
    return app.getLoginItemSettings().openAtLogin
  })

  ipcMain.handle('app:set-kiosk-mode', (event, enabled) => {
    const win = getWindowFromEvent(event)
    const kioskEnabled = Boolean(enabled)

    if (!win) return getDisplayMode(win)

    desiredKioskMode = kioskEnabled
    appSettingsStore.set(`kioskMode.${APP_TYPE}`, kioskEnabled)
    win.setKiosk(kioskEnabled)
    win.setResizable(!kioskEnabled)
    win.setMenuBarVisibility(false)
    win.webContents.setIgnoreMenuShortcuts(kioskEnabled)
    syncKioskShortcuts()
    if (kioskEnabled) enforceDesiredKiosk()

    return getDisplayMode(win)
  })
}

app.on('window-all-closed', () => {
  if (kioskShortcutsRegistered) {
    kioskEscapeAccelerators.forEach((accelerator) => {
      try { globalShortcut.unregister(accelerator) } catch {}
    })
    kioskShortcutsRegistered = false
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  kioskEscapeAccelerators.forEach((accelerator) => {
    try { globalShortcut.unregister(accelerator) } catch {}
  })
  staticServerInstance?.close()
})

// Bloqueia navegação para URLs externas (segurança para modo quiosque)
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
    const isAllowed = url.startsWith(devUrl)
      || url.startsWith('file://')
      || (staticServerOrigin && url.startsWith(staticServerOrigin))

    if (!isAllowed) {
      log.warn('Navegação bloqueada:', url)
      event.preventDefault()
    }
  })
})
