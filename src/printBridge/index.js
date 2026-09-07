const os = require('os')
const log = require('electron-log')
const store = require('./store')
const apiClient = require('./apiClient')
const wsClient = require('./wsClient')
const discovery = require('./discovery')
const { processPendingJobs } = require('./jobProcessor')
const { printOnWorker, checkHealthOnWorker, stopWorker } = require('./printerWorkerPool')

const POLL_INTERVAL_MS = 7000
const HEARTBEAT_INTERVAL_MS = 60000
const HEALTH_INTERVAL_MS = 20000

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

// Esquece todos os devices pareados localmente (para/desconecta cada um antes
// de limpar o store) — usado quando o cache local diverge do backend.
async function resetAll() {
  for (const device of store.getDevices()) {
    stopDevice(device.deviceId)
  }
  store.clearDevices()
}

async function startDevice(device) {
  stopDevice(device.deviceId)

  const state = { status: 'connecting', lastPullAt: null, lastError: null, online: null, lastHealthAt: null }
  active.set(device.deviceId, state)

  // runPull é disparado tanto pelo timer fixo (POLL_INTERVAL_MS) quanto pelo
  // evento WS (onJobQueued) — sem esse lock, as duas vias podem rodar
  // processPendingJobs em paralelo para o mesmo device quase ao mesmo tempo
  // (ex.: job de teste criado logo antes de um tick do timer), disparando
  // chamadas concorrentes ao worker de impressão da mesma porta/spooler, o
  // que pode corromper o handle nativo e derrubar o processo inteiro.
  let pulling = false
  const runPull = async () => {
    if (pulling) return
    pulling = true
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
    } finally {
      pulling = false
    }
  }

  // "Conectada"/"Desconectada" na UI reflete last_seen_at do StationDevice,
  // que só é atualizado quando o backend recebe um heartbeat — sem chamar
  // isso periodicamente, o dispositivo aparece sempre como desconectado
  // mesmo funcionando normalmente (pull/print/ack não tocam last_seen_at).
  // Também carrega o resultado do healthcheck real da porta (state.online),
  // que o backend grava em StationDevice.status — sem isso, o status do
  // device no backend só mudava quando alguém clicava "Testar impressão".
  const runHeartbeat = async () => {
    try {
      await apiClient.heartbeat(device.deviceToken, {
        hostname: os.hostname(),
        platform: process.platform,
        printerOnline: state.online,
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

  // Testa a porta/impressora de verdade (abre a porta COM, ou pergunta ao
  // spooler/socket se a impressora responde) — sem isso, "status" só reflete
  // a conexão WS do app com o backend, então a UI mostrava "Online" mesmo
  // com a impressora física desligada/desconectada.
  const runHealthCheck = async () => {
    const previous = state.online
    try {
      const result = await checkHealthOnWorker(device.deviceId, {
        connectionType: device.connectionType,
        address: device.address,
        serialPort: device.serialPort,
        serialBaudRate: device.serialBaudRate,
        serialRtscts: device.serialRtscts,
        printerIdentity: device.printerIdentity,
      })
      state.online = !!result.online
    } catch (err) {
      state.online = false
      log.error(`printBridge: falha ao checar saúde do device ${device.deviceId}`, err)
    } finally {
      state.lastHealthAt = Date.now()
      // Muda de estado (conectou/desconectou) — avisa o backend na hora, em
      // vez de esperar o próximo heartbeat fixo (até 60s de atraso).
      if (previous !== null && previous !== state.online) runHeartbeat()
    }
  }

  state.pollTimer = setInterval(runPull, POLL_INTERVAL_MS)
  runPull()

  state.healthTimer = setInterval(runHealthCheck, HEALTH_INTERVAL_MS)
  await runHealthCheck()

  state.heartbeatTimer = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS)
  runHeartbeat()
}

function stopDevice(deviceId) {
  const state = active.get(deviceId)
  if (!state) return
  if (state.pollTimer) clearInterval(state.pollTimer)
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  if (state.healthTimer) clearInterval(state.healthTimer)
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
      // online: resultado do healthcheck real da porta/impressora (null =
      // ainda não checou nenhuma vez desde que o app abriu).
      online: state?.online ?? null,
      lastHealthAt: state?.lastHealthAt || null,
    }
  })
}

module.exports = {
  setApiConfig,
  pairDevice,
  unpairDevice,
  resetAll,
  printNow,
  init,
  status,
  discover: discovery.discover,
}
