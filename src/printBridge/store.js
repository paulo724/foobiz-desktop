const Store = require('electron-store')
const { randomUUID, randomBytes } = require('crypto')
const os = require('os')

const store = new Store({ name: 'print-bridge' })

function getApiBaseUrl() {
  return store.get('apiBaseUrl', null)
}

function setApiBaseUrl(url) {
  store.set('apiBaseUrl', url)
}

function getTenantCode() {
  return store.get('tenantCode', null)
}

function setTenantCode(code) {
  store.set('tenantCode', code)
}

function getDevices() {
  return store.get('devices', [])
}

function saveDevice(device) {
  const devices = getDevices().filter((d) => d.deviceId !== device.deviceId)
  devices.push(device)
  store.set('devices', devices)
  return devices
}

function removeDevice(deviceId) {
  const devices = getDevices().filter((d) => d.deviceId !== deviceId)
  store.set('devices', devices)
  return devices
}

// Limpa todos os devices pareados localmente (mas mantém apiBaseUrl/tenantCode).
// Usado quando o cache local diverge do backend (ex.: devices removidos pela
// UI web mas ainda salvos aqui, tentando autenticar com token que não existe
// mais e gerando "Invalid station token" em loop no printBridge).
function clearDevices() {
  store.set('devices', [])
  return []
}

function identity() {
  if (!store.get('executorId')) store.set('executorId', randomUUID())
  if (!store.get('executorSecret')) store.set('executorSecret', randomBytes(32).toString('hex'))
  return { managed_direct_print: true, executor_id: store.get('executorId'), executor_secret: store.get('executorSecret'), name: os.hostname(), version: require('../../package.json').version }
}
function scope() { return `${getApiBaseUrl()}|${getTenantCode()}` }
function journalKey(attemptId) { return `${scope()}|${attemptId}` }
function journalGet(attemptId) { return store.get('journal', {})[journalKey(attemptId)] }
function journalSet(attemptId, record) {
  const rows = store.get('journal', {})
  rows[journalKey(attemptId)] = { ...record, updatedAt: Date.now() }
  store.set('journal', rows)
}
function pendingJournal(deviceId) {
  const prefix = `${scope()}|`
  return Object.entries(store.get('journal', {})).filter(([key, row]) => key.startsWith(prefix) && row.deviceId === deviceId && !row.acknowledged).map(([, row]) => row)
}
function pruneJournal() {
  const rows = store.get('journal', {})
  for (const [key, row] of Object.entries(rows)) if (row.acknowledged && row.updatedAt < Date.now() - 30 * 86400000) delete rows[key]
  store.set('journal', rows)
}
module.exports = {
  identity, scope, journalGet, journalSet, pendingJournal, pruneJournal,
  getApiBaseUrl,
  setApiBaseUrl,
  getTenantCode,
  setTenantCode,
  getDevices,
  saveDevice,
  removeDevice,
  clearDevices,
}
