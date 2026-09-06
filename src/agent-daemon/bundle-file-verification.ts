import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { binaryTargetArchitecture } from '../shared/node/binary-target'
import type { AgentPlatform } from '../shared/agent-target'
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
  label: string,
  platform: AgentPlatform = 'linux'
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
    const actual = binaryTargetArchitecture(
      header.subarray(0, bytesRead), platform
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
