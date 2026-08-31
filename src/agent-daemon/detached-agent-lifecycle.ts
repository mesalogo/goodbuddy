import { spawn } from 'node:child_process'
import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import type { VerifiedInstalledAgentBundle } from './installed-bundle-verifier'
import {
  LinuxProcessInspector,
  type LinuxProcessIdentity
} from './linux-process-identity'
import {
  assertAbsoluteManagedPath,
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFileAtomic
} from './managed-paths'
import type { AttachWelcome } from '../shared/agent-protocol'
import { AgentDiagnosticLog } from './diagnostic-log'

const DEFAULT_READINESS_TIMEOUT_MS = 15_000
const DEFAULT_STOP_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50

const processIdentitySchema = z
  .object({
    pid: z.number().int().positive().safe(),
    starttime: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    executablePath: z.string().min(1)
  })
  .strict()

const bootstrapLockRecordSchema = z
  .object({
    formatVersion: z.literal(1),
    installationId: z.string().min(1).max(128),
    process: processIdentitySchema
  })
  .strict()

export const detachedAgentLifecycleRecordSchema = z
  .object({
    formatVersion: z.literal(1),
    installationId: z.string().min(1).max(128),
    binaryDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    protocol: z
      .object({
        major: z.number().int().min(0).max(65_535),
        minor: z.number().int().min(0).max(65_535)
      })
      .strict(),
    process: processIdentitySchema,
    daemonBootId: z.string().min(1).max(128).nullable(),
    createdAt: z.number().int().nonnegative().safe()
  })
  .strict()

export type DetachedAgentLifecycleRecord = z.infer<
  typeof detachedAgentLifecycleRecordSchema
>

export type DetachedLifecycleStatus =
  | { state: 'absent' }
  | {
      state: 'starting' | 'ready'
      record: DetachedAgentLifecycleRecord
    }
  | {
      state: 'stale'
      reason: string
      record: DetachedAgentLifecycleRecord
    }

export type DetachedSpawn = (
  executable: string,
  argv: readonly string[],
  options: {
    env: Readonly<NodeJS.ProcessEnv>
    detached: true
    shell: false
    stdio: 'ignore'
    cwd: string
  }
) => {
  pid?: number
  unref(): void
}

export interface DetachedSocketInspector {
  removeStale(path: string): boolean
}

export type DetachedAgentLifecycleOptions = {
  installationId: string
  executablePath: string
  stateDirectory: string
  socketPath: string
  verifyInstallation: () => Promise<VerifiedInstalledAgentBundle>
  processInspector?: LinuxProcessInspector
  socketInspector?: DetachedSocketInspector
  spawnDetached?: DetachedSpawn
  currentPid?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  readinessTimeoutMs?: number
  stopTimeoutMs?: number
  environment?: Readonly<NodeJS.ProcessEnv>
  probeEndpoint?: (
    verified: VerifiedInstalledAgentBundle
  ) => Promise<Pick<AttachWelcome, 'daemonBootId'>>
  retireLegacyInstallation?: (
    verified: VerifiedInstalledAgentBundle
  ) => void | Promise<void>
}

