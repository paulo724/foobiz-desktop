const Store = require('electron-store')

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

module.exports = {
  getApiBaseUrl,
  setApiBaseUrl,
  getTenantCode,
  setTenantCode,
  getDevices,
  saveDevice,
  removeDevice,
  clearDevices,
}
