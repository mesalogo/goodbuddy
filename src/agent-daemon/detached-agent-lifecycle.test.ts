import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DetachedAgentLifecycle,
  detachedAgentLifecycleRecordSchema,
  type DetachedAgentLifecycleOptions,
  type DetachedAgentLifecycleRecord,
  type DetachedSocketInspector,
  type DetachedSpawn
} from './detached-agent-lifecycle'
import {
  LinuxProcessInspector,
  type LinuxProcessIdentity
} from './linux-process-identity'
import { writePrivateFileAtomic } from './managed-paths'
import type { VerifiedInstalledAgentBundle } from './installed-bundle-verifier'
import { readAgentDiagnostics } from './diagnostic-log'

const parentPid = 1101
const childPid = 2202
const temporaryPaths: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('detached Agent lifecycle', () => {
  it('serializes concurrent bootstrap and records endpoint readiness', async () => {
    const harness = lifecycleHarness()
    harness.onSleep(async () => {
      const starting = harness.readRecord()
      if (starting?.daemonBootId === null) {
        await harness.daemon.recordCurrentDaemonReady('daemon-boot-1')
      }
    })

    const [first, second] = await Promise.all([
      harness.lifecycle.bootstrap(),
      harness.lifecycle.bootstrap()
    ])

    expect(first.daemonBootId).toBe('daemon-boot-1')
    expect(second).toEqual(first)
    expect(harness.spawn).toHaveBeenCalledOnce()
    expect(harness.spawn).toHaveBeenCalledWith(
      harness.verified.executablePath,
      ['daemon', '--installation-id', 'install-1'],
      {
        detached: true,
        shell: false,
        stdio: 'ignore',
        cwd: harness.verified.installationDirectory,
        env: {
          HOME: '/home/tester',
          LANG: 'zh_CN.UTF-8',
          PATH: '/usr/bin',
          TMPDIR: '/tmp'
        }
      }
    )
    expect(harness.unref).toHaveBeenCalledOnce()
    expect(harness.probe).toHaveBeenCalled()
    expect(
      readAgentDiagnostics(harness.stateDirectory).map(
        (record) => record.event
      )
    ).toEqual(
      expect.arrayContaining([
        'detached.launching',
        'detached.spawned'
      ])
    )
  })

  it('creates the managed state parent before bootstrapping', async () => {
    const harness = lifecycleHarness({
      nestedStateDirectory: true
    })
    const stateRoot = resolve(harness.stateDirectory, '..')
    expect(existsSync(stateRoot)).toBe(false)

    await expect(harness.becomeReady()).resolves.toMatchObject({
      daemonBootId: 'daemon-boot-1'
    })

    expect(existsSync(stateRoot)).toBe(true)
    expect(existsSync(harness.stateDirectory)).toBe(true)
    if (process.platform !== 'win32') {
      expect(lstatSync(stateRoot).mode & 0o777).toBe(0o700)
      expect(
        lstatSync(harness.stateDirectory).mode & 0o777
      ).toBe(0o700)
    }
  })

  it('recovers stale lifecycle state without signalling a reused PID', async () => {
    const harness = lifecycleHarness()
    await harness.becomeReady()
    harness.signals.length = 0
    harness.identities.set(
      childPid,
      harness.childIdentity({ starttime: '99999' })
    )
    harness.onSleep(async () => {
      const starting = harness.readRecord()
      if (starting?.daemonBootId === null) {
        await harness.daemon.recordCurrentDaemonReady('daemon-after-reuse')
      }
    })

    await expect(harness.lifecycle.status()).resolves.toMatchObject({
      state: 'stale',
      reason: 'process-identity-mismatch'
    })
    const recovered = await harness.lifecycle.bootstrap()
    expect(recovered.daemonBootId).toBe('daemon-after-reuse')
    expect(harness.spawn).toHaveBeenCalledTimes(2)
    expect(harness.signals).toEqual([])
    expect(harness.socket.removed).toBe(1)
  })

  it.each([
    ['start time', { starttime: '99999' }],
    ['executable', { executablePath: resolve('foreign', 'runtime') }]
  ])('never signals a PID with mismatched %s', async (_label, mismatch) => {
    const harness = lifecycleHarness()
    await harness.becomeReady()
    harness.identities.set(childPid, harness.childIdentity(mismatch))
    harness.signals.length = 0

    await expect(harness.lifecycle.stop()).resolves.toEqual({
      state: 'absent'
    })
    expect(harness.signals).toEqual([])
    expect(harness.socket.removed).toBe(1)
  })

  it('reclaims a stale exclusive lock and preserves a live lock', async () => {
    const harness = lifecycleHarness()
    harness.writeLock(harness.childIdentity({ starttime: '1' }))
    harness.onSleep(async () => {
      if (harness.readRecord()?.daemonBootId === null) {
        await harness.daemon.recordCurrentDaemonReady('after-stale-lock')
      }
    })
    await expect(harness.lifecycle.bootstrap()).resolves.toMatchObject({
      daemonBootId: 'after-stale-lock'
    })

    const live = lifecycleHarness({ readinessTimeoutMs: 100 })
    live.writeLock(live.parentIdentity)
    await expect(live.lifecycle.bootstrap()).rejects.toThrow(
      'Timed out waiting'
    )
    expect(existsSync(live.lockPath)).toBe(true)
    expect(live.spawn).not.toHaveBeenCalled()
  })

  it('rejects corrupt and permissive lifecycle state', async () => {
    const corrupt = lifecycleHarness()
    mkdirSync(corrupt.stateDirectory, { mode: 0o700 })
    writeFileSync(corrupt.lifecyclePath, '{not-json\n', { mode: 0o600 })
    await expect(corrupt.lifecycle.status()).rejects.toThrow('corrupt')

    if (process.platform !== 'win32') {
      const permissive = lifecycleHarness()
      mkdirSync(permissive.stateDirectory, { mode: 0o700 })
      writeFileSync(permissive.lifecyclePath, '{}\n', { mode: 0o644 })
      await expect(permissive.lifecycle.status()).rejects.toThrow('corrupt')
    }
  })

  it('uses TERM then KILL and cleans lifecycle/socket state', async () => {
    const harness = lifecycleHarness({
      readinessTimeoutMs: 100,
      stopTimeoutMs: 100,
      termExits: false,
      killExits: true
    })

    await expect(harness.lifecycle.bootstrap()).rejects.toThrow(
      'readiness timed out'
    )
    expect(harness.signals.map(({ signal }) => signal)).toEqual([
      'SIGTERM',
      'SIGKILL'
    ])
    expect(existsSync(harness.lifecyclePath)).toBe(false)
    expect(harness.socket.removed).toBe(1)
  })

  it('keeps lifecycle state when TERM and KILL cannot stop the process', async () => {
    const harness = lifecycleHarness({
      readinessTimeoutMs: 100,
      stopTimeoutMs: 100,
      termExits: false,
      killExits: false
    })

    await expect(harness.lifecycle.bootstrap()).rejects.toThrow(
      'did not stop'
    )
    expect(harness.signals.map(({ signal }) => signal)).toEqual([
      'SIGTERM',
      'SIGKILL'
    ])
    expect(existsSync(harness.lifecyclePath)).toBe(true)
  })
})

