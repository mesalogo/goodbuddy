import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteRuntimeBundleManifest } from '../shared/remote-runtime-launch-contracts'
import {
  UNBOUNDED_REMOTE_PROMPT_DEADLINE
} from '../shared/remote-agent-contracts'
import {
  launchDirectLinuxStdioProcessOwner,
  reconcileOrphanedDirectLinuxStdioProcesses,
  type DirectLinuxStdioChild,
  type DirectLinuxStdioSpawn
} from './direct-linux-stdio-process-owner'
import { RuntimeOwnerRegistry } from './runtime-owner-registry'
import type { LinuxRuntimeProcessIdentity } from './runtime-process-identity'

const paths: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('direct Linux stdio Runtime ownership', () => {
  it('spawns Ask directly without systemd using detached fixed stdio', async () => {
    const registry = createRegistry()
    const child = fakeChild()
    let launchedIdentity!: LinuxRuntimeProcessIdentity
    const spawn = vi.fn<DirectLinuxStdioSpawn>((executable, args, options) => {
      expect(executable).toBe('/bundle/bin/opencode')
      expect(args).toEqual(['acp'])
      expect(args.join('\0')).not.toMatch(/systemd-run|systemctl|DBUS/iu)
      expect(options).toEqual({
        shell: false,
        detached: true,
        windowsHide: true,
        cwd: '/workspace',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          GOODBUDDY_RUNTIME_OWNER_TOKEN: 'a'.repeat(32)
        }
      })
      launchedIdentity = identity()
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    const owner = await launchDirectLinuxStdioProcessOwner({
      manifest: manifest(),
      profile: profile(),
      identity: { launchId: 'launch-1', processId: 'process-1' },
      installationId: 'installation-1',
      registry,
      deadlineAt: '2030-01-01T00:00:00.000Z',
      maximumInputBytes: 1024,
      platform: 'linux',
      spawn,
      randomOwnerToken: () => 'a'.repeat(32),
      readProcessIdentity: async () => launchedIdentity
    })
    expect(spawn).toHaveBeenCalledOnce()
    expect(owner.processIdentity).toEqual(launchedIdentity)
    expect(registry.get(owner.ownerId)).toMatchObject({
      state: 'running',
      installationId: 'installation-1',
      ownerToken: 'a'.repeat(32)
    })
    child.exitCode = 0
    child.emit('close', 0, null)
    expect(registry.get(owner.ownerId)).toBeUndefined()
    registry.close()
  })

  it('directly launches and verifies the packaged Node bridge helper', async () => {
    const registry = createRegistry()
    const child = fakeChild()
    const processIdentity = {
      ...identity(),
      executablePath: '/agent/node'
    }
    const spawn = vi.fn<DirectLinuxStdioSpawn>(
      (executable, args) => {
        expect(executable).toBe('/agent/node')
        expect(args).toEqual([
          '/agent/lib/agent.cjs',
          'model-bridge-helper'
        ])
        queueMicrotask(() => child.emit('spawn'))
        return child
      }
    )
    const owner = await launchDirectLinuxStdioProcessOwner({
      manifest: manifest(),
      profile: {
        executable: '/agent/node',
        processExecutable: '/agent/node',
        args: ['/agent/lib/agent.cjs', 'model-bridge-helper'],
        cwd: '/workspace',
        env: { PATH: '/usr/bin:/bin' },
        workMode: 'execute'
      },
      identity: { launchId: 'launch-1', processId: 'process-1' },
      installationId: 'installation-1',
      registry,
      deadlineAt: '2030-01-01T00:00:00.000Z',
      maximumInputBytes: 1024,
      platform: 'linux',
      spawn,
      randomOwnerToken: () => 'a'.repeat(32),
      readProcessIdentity: async () => processIdentity
    })

    expect(owner.processIdentity.executablePath).toBe('/agent/node')
    expect(registry.get(owner.ownerId)).toMatchObject({
      state: 'running',
      processIdentity
    })
    child.exitCode = 0
    child.emit('close', 0, null)
    registry.close()
  })

  it('rejects PID reuse before sending any signal', async () => {
    const registry = createRegistry()
    const child = fakeChild()
    const original = identity()
    const spawn: DirectLinuxStdioSpawn = () => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    }
    let reads = 0
    const sendSignal = vi.fn<typeof process.kill>(() => true)
    const owner = await launchDirectLinuxStdioProcessOwner({
      manifest: manifest(),
      profile: profile(),
      identity: { launchId: 'launch-1', processId: 'process-1' },
      installationId: 'installation-1',
      registry,
      deadlineAt: '2030-01-01T00:00:00.000Z',
      maximumInputBytes: 1024,
      platform: 'linux',
      spawn,
      randomOwnerToken: () => 'a'.repeat(32),
      readProcessIdentity: async () => {
        reads += 1
        return reads === 1
          ? original
          : { ...original, startTimeTicks: 999n }
      },
      sendSignal
    })
    await expect(
      owner.stop({
        reason: 'user-cancelled',
        deadlineAt: '2030-01-01T00:00:00.000Z'
      })
    ).rejects.toThrow(/identity changed/iu)
    expect(sendSignal).not.toHaveBeenCalled()
    expect(registry.get(owner.ownerId)).toBeUndefined()
    registry.close()
  })

  it('models verified process-group TERM then KILL and requires an empty tree', async () => {
    const registry = createRegistry()
    const child = fakeChild()
    let launched!: LinuxRuntimeProcessIdentity
    const spawn: DirectLinuxStdioSpawn = () => {
      launched = identity()
      queueMicrotask(() => child.emit('spawn'))
      return child
    }
    const signals: Array<[number, string | number | undefined]> = []
    let scans = 0
    let now = Date.now()
    const owner = await launchDirectLinuxStdioProcessOwner({
      manifest: manifest(),
      profile: profile(),
      identity: { launchId: 'launch-1', processId: 'process-1' },
      installationId: 'installation-1',
      registry,
      deadlineAt: new Date(now + 30_000).toISOString(),
      maximumInputBytes: 1024,
      platform: 'linux',
      spawn,
      randomOwnerToken: () => 'a'.repeat(32),
      readProcessIdentity: async () => launched,
      now: () => {
        now += 1_000
        return now
      },
      listPidNamespaceMembers: async () => {
        scans += 1
        return scans < 4 ? [launched] : []
      },
      sendSignal: ((pid, signal) => {
        signals.push([pid, signal])
        return true
      }) as typeof process.kill
    })
    await owner.stop({
      reason: 'user-cancelled',
      deadlineAt: new Date(now + 20_000).toISOString()
    })
    expect(signals).toEqual([
      [-launched.processGroupId, 'SIGTERM'],
      [-launched.processGroupId, 'SIGKILL']
    ])
    expect(registry.get(owner.ownerId)).toBeUndefined()
    registry.close()
  })

  it('does not stop an active prompt at the unbounded Runtime deadline', async () => {
    vi.useFakeTimers()
    try {
      const registry = createRegistry()
      const child = fakeChild()
      const launched = identity()
      const sendSignal = vi.fn<typeof process.kill>(() => true)
      const owner = await launchDirectLinuxStdioProcessOwner({
        manifest: manifest(),
        profile: profile(),
        identity: { launchId: 'launch-long', processId: 'process-long' },
        installationId: 'installation-1',
        registry,
        deadlineAt: UNBOUNDED_REMOTE_PROMPT_DEADLINE,
        maximumInputBytes: 1024,
        platform: 'linux',
        spawn: () => {
          queueMicrotask(() => child.emit('spawn'))
          return child
        },
        randomOwnerToken: () => 'a'.repeat(32),
        readProcessIdentity: async () => launched,
        listPidNamespaceMembers: async () => [],
        sendSignal
      })

      await vi.advanceTimersByTimeAsync(25 * 60 * 60_000)
      expect(sendSignal).not.toHaveBeenCalled()
      expect(await owner.reconcile()).toMatchObject({
        state: 'running',
        processTree: 'running'
      })
      await owner.stop({
        reason: 'user-cancelled',
        deadlineAt: new Date(Date.now() + 10_000).toISOString()
      })
      registry.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('startup reconciles only owners from the current installation', async () => {
    const registry = createRegistry()
    const reservation = {
      ownerId: 'owner-current',
      launchId: 'launch-current',
      processId: 'process-current',
      installationId: 'installation-current',
      ownerToken: 'a'.repeat(32)
    }
    registry.reserve(reservation)
    registry.reserve({
      ...reservation,
      ownerId: 'owner-other',
      launchId: 'launch-other',
      processId: 'process-other',
      installationId: 'installation-other'
    })

    await expect(
      reconcileOrphanedDirectLinuxStdioProcesses({
        installationId: 'installation-current',
        registry
      })
    ).resolves.toEqual({
      inspected: 1,
      stopped: 1,
      conflicts: 0,
      unknown: 0
    })
    expect(registry.get('owner-current')).toBeUndefined()
    expect(registry.get('owner-other')?.state).toBe('reserved')
    registry.close()
  })
})

function createRegistry(): RuntimeOwnerRegistry {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-direct-owner-'))
  paths.push(root)
  if (process.platform !== 'win32') chmodSync(root, 0o700)
  return new RuntimeOwnerRegistry(join(root, 'owners.sqlite'))
}

function fakeChild(): DirectLinuxStdioChild & EventEmitter {
  const child = new EventEmitter() as DirectLinuxStdioChild & EventEmitter
  child.pid = 42
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.kill = vi.fn(() => true)
  return child
}

function profile() {
  return {
    executable: '/bundle/bin/opencode' as const,
    processExecutable: '/bundle/bin/opencode' as const,
    cwd: '/workspace',
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    workMode: 'ask' as const,
    args: ['acp']
  }
}

function identity(): LinuxRuntimeProcessIdentity {
  return {
    bootId: '11111111-1111-1111-1111-111111111111',
    pid: 42,
    startTimeTicks: 100n,
    processGroupId: 42,
    executablePath: '/bundle/bin/opencode'
  }
}

function manifest(): RemoteRuntimeBundleManifest {
  return {
    formatVersion: 2,
    product: 'GoodBuddy',
    runtimeId: 'opencode',
    runtimeVersion: '1.18.9',
    provider: 'opencode',
    platform: 'linux',
    architecture: 'x64',
    signingKeyId: 'runtime-test',
    bundleDigest: `sha256:${'a'.repeat(64)}`,
    adapterDigest: `sha256:${'b'.repeat(64)}`,
    sourcePackage: {
      name: 'opencode-linux-x64-baseline',
      integrity:
        'sha512-x4KiJk9EF7ktM18Ru5Jue4kTntxMvlhWb7tHniQGGRvY2KeoK1iIkyAFd7ri5H/fSkM22hNv/Gg1Jk6/h9IlxQ=='
    },
    entrypoint: {
      identity: 'opencode-acp',
      path: 'bin/opencode',
      sha256: 'd'.repeat(64),
      argvPrefix: ['acp']
    },
    files: [
      { path: 'bin/opencode', size: 64, sha256: 'd'.repeat(64), mode: '0755' },
      { path: 'licenses/opencode.txt', size: 4, sha256: 'e'.repeat(64), mode: '0644' }
    ],
    licenses: [
      {
        package: 'opencode-ai',
        version: '1.18.9',
        spdx: 'MIT',
        path: 'licenses/opencode.txt'
      }
    ],
    allowedEnvironmentNames: [
      'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'
    ],
    protocol: { major: 1, minor: 0 },
    acpCapabilitiesDigest: `sha256:${'f'.repeat(64)}`,
    limits: {
      maximumPromptRuntimeMilliseconds: 60_000,
      maximumPromptInputBytes: 4096,
      maximumPromptOutputBytes: 1024 * 1024
    }
  }
}
