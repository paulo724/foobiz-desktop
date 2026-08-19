const { SerialPort } = require('serialport')

// Impressão via porta serial virtual (COM), sem passar pelo spooler do
// Windows. Cobre impressoras térmicas que expõem um chip USB-Serial
// (CDC/CH340/FTDI/PL2303) e aparecem como "COMx" no Gerenciador de
// Dispositivos > Portas (COM e LPT), em vez de USB Printing Class.

function openPort(path, baudRate, rtscts) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate, rtscts, autoOpen: false })
    port.open((err) => (err ? reject(err) : resolve(port)))
  })
}

function closePort(port) {
  return new Promise((resolve) => {
    if (!port?.isOpen) return resolve()
    port.close(() => resolve())
  })
}

function writeAndDrain(port, buffer) {
  return new Promise((resolve, reject) => {
    port.write(buffer, (writeErr) => {
      if (writeErr) return reject(writeErr)
      port.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()))
    })
  })
}

function build(path, options = {}) {
  // Impressoras térmicas com "Virtual COM" (ex: Bematech MP-4200 TH) tipicamente
  // operam a 115200 8N1 com controle de fluxo por hardware (RTS/CTS) — usar um
  // baud rate ou rtscts diferente do configurado no Windows (Painel de
  // Dispositivos > Propriedades da porta) causa timeouts/lentidão na escrita.
  const baudRate = options.baudRate || 115200
  const rtscts = options.rtscts !== false

  return {
    async printRaw(buffer) {
      if (!path) {
        throw new Error('serial requer a porta COM configurada no dispositivo.')
      }

      const port = await openPort(path, baudRate, rtscts)
      try {
        await writeAndDrain(port, buffer)
      } finally {
        await closePort(port)
      }
    },
  }
}

module.exports = { build }
