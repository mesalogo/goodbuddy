import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  remoteRuntimeLockSchema
} from '../src/shared/remote-runtime-launch-contracts'

describe('Remote Runtime lock', () => {
  it('pins the exact OpenCode Linux packages from package-lock.json', () => {
    const runtimeLock = remoteRuntimeLockSchema.parse(
      readJson('remote-runtime-lock.json')
    )
    const packageLock = readJson('package-lock.json') as {
      packages: Record<
        string,
        { version?: string; integrity?: string }
      >
    }
    const opencode = runtimeLock.runtimes.opencode

    expect(opencode.entrypoint).toBe('bin/opencode')
    expect(opencode.argvPrefix).toEqual(['acp'])
    for (const target of Object.values(opencode.targets)) {
      const lockedPackage =
        packageLock.packages[`node_modules/${target.package}`]
      expect(lockedPackage).toEqual(
        expect.objectContaining({
          version: opencode.version,
          integrity: target.integrity
        })
      )
    }
  })
})

function readJson(fileName: string): unknown {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), fileName), 'utf8')
  )
}
