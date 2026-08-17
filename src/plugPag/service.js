const log = require('electron-log')
const nativeClient = require('./nativeClient')

const ALLOWED_APP_TYPES = new Set(['pdv'])

let busy = false
let currentOperation = null
let initialized = false

function ensureAllowed() {
  const appType = process.env.FOOBIZ_APP || 'pdv'
  if (!ALLOWED_APP_TYPES.has(appType)) {
    throw new Error('PlugPag disponível apenas no app PDV.')
  }
}

function normalizeTerminalConfig(config = {}) {
  const terminal = config.payment_terminal && typeof config.payment_terminal === 'object' ? config.payment_terminal : config

  return {
    comPort: terminal.com_port ?? terminal.comPort ?? terminal.serial_port ?? terminal.serialPort,
    appName: terminal.app_name ?? terminal.appName ?? 'Foobiz',
    appVersion: terminal.app_version ?? terminal.appVersion ?? '1',
    timeoutSeconds: terminal.timeout_seconds ?? terminal.timeoutSeconds ?? 120,
  }
}

async function runExclusive(operation, fn, onStatus = null) {
  ensureAllowed()
  if (busy) {
    const err = new Error('PlugPag ocupado.')
    err.code = 'PLUGPAG_BUSY'
    throw err
  }

  busy = true
  currentOperation = { operation, startedAt: new Date().toISOString() }
  const emitStatus = (phase, payload = {}) => {
    onStatus?.({ operation, phase, at: new Date().toISOString(), ...payload })
  }

  try {
    return await fn(emitStatus)
  } finally {
    busy = false
    currentOperation = null
  }
}

function buildFriendlyError(code, codeName, fallbackMessage) {
  const messages = {
    PPPS_POS_NOT_READY: 'Terminal não está pronto. Verifique se está ligado, pareado e na tela inicial.',
    PPPS_TRANS_DENIED: 'Transação recusada pelo terminal.',
    PPPS_COMMUNICATION_ERROR: 'Falha de comunicação com o terminal. Verifique o pareamento Bluetooth e a porta COM.',
    PPPS_DRIVER_NOT_FOUND: 'Driver do PlugPag não encontrado (DLL ausente ou incompatível).',
    PPPS_TRANS_NODATA: 'Nenhuma transação encontrada.',
    PPPS_APP_NAME_VERSION_NOT_SET: 'Aplicativo não identificado junto ao terminal — ative o terminal antes de operar.',
    PPPS_SHARE_MODE_NOT_ALLOWED: 'Porta COM em uso por outro processo.',
  }

  const err = new Error(messages[codeName] || fallbackMessage || `PlugPag retornou erro: ${codeName} (${code}).`)
  err.code = 'PLUGPAG_ERROR'
  err.plugPagCode = code
  err.plugPagCodeName = codeName
  return err
}

async function init(config) {
  return runExclusive('init', async (emitStatus) => {
    const terminalConfig = normalizeTerminalConfig(config)
    if (!terminalConfig.comPort) {
      const err = new Error('Porta COM do PlugPag não configurada.')
      err.code = 'PLUGPAG_NO_COMPORT'
      throw err
    }

    emitStatus('connecting', { comPort: terminalConfig.comPort })
    log.info('plugPag: InitBTConnection', { comPort: terminalConfig.comPort })
    const initCode = await nativeClient.initBTConnection(terminalConfig.comPort)
    if (initCode !== 0) {
      const codeName = nativeClient.returnCodeName(initCode)
      log.warn('plugPag: falha ao conectar', { code: initCode, codeName })
      throw buildFriendlyError(initCode, codeName, 'Falha ao conectar com o terminal PlugPag.')
    }

    emitStatus('setting_version')
    log.info('plugPag: SetVersionName', { appName: terminalConfig.appName, appVersion: terminalConfig.appVersion })
    const versionCode = await nativeClient.setVersionName(terminalConfig.appName, terminalConfig.appVersion)
    if (versionCode !== 0) {
      const codeName = nativeClient.returnCodeName(versionCode)
      log.warn('plugPag: falha ao identificar aplicativo', { code: versionCode, codeName })
      throw buildFriendlyError(versionCode, codeName, 'Falha ao identificar o aplicativo junto ao terminal.')
    }

    initialized = true
    emitStatus('connected')
    return { ok: true, comPort: terminalConfig.comPort }
  }, config?.onStatus)
}

async function test(config) {
  return init(config)
}

async function transaction(payload, config, onStatus = null) {
  return runExclusive('transaction', async (emitStatus) => {
    if (!initialized) {
      const err = new Error('Terminal PlugPag não inicializado. Use "Ativar/Parear terminal" antes de vender.')
      err.code = 'PLUGPAG_NOT_INITIALIZED'
      throw err
    }

    const paymentMethod = nativeClient.PAYMENT_METHOD[String(payload.typeTransaction || '').toUpperCase()]
    if (!paymentMethod) {
      const err = new Error(`Tipo de transação inválido para PlugPag: ${payload.typeTransaction}`)
      err.code = 'PLUGPAG_INVALID_TYPE'
      throw err
    }

    const installments = Number(payload.installment ?? 1) || 1
    const installmentType =
      installments > 1 ? nativeClient.INSTALLMENT_TYPE.PARC_VENDEDOR : nativeClient.INSTALLMENT_TYPE.A_VISTA

    emitStatus('transaction_started', { operation: 'transaction', amount: payload.amount })
    log.info('plugPag: SimplePaymentTransaction', {
      paymentMethod,
      installmentType,
      installments,
      amount: payload.amount,
    })

    const { code, codeName, result } = await nativeClient.simplePaymentTransaction({
      paymentMethod,
      installmentType,
      installments,
      amount: payload.amount,
      userReference: payload.userReference ?? payload.entityIdentifier ?? '',
    })

    if (code !== 0) {
      log.warn('plugPag: transação não aprovada', { code, codeName, message: result?.message })
      emitStatus('finished_error', { code, codeName })
      throw buildFriendlyError(code, codeName, result?.message)
    }

    emitStatus('finished_success', { codeResult: code, finalResult: 'APPROVED' })
    return { codeResult: code, finalResult: 'APPROVED', ...result }
  }, onStatus)
}

async function cancel() {
  return runExclusive('cancel', async (emitStatus) => {
    emitStatus('cancel_started')
    const { code, codeName, result } = await nativeClient.cancelTransaction()
    if (code !== 0) {
      emitStatus('finished_error', { code, codeName })
      throw buildFriendlyError(code, codeName, result?.message)
    }
    emitStatus('finished_success')
    return { codeResult: code, finalResult: 'APPROVED', ...result }
  })
}

async function lastTransactionStatus() {
  return runExclusive('last-status', async () => {
    const { code, codeName, result } = await nativeClient.getLastApprovedTransactionStatus()
    if (code !== 0) {
      throw buildFriendlyError(code, codeName, result?.message)
    }
    return result
  })
}

function status() {
  return {
    ok: true,
    busy,
    initialized,
    currentOperation,
    appType: process.env.FOOBIZ_APP || 'pdv',
  }
}

module.exports = {
  init,
  test,
  transaction,
  cancel,
  lastTransactionStatus,
  status,
  normalizeTerminalConfig,
}
