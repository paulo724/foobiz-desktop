const os = require('os')
const log = require('electron-log')
const store = require('./store')
const apiClient = require('./apiClient')
const wsClient = require('./wsClient')
const discovery = require('./discovery')
const { processPendingJobs } = require('./jobProcessor')
const { printOnWorker, stopWorker } = require('./printerWorkerPool')

const POLL_INTERVAL_MS = 7000
const HEARTBEAT_INTERVAL_MS = 60000

const active = new Map() // deviceId -> { ws, pollTimer, status }

function setApiConfig({ apiBaseUrl, tenantCode }) {
  store.setApiBaseUrl(apiBaseUrl)
  store.setTenantCode(tenantCode)
}

async function pairDevice({
  deviceId,
  deviceToken,
  tenantId,
  connectionType,
  address,
  printerIdentity,
  serialPort,
  serialBaudRate,
  serialRtscts,
}) {
  const device = {
    deviceId,
    deviceToken,
    tenantId,
    connectionType,
    address,
    printerIdentity,
    serialPort,
    serialBaudRate,
    serialRtscts,
  }
  store.saveDevice(device)
  await startDevice(device)
  return device
}

// Impressão local via IPC, sem depender do pull remoto: resolve o device já
// pareado no store local e enfileira no worker daquela impressora (ver
// printerWorkerPool.js) — mesma fila usada pelo pull remoto, então as duas
// vias nunca escrevem na mesma porta ao mesmo tempo, e uma impressora
// travada não bloqueia a UI do Electron nem atrasa outras impressoras.
//
// printerIdentity/options, quando vêm do chamador, têm prioridade sobre a
// config local salva no pareamento — eles refletem o StationDevice resolvido
// no backend no momento da impressão (fonte de verdade), enquanto o store
// local é só o que foi digitado/selecionado uma vez durante o pareamento e
// pode ter ficado divergente (ex: impressora renomeada no spooler do SO).
async function printNow({ deviceId, payloadBase64, printerIdentity, options }) {
  const device = store.getDevices().find((d) => d.deviceId === deviceId)
  if (!device) {
    return { success: false, error: `Dispositivo ${deviceId} não está pareado.` }
  }
  if (!payloadBase64) {
    return { success: false, error: 'payloadBase64 ausente.' }
  }

  return printOnWorker(deviceId, {
    connectionType: options?.connection_type || device.connectionType,
    address: options?.address || device.address,
    serialPort: options?.serialPort || device.serialPort,
    serialBaudRate: options?.serialBaudRate || device.serialBaudRate,
    serialRtscts: options?.serialRtscts ?? device.serialRtscts,
    printerIdentity: printerIdentity || device.printerIdentity,
  }, payloadBase64)
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
      const count = await processPendingJobs(device.deviceId, device.deviceToken, {
        printerIdentityFallback: device.printerIdentity,
        printOnWorker,
      })
      state.lastPullAt = Date.now()
      state.lastError = null
      if (count > 0) log.info(`printBridge: device ${device.deviceId} imprimiu ${count} job(s)`)
    } catch (err) {
      state.lastError = String(err?.message || err)
      log.error(`printBridge: erro ao puxar jobs do device ${device.deviceId}`, err)
    }
  }

  // "Conectada"/"Desconectada" na UI reflete last_seen_at do StationDevice,
  // que só é atualizado quando o backend recebe um heartbeat — sem chamar
  // isso periodicamente, o dispositivo aparece sempre como desconectado
  // mesmo funcionando normalmente (pull/print/ack não tocam last_seen_at).
  const runHeartbeat = async () => {
    try {
      await apiClient.heartbeat(device.deviceToken, {
        hostname: os.hostname(),
        platform: process.platform,
      })
    } catch (err) {
      log.error(`printBridge: falha ao enviar heartbeat do device ${device.deviceId}`, err)
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

  state.heartbeatTimer = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS)
  runHeartbeat()
}

function stopDevice(deviceId) {
  const state = active.get(deviceId)
  if (!state) return
  if (state.pollTimer) clearInterval(state.pollTimer)
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  if (state.ws) state.ws.disconnect()
  active.delete(deviceId)
  stopWorker(deviceId)
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
  printNow,
  init,
  status,
  discover: discovery.discover,
}
