const POLYNOMIAL = 0x1021
const INITIAL_VALUE = 0xffff

function calculateCrc16Ccitt(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
  let crc = INITIAL_VALUE

  for (const byte of bytes) {
    crc ^= (byte << 8) & 0xffff
    for (let i = 0; i < 8; i += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ POLYNOMIAL) & 0xffff
      } else {
        crc = (crc << 1) & 0xffff
      }
    }
  }

  return crc & 0xffff
}

module.exports = {
  calculateCrc16Ccitt,
}
