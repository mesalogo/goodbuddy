import { describe, expect, it, vi } from 'vitest'
import type { StagedSftp } from './bounded-sftp'
import type {
  SshConnectionLease,
  SshConnectionPoolTarget,
  SshRemotePackageBootstrapLease
} from './ssh-connection-pool'
import type {
  SshRemotePackageBootstrapProbeResult
} from './ssh-remote-package-bootstrap'
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

type HarnessOptions = {
  registries?: {
    agent?: unknown
    runtime?: unknown
  }
  candidate?: {
    source: 'github' | 'mirror'
    size: number
    sha256: string
    urls: readonly string[]
  } | null
  candidateError?: Error
  candidateFailure?: {
    reason: 'package-unavailable' | 'probe-failed'
    source: 'github' | 'mirror' | null
    packageSize: number | null
  }
  bootstrapResult?: SshRemotePackageBootstrapProbeResult
  bootstrapError?: Error
  bootstrapIdentity?: {
    hostId: string
    hostRevision: number
    hostKeyGeneration: number
    authenticationIdentity: string
  }
}

function harness(options: HarnessOptions = {}) {
  const registries = options.registries ?? {}
  const release = vi.fn()
  const bootstrapRelease = vi.fn()
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
  const probe = vi.fn(async () => {
    if (options.bootstrapError) {
      throw options.bootstrapError
    }
    return options.bootstrapResult ?? { available: true as const }
  })
  const prepare = vi.fn()
  const commit = vi.fn()
  const bootstrapLease = {
    identity: options.bootstrapIdentity ?? lease.identity,
    isUsable: vi.fn(() => true),
    probe,
    prepare,
    commit,
    cleanup: vi.fn(),
    release: bootstrapRelease
  } as unknown as SshRemotePackageBootstrapLease
  const assertConnectionTargetCurrent = vi.fn()
  const acquireRemotePackageBootstrap = vi.fn(
    async () => bootstrapLease
  )
  const loadRemoteEnvironmentCatalog = vi.fn(async () => {
    const candidate =
      options.candidateError
        ? null
        : options.candidate === undefined
          ? {
              source: 'mirror' as const,
              size: 12_345,
              sha256: 'a'.repeat(64),
              urls: [
                'https://goodbuddy.oss-cn-beijing.aliyuncs.com/agent.zip'
              ]
            }
          : options.candidate
    return {
      expected: {
        agent: { version: '0.11.1' },
        runtimes: [{
          runtimeId: 'opencode' as const,
          provider: 'opencode' as const,
          version: '1.18.9'
        }]
      },
      candidate,
      candidateFailure: options.candidateFailure
    }
  })
  const inspector = new SshHostRemoteEnvironmentInspector({
    sshHosts: {
      resolveConnectionTarget: vi.fn(async () => currentTarget),
      assertConnectionTargetCurrent
    },
    sshPool: {
      acquire: vi.fn(async () => lease),
      acquireRemotePackageBootstrap
    },
    agentRuntimeLockPath: 'unused',
    remoteRuntimeLockPath: 'unused',
    loadRemoteEnvironmentCatalog,
    now: () => new Date('2030-01-01T00:00:00.000Z')
  })
  return {
    inspector,
    lease,
    close,
    release,
    bootstrapRelease,
    probe,
    prepare,
    commit,
    acquireRemotePackageBootstrap,
    loadRemoteEnvironmentCatalog,
    assertConnectionTargetCurrent
  }
}

