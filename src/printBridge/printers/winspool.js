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

  fns = {
    OpenPrinterW: winspool.func('__stdcall', 'OpenPrinterW', 'bool', ['str16', koffi.out(voidPtrPtr), voidPtr]),
    ClosePrinter: winspool.func('__stdcall', 'ClosePrinter', 'bool', [voidPtr]),
    StartDocPrinterW: winspool.func('__stdcall', 'StartDocPrinterW', 'uint32', [voidPtr, 'uint32', koffi.pointer(DOC_INFO_1W)]),
    EndDocPrinter: winspool.func('__stdcall', 'EndDocPrinter', 'bool', [voidPtr]),
    StartPagePrinter: winspool.func('__stdcall', 'StartPagePrinter', 'bool', [voidPtr]),
    EndPagePrinter: winspool.func('__stdcall', 'EndPagePrinter', 'bool', [voidPtr]),
    WritePrinter: winspool.func('__stdcall', 'WritePrinter', 'bool', [voidPtr, voidPtr, 'uint32', koffi.out(uint32Ptr)]),
    DOC_INFO_1W,
  }

  return fns
}

// Escreve o buffer RAW (ESC/POS já formatado) direto no spooler da impressora
// pelo nome exato reportado pelo Windows (o mesmo de getPrintersAsync()).
function printRaw(printerName, buffer) {
  const { OpenPrinterW, ClosePrinter, StartDocPrinterW, EndDocPrinter, StartPagePrinter, EndPagePrinter, WritePrinter, DOC_INFO_1W } = ensureLoaded()

  if (!printerName) {
    throw new Error('winspool: nome da impressora ausente.')
  }

  const handleOut = [null]
  if (!OpenPrinterW(printerName, handleOut, null)) {
    throw new Error(`winspool: não foi possível abrir a impressora "${printerName}" (removida, offline ou nome divergente).`)
  }
  const handle = handleOut[0]

  try {
    const docInfo = {
      pDocName: 'Foobiz Print Bridge',
      pOutputFile: null,
      pDatatype: 'RAW',
    }
    const jobId = StartDocPrinterW(handle, 1, docInfo)
    if (!jobId) {
      throw new Error(`winspool: StartDocPrinterW falhou para "${printerName}" (spooler ocupado ou inacessível).`)
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
  } finally {
    ClosePrinter(handle)
  }
}

// Healthcheck: abre e fecha o handle da impressora, sem enviar nenhum dado —
// confirma que o spooler conhece essa impressora e ela responde ao handle,
// sem imprimir nada a cada verificação.
function checkHealth(printerName) {
  const { OpenPrinterW, ClosePrinter } = ensureLoaded()
  if (!printerName) return false

  const handleOut = [null]
  if (!OpenPrinterW(printerName, handleOut, null)) return false
  ClosePrinter(handleOut[0])
  return true
}

module.exports = { printRaw, checkHealth }
