const path = require('path')
const util = require('util')
const koffi = require('koffi')
const { app } = require('electron')
const log = require('electron-log')

// Tamanhos e layout replicados literalmente de PPPagSeguro.h (SDK oficial PagBank,
// https://github.com/pagseguro/plugpag/blob/master/1.x/windows/1.3.3/x64/PPPagSeguro.h).
// O header usa #pragma pack(push,1) e tyAmount é dimensionado com PPPS_TRS_CODE_LEN
// (não PPPS_AMOUNT_LEN) — preservado assim de propósito, é o que a DLL espera.
const COMPORT_LEN = 8 + 1
const TRS_CODE_LEN = 32 + 1
const USER_REFERENCE_LEN = 10 + 1
const APP_NAME_LEN = 25 + 1
const APP_VERSION_LEN = 10 + 1
const MESSAGE_LEN = 1023 + 1
const DATE_LEN = 10 + 1
const TIME_LEN = 8 + 1
const TRS_HOSTNSU_LEN = 12 + 1
const CARD_BRAND_LEN = 30 + 1
const BIN_LEN = 6 + 1
const HOLDER_LEN = 4 + 1
const RAW_BUFFER_LEN = 65542 + 1
const TERMINAL_SERIAL_NUMBER_LEN = 65 + 1

const RETURN_CODES = {
  0: 'PPPS_RET_OK',
  '-1001': 'PPPS_BUFF_SIZE',
  '-1002': 'PPPS_NULL_PTR',
  '-1003': 'PPPS_POS_NOT_READY',
  '-1004': 'PPPS_TRANS_DENIED',
  '-1005': 'PPPS_DATA_INV_RESULT_MESSAGE',
  '-1006': 'PPPS_INV_AMOUNT_PARAM',
  '-1007': 'PPPS_INV_TOT_AMOUNT_PARAM',
  '-1008': 'PPPS_INV_USER_REF_PARAM',
  '-1009': 'PPPS_INV_TRS_RESULT_PARAM',
  '-1010': 'PPPS_DRIVER_NOT_FOUND',
  '-1011': 'PPPS_DRIVER_FUNCTION_ERROR',
  '-1012': 'PPPS_INV_FORMAT_AMOUNT_PARAM',
  '-1013': 'PPPS_INV_LEN_USER_REF_PARAM',
  '-1014': 'PPPS_INVALID_BUFFER',
  '-1015': 'PPPS_INV_APP_NAME_PARAM',
  '-1016': 'PPPS_INV_APP_VERSION_PARAM',
  '-1017': 'PPPS_APP_NAME_VERSION_NOT_SET',
  '-1018': 'PPPS_TRANS_NODATA',
  '-1019': 'PPPS_COMMUNICATION_ERROR',
  '-1020': 'PPPS_SHARE_MODE_NOT_ALLOWED',
  '-1999': 'PPPS_ERR_UNKNOW',
}

const PAYMENT_METHOD = {
  CREDIT: 1,
  DEBIT: 2,
  VOUCHER: 3,
}

const INSTALLMENT_TYPE = {
  A_VISTA: 1,
  PARC_VENDEDOR: 2,
}

function resolveDllPath() {
  const base = app?.isPackaged
    ? path.join(process.resourcesPath, 'plugpag')
    : path.join(__dirname, '../../resources/plugpag')
  return path.join(base, 'PPPagSeguro.dll')
}

let fns = null
let transactionResultType = null

function ensureDllSearchPath(dllDir) {
  // PPPagSeguro.dll depende de outras DLLs no mesmo diretório (ex: BTSerial.dll)
  // que o Windows só resolve automaticamente se o diretório estiver no PATH do
  // processo — carregar a DLL principal por caminho absoluto via koffi.load()
  // não é suficiente para as dependências transitivas dela.
  const current = process.env.PATH || ''
  if (!current.split(path.delimiter).includes(dllDir)) {
    process.env.PATH = `${dllDir}${path.delimiter}${current}`
  }
}

