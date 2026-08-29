import {
  readFileSync,
  readdirSync
} from 'node:fs'
import {
  join,
  resolve
} from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  SshConnectionPoolTarget
} from '../ssh/ssh-connection-pool'
import {
  RemoteRuntimeInstallationError,
  RemoteRuntimeInstallationManager
} from './remote-runtime-installation-manager'

const HOST_ID = 'host-1'
const AGENT_ID = `agent-${'a'.repeat(64)}` as never
const runtimeRoot = resolve(
  '.remote-runtime-resources',
  'linux-x64',
  'opencode'
)
const digestDirectory = readdirSync(runtimeRoot)[0]!
const manifest = JSON.parse(
  readFileSync(
    join(runtimeRoot, digestDirectory, 'manifest.json'),
    'utf8'
  )
) as {
  runtimeId: string
  runtimeVersion: string
  architecture: 'x64'
  bundleDigest: string
  adapterDigest: string
  acpCapabilitiesDigest: string
}
const entry = {
  runtimeId: manifest.runtimeId,
  runtimeVersion: manifest.runtimeVersion,
  architecture: manifest.architecture,
  bundleDigest: manifest.bundleDigest,
  manifestDigest: `sha256:${'b'.repeat(64)}`,
  runtimeAdapterDigest: manifest.adapterDigest,
  acpCapabilitiesDigest: manifest.acpCapabilitiesDigest
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
        fingerprintSha256: `SHA256:${'c'.repeat(43)}`,
        generation: 2
      }
    },
    hostRevision: 3,
    hostKeyGeneration: 2
  }
}

function fixture(options: {
  registryEntry?: typeof entry | undefined
  includeAdapter?: boolean
  activate?: ReturnType<typeof vi.fn>
  readRegistry?: () => Promise<Buffer>
} = {}) {
  const calls: string[] = []
  const registryEntry =
    'registryEntry' in options
      ? options.registryEntry
      : entry
  const storedEntry = registryEntry === undefined
    ? undefined
    : options.includeAdapter === false
      ? Object.fromEntries(
          Object.entries(registryEntry).filter(
            ([key]) => key !== 'runtimeAdapterDigest'
          )
        )
      : registryEntry
  const readRegistry =
    options.readRegistry ??
    vi.fn(async () => Buffer.from(JSON.stringify({
      formatVersion: 1,
      current: storedEntry === undefined ? [] : [storedEntry]
    })))
  const readFile = vi.fn(async (path: string) => {
    calls.push(`read:${path}`)
    if (path.endsWith('registry.json')) {
      return readRegistry()
    }
    return Buffer.from(JSON.stringify(manifest))
  })
  const close = vi.fn(() => calls.push('close-sftp'))
  const release = vi.fn(() => calls.push('release'))
  const lease = {
    identity: {
      hostId: HOST_ID,
      hostRevision: 3,
      hostKeyGeneration: 2,
      authenticationIdentity: 'd'.repeat(64)
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
      lstat: vi.fn(async (path: string) => ({
        type: 'file',
        size: 512,
        mode: path.endsWith('registry.json')
          ? 0o600
          : 0o644,
        uid: 1000,
        gid: 1000,
        atime: 0,
        mtime: 0
      })),
      readFile,
      close
    })),
    release,
    isUsable: vi.fn(() => true)
  }
  const activate =
    options.activate ??
    vi.fn(async () => {
      calls.push('activate')
    })
  const acquire = vi.fn(async () => lease as never)
  const resolver = {
    resolve: vi.fn(async () => target())
  }
  const manager = new RemoteRuntimeInstallationManager({
    resolver,
    sshPool: { acquire },
    activate: activate as never
  })
  return {
    manager,
    calls,
    resolver,
    lease,
    acquire,
    activate,
    readFile,
    readRegistry,
    close,
    release
  }
}

