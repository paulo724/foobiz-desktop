/**
 * electron-builder config — Foobiz KDS
 */
module.exports = {
  appId: 'com.foobiz.kds',
  productName: 'Foobiz KDS',
  copyright: 'Copyright © 2024 Foobiz',

  directories: {
    output: 'dist-electron/kds',
    buildResources: 'resources',
  },

  files: [
    'src/**/*',
    'package.json',
    'frontend/dist/**/*',
  ],

  extraResources: [
    { from: 'resources/icons/icon-kds-foobiz.png', to: 'icons/icon-kds-foobiz.png' },
    { from: 'resources/winraw.ps1', to: 'winraw.ps1' },
  ],

  extraMetadata: {
    main: 'src/main.js',
    foobiz: { appType: 'kds' },
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'resources/icons/icon-kds-foobiz.png',
  },

  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    icon: 'resources/icons/icon-kds-foobiz.png',
    category: 'Office',
  },

  nsis: {
    oneClick: true,
    perMachine: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Foobiz KDS',
  },

  publish: {
    provider: 'github',
    owner: 'paulo724',
    repo: 'foobiz-desktop',
    channel: 'kds',
  },
}
