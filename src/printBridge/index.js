const os = require('os')
const log = require('electron-log')
const store = require('./store')
const apiClient = require('./apiClient')
const wsClient = require('./wsClient')
const discovery = require('./discovery')
const { processPendingJobs } = require('./jobProcessor')

const POLL_INTERVAL_MS = 7000

const active = new Map() // deviceId -> { ws, pollTimer, status }

function setApiConfig({ apiBaseUrl, tenantCode }) {
  store.setApiBaseUrl(apiBaseUrl)
  store.setTenantCode(tenantCode)
}

async function pairDevice({ deviceId, deviceToken, tenantId, connectionType, address, printerIdentity }) {
  const device = { deviceId, deviceToken, tenantId, connectionType, address, printerIdentity }
  store.saveDevice(device)
  await startDevice(device)
  return device
}

async function unpairDevice(deviceId) {
  stopDevice(deviceId)
  store.removeDevice(deviceId)
}

async function startDevice(device) {
  stopDevice(device.deviceId)

  const state = { status: 'connecting', lastPullAt: null, lastError: null }
  active.set(device.deviceId, state)

  const runPull = async () => {
    try {
      const count = await processPendingJobs(device.deviceToken, {
        printerIdentityFallback: device.printerIdentity,
      })
      state.lastPullAt = Date.now()
      state.lastError = null
      if (count > 0) log.info(`printBridge: device ${device.deviceId} imprimiu ${count} job(s)`)
    } catch (err) {
      state.lastError = String(err?.message || err)
      log.error(`printBridge: erro ao puxar jobs do device ${device.deviceId}`, err)
    }
  }

  try {
    const connectResp = await apiClient.connect(device.deviceToken, {
      hostname: os.hostname(),
      platform: process.platform,
    })

    const ws = wsClient.connectDeviceChannel({
      deviceToken: device.deviceToken,
      deviceId: device.deviceId,
      tenantId: device.tenantId,
      wsConfig: connectResp.ws,
      onJobQueued: runPull,
      onConnectionChange: (s) => {
        state.status = s
      },
    })

    state.ws = ws
  } catch (err) {
    state.lastError = String(err?.message || err)
    log.error(`printBridge: falha ao conectar device ${device.deviceId}`, err)
  }

  state.pollTimer = setInterval(runPull, POLL_INTERVAL_MS)
  runPull()
}

function stopDevice(deviceId) {
  const state = active.get(deviceId)
  if (!state) return
  if (state.pollTimer) clearInterval(state.pollTimer)
  if (state.ws) state.ws.disconnect()
  active.delete(deviceId)
}

async function init() {
  for (const device of store.getDevices()) {
    await startDevice(device)
  }
}

function status() {
  return store.getDevices().map((d) => {
    const state = active.get(d.deviceId)
    return {
      deviceId: d.deviceId,
      connectionType: d.connectionType,
      address: d.address,
      status: state?.status || 'stopped',
      lastPullAt: state?.lastPullAt || null,
      lastError: state?.lastError || null,
    }
  })
}

module.exports = {
  setApiConfig,
  pairDevice,
  unpairDevice,
  init,
  status,
  discover: discovery.discover,
}
