import { describe, expect, it, vi } from 'vitest'
import type { StagedSftp } from './bounded-sftp'
import type {
  SshConnectionLease,
  SshConnectionPoolTarget
} from './ssh-connection-pool'
import {
  SshHostRemoteEnvironmentInspector
} from './ssh-host-remote-environment'

const hostId = '00000000-0000-4000-8000-000000000401'
const digest = `sha256:${'a'.repeat(64)}`

function target(): SshConnectionPoolTarget {
  return {
    host: {
      id: hostId,
      name: 'Build host',
      hostname: 'build.example.com',
      port: 22,
      username: 'builder',
      authentication: 'system-agent',
      hostKey: {
        algorithm: 'ssh-ed25519',
        publicKeyBase64: 'AAAA',
        fingerprintSha256: `SHA256:${'A'.repeat(43)}`,
        generation: 2
      }
    },
    hostRevision: 3,
    hostKeyGeneration: 2
  }
}

function agentEntry(version = '0.11.1', digestCharacter = 'a') {
  const manifestSha256 = digestCharacter.repeat(64)
  return {
    installationId: `agent-${manifestSha256}`,
    agentVersion: version,
    manifestSha256,
    arch: 'x64' as const
  }
}

function runtimeEntry(version = '1.18.9') {
  return {
    runtimeId: 'opencode',
    runtimeVersion: version,
    architecture: 'x64' as const,
    bundleDigest: digest,
    manifestDigest: digest,
    acpCapabilitiesDigest: digest
  }
}

function missing(): Error & { code: number } {
  return Object.assign(new Error('missing'), { code: 2 })
}

function harness(registries: {
  agent?: unknown
  runtime?: unknown
} = {}) {
  const release = vi.fn()
  const close = vi.fn()
  const readFile = vi.fn(async (path: string) => {
    const value =
      path === '.goodbuddy/agent/registry.json'
        ? registries.agent
        : path === '.goodbuddy/runtimes/registry.json'
          ? registries.runtime
          : undefined
    if (value === undefined) {
      throw missing()
    }
    return Buffer.from(JSON.stringify(value))
  })
  const sftp = { readFile, close } as unknown as StagedSftp
  const currentTarget = target()
  const lease = {
    identity: {
      hostId,
      hostRevision: 3,
      hostKeyGeneration: 2,
      authenticationIdentity: 'b'.repeat(64)
    },
    runAgentBootstrapProbe: vi.fn(async () => ({
      ready: true as const,
      platform: 'linux' as const,
      architecture: 'x64' as const,
      canonicalHomeDirectory: '/home/builder',
      uid: 1_000,
      shell: '/bin/bash',
      procfs: 'ready' as const
    })),
    openStagedSftp: vi.fn(async () => sftp),
    release
  } as unknown as SshConnectionLease
  const assertConnectionTargetCurrent = vi.fn()
  const inspector = new SshHostRemoteEnvironmentInspector({
    sshHosts: {
      resolveConnectionTarget: vi.fn(async () => currentTarget),
      assertConnectionTargetCurrent
    },
    sshPool: {
      acquire: vi.fn(async () => lease)
    },
    agentRuntimeLockPath: 'unused',
    remoteRuntimeLockPath: 'unused',
    loadExpectedCatalog: async () => ({
      agent: { version: '0.11.1' },
      runtimes: [{
        runtimeId: 'opencode',
        provider: 'opencode',
        version: '1.18.9'
      }]
    }),
    now: () => new Date('2030-01-01T00:00:00.000Z')
  })
  return {
    inspector,
    lease,
    close,
    release,
    assertConnectionTargetCurrent
  }
}

describe('SshHostRemoteEnvironmentInspector', () => {
  it('reports installed Agent and Runtime versions against the desktop catalog', async () => {
    const value = harness({
      agent: {
        formatVersion: 1,
        minimumTrustedReleaseSequence: 1,
        current: {
          ...agentEntry(),
          productVersion: '0.11.0',
          releaseSequence: 4,
          binaryDigest: `sha256:${'a'.repeat(64)}`,
          protocol: { major: 1, minor: 0 },
          signingKeyId: 'test-key',
          previouslyVerified: true
        },
        draining: []
      },
      runtime: {
        formatVersion: 1,
        minimumTrustedReleaseSequence: 1,
        current: [{
          ...runtimeEntry(),
          provider: 'opencode',
          releaseSequence: 3,
          signingKeyId: 'test-key'
        }]
      }
    })

    await expect(value.inspector.inspect(hostId)).resolves.toEqual({
      hostId,
      checkedAt: '2030-01-01T00:00:00.000Z',
      architecture: 'x64',
      agent: {
        state: 'current',
        expected: {
          version: '0.11.1',
          architecture: 'x64'
        },
        installed: {
          version: '0.11.1',
          architecture: 'x64'
        }
      },
      runtimes: [{
        runtimeId: 'opencode',
        provider: 'opencode',
        state: 'current',
        expected: {
          version: '1.18.9',
          architecture: 'x64'
        },
        installed: {
          version: '1.18.9',
          architecture: 'x64'
        }
      }]
    })
    expect(value.close).toHaveBeenCalledOnce()
    expect(value.release).toHaveBeenCalledOnce()
    expect(value.assertConnectionTargetCurrent).toHaveBeenCalledTimes(2)
  })

  it('reports an older Agent and a missing Runtime without installing either', async () => {
    const value = harness({
      agent: {
        formatVersion: 1,
        current: agentEntry('0.11.0', 'b')
      }
    })

    await expect(value.inspector.inspect(hostId)).resolves.toMatchObject({
      agent: {
        state: 'update-available',
        installed: { version: '0.11.0' }
      },
      runtimes: [{
        runtimeId: 'opencode',
        state: 'not-installed',
        installed: null
      }]
    })
    expect(value.lease.runAgentBootstrapProbe).toHaveBeenCalledOnce()
    expect(value.lease.openStagedSftp).toHaveBeenCalledOnce()
  })

  it('rejects corrupt remote metadata and still closes every lease', async () => {
    const value = harness({
      agent: {
        formatVersion: 1,
        current: { command: 'untrusted' }
      }
    })

    await expect(value.inspector.inspect(hostId)).rejects.toThrow(
      '元数据已损坏'
    )
    expect(value.close).toHaveBeenCalledOnce()
    expect(value.release).toHaveBeenCalledOnce()
  })
})
