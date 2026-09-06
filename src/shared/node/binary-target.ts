import type { AgentArchitecture } from '../agent-installation-contracts'
import type { AgentPlatform } from '../agent-target'

export function binaryTargetArchitecture(
  bytes: Buffer,
  platform: AgentPlatform
): AgentArchitecture | undefined {
  if (platform === 'darwin') {
    if (bytes.length < 8) return undefined
    const cpu = bytes.readUInt32LE(0) === 0xfeedfacf
      ? bytes.readUInt32LE(4)
      : bytes.readUInt32BE(0) === 0xfeedfacf ? bytes.readUInt32BE(4) : undefined
    return cpu === 0x0100000c ? 'arm64' : undefined
  }
  if (
    bytes.length < 20 || bytes[0] !== 0x7f ||
    bytes.toString('ascii', 1, 4) !== 'ELF' ||
    ![1, 2].includes(bytes[5]!)
  ) return undefined
  const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18)
  return machine === 62 ? 'x64' : machine === 183 ? 'arm64' : undefined
}
