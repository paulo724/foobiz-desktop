// Impressão via spooler do SO usando node-thermal-printer (mesma técnica já
// usada e comprovada em src/printer.js, usado pelo PDV/Totem). Antes esta
// função usava koffi para chamar winspool.drv/kernel32.dll diretamente via
// FFI dentro de um worker_thread — essa combinação (FFI nativo + thread
// isolada) provocava crash nativo do processo Electron inteiro sem stack
// trace JS capturável, porque uma falha nesse nível não é uma exceção da VM
// do V8 que o worker.on('error') consiga interceptar.
const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer')

function build(printerName) {
  return {
    async printRaw(buffer) {
      const printer = new ThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: `printer:${printerName}`,
        characterSet: CharacterSet.PC858_EURO,
        removeSpecialCharacters: false,
        lineCharacter: '-',
        options: { timeout: 5000 },
      })

      printer.clear()
      printer.add(buffer)
      await printer.execute()
    },

    // Healthcheck: node-thermal-printer sabe checar se o spooler enxerga a
    // impressora sem enviar nenhum dado — usado para o status Online/Offline
    // refletir a impressora de verdade, não só a conexão do bridge com o
    // backend. Na interface de spooler (printer:), a lib faz `throw false`
    // em vez de resolver/rejeitar como erro, então precisa de try/catch em
    // vez de só `await`.
    async checkHealth() {
      const printer = new ThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: `printer:${printerName}`,
        characterSet: CharacterSet.PC858_EURO,
        removeSpecialCharacters: false,
        lineCharacter: '-',
        options: { timeout: 3000 },
      })
      try {
        return await printer.isPrinterConnected()
      } catch {
        return false
      }
    },
  }
}

module.exports = { build }