describe('SshHostRemoteEnvironmentInspector', () => {
  it('reports installed Agent and Runtime versions against the desktop catalog', async () => {
    const value = harness({ registries: {
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
    } })

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
      }],
      remoteDownload: {
        available: true,
        source: 'mirror',
        packageSize: 12_345
      }
    })
    expect(value.close).toHaveBeenCalledOnce()
    expect(value.release).toHaveBeenCalledOnce()
    expect(value.bootstrapRelease).toHaveBeenCalledOnce()
    expect(value.assertConnectionTargetCurrent).toHaveBeenCalledTimes(5)
  })

  it('reports an older Agent and a missing Runtime without installing either', async () => {
    const value = harness({ registries: {
      agent: {
        formatVersion: 1,
        current: agentEntry('0.11.0', 'b')
      }
    } })

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
    expect(value.prepare).not.toHaveBeenCalled()
    expect(value.commit).not.toHaveBeenCalled()
  })

  it('rejects corrupt remote metadata and still closes every lease', async () => {
    const value = harness({ registries: {
      agent: {
        formatVersion: 1,
        current: { command: 'untrusted' }
      }
    } })

    await expect(value.inspector.inspect(hostId)).rejects.toThrow(
      '元数据已损坏'
    )
    expect(value.close).toHaveBeenCalledOnce()
    expect(value.release).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing-curl', 'missing-tools'],
    ['missing-sha256sum', 'missing-tools'],
    ['missing-unzip', 'missing-tools'],
    ['bootstrap-tools-unavailable', 'missing-tools'],
    ['managed-path-unavailable', 'home-unwritable'],
    ['insufficient-disk-space', 'insufficient-disk-space'],
    ['download-unavailable', 'source-unreachable']
  ] as const)(
    'maps direct probe reason %s to %s',
    async (probeReason, reason) => {
      const value = harness({
        bootstrapResult: {
          available: false,
          reason: probeReason
        }
      })

      await expect(value.inspector.inspect(hostId)).resolves.toMatchObject({
        agent: { state: 'not-installed' },
        runtimes: [{ state: 'not-installed' }],
        remoteDownload: {
          available: false,
          source: 'mirror',
          packageSize: 12_345,
          reason
        }
      })
      expect(value.bootstrapRelease).toHaveBeenCalledOnce()
    }
  )

  it('sanitizes catalog failures without hiding version status', async () => {
    const value = harness({
      candidateError: new Error(
        'private catalog URL and credential details'
      )
    })

    await expect(value.inspector.inspect(hostId)).resolves.toMatchObject({
      agent: { state: 'not-installed' },
      runtimes: [{ state: 'not-installed' }],
      remoteDownload: {
        available: false,
        source: null,
        packageSize: null,
        reason: 'package-unavailable'
      }
    })
    expect(value.acquireRemotePackageBootstrap).not.toHaveBeenCalled()
  })

  it('probes and reports an available signed format-v1 candidate', async () => {
    const value = harness({
      candidate: {
        source: 'github',
        size: 99,
        sha256: 'b'.repeat(64),
        urls: ['https://github.com/example/package.zip']
      }
    })

    await expect(value.inspector.inspect(hostId)).resolves.toMatchObject({
      remoteDownload: {
        available: true,
        source: 'github',
        packageSize: 99
      }
    })
    expect(value.acquireRemotePackageBootstrap).toHaveBeenCalledOnce()
    expect(value.probe).toHaveBeenCalledWith(
      {
        operationId: expect.any(String),
        urls: ['https://github.com/example/package.zip'],
        size: 99,
        sha256: 'b'.repeat(64)
      },
      { signal: undefined }
    )
  })

  it('reports a missing compatible package without source metadata', async () => {
    const value = harness({ candidate: null })

    await expect(value.inspector.inspect(hostId)).resolves.toMatchObject({
      remoteDownload: {
        available: false,
        source: null,
        packageSize: null,
        reason: 'package-unavailable'
      }
    })
  })

  it('preserves a catalog candidate probe failure and its source metadata', async () => {
    const value = harness({
      candidate: null,
      candidateFailure: {
        reason: 'probe-failed',
        source: 'mirror',
        packageSize: 12_345
      }
    })

    await expect(value.inspector.inspect(hostId)).resolves.toMatchObject({
      remoteDownload: {
        available: false,
        source: 'mirror',
        packageSize: 12_345,
        reason: 'probe-failed'
      }
    })
    expect(value.acquireRemotePackageBootstrap).not.toHaveBeenCalled()
  })

  it('reports direct bootstrap probe failures without hiding version status', async () => {
    const value = harness({
      bootstrapError: new Error('sensitive SSH diagnostic')
    })

    await expect(value.inspector.inspect(hostId)).resolves.toMatchObject({
      agent: { state: 'not-installed' },
      remoteDownload: {
        available: false,
        source: 'mirror',
        packageSize: 12_345,
        reason: 'probe-failed'
      }
    })
    expect(value.bootstrapRelease).toHaveBeenCalledOnce()
  })

  it('rejects a changed Host identity and releases both leases', async () => {
    const value = harness({
      bootstrapIdentity: {
        hostId,
        hostRevision: 4,
        hostKeyGeneration: 2,
        authenticationIdentity: 'b'.repeat(64)
      }
    })

    await expect(value.inspector.inspect(hostId)).rejects.toThrow(
      '连接身份不匹配'
    )
    expect(value.bootstrapRelease).toHaveBeenCalledOnce()
    expect(value.release).toHaveBeenCalledOnce()
  })

  it('honors cancellation while loading the remote environment catalog', async () => {
    const controller = new AbortController()
    const value = harness()
    value.loadRemoteEnvironmentCatalog.mockImplementationOnce(
      async () => {
        controller.abort()
        throw controller.signal.reason
      }
    )

    await expect(
      value.inspector.inspect(hostId, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(value.acquireRemotePackageBootstrap).not.toHaveBeenCalled()
    expect(value.release).toHaveBeenCalledOnce()
  })
})
