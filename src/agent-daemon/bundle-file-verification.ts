import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import type {
  AgentArchitecture
} from '../shared/agent-installation-contracts'

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

export async function assertElfArchitecture(
  filePath: string,
  expected: AgentArchitecture,
  label: string
): Promise<void> {
  const handle = await open(filePath, 'r')
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await handle.read(
      header,
      0,
      header.length,
      0
    )
    const actual = detectElfArchitecture(
      header.subarray(0, bytesRead)
    )
    if (actual !== expected) {
      throw new Error(
        `${label} architecture mismatch: expected ${expected}, received ${actual ?? 'unknown'}`
      )
    }
  } finally {
    await handle.close()
  }
}

function detectElfArchitecture(
  header: Buffer
): AgentArchitecture | undefined {
  if (
    header.length < 20 ||
    header[0] !== 0x7f ||
    header.toString('ascii', 1, 4) !== 'ELF' ||
    (header[5] !== 1 && header[5] !== 2)
  ) {
    return undefined
  }
  const machine =
    header[5] === 2
      ? header.readUInt16BE(18)
      : header.readUInt16LE(18)
  return machine === 62
    ? 'x64'
    : machine === 183
      ? 'arm64'
      : undefined
}
