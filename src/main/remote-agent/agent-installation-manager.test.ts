import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentDiagnosticResult,
  SshConnectionPoolTarget
} from '../ssh/ssh-connection-pool'
import {
  AgentInstallationError,
  AgentInstallationManager
} from './agent-installation-manager'

const HOST_ID = 'host-1'
const MANIFEST_SHA256 = 'a'.repeat(64)
const INSTALLATION_ID = `agent-${MANIFEST_SHA256}`
const runtimeLock = JSON.parse(
  readFileSync(
    resolve('agent-runtime-lock.json'),
    'utf8'
  )
) as {
  agentVersion: string
  protocol: { major: number; minor: number }
}

function target(): SshConnectionPoolTarget {
  return {
    host: {
      id: HOST_ID,
      name: 'Builder',
      hostname: 'builder.example',
      port: 22,
      username: 'goodbuddy',
      authentication: 'password',
      password: 'secret',
      hostKey: {
        algorithm: 'ssh-ed25519',
        publicKeyBase64: 'a2V5',
        fingerprintSha256: `SHA256:${'b'.repeat(43)}`,
        generation: 2
      }
    },
    hostRevision: 3,
    hostKeyGeneration: 2
  }
}

function diagnostic(
  exitCode = 0,
  stderr = ''
): AgentDiagnosticResult {
  return { exitCode, stdout: '', stderr }
}

function fixture(options: {
  registry?: unknown
  lifecycle?: (
    action: string,
    signal?: AbortSignal
  ) => Promise<AgentDiagnosticResult>
  readRegistry?: () => Promise<Buffer>
} = {}) {
  const calls: string[] = []
  const registry = options.registry ?? {
    formatVersion: 1,
    current: {
      installationId: INSTALLATION_ID,
      agentVersion: runtimeLock.agentVersion,
      manifestSha256: MANIFEST_SHA256,
      arch: 'x64'
    }
  }
  const readRegistry =
    options.readRegistry ??
    vi.fn(async () => Buffer.from(JSON.stringify(registry)))
  const lifecycle =
    options.lifecycle ??
    vi.fn(async (action: string) => {
      calls.push(action)
      return diagnostic()
    })
  const close = vi.fn(() => calls.push('close-sftp'))
  const release = vi.fn(() => calls.push('release'))
  const lease = {
    identity: {
      hostId: HOST_ID,
      hostRevision: 3,
      hostKeyGeneration: 2,
      authenticationIdentity: 'c'.repeat(64)
    },
    runAgentBootstrapProbe: vi.fn(async () => ({
      ready: true,
      platform: 'linux',
      architecture: 'x64',
      canonicalHomeDirectory: '/home/goodbuddy',
      uid: 1000,
      shell: '/bin/sh',
      procfs: 'ready'
    })),
    openStagedSftp: vi.fn(async () => ({
      lstat: vi.fn(async () => ({
        type: 'file',
        size: 256,
        mode: 0o600,
        uid: 1000,
        gid: 1000,
        atime: 0,
        mtime: 0
      })),
      readFile: readRegistry,
      close
    })),
    runAgentLifecycleAction: vi.fn(
      async (
        _installationId: string,
        action: string,
        signal?: AbortSignal
      ) => lifecycle(action, signal)
    ),
    release,
    isUsable: vi.fn(() => true)
  }
  const resolver = {
    resolve: vi.fn(async () => target())
  }
  const acquire = vi.fn(async () => lease as never)
  const manager = new AgentInstallationManager({
    resolver,
    sshPool: { acquire },
    resourcePaths: {
      runtimeLockPath: resolve('agent-runtime-lock.json'),
      keyRegistryPath: resolve(
        'resources',
        'agent-release-keys.json'
      ),
      bundleDirectories: {
        x64: resolve('.agent-resources', 'linux-x64'),
        arm64: resolve('.agent-resources', 'linux-arm64')
      }
    }
  })
  return {
    manager,
    calls,
    resolver,
    acquire,
    lease,
    lifecycle,
    readRegistry,
    close,
    release
  }
}

