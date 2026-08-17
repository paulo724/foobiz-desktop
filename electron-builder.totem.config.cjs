/**
 * electron-builder config — Foobiz Totem
 */
module.exports = {
  appId: 'com.foobiz.totem',
  productName: 'Foobiz Totem',
  copyright: 'Copyright © 2024 Foobiz',

  directories: {
    output: 'dist-electron/totem',
    buildResources: 'resources',
  },

  files: [
    'src/**/*',
    'package.json',
    'frontend/dist/**/*',
  ],

  extraResources: [
    { from: 'resources/icons/icon-totem-foobiz.png', to: 'icons/icon-totem-foobiz.png' },
    { from: 'resources/winraw.ps1', to: 'winraw.ps1' },
  ],

  extraMetadata: {
    main: 'src/main.js',
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'resources/icons/icon-totem-foobiz.png',
  },

  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    icon: 'resources/icons/icon-totem-foobiz.png',
    category: 'Office',
  },

  nsis: {
    oneClick: true,
    perMachine: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Foobiz Totem',
  },

  publish: {
    provider: 'github',
    owner: 'paulo724',
    repo: 'foobiz-desktop',
  },
}
