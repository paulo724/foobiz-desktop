const { Pusher } = require('pusher-js')
const log = require('electron-log')
const apiClient = require('./apiClient')

function connectDeviceChannel({ deviceToken, deviceId, tenantId, wsConfig, onJobQueued, onConnectionChange }) {
  const pusher = new Pusher(wsConfig.key, {
    cluster: 'mt1',
    wsHost: wsConfig.host,
    wsPort: Number(wsConfig.port),
    wssPort: Number(wsConfig.port),
    forceTLS: wsConfig.scheme === 'https',
    enabledTransports: ['ws', 'wss'],
    disableStats: true,
    authorizer: (channel) => ({
      authorize: (socketId, callback) => {
        apiClient
          .broadcastingAuth(deviceToken, { channelName: channel.name, socketId })
          .then((data) => callback(null, data))
          .catch((err) => callback(err, null))
      },
    }),
  })

  const channelName = `private-device.${tenantId}.${deviceId}`
  const channel = pusher.subscribe(channelName)

  channel.bind('print.job.queued', (data) => {
    onJobQueued?.(data)
  })

  pusher.connection.bind('state_change', (states) => {
    log.info(`printBridge ws[${deviceId}]: ${states.previous} -> ${states.current}`)
    onConnectionChange?.(states.current)
    if (states.current === 'connected') {
      onJobQueued?.({ reason: 'reconnect' })
    }
  })

  pusher.connection.bind('error', (err) => {
    log.error(`printBridge ws[${deviceId}]: erro de conexão`, err)
  })

  return {
    disconnect() {
      try {
        pusher.unsubscribe(channelName)
        pusher.disconnect()
      } catch (err) {
        log.error('printBridge ws: erro ao desconectar', err)
      }
    },
  }
}

module.exports = { connectDeviceChannel }
