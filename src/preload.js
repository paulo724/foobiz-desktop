const { contextBridge, ipcRenderer } = require('electron')

// API exposta ao Vue via window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', {

  // --- Impressão ---
  printer: {
    list: () => ipcRenderer.invoke('printer:list'),
    printReceipt: (data) => ipcRenderer.invoke('printer:receipt', data),
    printKdsTicket: (data) => ipcRenderer.invoke('printer:kds-ticket', data),
    testPrint: (printerName) => ipcRenderer.invoke('printer:test', printerName),
  },

  // --- Print Bridge (descoberta e pareamento de impressoras) ---
  printBridge: {
    discover: () => ipcRenderer.invoke('printbridge:discover'),
    setApiConfig: (cfg) => ipcRenderer.invoke('printbridge:set-api-config', cfg),
    pairDevice: (device) => ipcRenderer.invoke('printbridge:pair', device),
    unpairDevice: (deviceId) => ipcRenderer.invoke('printbridge:unpair', deviceId),
    status: () => ipcRenderer.invoke('printbridge:status'),
  },

  // --- DirectPin (PINPad serial) ---
  directPin: {
    listPorts: () => ipcRenderer.invoke('directpin:list-ports'),
    test: (config) => ipcRenderer.invoke('directpin:test', config),
    transaction: (payload, config) => ipcRenderer.invoke('directpin:transaction', payload, config),
    confirm: (nsu, config) => ipcRenderer.invoke('directpin:confirm', nsu, config),
    undo: (nsu, config) => ipcRenderer.invoke('directpin:undo', nsu, config),
    cancel: (nsu, config) => ipcRenderer.invoke('directpin:cancel', nsu, config),
    abort: (config) => ipcRenderer.invoke('directpin:abort', config),
    status: () => ipcRenderer.invoke('directpin:status'),
    onStatus: (cb) => {
      const listener = (_, status) => cb(status)
      ipcRenderer.on('directpin:status', listener)
      return () => ipcRenderer.removeListener('directpin:status', listener)
    },
  },

  // --- PlugPag (PagBank, via Bluetooth/porta COM virtual) ---
  plugPag: {
    init: (config) => ipcRenderer.invoke('plugpag:init', config),
    test: (config) => ipcRenderer.invoke('plugpag:test', config),
    transaction: (payload, config) => ipcRenderer.invoke('plugpag:transaction', payload, config),
    cancel: () => ipcRenderer.invoke('plugpag:cancel'),
    lastStatus: () => ipcRenderer.invoke('plugpag:last-status'),
    status: () => ipcRenderer.invoke('plugpag:status'),
    onStatus: (cb) => {
      const listener = (_, status) => cb(status)
      ipcRenderer.on('plugpag:status', listener)
      return () => ipcRenderer.removeListener('plugpag:status', listener)
    },
  },

  // --- App ---
  app: {
    getVersion: () => ipcRenderer.invoke('app:version'),
    getType: () => ipcRenderer.invoke('app:type'),
    getDisplayMode: () => ipcRenderer.invoke('app:display-mode'),
    setKioskMode: (enabled) => ipcRenderer.invoke('app:set-kiosk-mode', enabled),
    minimize: () => ipcRenderer.invoke('app:minimize'),
    close: () => ipcRenderer.invoke('app:close'),
    onFullscreenChanged: (cb) => {
      const listener = (_, val) => cb(val)
      ipcRenderer.on('app:fullscreen-changed', listener)
      return () => ipcRenderer.removeListener('app:fullscreen-changed', listener)
    },
    toggleFullscreen: () => ipcRenderer.invoke('app:toggle-fullscreen'),
    setFullscreenMode: (enabled) => ipcRenderer.invoke('app:set-fullscreen-mode', enabled),
    getOpenAtLogin: () => ipcRenderer.invoke('app:get-open-at-login'),
    setOpenAtLogin: (enabled) => ipcRenderer.invoke('app:set-open-at-login', enabled),
  },

  // --- Updates ---
  updater: {
    check: () => ipcRenderer.invoke('update:check'),
    installUpdate: () => ipcRenderer.invoke('update:install'),
    onChecking: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('update:checking', listener)
      return () => ipcRenderer.removeListener('update:checking', listener)
    },
    onUpdateAvailable: (cb) => {
      const listener = (_, info) => cb(info)
      ipcRenderer.on('update:available', listener)
      return () => ipcRenderer.removeListener('update:available', listener)
    },
    onUpdateNotAvailable: (cb) => {
      const listener = (_, info) => cb(info)
      ipcRenderer.on('update:not-available', listener)
      return () => ipcRenderer.removeListener('update:not-available', listener)
    },
    onDownloadProgress: (cb) => {
      const listener = (_, progress) => cb(progress)
      ipcRenderer.on('update:download-progress', listener)
      return () => ipcRenderer.removeListener('update:download-progress', listener)
    },
    onUpdateDownloaded: (cb) => {
      const listener = (_, info) => cb(info)
      ipcRenderer.on('update:downloaded', listener)
      return () => ipcRenderer.removeListener('update:downloaded', listener)
    },
    onError: (cb) => {
      const listener = (_, err) => cb(err)
      ipcRenderer.on('update:error', listener)
      return () => ipcRenderer.removeListener('update:error', listener)
    },
  },

  // Detecta se está rodando dentro do Electron
  isElectron: true,
})
