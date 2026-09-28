// Impressão RAW via winspool.drv (Win32 Print Spooler API) usando koffi FFI —
// mesma técnica já validada em src/plugPag/nativeClient.js. Roda SOMENTE no
// processo principal do Electron (nunca em worker_thread): FFI nativo dentro
// de uma thread isolada já causou crash nativo do processo inteiro sem stack
// trace JS capturável (ver histórico em src/printBridge/printers/usbPrinter.js),
// porque uma falha nesse nível não é uma exceção da VM do V8 interceptável.
//
// Usa a API clássica OpenPrinter/StartDocPrinter/WritePrinter/EndDocPrinter —
// o mesmo caminho que qualquer driver de impressora Windows usa para RAW
// datatype, sem depender de nenhum pacote npm com binding nativo de terceiros
// (que historicamente falha para compilar/rebuildar para a ABI do Electron
// neste projeto — ver tentativas de `printer`/`@thiagoelg/node-printer`).
const koffi = require('koffi')
const log = require('electron-log')
const { describePrinter, describeJob } = require('./spoolerStatus')

// dwPrinterDriverAttributes (DRIVER_INFO_8W): driver baseado no pipeline XPS
// (todo driver v4 e alguns v3 XPSDrv). Nesses drivers o datatype RAW NÃO vai
// direto para a porta — os bytes entram no filtro XPS, que não entende
// ESC/POS e renderiza um documento vazio: a impressora térmica alimenta uma
// "página" inteira do tamanho do formulário (ex.: rolo 80 x 297mm) em branco.
// Para esses drivers a Microsoft documenta o datatype XPS_PASS, que repassa
// os bytes para a porta sem passar pelo pipeline.
const PRINTER_DRIVER_XPS = 0x00000002

let winspool = null
let fns = null

