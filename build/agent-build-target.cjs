const { readFileSync } = require('node:fs')
const {
  detectBinaryArchitecture,
  detectElfArchitecture
} = require('./binary-architecture.cjs')

function targetName(architecture, platform = 'linux') {
  if (
    !(platform === 'linux' && ['x64', 'arm64'].includes(architecture)) &&
    !(platform === 'darwin' && architecture === 'arm64')
  ) {
    throw new Error(`Unsupported Agent build target: ${platform}-${architecture}`)
  }
  return `${platform}-${architecture}`
}

function assertTargetBinary(filePath, architecture, platform, label) {
  targetName(architecture, platform)
  const header = readFileSync(filePath).subarray(0, 64)
  const isMachO = header.length >= 8 &&
    (header.readUInt32LE(0) === 0xfeedfacf ||
      header.readUInt32BE(0) === 0xfeedfacf)
  const actual = platform === 'linux'
    ? detectElfArchitecture(header)
    : isMachO ? detectBinaryArchitecture(header) : undefined
  if (actual !== architecture) {
    throw new Error(
      `${label} architecture mismatch: expected ${platform}-${architecture}, received ${actual ?? 'unknown'}`
    )
  }
}

module.exports = { targetName, assertTargetBinary }
