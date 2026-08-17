const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer')

function build(address, options = {}) {
  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `tcp://${address}`,
    characterSet: CharacterSet.PC858_EURO,
    removeSpecialCharacters: false,
    lineCharacter: '-',
    options: { timeout: options.tcpTimeoutMs || options.timeoutMs || 5000 },
  })

  return {
    async printRaw(buffer) {
      printer.clear()
      printer.add(buffer)
      await printer.execute()
    },
  }
}

module.exports = { build }