function ensureLoaded() {
  if (fns) return fns

  winspool = koffi.load('winspool.drv')

  const DOC_INFO_1W = koffi.struct('DOC_INFO_1W', {
    pDocName: 'str16',
    pOutputFile: 'str16',
    pDatatype: 'str16',
  })

  const voidPtr = koffi.pointer('void')
  const voidPtrPtr = koffi.pointer(voidPtr)
  const uint32Ptr = koffi.pointer('uint32')

  const FILETIME = koffi.struct('FILETIME', { low: 'uint32', high: 'uint32' })
  const DRIVER_INFO_8W = koffi.struct('DRIVER_INFO_8W', {
    cVersion: 'uint32',
    pName: 'str16',
    pEnvironment: voidPtr,
    pDriverPath: voidPtr,
    pDataFile: voidPtr,
    pConfigFile: voidPtr,
    pHelpFile: voidPtr,
    pDependentFiles: voidPtr,
    pMonitorName: voidPtr,
    pDefaultDataType: 'str16',
    pszzPreviousNames: voidPtr,
    ftDriverDate: FILETIME,
    dwlDriverVersion: 'uint64',
    pszMfgName: voidPtr,
    pszOEMUrl: voidPtr,
    pszHardwareID: voidPtr,
    pszProvider: voidPtr,
    pszPrintProcessor: voidPtr,
    pszVendorSetup: voidPtr,
    pszzColorProfiles: voidPtr,
    pszInfPath: voidPtr,
    dwPrinterDriverAttributes: 'uint32',
    pszzCoreDriverDependencies: voidPtr,
    ftMinInboxDriverVerDate: FILETIME,
    dwlMinInboxDriverVerVersion: 'uint64',
  })

  const SYSTEMTIME = koffi.struct('SYSTEMTIME', {
    wYear: 'uint16', wMonth: 'uint16', wDayOfWeek: 'uint16', wDay: 'uint16',
    wHour: 'uint16', wMinute: 'uint16', wSecond: 'uint16', wMilliseconds: 'uint16',
  })
  const PRINTER_INFO_2W = koffi.struct('PRINTER_INFO_2W', {
    pServerName: voidPtr, pPrinterName: voidPtr, pShareName: voidPtr, pPortName: voidPtr,
    pDriverName: voidPtr, pComment: voidPtr, pLocation: voidPtr, pDevMode: voidPtr,
    pSepFile: voidPtr, pPrintProcessor: voidPtr, pDatatype: voidPtr, pParameters: voidPtr,
    pSecurityDescriptor: voidPtr,
    Attributes: 'uint32', Priority: 'uint32', DefaultPriority: 'uint32', StartTime: 'uint32',
    UntilTime: 'uint32', Status: 'uint32', cJobs: 'uint32', AveragePPM: 'uint32',
  })
  const JOB_INFO_1W = koffi.struct('JOB_INFO_1W', {
    JobId: 'uint32', pPrinterName: voidPtr, pMachineName: voidPtr, pUserName: voidPtr,
    pDocument: voidPtr, pDatatype: voidPtr, pStatus: voidPtr,
    Status: 'uint32', Priority: 'uint32', Position: 'uint32', TotalPages: 'uint32', PagesPrinted: 'uint32',
    Submitted: SYSTEMTIME,
  })

  fns = {
    OpenPrinterW: winspool.func('__stdcall', 'OpenPrinterW', 'bool', ['str16', koffi.out(voidPtrPtr), voidPtr]),
    ClosePrinter: winspool.func('__stdcall', 'ClosePrinter', 'bool', [voidPtr]),
    StartDocPrinterW: winspool.func('__stdcall', 'StartDocPrinterW', 'uint32', [voidPtr, 'uint32', koffi.pointer(DOC_INFO_1W)]),
    EndDocPrinter: winspool.func('__stdcall', 'EndDocPrinter', 'bool', [voidPtr]),
    StartPagePrinter: winspool.func('__stdcall', 'StartPagePrinter', 'bool', [voidPtr]),
    EndPagePrinter: winspool.func('__stdcall', 'EndPagePrinter', 'bool', [voidPtr]),
    WritePrinter: winspool.func('__stdcall', 'WritePrinter', 'bool', [voidPtr, voidPtr, 'uint32', koffi.out(uint32Ptr)]),
    GetPrinterDriverW: winspool.func('__stdcall', 'GetPrinterDriverW', 'bool', [voidPtr, 'str16', 'uint32', voidPtr, 'uint32', koffi.out(uint32Ptr)]),
    GetPrinterW: winspool.func('__stdcall', 'GetPrinterW', 'bool', [voidPtr, 'uint32', voidPtr, 'uint32', koffi.out(uint32Ptr)]),
    GetJobW: winspool.func('__stdcall', 'GetJobW', 'bool', [voidPtr, 'uint32', 'uint32', voidPtr, 'uint32', koffi.out(uint32Ptr)]),
    DOC_INFO_1W,
    DRIVER_INFO_8W,
    PRINTER_INFO_2W,
    JOB_INFO_1W,
  }

  return fns
}

// Lê versão/atributos do driver da impressora já aberta. Retorna null se a
// consulta falhar — o chamador cai no datatype RAW padrão.
function getDriverInfo(handle) {
  const { GetPrinterDriverW, DRIVER_INFO_8W } = ensureLoaded()

  const neededOut = [0]
  GetPrinterDriverW(handle, null, 8, null, 0, neededOut)
  if (!neededOut[0]) return null

  const buf = Buffer.alloc(neededOut[0])
  if (!GetPrinterDriverW(handle, null, 8, buf, buf.length, neededOut)) return null

  const info = koffi.decode(buf, DRIVER_INFO_8W)
  return {
    name: info.pName,
    version: info.cVersion,
    defaultDataType: info.pDefaultDataType,
    isXps: (info.dwPrinterDriverAttributes & PRINTER_DRIVER_XPS) !== 0,
  }
}

