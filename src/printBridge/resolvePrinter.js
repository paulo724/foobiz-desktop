const serialPrinter = require('./printers/serialPrinter')
const tcpPrinter = require('./printers/tcpPrinter')

function resolvePrinter({ connectionType, address, serialPort, serialBaudRate, serialRtscts }) {
  const type = connectionType || 'usb'

  if (type === 'network') {
    return tcpPrinter.build(address, {})
  }

  if (type === 'serial') {
    return serialPrinter.build(serialPort, { baudRate: serialBaudRate, rtscts: serialRtscts })
  }

  throw new Error(`resolvePrinter: connectionType '${type}' não deveria chegar ao worker (USB é resolvido no main process).`)
}

module.exports = { resolvePrinter }