export class DetachedAgentLifecycle {
  readonly #installationId: string
  readonly #executablePath: string
  readonly #stateDirectory: string
  readonly #socketPath: string
  readonly #lifecyclePath: string
  readonly #lockPath: string
  readonly #verifyInstallation: () => Promise<VerifiedInstalledAgentBundle>
  readonly #processInspector: LinuxProcessInspector
  readonly #socketInspector: DetachedSocketInspector
  readonly #spawnDetached: DetachedSpawn
  readonly #currentPid: number
  readonly #now: () => number
  readonly #sleep: (milliseconds: number) => Promise<void>
  readonly #readinessTimeoutMs: number
  readonly #stopTimeoutMs: number
  readonly #environment: Readonly<NodeJS.ProcessEnv>
  readonly #probeEndpoint?: DetachedAgentLifecycleOptions['probeEndpoint']
  readonly #retireLegacyInstallation?: (
    verified: VerifiedInstalledAgentBundle
  ) => void | Promise<void>
  readonly #diagnostics: AgentDiagnosticLog

  constructor(options: DetachedAgentLifecycleOptions) {
    this.#installationId = validateInstallationId(options.installationId)
    this.#executablePath = assertAbsoluteManagedPath(resolve(options.executablePath))
    this.#stateDirectory = assertAbsoluteManagedPath(resolve(options.stateDirectory))
    this.#socketPath = assertAbsoluteManagedPath(resolve(options.socketPath))
    this.#lifecyclePath = resolve(this.#stateDirectory, 'detached-lifecycle.json')
    this.#lockPath = resolve(this.#stateDirectory, 'detached-bootstrap.lock')
    this.#verifyInstallation = options.verifyInstallation
    this.#processInspector =
      options.processInspector ?? new LinuxProcessInspector()
    this.#socketInspector =
      options.socketInspector ?? new FileSystemSocketInspector()
    this.#spawnDetached = options.spawnDetached ?? spawnDetachedProcess
    this.#currentPid = positivePid(options.currentPid ?? process.pid)
    this.#now = options.now ?? Date.now
    this.#diagnostics = new AgentDiagnosticLog(this.#stateDirectory, {
      now: this.#now,
      pid: this.#currentPid
    })
    this.#sleep =
      options.sleep ??
      (async (milliseconds) =>
        await new Promise<void>((resolveSleep) =>
          setTimeout(resolveSleep, milliseconds)
        ))
    this.#readinessTimeoutMs = boundedTimeout(
      options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
    )
    this.#stopTimeoutMs = boundedTimeout(
      options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
    )
    this.#environment = options.environment ?? process.env
    this.#probeEndpoint = options.probeEndpoint
    this.#retireLegacyInstallation = options.retireLegacyInstallation
  }

  async status(): Promise<DetachedLifecycleStatus> {
    return this.#statusAfterVerification(await this.#verifyAndBind())
  }

  async health(): Promise<DetachedAgentLifecycleRecord> {
    const verified = await this.#verifyAndBind()
    const status = this.#statusAfterVerification(verified)
    if (status.state !== 'ready') {
      throw new Error(`Detached Agent is not healthy: ${status.state}`)
    }
    await this.#assertEndpointReady(status.record, verified)
    return status.record
  }

  async bootstrap(): Promise<DetachedAgentLifecycleRecord> {
    const verified = await this.#verifyAndBind()
    ensurePrivateDirectory(dirname(this.#stateDirectory))
    ensurePrivateDirectory(this.#stateDirectory)
    ensurePrivateDirectory(dirname(this.#socketPath))
    const releaseLock = await this.#acquireBootstrapLock()
    try {
      await this.#retireLegacyInstallation?.(verified)
      const existing = this.#statusAfterVerification(verified)
      if (existing.state === 'ready') {
        try {
          await this.#assertEndpointReady(existing.record, verified)
          return existing.record
        } catch {
          await this.#retireLiveRecord(existing.record)
        }
      } else if (existing.state === 'starting') {
        const ready = await this.#waitForReady(verified)
        if (ready !== undefined) {
          return ready
        }
        await this.#retireLiveRecord(existing.record)
      } else if (existing.state === 'stale') {
        this.#cleanupRecord(existing.record)
      }

      const launchArgv = ['daemon', '--installation-id', this.#installationId]
      const runtimePath = expectedRuntimePath(verified)
      this.#diagnostics.tryRecord('detached.launching')
      const child = this.#spawnDetached(this.#executablePath, launchArgv, {
        env: detachedEnvironment(this.#environment),
        detached: true,
        shell: false,
        stdio: 'ignore',
        cwd: dirname(this.#executablePath)
      })
      if (child.pid === undefined) {
        throw new Error('Detached Agent spawn did not return a process ID')
      }
      child.unref()
      this.#diagnostics.tryRecord('detached.spawned')
      const processIdentity = await this.#waitForProcessIdentity(
        child.pid,
        runtimePath
      )
      const starting = detachedAgentLifecycleRecordSchema.parse({
        formatVersion: 1,
        installationId: this.#installationId,
        binaryDigest: verified.binaryDigest,
        protocol: verified.manifest.protocol,
        process: processIdentity,
        daemonBootId: null,
        createdAt: this.#now()
      })
      this.#writeRecord(starting)
      const ready = await this.#waitForReady(verified)
      if (ready === undefined) {
        await this.#retireLiveRecord(starting)
        throw new Error('Detached Agent readiness timed out')
      }
      return ready
    } catch (error) {
      this.#diagnostics.tryRecord('recovery.failed', {
        reason: 'bootstrap',
        error
      })
      throw error
    } finally {
      try {
        releaseLock()
      } finally {
        await this.#diagnostics.flush()
      }
    }
  }

  async recordCurrentDaemonReady(
    daemonBootId: string
  ): Promise<DetachedAgentLifecycleRecord> {
    const verified = await this.#verifyAndBind()
    const current = this.#processInspector.inspect(this.#currentPid)
    if (current === undefined) {
      throw new Error('Current detached Agent process identity is unavailable')
    }
    const deadline = this.#now() + this.#readinessTimeoutMs
    while (this.#now() <= deadline) {
      const record = this.#readRecord()
      if (
        record !== undefined &&
        record.daemonBootId === null &&
        sameProcessIdentity(record.process, current)
      ) {
        this.#assertRecordBinding(record, verified)
        const ready = detachedAgentLifecycleRecordSchema.parse({
          ...record,
          daemonBootId
        })
        this.#writeRecord(ready)
        return ready
      }
      await this.#sleep(POLL_INTERVAL_MS)
    }
    throw new Error('Detached Agent bootstrap record is unavailable')
  }

  async stop(): Promise<DetachedLifecycleStatus> {
    const verified = await this.#verifyAndBind()
    ensurePrivateDirectory(dirname(this.#stateDirectory))
    ensurePrivateDirectory(this.#stateDirectory)
    const releaseLock = await this.#acquireBootstrapLock()
    try {
      const status = this.#statusAfterVerification(verified)
      if (status.state === 'absent') {
        return status
      }
      if (status.state === 'stale') {
        this.#cleanupRecord(status.record)
      } else {
        await this.#retireLiveRecord(status.record)
      }
      return { state: 'absent' }
    } finally {
      releaseLock()
    }
  }

  async retire(): Promise<DetachedLifecycleStatus> {
    return await this.stop()
  }

  #statusAfterVerification(
    verified: VerifiedInstalledAgentBundle
  ): DetachedLifecycleStatus {
    const record = this.#readRecord()
    if (record === undefined) {
      return { state: 'absent' }
    }
    this.#assertRecordBinding(record, verified)
    if (!this.#processInspector.matches(record.process)) {
      return {
        state: 'stale',
        reason: 'process-identity-mismatch',
        record
      }
    }
    return {
      state: record.daemonBootId === null ? 'starting' : 'ready',
      record
    }
  }

  async #verifyAndBind(): Promise<VerifiedInstalledAgentBundle> {
    const verified = await this.#verifyInstallation()
    if (
      verified.installationId !== this.#installationId ||
      resolve(verified.executablePath) !== this.#executablePath
    ) {
      throw new Error(
        'Signed Agent verification does not match the lifecycle installation'
      )
    }
    return verified
  }

  #assertRecordBinding(
    record: DetachedAgentLifecycleRecord,
    verified: VerifiedInstalledAgentBundle
  ): void {
    if (
      record.installationId !== this.#installationId ||
      record.binaryDigest !== verified.binaryDigest ||
      record.protocol.major !== verified.manifest.protocol.major ||
      record.protocol.minor !== verified.manifest.protocol.minor ||
      record.process.executablePath !== expectedRuntimePath(verified)
    ) {
      throw new Error(
        'Detached Agent lifecycle record does not match the signed installation'
      )
    }
  }

  #readRecord(): DetachedAgentLifecycleRecord | undefined {
    try {
      assertPrivateRegularFile(this.#lifecyclePath)
      return detachedAgentLifecycleRecordSchema.parse(
        JSON.parse(readBoundedPrivateFile(this.#lifecyclePath))
      )
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return undefined
      }
      throw new Error('Detached Agent lifecycle record is corrupt', {
        cause: error
      })
    }
  }

  #writeRecord(record: DetachedAgentLifecycleRecord): void {
    writePrivateFileAtomic(
      this.#lifecyclePath,
      `${JSON.stringify(detachedAgentLifecycleRecordSchema.parse(record), null, 2)}\n`
    )
  }

  async #waitForReady(
    verified: VerifiedInstalledAgentBundle
  ): Promise<DetachedAgentLifecycleRecord | undefined> {
    const deadline = this.#now() + this.#readinessTimeoutMs
    while (this.#now() <= deadline) {
      const status = this.#statusAfterVerification(verified)
      if (status.state === 'ready') {
        try {
          await this.#assertEndpointReady(status.record, verified)
          return status.record
        } catch {
          // The process may have written readiness just before listen completed.
        }
      } else if (status.state === 'absent' || status.state === 'stale') {
        return undefined
      }
      await this.#sleep(POLL_INTERVAL_MS)
    }
    return undefined
  }

  async #assertEndpointReady(
    record: DetachedAgentLifecycleRecord,
    verified: VerifiedInstalledAgentBundle
  ): Promise<void> {
    if (this.#probeEndpoint === undefined) {
      return
    }
    const welcome = await this.#probeEndpoint(verified)
    if (welcome.daemonBootId !== record.daemonBootId) {
      throw new Error(
        'Detached Agent endpoint boot identity does not match lifecycle state'
      )
    }
  }

  async #waitForProcessIdentity(
    pid: number,
    executablePath: string
  ): Promise<LinuxProcessIdentity> {
    const deadline = this.#now() + this.#readinessTimeoutMs
    while (this.#now() <= deadline) {
      const identity = this.#processInspector.inspect(pid)
      if (
        identity !== undefined &&
        identity.executablePath === executablePath
      ) {
        return identity
      }
      await this.#sleep(POLL_INTERVAL_MS)
    }
    throw new Error('Detached Agent process identity could not be established')
  }

  async #waitForExit(
    identity: LinuxProcessIdentity,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = this.#now() + timeoutMs
    while (this.#now() <= deadline) {
      if (!this.#processInspector.matches(identity)) {
        return true
      }
      await this.#sleep(POLL_INTERVAL_MS)
    }
    return !this.#processInspector.matches(identity)
  }

  async #retireLiveRecord(
    record: DetachedAgentLifecycleRecord
  ): Promise<void> {
    if (this.#processInspector.matches(record.process)) {
      this.#processInspector.signal(record.process, 'SIGTERM')
      if (!(await this.#waitForExit(record.process, this.#stopTimeoutMs))) {
        this.#processInspector.signal(record.process, 'SIGKILL')
        await this.#waitForExit(record.process, this.#stopTimeoutMs)
      }
    }
    if (this.#processInspector.matches(record.process)) {
      throw new Error('Detached Agent did not stop')
    }
    this.#cleanupRecord(record)
  }

  #cleanupRecord(record: DetachedAgentLifecycleRecord): void {
    if (this.#processInspector.matches(record.process)) {
      throw new Error('Refusing to clean a live detached Agent lifecycle')
    }
    assertPrivateRegularFile(this.#lifecyclePath)
    const current = detachedAgentLifecycleRecordSchema.parse(
      JSON.parse(readBoundedPrivateFile(this.#lifecyclePath))
    )
    if (!sameLifecycleRecord(current, record)) {
      throw new Error('Detached Agent lifecycle changed during cleanup')
    }
    this.#socketInspector.removeStale(this.#socketPath)
    unlinkSync(this.#lifecyclePath)
  }

  async #acquireBootstrapLock(): Promise<() => void> {
    const deadline = this.#now() + this.#readinessTimeoutMs
    while (this.#now() <= deadline) {
      const descriptor = tryCreateLock(this.#lockPath)
      if (descriptor !== undefined) {
        const owner = this.#processInspector.inspect(this.#currentPid)
        if (owner === undefined) {
          closeSync(descriptor)
          unlinkSync(this.#lockPath)
          throw new Error(
            'Current bootstrap lock process identity is unavailable'
          )
        }
        try {
          writeFileSync(
            descriptor,
            `${JSON.stringify({
              formatVersion: 1,
              installationId: this.#installationId,
              process: owner
            })}\n`,
            'utf8'
          )
          if (process.platform !== 'win32') {
            fchmodSync(descriptor, 0o600)
          }
        } finally {
          closeSync(descriptor)
        }
        return () => this.#releaseBootstrapLock(owner)
      }
      const lock = this.#readLock()
      if (lock === undefined) {
        continue
      }
      if (!this.#processInspector.matches(lock.process)) {
        const current = this.#readLock()
        if (
          current !== undefined &&
          sameProcessIdentity(current.process, lock.process)
        ) {
          unlinkSync(this.#lockPath)
        }
        continue
      }
      await this.#sleep(POLL_INTERVAL_MS)
    }
    throw new Error('Timed out waiting for detached Agent bootstrap lock')
  }

  #readLock(): z.infer<typeof bootstrapLockRecordSchema> | undefined {
    try {
      assertPrivateRegularFile(this.#lockPath)
      const lock = bootstrapLockRecordSchema.parse(
        JSON.parse(readBoundedPrivateFile(this.#lockPath))
      )
      if (lock.installationId !== this.#installationId) {
        throw new Error(
          'Detached Agent bootstrap lock belongs to another installation'
        )
      }
      return lock
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return undefined
      }
      throw new Error('Detached Agent bootstrap lock is corrupt', {
        cause: error
      })
    }
  }

  #releaseBootstrapLock(owner: LinuxProcessIdentity): void {
    const lock = this.#readLock()
    if (
      lock !== undefined &&
      sameProcessIdentity(lock.process, owner)
    ) {
      unlinkSync(this.#lockPath)
    }
  }
}

function spawnDetachedProcess(
  executable: string,
  argv: readonly string[],
  options: {
    env: Readonly<NodeJS.ProcessEnv>
    detached: true
    shell: false
    stdio: 'ignore'
    cwd: string
  }
): ReturnType<DetachedSpawn> {
  return spawn(executable, [...argv], options)
}

function detachedEnvironment(
  source: Readonly<NodeJS.ProcessEnv>
): Readonly<NodeJS.ProcessEnv> {
  const allowed = [
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOGNAME',
    'PATH',
    'TMPDIR',
    'TZ',
    'USER'
  ] as const
  const env: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    const value = source[key]
    if (value !== undefined && !value.includes('\0')) {
      env[key] = value
    }
  }
  return env
}

function expectedRuntimePath(
  verified: VerifiedInstalledAgentBundle
): string {
  return assertAbsoluteManagedPath(
    resolve(
      verified.installationDirectory,
      verified.manifest.entrypoint.runtimePath
    )
  )
}

class FileSystemSocketInspector implements DetachedSocketInspector {
  removeStale(path: string): boolean {
    try {
      const stat = lstatSync(path)
      const uid = process.getuid?.()
      if (
        !stat.isSocket() ||
        stat.isSymbolicLink() ||
        (uid !== undefined && stat.uid !== uid)
      ) {
        throw new Error('Refusing to remove an unrelated endpoint path')
      }
      unlinkSync(path)
      return true
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return false
      }
      throw error
    }
  }
}

function tryCreateLock(path: string): number | undefined {
  try {
    return openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    )
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      return undefined
    }
    throw error
  }
}

function readBoundedPrivateFile(path: string): string {
  return readPrivateFile(path, 64 * 1024).toString('utf8')
}

function sameProcessIdentity(
  left: LinuxProcessIdentity,
  right: LinuxProcessIdentity
): boolean {
  return (
    left.pid === right.pid &&
    left.starttime === right.starttime &&
    left.executablePath === right.executablePath
  )
}

function sameLifecycleRecord(
  left: DetachedAgentLifecycleRecord,
  right: DetachedAgentLifecycleRecord
): boolean {
  return (
    sameProcessIdentity(left.process, right.process) &&
    left.daemonBootId === right.daemonBootId &&
    left.createdAt === right.createdAt
  )
}

function validateInstallationId(value: string): string {
  if (
    value.length > 128 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/u.test(value)
  ) {
    throw new Error('Invalid Agent installation ID')
  }
  return value
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 120_000) {
    throw new Error('Detached Agent timeout is invalid')
  }
  return value
}

function positivePid(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Detached Agent process ID is invalid')
  }
  return value
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
