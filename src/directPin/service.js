const { SerialPort } = require('serialport')
const log = require('electron-log')
const { DirectPinSerialClient } = require('./serialClient')

const ALLOWED_APP_TYPES = new Set(['pdv', 'totem'])

let busy = false
let currentOperation = null
let currentClient = null

function ensureAllowed() {
  const appType = process.env.FOOBIZ_APP || 'pdv'
  if (!ALLOWED_APP_TYPES.has(appType)) {
    throw new Error('DirectPin disponível apenas nos apps PDV e Totem.')
  }
}

function normalizeTerminalConfig(config = {}) {
  const terminal = config.payment_terminal && typeof config.payment_terminal === 'object'
    ? config.payment_terminal
    : config

  return {
    path: terminal.serial_port ?? terminal.path ?? terminal.serialPort,
    baud_rate: terminal.baud_rate ?? terminal.baudRate ?? 115200,
    timeout_seconds: terminal.timeout_seconds ?? terminal.timeoutSeconds ?? 120,
    max_retries: terminal.max_retries ?? terminal.maxRetries ?? 3,
    entityIdentifier: terminal.entity_identifier ?? terminal.entityIdentifier ?? null,
    autoConfirm: terminal.auto_confirm ?? terminal.autoConfirm ?? false,
    printReceipt: terminal.print_receipt_on_terminal ?? terminal.printReceipt ?? false,
  }
}

function withEntity(payload, config) {
  const normalized = normalizeTerminalConfig(config)
  return {
    ...payload,
    entityIdentifier: payload.entityIdentifier ?? normalized.entityIdentifier ?? undefined,
  }
}

async function runExclusive(operation, config, fn, onStatus = null) {
  ensureAllowed()
  if (busy) {
    const err = new Error('DirectPin ocupado.')
    err.code = 'DIRECTPIN_BUSY'
    throw err
  }

  busy = true
  currentOperation = { operation, startedAt: new Date().toISOString() }
  try {
    const terminalConfig = normalizeTerminalConfig(config)
    const client = new DirectPinSerialClient(terminalConfig, (status) => {
      onStatus?.({
        operation,
        ...status,
      })
    })
    currentClient = client
    return await fn(client, terminalConfig)
  } finally {
    busy = false
    currentOperation = null
    currentClient = null
  }
}

async function listPorts() {
  ensureAllowed()
  const ports = await SerialPort.list()
  return ports.map((port) => ({
    path: port.path,
    manufacturer: port.manufacturer ?? null,
    serialNumber: port.serialNumber ?? null,
    pnpId: port.pnpId ?? null,
    vendorId: port.vendorId ?? null,
    productId: port.productId ?? null,
  }))
}

async function test(config) {
  return runExclusive('test', config, (client) => client.testConnection())
}

async function transaction(payload, config, onStatus = null) {
  return runExclusive('transaction', config, async (client, terminalConfig) => {
    const request = buildTransactionRequest(payload, terminalConfig)
    const finalRequest = stripUndefined(request)
    log.info('directPin: payload transaction', finalRequest)

    try {
      return ensureApprovedResponse(await client.send(finalRequest))
    } catch (err) {
      if (err?.code === 'DIRECTPIN_NAK') throw buildNakError(err)
      throw err
    }
  }, onStatus)
}

function buildNakError(previousError) {
  const err = new Error(
    'POS recusou a comunicação antes de iniciar o pagamento. Verifique se o terminal está na tela inicial, livre para uma nova venda, na porta COM correta e tente novamente.',
  )
  err.code = 'DIRECTPIN_NAK'
  err.cause = previousError
  return err
}

function ensureApprovedResponse(response) {
  const result = normalizeDirectPinResponse(response)
  const codeResult = Number(result?.codeResult ?? result?.code_result ?? NaN)
  const finalResult = String(result?.finalResult ?? result?.final_result ?? '').toUpperCase()
  const approved = codeResult === 0 || finalResult === 'APPROVED' || result?.result === true

  if (approved) return response

  log.warn('directPin: transação não aprovada pelo terminal', {
    codeResult: Number.isNaN(codeResult) ? null : codeResult,
    finalResult: finalResult || null,
    message: result?.message ?? result?.mensagem ?? null,
  })

  const err = new Error(directPinDeclinedMessage(result))
  err.code = 'DIRECTPIN_DECLINED'
  err.directPin = result
  throw err
}

function normalizeDirectPinResponse(response) {
  if (
    response?.result &&
    typeof response.result === 'object' &&
    !Array.isArray(response.result)
  ) {
    return response.result
  }

  return response
}

function directPinDeclinedMessage(result) {
  const message = String(result?.message ?? result?.mensagem ?? '').trim()
  const finalResult = String(result?.finalResult ?? result?.final_result ?? '').trim()
  const codeResult = result?.codeResult ?? result?.code_result ?? null

  if (message) return message
  if (finalResult && finalResult.toUpperCase() !== 'APPROVED') {
    return `Transação não aprovada no POS: ${finalResult}.`
  }
  if (codeResult !== null && codeResult !== undefined && codeResult !== '') {
    return `Transação não aprovada no POS. Código ${codeResult}.`
  }

  return 'Transação não aprovada no POS.'
}

function buildTransactionRequest(payload, terminalConfig) {
  const request = {
      type: 'transaction',
      amount: payload.amount,
      typeTransaction: payload.typeTransaction,
      autoConfirm: payload.autoConfirm ?? terminalConfig.autoConfirm,
      printReceipt: payload.printReceipt ?? terminalConfig.printReceipt,
      entityIdentifier: payload.entityIdentifier ?? terminalConfig.entityIdentifier ?? undefined,
      customerId: payload.customerId ?? undefined,
  }

  if (payload.typeTransaction === 'CREDIT' && Number(payload.installment ?? 1) > 1) {
    request.creditType = payload.creditType ?? 'INSTALLMENT'
    request.installment = payload.installment
    request.interestType = payload.interestType ?? 'MERCHANT'
  }

  return request
}

