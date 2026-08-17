const os = require('os')
const net = require('net')
const { Bonjour } = require('bonjour-service')
const log = require('electron-log')

const PRINTER_PORT = 9100
const SCAN_TIMEOUT_MS = 300
const SCAN_CONCURRENCY = 40
const MDNS_TIMEOUT_MS = 3000

async function discoverUsb() {
  try {
    const { webContents } = require('electron')
    const wc = webContents.getAllWebContents()[0]
    if (!wc) return []
    const printers = await wc.getPrintersAsync()
    return printers.map((p) => ({
      type: 'usb',
      name: p.name,
      address: null,
      raw: p,
    }))
  } catch (err) {
    log.error('printBridge discovery: erro ao listar impressoras USB', err)
    return []
  }
}

function discoverMdns() {
  return new Promise((resolve) => {
    const found = []
    let bonjour
    try {
      bonjour = new Bonjour()
    } catch (err) {
      log.error('printBridge discovery: erro ao iniciar mDNS', err)
      return resolve([])
    }

    const onService = (service) => {
      const address = (service.addresses || []).find((a) => a.includes('.'))
      if (!address) return
      found.push({
        type: 'network',
        name: service.name || address,
        address: `${address}:${service.port || PRINTER_PORT}`,
        raw: service,
      })
    }

    const browserPdl = bonjour.find({ type: 'pdl-datastream' }, onService)
    const browserPrinter = bonjour.find({ type: 'printer' }, onService)

    setTimeout(() => {
      try {
        browserPdl.stop()
        browserPrinter.stop()
        bonjour.destroy()
      } catch {
        // ignore
      }
      resolve(found)
    }, MDNS_TIMEOUT_MS)
  })
}

function testTcpPort(host, port, timeout) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout })
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function localSubnetHosts() {
  const interfaces = os.networkInterfaces()
  const hosts = []

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const parts = entry.address.split('.')
      if (parts.length !== 4) continue
      const prefix = parts.slice(0, 3).join('.')
      for (let i = 1; i <= 254; i++) {
        hosts.push(`${prefix}.${i}`)
      }
      break
    }
  }

  return [...new Set(hosts)]
}

async function discoverNetworkScan(alreadyFound = []) {
  const known = new Set(alreadyFound.map((f) => f.address?.split(':')[0]))
  const hosts = localSubnetHosts().filter((h) => !known.has(h))
  const found = []

  for (let i = 0; i < hosts.length; i += SCAN_CONCURRENCY) {
    const batch = hosts.slice(i, i + SCAN_CONCURRENCY)
    const results = await Promise.all(
      batch.map((host) => testTcpPort(host, PRINTER_PORT, SCAN_TIMEOUT_MS))
    )
    results.forEach((ok, idx) => {
      if (ok) {
        const host = batch[idx]
        found.push({
          type: 'network',
          name: host,
          address: `${host}:${PRINTER_PORT}`,
          raw: { host, port: PRINTER_PORT },
        })
      }
    })
  }

  return found
}

async function discover() {
  const [usb, mdns] = await Promise.all([discoverUsb(), discoverMdns()])
  const scan = await discoverNetworkScan(mdns)
  return [...usb, ...mdns, ...scan]
}

module.exports = { discover, discoverUsb, discoverMdns, discoverNetworkScan }
