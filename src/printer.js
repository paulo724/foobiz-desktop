const { app } = require('electron')
const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer')
const log = require('electron-log')

function setupPrinterHandlers(ipcMain) {

  // Lista impressoras disponíveis no SO
  ipcMain.handle('printer:list', async () => {
    try {
      const { webContents } = require('electron')
      const wc = webContents.getAllWebContents()[0]
      if (!wc) return []
      return await wc.getPrintersAsync()
    } catch (err) {
      log.error('printer:list erro:', err)
      return []
    }
  })

  // Imprime cupom de venda (PDV / Totem)
  ipcMain.handle('printer:receipt', async (_, data) => {
    const { printerName, order } = data
    try {
      const printer = createPrinter(printerName)

      printer.alignCenter()
      printer.bold(true)
      printer.println(order.storeName || 'Foobiz')
      printer.bold(false)
      printer.drawLine()

      printer.alignLeft()
      printer.println(`Pedido: #${order.number}`)
      printer.println(`Data: ${new Date().toLocaleString('pt-BR')}`)
      printer.drawLine()

      for (const item of order.items) {
        printer.leftRight(`${item.qty}x ${item.name}`, formatPrice(item.total))
        if (item.notes) printer.println(`  Obs: ${item.notes}`)
      }

      printer.drawLine()
      printer.bold(true)
      printer.leftRight('TOTAL', formatPrice(order.total))
      printer.bold(false)
      printer.println(`Pagamento: ${order.paymentMethod}`)
      printer.drawLine()

      printer.alignCenter()
      printer.println('Obrigado pela preferência!')
      printer.cut()

      await printer.execute()
      return { success: true }
    } catch (err) {
      log.error('printer:receipt erro:', err)
      return { success: false, error: err.message }
    }
  })

  // Imprime ticket de produção (KDS)
  ipcMain.handle('printer:kds-ticket', async (_, data) => {
    const { printerName, ticket } = data
    try {
      const printer = createPrinter(printerName)

      printer.alignCenter()
      printer.bold(true)
      printer.setTextSize(1, 1)
      printer.println(`PEDIDO #${ticket.number}`)
      printer.setTextNormal()
      printer.bold(false)
      printer.drawLine()

      printer.alignLeft()
      for (const item of ticket.items) {
        printer.bold(true)
        printer.println(`${item.qty}x ${item.name}`)
        printer.bold(false)
        if (item.notes) printer.println(`  -> ${item.notes}`)
      }

      printer.drawLine()
      printer.alignCenter()
      printer.println(new Date().toLocaleTimeString('pt-BR'))
      printer.cut()

      await printer.execute()
      return { success: true }
    } catch (err) {
      log.error('printer:kds-ticket erro:', err)
      return { success: false, error: err.message }
    }
  })

  // Imprime página de teste
  ipcMain.handle('printer:test', async (_, printerName) => {
    try {
      const printer = createPrinter(printerName)
      printer.alignCenter()
      printer.bold(true)
      printer.println('=== TESTE DE IMPRESSÃO ===')
      printer.bold(false)
      printer.println('Foobiz Desktop')
      printer.println(new Date().toLocaleString('pt-BR'))
      printer.println('Impressora funcionando corretamente!')
      printer.cut()
      await printer.execute()
      return { success: true }
    } catch (err) {
      log.error('printer:test erro:', err)
      return { success: false, error: err.message }
    }
  })

  // Handlers de controle da janela
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:type', () => process.env.FOOBIZ_APP || 'pdv')
  ipcMain.handle('app:minimize', () => {
    const { BrowserWindow } = require('electron')
    BrowserWindow.getFocusedWindow()?.minimize()
  })
  ipcMain.handle('app:close', () => {
    const { BrowserWindow } = require('electron')
    BrowserWindow.getFocusedWindow()?.close()
  })
}

function createPrinter(printerName) {
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `printer:${printerName}`,
    characterSet: CharacterSet.PC858_EURO,
    removeSpecialCharacters: false,
    lineCharacter: '-',
    options: { timeout: 5000 },
  })
}

function formatPrice(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value / 100)
}

module.exports = { setupPrinterHandlers }
