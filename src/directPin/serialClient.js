const log = require('electron-log')
const { SerialPort } = require('serialport')
const { ACK, NAK, buildFrame, parseFrame, tryExtractFrame } = require('./frame')

const SERIAL_CLIENT_VERSION = 'directpin-serial-no-final-ack-2026-06-25-4'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function openPort(port) {
  return new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()))
  })
}

function closePort(port) {
  return new Promise((resolve) => {
    if (!port?.isOpen) return resolve()
    try {
      port.close(() => resolve())
    } catch (err) {
      log.warn('directPin: falha ao fechar porta serial', err)
      resolve()
    }
  })
}

function flushPort(port) {
  return new Promise((resolve) => {
    if (!port?.isOpen) return resolve()

    try {
      port.flush((err) => {
        if (err) log.warn('directPin: falha ao limpar buffer serial', err)
        resolve()
      })
    } catch (err) {
      log.warn('directPin: falha ao limpar buffer serial', err)
      resolve()
    }
  })
}

function writeAndDrain(port, data) {
  return new Promise((resolve, reject) => {
    try {
      if (!port?.isOpen) {
        const err = new Error('Porta serial DirectPin fechada antes do envio.')
        err.code = 'DIRECTPIN_PORT_CLOSED'
        reject(err)
        return
      }

      port.write(data, (writeErr) => {
        if (writeErr) return reject(writeErr)

        try {
          port.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()))
        } catch (drainErr) {
          reject(drainErr)
        }
      })
    } catch (writeErr) {
      reject(writeErr)
    }
  })
}

function shortHex(buffer) {
  return buffer.toString('hex').slice(0, 2000)
}

function tryParseLooseJson(buffer) {
  const candidates = [buffer]

  if (buffer[0] === ACK || buffer[0] === NAK || buffer[0] === 0x16) {
    candidates.push(buffer.subarray(1))
  }

  const etbIndex = buffer.indexOf(0x17)
  if (etbIndex > 0) {
    candidates.push(buffer.subarray(buffer[0] === 0x16 ? 1 : 0, etbIndex))
  }

  for (const candidate of candidates) {
    const text = candidate.toString('utf8').trim()
    if (!text) continue

    if (text.startsWith('{') && text.endsWith('}')) {
      return JSON.parse(text)
    }

    const compact = text.replace(/[^A-Za-z0-9+/=]/g, '')
    if (compact.length >= 8) {
      const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=')
      const decoded = Buffer.from(padded, 'base64').toString('utf8').trim()
      const start = decoded.indexOf('{')
      const end = decoded.lastIndexOf('}')
      if (start >= 0 && end > start) {
        return JSON.parse(decoded.slice(start, end + 1))
      }
    }
  }

  return null
}

class DirectPinSerialClient {
  constructor(config = {}, onStatus = null) {
    this.config = normalizeConfig(config)
    this.onStatus = typeof onStatus === 'function' ? onStatus : null
    this.activePort = null
  }

  // Envia um frame na MESMA porta serial já aberta por uma operação em
  // andamento (ex: abort durante uma transaction pendente). Reabrir a porta
  // nesse cenário falha no Windows com erro 170 (recurso ocupado) — o
  // terminal aceita um segundo frame na mesma conexão, então reaproveitamos
  // o handle aberto em vez de criar um SerialPort novo.
  async sendOnActivePort(payload) {
    if (!this.activePort?.isOpen) {
      const err = new Error('Nenhuma operação DirectPin em andamento nesta porta para abortar.')
      err.code = 'DIRECTPIN_NO_ACTIVE_PORT'
      throw err
    }

    const frame = buildFrame(payload)
    log.info('directPin: enviando frame na porta ativa', {
      operation: payload?.type ?? null,
      path: this.config.path,
      frameBytes: frame.length,
    })
    await writeAndDrain(this.activePort, frame)
    log.info('directPin: frame enviado na porta ativa')
  }

