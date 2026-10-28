function normalizeApiBaseUrl(value) {
  const input = String(value || '').trim().replace(/\/+$/, '')

  try {
    const url = new URL(input)
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/+$/, '')
  } catch {
    return input
  }
}

function sameApiConfig(current, next) {
  return normalizeApiBaseUrl(current.apiBaseUrl) === normalizeApiBaseUrl(next.apiBaseUrl)
    && String(current.tenantCode || '').trim() === String(next.tenantCode || '').trim()
}

module.exports = { normalizeApiBaseUrl, sameApiConfig }