describe('AgentInstallationManager', () => {
  it('activates the registered Agent with one metadata read and one health command', async () => {
    const value = fixture()
    const progress: string[] = []

    await expect(value.manager.activateInstalled(
      HOST_ID,
      { onProgress: (phase) => progress.push(phase) }
    )).resolves.toMatchObject({
      installationId: INSTALLATION_ID,
      binaryDigest: `sha256:${MANIFEST_SHA256}`,
      agentVersion: runtimeLock.agentVersion,
      protocol: runtimeLock.protocol,
      architecture: 'x64'
    })
    expect(value.readRegistry).toHaveBeenCalledOnce()
    expect(value.lease.runAgentLifecycleAction)
      .toHaveBeenCalledWith(
        INSTALLATION_ID,
        'health',
        expect.any(AbortSignal)
      )
    expect(value.calls).toEqual([
      'close-sftp',
      'health',
      'release'
    ])
    expect(progress).toEqual([
      'inspecting-host',
      'verifying-bundle',
      'checking-health',
      'complete'
    ])
  })

  it('uses bootstrap readiness as the recovery proof without a second health command', async () => {
    const value = fixture({
      lifecycle: vi.fn(async (action: string) =>
        action === 'health'
          ? diagnostic(1, 'not running')
          : diagnostic()
      )
    })

    await expect(
      value.manager.activateInstalled(HOST_ID)
    ).resolves.toBeDefined()
    expect(value.lease.runAgentLifecycleAction.mock.calls.map(
      (call) => call[1]
    )).toEqual(['health', 'bootstrap'])
  })

  it('returns its cached identity until the Host is invalidated', async () => {
    const value = fixture()

    const first = await value.manager.activateInstalled(HOST_ID)
    const second = await value.manager.activateInstalled(HOST_ID)
    expect(second).toEqual(first)
    expect(value.acquire).toHaveBeenCalledOnce()

    value.manager.invalidateHost(HOST_ID)
    await value.manager.activateInstalled(HOST_ID)
    expect(value.acquire).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent activation for the same Host', async () => {
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolveRead) => {
      releaseRead = resolveRead
    })
    const value = fixture({
      readRegistry: vi.fn(async () => {
        await readGate
        return Buffer.from(JSON.stringify({
          formatVersion: 1,
          current: {
            installationId: INSTALLATION_ID,
            agentVersion: runtimeLock.agentVersion,
            manifestSha256: MANIFEST_SHA256,
            arch: 'x64'
          }
        }))
      })
    })

    const first = value.manager.activateInstalled(HOST_ID)
    const second = value.manager.activateInstalled(HOST_ID)
    releaseRead()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(value.acquire).toHaveBeenCalledOnce()
  })

  it('rejects incompatible registry identity before lifecycle activation', async () => {
    const value = fixture({
      registry: {
        formatVersion: 1,
        current: {
          installationId: INSTALLATION_ID,
          agentVersion: '0.0.1',
          manifestSha256: MANIFEST_SHA256,
          arch: 'x64'
        }
      }
    })

    await expect(
      value.manager.activateInstalled(HOST_ID)
    ).rejects.toMatchObject({
      reason: 'incompatible'
    })
    expect(value.lifecycle).not.toHaveBeenCalled()
  })

  it('accepts a newer independently published Agent with a compatible registered protocol', async () => {
    const value = fixture({
      registry: {
        formatVersion: 1,
        current: {
          installationId: INSTALLATION_ID,
          agentVersion: '99.0.0',
          manifestSha256: MANIFEST_SHA256,
          arch: 'x64',
          protocol: runtimeLock.protocol
        }
      }
    })

    await expect(
      value.manager.activateInstalled(HOST_ID)
    ).resolves.toMatchObject({
      agentVersion: '99.0.0',
      protocol: runtimeLock.protocol
    })
  })

  it('preserves bounded lifecycle diagnostics', async () => {
    const value = fixture({
      lifecycle: vi.fn(async (action: string) =>
        action === 'health'
          ? diagnostic(1)
          : diagnostic(2, 'entrypoint permission denied')
      )
    })

    await expect(
      value.manager.activateInstalled(HOST_ID)
    ).rejects.toMatchObject({
      reason: 'lifecycle',
      message: expect.stringContaining(
        'entrypoint permission denied'
      )
    })
  })

  it('disposes active work and rejects future activation', async () => {
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolveRead) => {
      releaseRead = resolveRead
    })
    const value = fixture({
      readRegistry: vi.fn(async () => {
        await readGate
        return Buffer.from('{}')
      })
    })
    const active = value.manager.activateInstalled(HOST_ID)
    const disposing = value.manager.dispose()
    releaseRead()
    await active.catch(() => undefined)
    await disposing

    await expect(
      value.manager.activateInstalled(HOST_ID)
    ).rejects.toThrow('disposed')
  })

  it('classifies malformed registered state as corrupt', async () => {
    const value = fixture({ registry: { formatVersion: 1 } })
    await expect(
      value.manager.activateInstalled(HOST_ID)
    ).rejects.toBeInstanceOf(AgentInstallationError)
  })
})
