const store = require('./store')

function baseUrl() {
  const apiBaseUrl = store.getApiBaseUrl()
  const tenantCode = store.getTenantCode()
  if (!apiBaseUrl || !tenantCode) {
    throw new Error('printBridge: apiBaseUrl/tenantCode não configurados')
  }
  return `${apiBaseUrl.replace(/\/+$/, '')}/${tenantCode}`
}

async function request(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { 'X-Station-Token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

function connect(token, { hostname, platform } = {}) {
  return request('/bridge/connect', { method: 'POST', token, body: { hostname, platform } })
}

function heartbeat(token, { hostname, platform } = {}) {
  return request('/bridge/heartbeat', { method: 'POST', token, body: { hostname, platform } })
}

function disconnect(token) {
  return request('/bridge/disconnect', { method: 'POST', token, body: {} })
}

function broadcastingAuth(token, { channelName, socketId }) {
  return request('/bridge/broadcasting/auth', {
    method: 'POST',
    token,
    body: { channel_name: channelName, socket_id: socketId },
  })
}

function pull(token, { limit = 5 } = {}) {
  return request(`/print-jobs/pull?limit=${limit}`, { token })
}

function ack(token, jobId, { status, error } = {}) {
  return request(`/print-jobs/${jobId}/ack`, { method: 'POST', token, body: { status, error } })
}

module.exports = { connect, heartbeat, disconnect, broadcastingAuth, pull, ack }