describe('RemoteRuntimeInstallationManager', () => {
  it('activates a registered Runtime without reading its payload', async () => {
    const value = fixture()
    const phases: string[] = []

    await expect(value.manager.activateInstalled(
      HOST_ID,
      {
        agentInstallationId: AGENT_ID,
        onProgress: (phase) => phases.push(phase)
      }
    )).resolves.toEqual({
      ...entry,
      platform: 'linux'
    })
    expect(value.readFile.mock.calls.map(
      (call) => call[0]
    )).toEqual(['.goodbuddy/runtimes/registry.json'])
    expect(value.activate).toHaveBeenCalledWith(
      value.lease,
      entry.runtimeId,
      entry.bundleDigest,
      entry.architecture,
      AGENT_ID,
      expect.any(AbortSignal)
    )
    expect(phases).toEqual([
      'inspecting-host',
      'verifying-bundle',
      'activating-runtime',
      'complete'
    ])
  })

  it('reads only the signed manifest metadata for a legacy registry entry', async () => {
    const value = fixture({ includeAdapter: false })

    await expect(
      value.manager.activateInstalled(HOST_ID)
    ).resolves.toMatchObject({
      runtimeAdapterDigest: manifest.adapterDigest
    })
    expect(value.readFile.mock.calls.map(
      (call) => call[0]
    )).toEqual([
      '.goodbuddy/runtimes/registry.json',
      `.goodbuddy/runtimes/opencode/${digestDirectory}/manifest.json`
    ])
  })

  it('caches activation until the Host is invalidated', async () => {
    const value = fixture()
    const first = await value.manager.activateInstalled(HOST_ID)
    const second = await value.manager.activateInstalled(HOST_ID)
    expect(second).toEqual(first)
    expect(value.acquire).toHaveBeenCalledOnce()

    value.manager.invalidateHost(HOST_ID)
    await value.manager.activateInstalled(HOST_ID)
    expect(value.acquire).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent activation for one Agent identity', async () => {
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolveRead) => {
      releaseRead = resolveRead
    })
    const value = fixture({
      readRegistry: vi.fn(async () => {
        await readGate
        return Buffer.from(JSON.stringify({
          formatVersion: 1,
          current: [entry]
        }))
      })
    })

    const first = value.manager.activateInstalled(HOST_ID, {
      agentInstallationId: AGENT_ID
    })
    const second = value.manager.activateInstalled(HOST_ID, {
      agentInstallationId: AGENT_ID
    })
    releaseRead()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(value.acquire).toHaveBeenCalledOnce()
  })

  it('classifies a missing Runtime registry entry as incompatible', async () => {
    const value = fixture({ registryEntry: undefined })
    await expect(
      value.manager.activateInstalled(HOST_ID)
    ).rejects.toMatchObject({
      reason: 'incompatible'
    })
    expect(value.activate).not.toHaveBeenCalled()
  })

  it('preserves concrete Agent activation failures', async () => {
    const failure = new Error('entrypoint permission denied')
    const value = fixture({
      activate: vi.fn(async () => {
        throw failure
      })
    })
    await expect(
      value.manager.activateInstalled(HOST_ID)
    ).rejects.toMatchObject({
      reason: 'corrupt',
      message: expect.stringContaining(
        'entrypoint permission denied'
      )
    })
  })

  it('rejects a mismatched legacy manifest before activation', async () => {
    const value = fixture({ includeAdapter: false })
    value.readFile.mockImplementation(async (path: string) =>
      path.endsWith('registry.json')
        ? Buffer.from(JSON.stringify({
            formatVersion: 1,
            current: [
              Object.fromEntries(
                Object.entries(entry).filter(
                  ([key]) =>
                    key !== 'runtimeAdapterDigest'
                )
              )
            ]
          }))
        : Buffer.from(JSON.stringify({
            ...manifest,
            runtimeVersion: '99.0.0'
          }))
    )

    await expect(
      value.manager.activateInstalled(HOST_ID)
    ).rejects.toBeInstanceOf(
      RemoteRuntimeInstallationError
    )
    expect(value.activate).not.toHaveBeenCalled()
  })
})