// Escreve o buffer RAW (ESC/POS já formatado) direto no spooler da impressora
// pelo nome exato reportado pelo Windows (o mesmo de getPrintersAsync()).
function printRaw(printerName, buffer) {
  const { OpenPrinterW, ClosePrinter, StartDocPrinterW, EndDocPrinter, StartPagePrinter, EndPagePrinter, WritePrinter } = ensureLoaded()

  if (!printerName) {
    throw new Error('winspool: nome da impressora ausente.')
  }

  const handleOut = [null]
  if (!OpenPrinterW(printerName, handleOut, null)) {
    throw notSubmitted(`winspool: não foi possível abrir a impressora "${printerName}" (removida, offline ou nome divergente).`)
  }
  const handle = handleOut[0]

  try {
    let driver = null
    try {
      driver = getDriverInfo(handle)
    } catch (err) {
      log.warn(`winspool: não foi possível ler o driver de "${printerName}":`, err)
    }
    const datatype = driver?.isXps ? 'XPS_PASS' : 'RAW'
    log.info(`winspool: "${printerName}" driver=${JSON.stringify(driver)} datatype=${datatype}`)

    let jobId = StartDocPrinterW(handle, 1, { pDocName: 'Foobiz Print Bridge', pOutputFile: null, pDatatype: datatype })
    if (!jobId && datatype !== 'RAW') {
      log.warn(`winspool: ${datatype} recusado por "${printerName}", tentando RAW.`)
      jobId = StartDocPrinterW(handle, 1, { pDocName: 'Foobiz Print Bridge', pOutputFile: null, pDatatype: 'RAW' })
    }
    if (!jobId) {
      throw notSubmitted(`winspool: StartDocPrinterW falhou para "${printerName}" (spooler ocupado ou inacessível).`)
    }

    try {
      if (!StartPagePrinter(handle)) {
        throw new Error(`winspool: StartPagePrinter falhou para "${printerName}".`)
      }

      try {
        const writtenOut = [0]
        const ok = WritePrinter(handle, buffer, buffer.length, writtenOut)
        if (!ok) {
          throw new Error(`winspool: WritePrinter falhou para "${printerName}".`)
        }
        if (writtenOut[0] !== buffer.length) {
          throw new Error(`winspool: WritePrinter escreveu ${writtenOut[0]}/${buffer.length} bytes para "${printerName}".`)
        }
      } finally {
        EndPagePrinter(handle)
      }
    } finally {
      EndDocPrinter(handle)
    }
    return jobId
  } finally {
    ClosePrinter(handle)
  }
}

// Falha antes de qualquer byte entrar no spooler: repetir é seguro.
function notSubmitted(message) {
  const err = new Error(message)
  err.notSubmitted = true
  return err
}

function withPrinter(printerName, fn) {
  const { OpenPrinterW, ClosePrinter } = ensureLoaded()
  const handleOut = [null]
  if (!OpenPrinterW(printerName, handleOut, null)) return null
  try {
    return fn(handleOut[0])
  } finally {
    ClosePrinter(handleOut[0])
  }
}

function readStruct(call, type) {
  const neededOut = [0]
  call(null, 0, neededOut)
  if (!neededOut[0]) return null
  const buf = Buffer.alloc(neededOut[0])
  if (!call(buf, buf.length, neededOut)) return null
  return koffi.decode(buf, type)
}

// Estado da impressora segundo o spooler. Numa impressora de rede instalada no
// Windows, "offline" só é detectado se a porta TCP/IP tiver status SNMP ativo.
function getStatus(printerName) {
  if (!printerName) return { online: false, reason: 'Nome da impressora ausente', jobs: 0 }
  const { GetPrinterW, PRINTER_INFO_2W } = ensureLoaded()
  const result = withPrinter(printerName, (handle) => {
    const info = readStruct((buf, size, out) => GetPrinterW(handle, 2, buf, size, out), PRINTER_INFO_2W)
    if (!info) return { online: true, reason: null, jobs: 0 }
    return describePrinter({ status: info.Status, attributes: info.Attributes, jobs: info.cJobs })
  })
  return result || { online: false, reason: `Impressora "${printerName}" não encontrada no Windows`, jobs: 0 }
}

// Situação de um trabalho já entregue ao spooler.
function getJob(printerName, jobId) {
  const { GetJobW, JOB_INFO_1W } = ensureLoaded()
  const result = withPrinter(printerName, (handle) => {
    const info = readStruct((buf, size, out) => GetJobW(handle, jobId, 1, buf, size, out), JOB_INFO_1W)
    return describeJob(info ? { status: info.Status } : null)
  })
  return result || { state: 'error', reason: `Impressora "${printerName}" não encontrada no Windows` }
}

// Healthcheck: consulta o estado da impressora no spooler, sem enviar dados.
function checkHealth(printerName) {
  return getStatus(printerName).online
}

module.exports = { printRaw, checkHealth, getStatus, getJob }
