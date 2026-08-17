const { calculateCrc16Ccitt } = require('./crc')

const SYN = 0x16
const ETB = 0x17
const ACK = 0x06
const NAK = 0x15

function encodePayload(payload) {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return Buffer.from(json, 'utf8').toString('base64')
}

function buildFrame(payload) {
  const base64Payload = Buffer.from(encodePayload(payload), 'ascii')
  const crc = calculateCrc16Ccitt(base64Payload)
  return Buffer.concat([
    Buffer.from([SYN]),
    base64Payload,
    Buffer.from([ETB, (crc >> 8) & 0xff, crc & 0xff]),
  ])
}

function tryExtractFrame(buffer) {
  const start = buffer.indexOf(SYN)
  if (start < 0) return { frame: null, rest: Buffer.alloc(0) }

  const etb = buffer.indexOf(ETB, start + 1)
  if (etb < 0 || buffer.length < etb + 3) {
    return { frame: null, rest: start > 0 ? buffer.subarray(start) : buffer }
  }

  const frame = buffer.subarray(start, etb + 3)
  const rest = buffer.subarray(etb + 3)
  return { frame, rest }
}

function parseFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 5) {
    throw new Error('Frame DirectPin vazio ou curto demais.')
  }
  if (frame[0] !== SYN) {
    throw new Error('Frame DirectPin sem SYN.')
  }

  const etb = frame.indexOf(ETB, 1)
  if (etb < 0 || frame.length !== etb + 3) {
    throw new Error('Frame DirectPin malformado.')
  }

  const base64Payload = frame.subarray(1, etb)
  const expectedCrc = (frame[etb + 1] << 8) | frame[etb + 2]
  const actualCrc = calculateCrc16Ccitt(base64Payload)
  if (actualCrc !== expectedCrc) {
    throw new Error('CRC inválido na resposta DirectPin.')
  }

  const json = Buffer.from(base64Payload.toString('ascii'), 'base64').toString('utf8')
  return JSON.parse(json)
}

module.exports = {
  SYN,
  ETB,
  ACK,
  NAK,
  buildFrame,
  parseFrame,
  tryExtractFrame,
}
