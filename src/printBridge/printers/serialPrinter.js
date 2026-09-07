const fs = require('fs')

// Impressão via porta serial virtual (COM), sem passar pelo spooler do
// Windows. Cobre impressoras térmicas que expõem um chip USB-Serial
// (CDC/CH340/FTDI/PL2303) e aparecem como "COMx" no Gerenciador de
// Dispositivos > Portas (COM e LPT), em vez de USB Printing Class.
//
// Escreve direto no arquivo de dispositivo da porta (\\.\COM7) usando fs do
// Node — sem nenhum binding nativo (C++/N-API) de terceiros. Antes usava o
// pacote `serialport`, mas port.write() causava um crash nativo do processo
// inteiro (confirmado via logging granular: o callback de write() nunca
// disparava, mesmo com o buffer chegando fisicamente na impressora) — um bug
// no binding `@serialport/bindings-cpp` nesta combinação específica de
// driver Windows/Electron, não relacionado a parâmetros como rtscts/baudRate.
// fs.open/write/close usam apenas a API de arquivo do SO (CreateFile/
// WriteFile por baixo, via libuv), o mesmo caminho que qualquer programa
// Node usa para qualquer arquivo — sem código nativo de terceiros.

function devicePath(name) {
  // COM10 e acima exigem o prefixo \\.\ para o Win32 CreateFile funcionar;
  // COM1-9 aceitam com ou sem prefixo, então sempre normalizamos.
  const trimmed = String(name || '').trim()
  if (trimmed.startsWith('\\\\.\\')) return trimmed
  return `\\\\.\\${trimmed}`
}

function build(path, options = {}) {
  void options // baudRate/rtscts não se aplicam aqui — a porta já está
  // configurada (baud rate, paridade, bits) pelo driver/Painel de
  // Dispositivos do Windows; escrever no arquivo de dispositivo usa essa
  // configuração já ativa, sem reconfigurar a porta a cada job.

  return {
    async printRaw(buffer) {
      if (!path) {
        throw new Error('serial requer a porta COM configurada no dispositivo.')
      }

      const target = devicePath(path)
      const handle = await fs.promises.open(target, 'w')
      try {
        await handle.writeFile(buffer)
      } finally {
        await handle.close()
      }
    },

    // Healthcheck: só abre e fecha o handle da porta, sem escrever nada —
    // confirma que a porta COM existe e está livre (não em uso por outro
    // processo), sem imprimir uma página em branco a cada verificação.
    async checkHealth() {
      if (!path) return false
      const target = devicePath(path)
      const handle = await fs.promises.open(target, 'r+')
      await handle.close()
      return true
    },
  }
}

module.exports = { build }
