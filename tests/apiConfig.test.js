const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalizeApiBaseUrl, sameApiConfig } = require('../src/printBridge/apiConfig')

test('URLs equivalentes não exigem remover as impressoras pareadas', () => {
  assert.equal(normalizeApiBaseUrl(' HTTPS://EXAMPLE.COM:443/api/ '), 'https://example.com/api')
  assert.equal(sameApiConfig(
    { apiBaseUrl: 'https://example.com/api/', tenantCode: ' LOJA ' },
    { apiBaseUrl: 'https://EXAMPLE.com:443/api', tenantCode: 'LOJA' },
  ), true)
})

test('troca real de servidor ou estabelecimento continua bloqueada', () => {
  const current = { apiBaseUrl: 'https://example.com/api', tenantCode: 'LOJA' }

  assert.equal(sameApiConfig(current, { ...current, apiBaseUrl: 'https://outro.com/api' }), false)
  assert.equal(sameApiConfig(current, { ...current, tenantCode: 'OUTRA' }), false)
})