  emitStatus(phase, payload = {}) {
    this.onStatus?.({
      phase,
      path: this.config.path,
      at: new Date().toISOString(),
      ...payload,
    })
  }

  async testConnection() {
    const port = this.createPort()
    await openPort(port)
    await closePort(port)
    return { ok: true, path: this.config.path }
  }

  async send(payload) {
    const frame = buildFrame(payload)
    const retries = Math.max(0, Number(this.config.maxRetries ?? 3))
    const timeoutMs = Math.max(1000, Number(this.config.timeoutSeconds ?? 120) * 1000)
    log.info('directPin: enviando frame', {
      clientVersion: SERIAL_CLIENT_VERSION,
      operation: payload?.type ?? null,
      path: this.config.path,
      frameBytes: frame.length,
      timeoutMs,
      retries,
    })
    this.emitStatus('transaction_started', {
      operation: payload?.type ?? null,
      frameBytes: frame.length,
      timeoutMs,
    })

    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.sendOnce(frame, timeoutMs)
      } catch (err) {
        lastError = err
        if (err?.code === 'DIRECTPIN_NAK') break
        if (attempt >= retries) break
        await delay(Math.min(1000, 150 * (attempt + 1)))
      }
    }

    throw lastError || new Error('Falha ao comunicar com DirectPin.')
  }

  async sendOnce(frame, timeoutMs) {
    const port = this.createPort()
    let buffer = Buffer.alloc(0)
    let acked = false
    let settled = false
    let ackTimer = null

    return new Promise((resolve, reject) => {
      const finish = async (err, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(ackTimer)
        port.off('data', onData)
        port.off('error', onError)
        if (this.activePort === port) this.activePort = null
        await closePort(port)
        this.emitStatus(err ? 'finished_error' : 'finished_success', {
          error: err ? { code: err?.code ?? null, message: err?.message ?? String(err) } : null,
        })
        if (err) reject(err)
        else resolve(result)
      }

      const onError = (err) => {
        log.error('directPin: erro na porta serial', err)
        finish(err)
      }

      const onData = (chunk) => {
        log.info('directPin: bytes recebidos', {
          bytes: chunk.length,
          hex: shortHex(chunk),
        })
        this.emitStatus('bytes_received', {
          bytes: chunk.length,
        })

        for (const byte of chunk) {
          if (!acked && byte === ACK) {
            acked = true
            clearTimeout(ackTimer)
            log.info('directPin: ACK recebido')
            this.emitStatus('ack_received')
            continue
          }
          if (!acked && byte === NAK && buffer.length === 0) {
            const err = new Error('DirectPin retornou NAK.')
            err.code = 'DIRECTPIN_NAK'
            log.warn('directPin: NAK recebido')
            this.emitStatus('nak_received')
            finish(err)
            return
          }
          buffer = Buffer.concat([buffer, Buffer.from([byte])])
        }

        const extracted = tryExtractFrame(buffer)
        if (extracted.frame) {
          buffer = extracted.rest

          try {
            const response = parseFrame(extracted.frame)
            log.info('directPin: frame final parseado', {
              keys: response && typeof response === 'object' ? Object.keys(response) : [],
            })
            this.emitStatus('response_received', {
              format: 'frame',
              codeResult: response?.codeResult ?? response?.code_result ?? null,
              finalResult: response?.finalResult ?? response?.final_result ?? null,
            })
            finish(null, response)
            return
          } catch (err) {
            log.error('directPin: falha ao parsear frame final', err)
            finish(err)
            return
          }
        }

        try {
          const loose = tryParseLooseJson(buffer)
          if (loose) {
            log.warn('directPin: resposta sem frame reconhecida; finalizando sem ACK extra', {
              clientVersion: SERIAL_CLIENT_VERSION,
              codeResult: loose?.codeResult ?? loose?.code_result ?? null,
              finalResult: loose?.finalResult ?? loose?.final_result ?? null,
              fullPayload: JSON.stringify(loose),
            })
            this.emitStatus('response_received', {
              format: 'loose',
              codeResult: loose?.codeResult ?? loose?.code_result ?? null,
              finalResult: loose?.finalResult ?? loose?.final_result ?? null,
            })
            finish(null, loose)
            return
          }
        } catch (err) {
          log.warn('directPin: resposta parcial ainda não parseável', err?.message)
        }

        if (buffer.length > 8192) {
          log.warn('directPin: buffer serial excedeu limite, descartando prefixo', {
            bytes: buffer.length,
            hex: shortHex(buffer),
          })
          buffer = buffer.subarray(buffer.length - 4096)
        }
      }

      const timer = setTimeout(() => {
        try {
          const loose = tryParseLooseJson(buffer)
          if (loose) {
            log.warn('directPin: resposta sem ETB/CRC reconhecida no timeout; finalizando sem ACK extra', {
              clientVersion: SERIAL_CLIENT_VERSION,
              codeResult: loose?.codeResult ?? loose?.code_result ?? null,
              finalResult: loose?.finalResult ?? loose?.final_result ?? null,
            })
            this.emitStatus('response_received', {
              format: 'loose_timeout',
              codeResult: loose?.codeResult ?? loose?.code_result ?? null,
              finalResult: loose?.finalResult ?? loose?.final_result ?? null,
            })
            finish(null, loose)
            return
          }
        } catch (parseErr) {
          log.warn('directPin: falha ao parsear buffer no timeout', parseErr?.message)
        }

        const err = new Error('Tempo esgotado aguardando resposta do DirectPin.')
        err.code = 'DIRECTPIN_TIMEOUT'
        log.error('directPin: timeout aguardando resposta', {
          timeoutMs,
          acked,
          bufferedBytes: buffer.length,
          bufferHex: shortHex(buffer),
        })
        finish(err)
      }, timeoutMs)

      ackTimer = setTimeout(() => {
        if (acked || settled) return
        const err = new Error('DirectPin não respondeu ao envio do frame.')
        err.code = 'DIRECTPIN_ACK_TIMEOUT'
        log.error('directPin: timeout aguardando ACK/NAK inicial', {
          ackTimeoutMs: 6000,
          bufferedBytes: buffer.length,
          bufferHex: shortHex(buffer),
        })
        finish(err)
      }, 6000)

      port.on('data', onData)
      port.on('error', onError)
      this.emitStatus('opening_port')
      openPort(port)
        .then(() => {
          log.info('directPin: porta aberta', this.config.path)
          this.activePort = port
          this.emitStatus('port_opened')
          return flushPort(port)
        })
        .then(() => delay(120))
        .then(() => {
          return writeAndDrain(port, frame)
        })
        .then(() => {
          log.info('directPin: frame enviado')
          this.emitStatus('frame_sent')
        })
        .catch((err) => {
          log.error('directPin: falha ao abrir/enviar', err)
          finish(err)
        })
    })
  }

  createPort() {
    return new SerialPort({
      path: this.config.path,
      baudRate: this.config.baudRate,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autoOpen: false,
      rtscts: false,
      xon: false,
      xoff: false,
      xany: false,
    })
  }
}

function normalizeConfig(config = {}) {
  const path = String(config.path ?? config.serial_port ?? config.serialPort ?? '').trim()
  if (!path) throw new Error('Porta serial DirectPin não configurada.')

  return {
    path,
    baudRate: Number(config.baud_rate ?? config.baudRate ?? 115200) || 115200,
    timeoutSeconds: Number(config.timeout_seconds ?? config.timeoutSeconds ?? 120) || 120,
    maxRetries: Number(config.max_retries ?? config.maxRetries ?? 3) || 3,
  }
}

module.exports = {
  DirectPinSerialClient,
  normalizeConfig,
  SERIAL_CLIENT_VERSION,
}