function loadLibrary() {
  if (fns) return fns

  const dllPath = resolveDllPath()
  ensureDllSearchPath(path.dirname(dllPath))
  log.info('plugPag: carregando DLL', dllPath)
  const lib = koffi.load(dllPath)

  // #pragma pack(push,1) no header original — sem padding entre campos char[],
  // na ordem exata declarada em PPPagSeguro.h. koffi.pack() cria o tipo já com
  // alinhamento 1 (equivalente ao pack(1) do C), diferente de koffi.struct().
  transactionResultType = koffi.pack('stPPPSTransactionResult', {
    rawBuffer: koffi.array('char', RAW_BUFFER_LEN),
    message: koffi.array('char', MESSAGE_LEN),
    transactionCode: koffi.array('char', TRS_CODE_LEN),
    date: koffi.array('char', DATE_LEN),
    time: koffi.array('char', TIME_LEN),
    hostNsu: koffi.array('char', TRS_HOSTNSU_LEN),
    cardBrand: koffi.array('char', CARD_BRAND_LEN),
    bin: koffi.array('char', BIN_LEN),
    holder: koffi.array('char', HOLDER_LEN),
    userReference: koffi.array('char', USER_REFERENCE_LEN),
    terminalSerialNumber: koffi.array('char', TERMINAL_SERIAL_NUMBER_LEN),
  })

  const transactionResultPtr = koffi.pointer(transactionResultType)

  const rawFns = {
    GetVersionLib: lib.func('GetVersionLib', 'str', []),
    InitBTConnection: lib.func('InitBTConnection', 'int', ['str']),
    SimplePaymentTransaction: lib.func('SimplePaymentTransaction', 'int', [
      'int',
      'int',
      'uint32',
      'str',
      'str',
      koffi.out(transactionResultPtr),
    ]),
    CancelTransaction: lib.func('CancelTransaction', 'int', [koffi.out(transactionResultPtr)]),
    GetLastApprovedTransactionStatus: lib.func('GetLastApprovedTransactionStatus', 'int', [
      koffi.out(transactionResultPtr),
    ]),
    UnloadDriverConnection: lib.func('UnloadDriverConnection', 'void', []),
    SetVersionName: lib.func('SetVersionName', 'int', ['str', 'str']),
  }

  // Chamadas nativas via koffi são SÍNCRONAS por padrão e bloqueiam o processo
  // main do Electron inteiro. InitBTConnection e SimplePaymentTransaction podem
  // demorar dezenas de segundos (esperando o Bluetooth conectar ou o cliente
  // interagir com a maquininha) — sem .async() o app trava completamente
  // durante esse tempo. Rodamos em worker thread via koffi e promisificamos.
  fns = {
    GetVersionLib: util.promisify(rawFns.GetVersionLib.async),
    InitBTConnection: util.promisify(rawFns.InitBTConnection.async),
    SimplePaymentTransaction: util.promisify(rawFns.SimplePaymentTransaction.async),
    CancelTransaction: util.promisify(rawFns.CancelTransaction.async),
    GetLastApprovedTransactionStatus: util.promisify(rawFns.GetLastApprovedTransactionStatus.async),
    UnloadDriverConnection: rawFns.UnloadDriverConnection,
    SetVersionName: util.promisify(rawFns.SetVersionName.async),
  }

  return fns
}

function toCString(value, len, fieldName) {
  const str = String(value ?? '')
  if (Buffer.byteLength(str, 'utf8') > len - 1) {
    const err = new Error(`plugPag: valor de "${fieldName}" excede o tamanho máximo (${len - 1} bytes).`)
    err.code = 'PLUGPAG_BUFFER_TOO_LONG'
    throw err
  }
  return str
}

function returnCodeName(code) {
  return RETURN_CODES[String(code)] ?? 'PPPS_ERR_UNKNOW'
}

async function getVersionLib() {
  const { GetVersionLib } = loadLibrary()
  return GetVersionLib()
}

async function initBTConnection(comPort) {
  const { InitBTConnection } = loadLibrary()
  const comport = toCString(comPort, COMPORT_LEN, 'comport')
  return InitBTConnection(comport)
}

async function setVersionName(appName, appVersion) {
  const { SetVersionName } = loadLibrary()
  const name = toCString(appName, APP_NAME_LEN, 'appName')
  const version = toCString(appVersion, APP_VERSION_LEN, 'version')
  return SetVersionName(name, version)
}

async function simplePaymentTransaction({ paymentMethod, installmentType, installments, amount, userReference }) {
  const { SimplePaymentTransaction } = loadLibrary()
  const amountStr = toCString(amount, TRS_CODE_LEN, 'amount')
  const userReferenceStr = toCString(userReference, USER_REFERENCE_LEN, 'userreference')
  const result = {}
  const code = await SimplePaymentTransaction(
    paymentMethod,
    installmentType,
    Number(installments) || 1,
    amountStr,
    userReferenceStr,
    result,
  )
  return { code, codeName: returnCodeName(code), result }
}

async function cancelTransaction() {
  const { CancelTransaction } = loadLibrary()
  const result = {}
  const code = await CancelTransaction(result)
  return { code, codeName: returnCodeName(code), result }
}

async function getLastApprovedTransactionStatus() {
  const { GetLastApprovedTransactionStatus } = loadLibrary()
  const result = {}
  const code = await GetLastApprovedTransactionStatus(result)
  return { code, codeName: returnCodeName(code), result }
}

function unloadDriverConnection() {
  if (!fns) return
  fns.UnloadDriverConnection()
}

module.exports = {
  PAYMENT_METHOD,
  INSTALLMENT_TYPE,
  RETURN_CODES,
  returnCodeName,
  getVersionLib,
  initBTConnection,
  setVersionName,
  simplePaymentTransaction,
  cancelTransaction,
  getLastApprovedTransactionStatus,
  unloadDriverConnection,
}
