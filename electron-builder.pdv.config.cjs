/**
 * electron-builder config — Foobiz PDV
 */
module.exports = {
  appId: 'com.foobiz.pdv',
  productName: 'Foobiz PDV',
  copyright: 'Copyright © 2024 Foobiz',

  directories: {
    output: 'dist-electron/pdv',
    buildResources: 'resources',
  },

  files: [
    'src/**/*',
    'package.json',
    'frontend/dist/**/*',
  ],

  extraResources: [
    { from: 'resources/icons/icon-pdv-foobiz.png', to: 'icons/icon-pdv-foobiz.png' },
    { from: 'resources/plugpag/PPPagSeguro.dll', to: 'plugpag/PPPagSeguro.dll' },
    { from: 'resources/plugpag/BTSerial.dll', to: 'plugpag/BTSerial.dll' },
    { from: 'resources/winraw.ps1', to: 'winraw.ps1' },
  ],

  extraMetadata: {
    main: 'src/main.js',
    foobiz: { appType: 'pdv' },
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'resources/icons/icon-pdv-foobiz.png',
  },

  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    icon: 'resources/icons/icon-pdv-foobiz.png',
    category: 'Office',
  },

  nsis: {
    oneClick: true,
    perMachine: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Foobiz PDV',
  },

  publish: {
    provider: 'github',
    owner: 'paulo724',
    repo: 'foobiz-desktop',
    channel: 'pdv',
  },
}