function buildLegacyTransactionRequest(payload, terminalConfig) {
  const typeTransaction = payload.typeTransaction
  const installment = Number(payload.installment ?? 1) || 1

  return {
    type: 'transaction',
    amount: payload.amount,
    typeTransaction,
    creditType: typeTransaction === 'CREDIT' && installment > 1 ? 'INSTALLMENT' : 'NO_INSTALLMENT',
    installment: typeTransaction === 'CREDIT' ? installment : undefined,
    isTyped: payload.isTyped ?? false,
    isPreAuth: payload.isPreAuth ?? false,
    autoConfirm: payload.autoConfirm ?? terminalConfig.autoConfirm,
    interestType: payload.interestType ?? 'MERCHANT',
    printReceipt: payload.printReceipt ?? terminalConfig.printReceipt,
    entityIdentifier: payload.entityIdentifier ?? terminalConfig.entityIdentifier ?? undefined,
  }
}

async function confirm(nsu, config) {
  return runExclusive('confirm', config, (client, terminalConfig) => client.send(stripUndefined(withEntity({
    type: 'confirmtransaction',
    nsu,
  }, terminalConfig))))
}

async function undo(nsu, config) {
  return runExclusive('undo', config, (client, terminalConfig) => client.send(stripUndefined(withEntity({
    type: 'undotransaction',
    nsu,
  }, terminalConfig))))
}

async function cancel(nsu, config, onStatus = null) {
  return runExclusive('cancel', config, async (client, terminalConfig) => {
    const response = await client.send(stripUndefined(withEntity({
      type: 'cancel_transaction',
      nsu,
    }, terminalConfig)))
    return normalizeCancelResponse(response)
  }, onStatus)
}

async function transactionStatus(customerId, config) {
  return runExclusive('transactionStatus', config, (client, terminalConfig) => client.send(stripUndefined(withEntity({
    type: 'transactionStatus',
    customerId,
  }, terminalConfig))))
}

async function collect(payload, config, onStatus = null) {
  return runExclusive('collect', config, (client, terminalConfig) => client.send(stripUndefined(withEntity({
    type: 'collect',
    title: payload?.title,
    mask: payload?.mask,
    inputType: payload?.inputType,
  }, terminalConfig))), onStatus)
}

// Diferente da resposta de transaction (que sempre traz finalResult tipo
// "APPROVED"), a resposta real do terminal para cancel_transaction NUNCA
// inclui finalResult/codeResult — só {"result":true,"type":"CANCELLATION",
// "message":"...",...} (confirmado em log real, electron-log main.log).
//
// IMPORTANTE: `result: true` NÃO significa sucesso do cancelamento — significa
// só que o terminal processou e devolveu uma resposta (confirmado também em
// log real: um cancelamento que falhou por cartão errado voltou com
// {"result":true,"type":"CANCELLATION","message":"Falha no cancelamento da
// transação","receiptContent":""}). O único sinal confiável de sucesso/falha
// nesse payload é a mensagem em si. Não lança erro aqui (diferente de
// ensureApprovedResponse): quem decide se o resultado é sucesso ou falha é
// o chamador, olhando finalResult.
const CANCEL_FAILURE_HINTS = ['falha', 'erro', 'recusad', 'negad', 'rejeitad', 'não aprovad', 'nao aprovad']

function normalizeCancelResponse(response) {
  const result = normalizeDirectPinResponse(response)
  if (!result || typeof result !== 'object') return response

  if (result.finalResult === undefined && result.final_result !== undefined) {
    result.finalResult = result.final_result
  }

  if (result.finalResult === undefined) {
    const type = String(result.type ?? '').toUpperCase()
    const message = String(result.message ?? '').toLowerCase()
    const looksLikeFailure = CANCEL_FAILURE_HINTS.some((hint) => message.includes(hint))

    if (result.result === true && (type === 'CANCELLATION' || type === '') && !looksLikeFailure) {
      result.finalResult = 'CANCELED'
    } else if (looksLikeFailure) {
      result.finalResult = 'DECLINED'
    }
  }

  return response
}

async function abort(config) {
  // Não passa por runExclusive: precisa rodar mesmo com uma transação pendente
  // travada na mesma porta serial. No Windows, abrir uma SEGUNDA conexão na
  // mesma porta COM enquanto a primeira está aberta falha com erro 170
  // (recurso ocupado) — então reaproveitamos a porta já aberta pela operação
  // em andamento (currentClient) em vez de criar um SerialPort novo.
  ensureAllowed()
  const terminalConfig = normalizeTerminalConfig(config)
  const abortPayload = stripUndefined(withEntity({ type: 'abort' }, terminalConfig))

  if (currentClient?.activePort?.isOpen && currentClient.config.path === terminalConfig.path) {
    return currentClient.sendOnActivePort(abortPayload)
  }

  const client = new DirectPinSerialClient({ ...terminalConfig, timeout_seconds: 10, max_retries: 0 })
  return client.send(abortPayload)
}

function status() {
  return {
    ok: true,
    busy,
    currentOperation,
    appType: process.env.FOOBIZ_APP || 'pdv',
  }
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ''))
}

module.exports = {
  listPorts,
  test,
  transaction,
  confirm,
  undo,
  cancel,
  transactionStatus,
  collect,
  abort,
  status,
  normalizeTerminalConfig,
}
