function detectElfArchitecture(buffer) {
  if (
    buffer.length < 20 ||
    buffer[0] !== 0x7f ||
    buffer.toString('ascii', 1, 4) !== 'ELF' ||
    ![1, 2].includes(buffer[5])
  ) {
    return undefined
  }
  const machine =
    buffer[5] === 2
      ? buffer.readUInt16BE(18)
      : buffer.readUInt16LE(18)
  if (machine === 62) {
    return 'x64'
  }
  if (machine === 183) {
    return 'arm64'
  }
  return undefined
}

function detectBinaryArchitecture(buffer) {
  if (
    buffer.length >= 64 &&
    buffer[0] === 0x4d &&
    buffer[1] === 0x5a
  ) {
    const peOffset = buffer.readUInt32LE(0x3c)
    if (
      peOffset + 6 <= buffer.length &&
      buffer.toString('ascii', peOffset, peOffset + 4) === 'PE\0\0'
    ) {
      const machine = buffer.readUInt16LE(peOffset + 4)
      if (machine === 0x8664) {
        return 'x64'
      }
      if (machine === 0xaa64) {
        return 'arm64'
      }
    }
  }

  const elfArchitecture = detectElfArchitecture(buffer)
  if (elfArchitecture) {
    return elfArchitecture
  }

  if (buffer.length >= 8) {
    const littleMagic = buffer.readUInt32LE(0)
    const bigMagic = buffer.readUInt32BE(0)
    const cpuType =
      littleMagic === 0xfeedfacf
        ? buffer.readUInt32LE(4)
        : bigMagic === 0xfeedfacf
          ? buffer.readUInt32BE(4)
          : undefined
    if (cpuType === 0x01000007) {
      return 'x64'
    }
    if (cpuType === 0x0100000c) {
      return 'arm64'
    }
  }
  return undefined
}

module.exports = {
  detectBinaryArchitecture,
  detectElfArchitecture
}
