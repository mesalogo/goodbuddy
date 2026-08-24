import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstallationRegistry } from './installation-registry'
import type { VerifiedInstalledAgentBundle } from './installed-bundle-verifier'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('Agent installation registry', () => {
  it('stages and atomically promotes an exact signed installation', () => {
    const { registry, storagePath } = createRegistry()
    const first = verified('install-a', '0.11.0', 'a')
    const second = verified('install-b', '0.11.1', 'b')

    registry.stageCandidate(first)
    expect(registry.snapshot()).toMatchObject({
      candidate: { installationId: 'install-a' }
    })
    registry.promoteCandidate('install-a')
    expect(registry.snapshot()).toMatchObject({
      current: { installationId: 'install-a' }
    })
    expect(registry.snapshot().candidate).toBeUndefined()

    registry.stageCandidate(second)
    registry.promoteCandidate('install-b')
    expect(registry.snapshot()).toEqual({
      formatVersion: 1,
      current: expect.objectContaining({
        installationId: 'install-b',
        agentVersion: '0.11.1'
      })
    })
    expect(
      new InstallationRegistry({ storagePath }).snapshot()
    ).toEqual(registry.snapshot())
  })

  it('reuses the exact current identity without staging it again', () => {
    const { registry } = createRegistry()
    const current = verified('install-a', '0.11.1', 'a')
    registry.stageCandidate(current)
    registry.promoteCandidate('install-a')

    expect(registry.stageCandidate(current)).toEqual(
      registry.snapshot().current
    )
    expect(registry.snapshot().candidate).toBeUndefined()
    expect(() =>
      registry.assertVerifiedRole(current, ['current'])
    ).not.toThrow()
  })

  it('replaces a stale candidate with the requested signed identity', () => {
    const { registry } = createRegistry()
    registry.stageCandidate(verified('install-a', '0.11.0', 'a'))
    registry.stageCandidate(verified('install-b', '0.11.1', 'b'))

    expect(registry.snapshot().candidate?.installationId).toBe(
      'install-b'
    )
  })

  it('preserves legacy bytes until the registry is mutated', () => {
    const root = privateTemporaryDirectory()
    const storagePath = resolve(root, 'registry.json')
    const current = {
      installationId: 'install-a',
      productVersion: '0.11.0',
      agentVersion: '0.11.0',
      releaseSequence: 4,
      manifestSha256: 'a'.repeat(64),
      binaryDigest: `sha256:${'a'.repeat(64)}`,
      arch: 'x64',
      protocol: { major: 1, minor: 0 },
      signingKeyId: 'test-key',
      previouslyVerified: true
    }
    const legacyBytes = `${JSON.stringify({
      formatVersion: 1,
      minimumTrustedReleaseSequence: 1,
      current,
      draining: []
    }, null, 2)}\n`
    writeFileSync(storagePath, legacyBytes, { mode: 0o600 })

    const registry = new InstallationRegistry({ storagePath })
    expect(registry.snapshot()).toEqual({
      formatVersion: 1,
      current: {
        installationId: 'install-a',
        agentVersion: '0.11.0',
        manifestSha256: 'a'.repeat(64),
        arch: 'x64'
      }
    })
    expect(readFileSync(storagePath, 'utf8')).toBe(legacyBytes)

    registry.stageCandidate(
      verified('install-b', '0.11.1', 'b')
    )
    expect(readFileSync(storagePath, 'utf8')).not.toContain(
      'releaseSequence'
    )
  })

  it('fails closed on corrupt and concurrent state', () => {
    const root = privateTemporaryDirectory()
    const storagePath = resolve(root, 'registry.json')
    writeFileSync(
      storagePath,
      '{"formatVersion":1,"unknown":true}',
      { mode: 0o600 }
    )
    expect(() => new InstallationRegistry({ storagePath })).toThrow(
      'corrupt'
    )
    writeFileSync(storagePath, '{}', { mode: 0o644 })
    expect(() => new InstallationRegistry({ storagePath })).toThrow(
      'corrupt'
    )

    rmSync(storagePath)
    const first = new InstallationRegistry({ storagePath })
    const concurrent = new InstallationRegistry({ storagePath })
    first.stageCandidate(verified('install-a', '0.11.0', 'a'))
    expect(() =>
      concurrent.stageCandidate(
        verified('install-b', '0.11.1', 'b')
      )
    ).toThrow('changed concurrently')
    expect(readFileSync(storagePath, 'utf8')).toContain('install-a')
  })
})

function createRegistry(): {
  registry: InstallationRegistry
  storagePath: string
} {
  const root = privateTemporaryDirectory()
  const storagePath = resolve(root, 'registry.json')
  return {
    registry: new InstallationRegistry({ storagePath }),
    storagePath
  }
}

function privateTemporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'goodbuddy-registry-'))
  temporaryPaths.push(path)
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
  return resolve(path)
}

function verified(
  installationId: string,
  agentVersion: string,
  digestCharacter: string
): VerifiedInstalledAgentBundle {
  const manifestSha256 = digestCharacter.repeat(64)
  return {
    installationId,
    installationDirectory: `/agent/${installationId}`,
    executablePath: `/agent/${installationId}/goodbuddy-agent`,
    manifestSha256,
    binaryDigest: `sha256:${manifestSha256}`,
    manifest: {
      formatVersion: 1,
      product: 'GoodBuddy',
      agentVersion,
      platform: 'linux',
      arch: 'x64',
      protocol: { major: 1, minor: 0 },
      signingKeyId: 'test-key',
      entrypoint: {
        path: 'goodbuddy-agent',
        runtimePath: 'node',
        scriptPath: 'lib/agent.cjs'
      },
      files: [
        {
          path: 'goodbuddy-agent',
          size: 1,
          sha256: 'a'.repeat(64),
          mode: '0755'
        },
        {
          path: 'node',
          size: 1,
          sha256: 'b'.repeat(64),
          mode: '0755'
        },
        {
          path: 'lib/agent.cjs',
          size: 1,
          sha256: 'c'.repeat(64),
          mode: '0644'
        },
        {
          path: 'licenses/license.txt',
          size: 1,
          sha256: 'd'.repeat(64),
          mode: '0644'
        }
      ],
      licenses: [
        {
          package: 'GoodBuddy',
          version: agentVersion,
          spdx: '0BSD',
          path: 'licenses/license.txt'
        }
      ]
    }
  }
}