type HarnessOptions = {
  readinessTimeoutMs?: number
  stopTimeoutMs?: number
  termExits?: boolean
  killExits?: boolean
  nestedStateDirectory?: boolean
}

function lifecycleHarness(options: HarnessOptions = {}) {
  const root = privateTemporaryDirectory()
  const installationDirectory = resolve(root, 'installation')
  const stateDirectory = options.nestedStateDirectory
    ? resolve(root, 'state', 'install-1')
    : resolve(root, 'state')
  const socketPath = resolve(root, 'endpoint', 'agent.sock')
  const lifecyclePath = resolve(stateDirectory, 'detached-lifecycle.json')
  const lockPath = resolve(stateDirectory, 'detached-bootstrap.lock')
  const verified = verifiedInstallation(installationDirectory)
  const parentIdentity: LinuxProcessIdentity = {
    pid: parentPid,
    starttime: '101',
    executablePath: resolve(root, 'host', 'node')
  }
  const expectedChildIdentity = (
    changes: Partial<LinuxProcessIdentity> = {}
  ): LinuxProcessIdentity => ({
    pid: childPid,
    starttime: '202',
    executablePath: resolve(installationDirectory, 'node'),
    ...changes
  })
  const identities = new Map<number, LinuxProcessIdentity>([
    [parentPid, parentIdentity],
    [childPid, expectedChildIdentity()]
  ])
  const inspector = new LinuxProcessInspector()
  vi.spyOn(inspector, 'inspect').mockImplementation((pid) =>
    identities.get(pid)
  )
  vi.spyOn(inspector, 'matches').mockImplementation((expected) => {
    const actual = identities.get(expected.pid)
    return actual !== undefined && sameIdentity(actual, expected)
  })
  const signals: Array<{
    identity: LinuxProcessIdentity
    signal: NodeJS.Signals
  }> = []
  vi.spyOn(inspector, 'signal').mockImplementation((identity, signal) => {
    const actual = identities.get(identity.pid)
    if (actual === undefined || !sameIdentity(actual, identity)) {
      return false
    }
    signals.push({ identity, signal })
    if (
      (signal === 'SIGTERM' && options.termExits !== false) ||
      (signal === 'SIGKILL' && options.killExits !== false)
    ) {
      identities.delete(identity.pid)
    }
    return true
  })
  const socket = new FakeSocketInspector()
  const unref = vi.fn()
  const spawn = vi.fn<DetachedSpawn>(() => {
    identities.set(childPid, expectedChildIdentity())
    return { pid: childPid, unref }
  })
  let time = 1_000
  let sleepHook: (() => void | Promise<void>) | undefined
  let hookActive = false
  const sleep = async (milliseconds: number): Promise<void> => {
    time += milliseconds
    await Promise.resolve()
    if (sleepHook !== undefined && !hookActive) {
      hookActive = true
      try {
        await sleepHook()
      } finally {
        hookActive = false
      }
    }
  }
  const probe = vi.fn(async () => ({
    daemonBootId:
      detachedAgentLifecycleRecordSchema.parse(
        JSON.parse(readFileSync(lifecyclePath, 'utf8'))
      ).daemonBootId ?? 'not-ready'
  }))
  const common: Omit<
    DetachedAgentLifecycleOptions,
    'currentPid' | 'spawnDetached'
  > = {
    installationId: 'install-1',
    executablePath: verified.executablePath,
    stateDirectory,
    socketPath,
    verifyInstallation: async () => verified,
    processInspector: inspector,
    socketInspector: socket,
    now: () => time,
    sleep,
    readinessTimeoutMs: options.readinessTimeoutMs ?? 500,
    stopTimeoutMs: options.stopTimeoutMs ?? 100,
    environment: {
      HOME: '/home/tester',
      LANG: 'zh_CN.UTF-8',
      PATH: '/usr/bin',
      TMPDIR: '/tmp',
      NODE_OPTIONS: '--inspect',
      GOODBUDDY_SECRET: 'must-not-leak'
    }
  }
  const lifecycle = new DetachedAgentLifecycle({
    ...common,
    currentPid: parentPid,
    spawnDetached: spawn,
    probeEndpoint: probe
  })
  const daemon = new DetachedAgentLifecycle({
    ...common,
    currentPid: childPid,
    spawnDetached: () => {
      throw new Error('Daemon must not spawn another daemon')
    }
  })

  const readRecord = (): DetachedAgentLifecycleRecord | undefined => {
    if (!existsSync(lifecyclePath)) {
      return undefined
    }
    return detachedAgentLifecycleRecordSchema.parse(
      JSON.parse(readFileSync(lifecyclePath, 'utf8'))
    )
  }
  return {
    lifecycle,
    daemon,
    verified,
    stateDirectory,
    lifecyclePath,
    lockPath,
    identities,
    parentIdentity,
    childIdentity: expectedChildIdentity,
    socket,
    spawn,
    unref,
    probe,
    signals,
    readRecord,
    onSleep(hook: () => void | Promise<void>) {
      sleepHook = hook
    },
    writeLock(processIdentity: LinuxProcessIdentity) {
      mkdirSync(stateDirectory, { mode: 0o700, recursive: true })
      writePrivateFileAtomic(
        lockPath,
        `${JSON.stringify({
          formatVersion: 1,
          installationId: 'install-1',
          process: processIdentity
        })}\n`
      )
    },
    async becomeReady(): Promise<DetachedAgentLifecycleRecord> {
      let completed = false
      sleepHook = async () => {
        if (readRecord()?.daemonBootId === null && !completed) {
          completed = true
          await daemon.recordCurrentDaemonReady('daemon-boot-1')
        }
      }
      return await lifecycle.bootstrap()
    }
  }
}

