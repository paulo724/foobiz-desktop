const koffi = require('koffi')

let winspool = null
let OpenPrinterA = null
let ClosePrinter = null
let StartDocPrinterA = null
let EndDocPrinter = null
let StartPagePrinter = null
let EndPagePrinter = null
let WritePrinter = null
let GetLastError = null

function loadWinspool() {
  if (winspool) return

  winspool = koffi.load('winspool.drv')
  const kernel32 = koffi.load('kernel32.dll')

  koffi.struct('DOCINFOA', {
    pDocName: 'str',
    pOutputFile: 'str',
    pDataType: 'str',
  })

  OpenPrinterA = winspool.func('bool __stdcall OpenPrinterA(str pPrinterName, _Out_ void **phPrinter, void *pDefault)')
  ClosePrinter = winspool.func('bool __stdcall ClosePrinter(void *hPrinter)')
  StartDocPrinterA = winspool.func('int __stdcall StartDocPrinterA(void *hPrinter, uint32_t level, const DOCINFOA *pDocInfo)')
  EndDocPrinter = winspool.func('bool __stdcall EndDocPrinter(void *hPrinter)')
  StartPagePrinter = winspool.func('bool __stdcall StartPagePrinter(void *hPrinter)')
  EndPagePrinter = winspool.func('bool __stdcall EndPagePrinter(void *hPrinter)')
  WritePrinter = winspool.func('bool __stdcall WritePrinter(void *hPrinter, void *pBuf, uint32_t cbBuf, _Out_ uint32_t *pcWritten)')
  GetLastError = kernel32.func('uint32_t __stdcall GetLastError()')
}

function win32Error() {
  try {
    return GetLastError()
  } catch {
    return 'desconhecido'
  }
}

function sendRawBytesToPrinter(printerName, buffer) {
  loadWinspool()

  const hPrinterOut = [null]
  if (!OpenPrinterA(printerName, hPrinterOut, null)) {
    throw new Error(`OpenPrinter falhou para "${printerName}" (Win32Error=${win32Error()})`)
  }
  const hPrinter = hPrinterOut[0]

  try {
    const jobId = StartDocPrinterA(hPrinter, 1, {
      pDocName: 'ESC/POS Job',
      pOutputFile: null,
      pDataType: 'RAW',
    })
    if (jobId <= 0) {
      throw new Error(`StartDocPrinter falhou (Win32Error=${win32Error()})`)
    }

    try {
      if (!StartPagePrinter(hPrinter)) {
        throw new Error(`StartPagePrinter falhou (Win32Error=${win32Error()})`)
      }

      try {
        const writtenOut = [0]
        const ok = WritePrinter(hPrinter, buffer, buffer.length, writtenOut)
        const written = writtenOut[0]
        if (!ok || written !== buffer.length) {
          throw new Error(`WritePrinter falhou: escreveu ${written}/${buffer.length} bytes (Win32Error=${win32Error()})`)
        }
      } finally {
        EndPagePrinter(hPrinter)
      }
    } finally {
      EndDocPrinter(hPrinter)
    }
  } finally {
    ClosePrinter(hPrinter)
  }
}

function build(printerName) {
  return {
    async printRaw(buffer) {
      if (process.platform !== 'win32') {
        throw new Error('Impressão USB/spooler só é suportada no Windows.')
      }

      sendRawBytesToPrinter(printerName, buffer)
    },
  }
}

module.exports = { build }