class FakeSocketInspector implements DetachedSocketInspector {
  removed = 0

  removeStale(): boolean {
    this.removed += 1
    return true
  }
}

function sameIdentity(
  left: LinuxProcessIdentity,
  right: LinuxProcessIdentity
): boolean {
  return (
    left.pid === right.pid &&
    left.starttime === right.starttime &&
    left.executablePath === right.executablePath
  )
}

function privateTemporaryDirectory(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'goodbuddy-lifecycle-'))
  temporaryPaths.push(path)
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
  return resolve(path)
}

function verifiedInstallation(
  installationDirectory: string
): VerifiedInstalledAgentBundle {
  const digest = 'a'.repeat(64)
  return {
    installationId: 'install-1',
    installationDirectory,
    executablePath: resolve(installationDirectory, 'goodbuddy-agent'),
    manifestSha256: digest,
    binaryDigest: `sha256:${digest}`,
    manifest: {
      formatVersion: 1,
      product: 'GoodBuddy',
      agentVersion: '0.11.0',
      platform: 'linux',
      arch: 'x64',
      protocol: { major: 1, minor: 0 },
      signingKeyId: 'test-key',
      entrypoint: {
        path: 'goodbuddy-agent',
        runtimePath: 'node',
        scriptPath: 'lib/agent.cjs'
      },
      files: [],
      licenses: []
    }
  }
}
