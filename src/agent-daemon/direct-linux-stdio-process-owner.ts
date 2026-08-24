import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { posix } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  agentIdentifierSchema,
  sha256DigestSchema
} from '../shared/agent-protocol/contracts'
import { canonicalJson } from '../shared/agent-protocol/canonical'
import {
  remoteRuntimeBundleManifestSchema,
  type RemoteRuntimeBundleManifest
} from '../shared/remote-runtime-launch-contracts'
import type { ModelBridgePolicy } from '../shared/model-bridge-contracts'
import {
  createOpenCodeLaunchProfile,
  OPENCODE_BWRAP_EXECUTABLE,
  type OpenCodeLaunchProfile
} from './opencode-runtime-profile'
import {
  RuntimeOwnerRegistry
} from './runtime-owner-registry'
import {
  readLinuxRuntimeProcessIdentity,
  sameLinuxRuntimeProcessIdentity,
  type LinuxRuntimeProcessIdentity
} from './runtime-process-identity'

const DEFAULT_MAXIMUM_STDIN_WRITE_BYTES = 1024 * 1024
const DEFAULT_MAXIMUM_OUTPUT_QUEUE_CHUNKS = 128
const DEFAULT_MAXIMUM_LISTENERS = 8
const DEFAULT_STOP_TIMEOUT_MS = 10_000
const TERM_GRACE_MS = 2_000
const POLL_INTERVAL_MS = 25
const OWNER_TOKEN_ENVIRONMENT_NAME = 'GOODBUDDY_RUNTIME_OWNER_TOKEN'

export type DirectLinuxStdioProcessIdentity = {
  launchId: string
  processId: string
  supervisorIdentityDigest: string
}

export type DirectLinuxStdioProcessOutput = {
  stream: 'stdout' | 'stderr'
  data: Uint8Array
}

export type DirectLinuxStdioProcessReconciliation = {
  identity: DirectLinuxStdioProcessIdentity
  state:
    | 'starting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'outcome-unknown'
  processTree: 'running' | 'empty' | 'unknown'
}

export type DirectLinuxStdioChild = {
  pid?: number
  stdin: Writable
  stdout: Readable
  stderr: Readable
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown
}

export type DirectLinuxStdioSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    shell: false
    detached: true
    windowsHide: true
    cwd: string
    stdio: readonly ['pipe', 'pipe', 'pipe']
    env: Readonly<NodeJS.ProcessEnv>
  }
) => DirectLinuxStdioChild

export type DirectLinuxStdioProcessOwnerOptions = {
  manifest: RemoteRuntimeBundleManifest
  profile?: OpenCodeLaunchProfile
  profileInput?: {
    bundleDirectory: string
    workspaceDirectory: string
    scratchDirectory: string
    workMode: 'ask' | 'execute'
    modelBridge?: {
      agentExecutablePath: string
      bridgeDirectory: string
      socketPath: string
      policy: ModelBridgePolicy
    }
  }
  identity: { launchId: string; processId: string }
  installationId: string
  registry: RuntimeOwnerRegistry
  deadlineAt: string
  maximumInputBytes: number
  signal?: AbortSignal
  platform?: NodeJS.Platform
  spawn?: DirectLinuxStdioSpawn
  now?: () => number
  randomOwnerToken?: () => string
  readProcessIdentity?: typeof readLinuxRuntimeProcessIdentity
  listPidNamespaceMembers?: typeof listLinuxPidNamespaceMembers
  sendSignal?: typeof process.kill
  maximumStdinWriteBytes?: number
  maximumPendingStdinBytes?: number
  maximumOutputQueueChunks?: number
  maximumListeners?: number
}

export class DirectLinuxStdioProcessOwnerError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'capacity'
      | 'closed'
      | 'deadline'
      | 'identity'
      | 'platform'
      | 'process'
  ) {
    super(message)
    this.name = 'DirectLinuxStdioProcessOwnerError'
  }
}

export class DirectLinuxStdioProcessOwner {
  readonly identity: DirectLinuxStdioProcessIdentity
  readonly ownerId: string
  readonly processIdentity: LinuxRuntimeProcessIdentity

  readonly #child: DirectLinuxStdioChild
  readonly #registry: RuntimeOwnerRegistry
  readonly #now: () => number
  readonly #readIdentity: typeof readLinuxRuntimeProcessIdentity
  readonly #listMembers: typeof listLinuxPidNamespaceMembers
  readonly #sendSignal: typeof process.kill
  readonly #maximumOutputBytes: number
  readonly #maximumPromptInputBytes: number
  readonly #maximumPromptRuntimeMilliseconds: number
  readonly #maximumStdinWriteBytes: number
  readonly #maximumOutputQueueChunks: number
  readonly #maximumListeners: number
  readonly #outputListeners = new Set<
    (output: DirectLinuxStdioProcessOutput) => void | Promise<void>
  >()
  readonly #exitListeners = new Set<() => void | Promise<void>>()
  readonly #outputQueue: Uint8Array[] = []
  #maximumInputBytes: number
  #maximumPendingStdinBytes: number
  #inputBytes = 0
  #pendingInputBytes = 0
  #outputBytes = 0
  #queuedOutputBytes = 0
  #writeTail: Promise<void> = Promise.resolve()
  #deadlineTimer?: NodeJS.Timeout
  #promptGeneration = 1
  #promptActive = true
  #draining = false
  #closed = false
  #stdinClosed = false
  #stopPromise?: Promise<void>
  #terminalState?: 'completed' | 'failed' | 'cancelled'

  constructor(input: {
    identity: DirectLinuxStdioProcessIdentity
    ownerId: string
    processIdentity: LinuxRuntimeProcessIdentity
    child: DirectLinuxStdioChild
    registry: RuntimeOwnerRegistry
    now: () => number
    readProcessIdentity: typeof readLinuxRuntimeProcessIdentity
    listPidNamespaceMembers: typeof listLinuxPidNamespaceMembers
    sendSignal: typeof process.kill
    maximumInputBytes: number
    maximumPendingStdinBytes: number
    maximumStdinWriteBytes: number
    maximumOutputBytes: number
    maximumPromptInputBytes: number
    maximumPromptRuntimeMilliseconds: number
    maximumOutputQueueChunks: number
    maximumListeners: number
    deadlineAt: string
    signal?: AbortSignal
  }) {
    this.identity = input.identity
    this.ownerId = input.ownerId
    this.processIdentity = Object.freeze({ ...input.processIdentity })
    this.#child = input.child
    this.#registry = input.registry
    this.#now = input.now
    this.#readIdentity = input.readProcessIdentity
    this.#listMembers = input.listPidNamespaceMembers
    this.#sendSignal = input.sendSignal
    this.#maximumInputBytes = input.maximumInputBytes
    this.#maximumPendingStdinBytes = input.maximumPendingStdinBytes
    this.#maximumStdinWriteBytes = input.maximumStdinWriteBytes
    this.#maximumOutputBytes = input.maximumOutputBytes
    this.#maximumPromptInputBytes = input.maximumPromptInputBytes
    this.#maximumPromptRuntimeMilliseconds =
      input.maximumPromptRuntimeMilliseconds
    this.#maximumOutputQueueChunks = input.maximumOutputQueueChunks
    this.#maximumListeners = input.maximumListeners
    this.#scheduleDeadline(input.deadlineAt)
    input.child.stdout.on('data', (chunk: Buffer | Uint8Array) => {
      this.#acceptOutput(chunk)
    })
    // Stderr is deliberately drained but never forwarded into ACP.
    input.child.stderr.on('data', () => undefined)
    input.child.on('close', (code) => this.#handleClose(code))
  }

  async writeStdin(payload: Uint8Array): Promise<void> {
    if (!(payload instanceof Uint8Array) || payload.byteLength === 0) {
      throw capacityError('ACP stdin payload must be non-empty bytes')
    }
    if (
      this.#closed ||
      this.#stdinClosed ||
      this.#stopPromise !== undefined ||
      !this.#promptActive
    ) {
      throw new DirectLinuxStdioProcessOwnerError('Runtime stdin is closed', 'closed')
    }
    if (
      payload.byteLength > this.#maximumStdinWriteBytes ||
      this.#inputBytes + payload.byteLength > this.#maximumInputBytes ||
      this.#pendingInputBytes + payload.byteLength > this.#maximumPendingStdinBytes
    ) {
      throw capacityError('Runtime stdin quota reached')
    }
    const copy = Buffer.from(payload)
    this.#inputBytes += copy.byteLength
    this.#pendingInputBytes += copy.byteLength
    const write = this.#writeTail.then(async () => {
      if (this.#closed || this.#stdinClosed || !this.#promptActive) {
        throw new DirectLinuxStdioProcessOwnerError('Runtime stdin is closed', 'closed')
      }
      await writeWithBackpressure(this.#child.stdin, copy)
    })
    this.#writeTail = write.catch(() => undefined)
    try {
      await write
    } finally {
      this.#pendingInputBytes -= copy.byteLength
    }
  }

  beginPrompt(input: { deadlineAt: string; maximumInputBytes: number }): void {
    if (this.#closed || this.#stdinClosed || this.#promptActive) {
      throw new DirectLinuxStdioProcessOwnerError(
        this.#promptActive ? 'A Runtime prompt is already active' : 'Runtime process is closed',
        this.#promptActive ? 'identity' : 'closed'
      )
    }
    this.#maximumInputBytes = positiveInteger(
      Math.min(input.maximumInputBytes, this.#maximumPromptInputBytes),
      'Maximum Runtime input bytes'
    )
    this.#maximumPendingStdinBytes = this.#maximumInputBytes
    this.#inputBytes = 0
    this.#pendingInputBytes = 0
    this.#outputBytes = 0
    this.#promptActive = true
    this.#promptGeneration += 1
    this.#scheduleDeadline(
      boundedPromptDeadline(
        input.deadlineAt,
        this.#now(),
        this.#maximumPromptRuntimeMilliseconds
      )
    )
  }

  async completePrompt(): Promise<void> {
    if (!this.#promptActive) return
    await this.#writeTail
    this.#promptActive = false
    this.#inputBytes = 0
    this.#pendingInputBytes = 0
    this.#promptGeneration += 1
    this.#clearDeadline()
  }

  subscribeOutput(
    listener: (output: DirectLinuxStdioProcessOutput) => void | Promise<void>
  ): () => void {
    if (this.#outputListeners.size >= this.#maximumListeners) {
      throw capacityError('Runtime output listener capacity reached')
    }
    this.#outputListeners.add(listener)
    this.#scheduleDrain()
    return () => this.#outputListeners.delete(listener)
  }

  subscribeExit(listener: () => void | Promise<void>): () => void {
    if (this.#closed) {
      void Promise.resolve(listener()).catch(() => undefined)
      return () => undefined
    }
    if (this.#exitListeners.size >= this.#maximumListeners) {
      throw capacityError('Runtime exit listener capacity reached')
    }
    this.#exitListeners.add(listener)
    return () => this.#exitListeners.delete(listener)
  }

  async stop(input: {
    reason:
      | 'binding-closed'
      | 'controller-disconnected'
      | 'deadline-exceeded'
      | 'identity-conflict'
      | 'output-quota'
      | 'user-cancelled'
    deadlineAt: string
  }): Promise<void> {
    if (this.#stopPromise !== undefined) return await this.#stopPromise
    this.#stopPromise = this.#stopOnce(input.deadlineAt)
    try {
      await this.#stopPromise
    } catch (error) {
      this.#stopPromise = undefined
      throw error
    }
  }

  async dispose(): Promise<void> {
    await this.stop({
      reason: 'binding-closed',
      deadlineAt: new Date(this.#now() + DEFAULT_STOP_TIMEOUT_MS).toISOString()
    })
  }

  async reconcile(): Promise<DirectLinuxStdioProcessReconciliation> {
    if (this.#terminalState !== undefined) {
      return {
        identity: this.identity,
        state: this.#terminalState,
        processTree: 'empty'
      }
    }
    try {
      const actual = await this.#readIdentity(this.processIdentity.pid)
      if (!sameLinuxRuntimeProcessIdentity(this.processIdentity, actual)) {
        return {
          identity: this.identity,
          state: 'outcome-unknown',
          processTree: 'unknown'
        }
      }
      return { identity: this.identity, state: 'running', processTree: 'running' }
    } catch (error) {
      if (isMissingProcess(error) && this.#closed) {
        return {
          identity: this.identity,
          state: this.#terminalState ?? 'interrupted',
          processTree: 'empty'
        }
      }
      return {
        identity: this.identity,
        state: 'outcome-unknown',
        processTree: 'unknown'
      }
    }
  }

  async #stopOnce(deadlineAt: string): Promise<void> {
    remainingMilliseconds(deadlineAt, this.#now())
    if (this.#terminalState !== undefined) return
    const record = this.#registry.get(this.ownerId)
    if (record?.state !== 'running') {
      throw identityError('Runtime owner registry identity conflicts')
    }
    const actual = await this.#readIdentity(this.processIdentity.pid)
    if (
      record.processIdentity === undefined ||
      !sameLinuxRuntimeProcessIdentity(record.processIdentity, actual)
    ) {
      this.#registry.remove(this.ownerId, 'running')
      throw identityError('Runtime PID identity changed before signal')
    }
    this.#registry.markStopping(this.ownerId)
    this.#stdinClosed = true
    this.#child.stdin.end()
    this.#sendSignal(-record.processIdentity.processGroupId, 'SIGTERM')
    const termDeadline = Math.min(Date.parse(deadlineAt), this.#now() + TERM_GRACE_MS)
    if (!(await this.#waitForTreeEmpty(termDeadline))) {
      await this.#killVerifiedProcessGroup()
      if (!(await this.#waitForTreeEmpty(Date.parse(deadlineAt)))) {
        this.#registry.remove(this.ownerId, 'stopping')
        throw new DirectLinuxStdioProcessOwnerError(
          'Runtime process group cleanup could not be verified',
          'process'
        )
      }
    }
    this.#registry.remove(this.ownerId, 'stopping')
    this.#terminalState = 'cancelled'
    this.#closed = true
    this.#clearDeadline()
  }

  async #killVerifiedProcessGroup(): Promise<void> {
    const record = this.#registry.get(this.ownerId)
    const actual = await this.#readIdentity(this.processIdentity.pid)
    if (
      record?.state !== 'stopping' ||
      record.processIdentity === undefined ||
      !sameLinuxRuntimeProcessIdentity(record.processIdentity, actual)
    ) {
      if (record?.state === 'stopping') {
        this.#registry.remove(this.ownerId, 'stopping')
      }
      throw identityError('Runtime PID identity changed before signal')
    }
    this.#sendSignal(-record.processIdentity.processGroupId, 'SIGKILL')
  }

  async #waitForTreeEmpty(deadline: number): Promise<boolean> {
    while (this.#now() < deadline) {
      const members = await this.#listMembers(this.processIdentity)
      if (members.length === 0) return true
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - this.#now())))
    }
    return (await this.#listMembers(this.processIdentity)).length === 0
  }

  #acceptOutput(chunk: Buffer | Uint8Array): void {
    if (this.#closed || chunk.byteLength === 0) return
    if (
      this.#outputBytes + chunk.byteLength > this.#maximumOutputBytes ||
      this.#outputQueue.length >= this.#maximumOutputQueueChunks ||
      this.#queuedOutputBytes + chunk.byteLength > this.#maximumOutputBytes
    ) {
      this.#child.stdout.pause()
      this.#outputQueue.splice(0)
      this.#queuedOutputBytes = 0
      void this.stop({
        reason: 'output-quota',
        deadlineAt: new Date(this.#now() + DEFAULT_STOP_TIMEOUT_MS).toISOString()
      }).catch(() => undefined)
      return
    }
    const copy = Uint8Array.from(chunk)
    this.#outputBytes += copy.byteLength
    this.#queuedOutputBytes += copy.byteLength
    this.#outputQueue.push(copy)
    this.#scheduleDrain()
  }

  #scheduleDrain(): void {
    if (this.#draining || this.#outputListeners.size === 0 || this.#outputQueue.length === 0) return
    this.#draining = true
    queueMicrotask(() => void this.#drain())
  }

  async #drain(): Promise<void> {
    try {
      while (this.#outputListeners.size > 0 && this.#outputQueue.length > 0) {
        const data = this.#outputQueue.shift()!
        this.#queuedOutputBytes -= data.byteLength
        for (const listener of [...this.#outputListeners]) {
          await listener({ stream: 'stdout', data: data.slice() })
        }
      }
    } catch {
      void this.stop({
        reason: 'output-quota',
        deadlineAt: new Date(this.#now() + DEFAULT_STOP_TIMEOUT_MS).toISOString()
      }).catch(() => undefined)
    } finally {
      this.#draining = false
      this.#scheduleDrain()
    }
  }

  #handleClose(code: number | null): void {
    this.#closed = true
    this.#clearDeadline()
    const record = this.#registry.get(this.ownerId)
    if (record?.state === 'running') {
      const outcome = code === 0 ? 'completed' : 'failed'
      this.#registry.remove(this.ownerId, 'running')
      this.#terminalState = outcome
    }
    for (const listener of this.#exitListeners) {
      void Promise.resolve(listener()).catch(() => undefined)
    }
    this.#exitListeners.clear()
  }

  #scheduleDeadline(deadlineAt: string): void {
    const remaining = remainingMilliseconds(deadlineAt, this.#now())
    this.#clearDeadline()
    const generation = this.#promptGeneration
    this.#deadlineTimer = setTimeout(() => {
      if (!this.#promptActive || generation !== this.#promptGeneration) return
      void this.stop({
        reason: 'deadline-exceeded',
        deadlineAt: new Date(this.#now() + DEFAULT_STOP_TIMEOUT_MS).toISOString()
      }).catch(() => undefined)
    }, Math.min(remaining, 0x7fff_ffff))
    this.#deadlineTimer.unref?.()
  }

  #clearDeadline(): void {
    if (this.#deadlineTimer !== undefined) clearTimeout(this.#deadlineTimer)
    this.#deadlineTimer = undefined
  }

}

export async function launchDirectLinuxStdioProcessOwner(
  options: DirectLinuxStdioProcessOwnerOptions
): Promise<DirectLinuxStdioProcessOwner> {
  if ((options.platform ?? process.platform) !== 'linux') {
    throw new DirectLinuxStdioProcessOwnerError(
      'Direct Runtime ownership is Linux-only',
      'platform'
    )
  }
  if (options.signal?.aborted === true) {
    throw new DirectLinuxStdioProcessOwnerError('Runtime launch was cancelled', 'deadline')
  }
  const now = options.now ?? Date.now
  const manifest = remoteRuntimeBundleManifestSchema.parse(options.manifest)
  const limits = enforceablePromptLimits(manifest)
  const effectiveDeadlineAt = boundedPromptDeadline(
    options.deadlineAt,
    now(),
    limits.maximumPromptRuntimeMilliseconds
  )
  const timeoutMs = remainingMilliseconds(effectiveDeadlineAt, now())
  const baseProfile = resolveProfile(options, manifest)
  const ownerToken = (options.randomOwnerToken ?? (() => randomBytes(16).toString('hex')))()
  if (!/^[a-f0-9]{32}$/u.test(ownerToken)) {
    throw identityError('Runtime owner token marker is malformed')
  }
  const profile = bindDirectOwnerToken(baseProfile, ownerToken)
  const stableIdentity = {
    launchId: agentIdentifierSchema.parse(options.identity.launchId),
    processId: agentIdentifierSchema.parse(options.identity.processId)
  }
  const installationId = agentIdentifierSchema.parse(options.installationId)
  const ownerId = `owner-${stableIdentity.launchId}`
  agentIdentifierSchema.parse(ownerId)
  const maximumInputBytes = positiveInteger(
    Math.min(options.maximumInputBytes, limits.maximumPromptInputBytes),
    'Maximum Runtime input bytes'
  )
  const maximumStdinWriteBytes = positiveInteger(
    options.maximumStdinWriteBytes ?? DEFAULT_MAXIMUM_STDIN_WRITE_BYTES,
    'Maximum Runtime stdin write bytes'
  )
  const maximumPendingStdinBytes = positiveInteger(
    options.maximumPendingStdinBytes ?? maximumInputBytes,
    'Maximum pending Runtime stdin bytes'
  )
  const maximumOutputQueueChunks = positiveInteger(
    options.maximumOutputQueueChunks ?? DEFAULT_MAXIMUM_OUTPUT_QUEUE_CHUNKS,
    'Maximum Runtime output queue chunks'
  )
  const maximumListeners = positiveInteger(
    options.maximumListeners ?? DEFAULT_MAXIMUM_LISTENERS,
    'Maximum Runtime output listeners'
  )
  options.registry.reserve({
    ownerId,
    ...stableIdentity,
    installationId,
    ownerToken
  })
  const spawn = options.spawn ?? defaultSpawn
  const child = spawn(profile.executable, profile.args, {
    shell: false,
    detached: true,
    windowsHide: true,
    cwd: profile.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: profile.env
  })
  try {
    await waitForSpawn(child, options.signal, timeoutMs)
    if (child.pid === undefined) throw new Error('Runtime spawn did not return a PID')
    const readIdentity = options.readProcessIdentity ?? readLinuxRuntimeProcessIdentity
    const processIdentity = await readIdentity(child.pid)
    assertLaunchedIdentity(processIdentity, profile)
    const supervisorIdentityDigest = supervisorDigest({
      installationId,
      ownerId,
      ownerToken,
      processIdentity,
      profile
    })
    options.registry.markRunning(ownerId, processIdentity)
    return new DirectLinuxStdioProcessOwner({
      identity: { ...stableIdentity, supervisorIdentityDigest },
      ownerId,
      processIdentity,
      child,
      registry: options.registry,
      now,
      readProcessIdentity: readIdentity,
      listPidNamespaceMembers:
        options.listPidNamespaceMembers ?? listLinuxPidNamespaceMembers,
      sendSignal: options.sendSignal ?? process.kill,
      maximumInputBytes,
      maximumPendingStdinBytes,
      maximumStdinWriteBytes,
      maximumOutputBytes: manifest.limits.maximumPromptOutputBytes,
      maximumPromptInputBytes: limits.maximumPromptInputBytes,
      maximumPromptRuntimeMilliseconds:
        limits.maximumPromptRuntimeMilliseconds,
      maximumOutputQueueChunks,
      maximumListeners,
      deadlineAt: effectiveDeadlineAt,
      signal: options.signal
    })
  } catch (error) {
    const record = options.registry.get(ownerId)
    if (record?.state === 'reserved') {
      options.registry.remove(ownerId, 'reserved')
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    throw error
  }
}

export async function reconcileOrphanedDirectLinuxStdioProcesses(options: {
  installationId: string
  registry: RuntimeOwnerRegistry
  deadlineAt?: string
  now?: () => number
  readProcessIdentity?: typeof readLinuxRuntimeProcessIdentity
  listPidNamespaceMembers?: typeof listLinuxPidNamespaceMembers
  sendSignal?: typeof process.kill
}): Promise<{ inspected: number; stopped: number; conflicts: number; unknown: number }> {
  const installationId = agentIdentifierSchema.parse(options.installationId)
  const now = options.now ?? Date.now
  const deadlineAt =
    options.deadlineAt ?? new Date(now() + 30_000).toISOString()
  const records = options.registry
    .listForInstallation(installationId)
  let stopped = 0
  let conflicts = 0
  let unknown = 0
  const sendSignal = options.sendSignal ?? process.kill
  for (const record of records) {
    remainingMilliseconds(deadlineAt, now())
    if (record.state === 'reserved' || record.processIdentity === undefined) {
      options.registry.remove(record.ownerId, record.state)
      stopped += 1
      continue
    }
    const readIdentity = options.readProcessIdentity ?? readLinuxRuntimeProcessIdentity
    try {
      const actual = await readIdentity(record.processIdentity.pid)
      if (!sameLinuxRuntimeProcessIdentity(record.processIdentity, actual)) {
        options.registry.remove(record.ownerId, record.state)
        conflicts += 1
        continue
      }
      if (record.state === 'running') options.registry.markStopping(record.ownerId)
      sendSignal(
        -record.processIdentity.processGroupId,
        'SIGTERM'
      )
      const listMembers = options.listPidNamespaceMembers ?? listLinuxPidNamespaceMembers
      const termDeadline = Math.min(Date.parse(deadlineAt), now() + TERM_GRACE_MS)
      if (!(await waitForNamespaceEmpty(record.processIdentity, listMembers, termDeadline, now))) {
        const current = options.registry.get(record.ownerId)
        const ownerIdentity = await readIdentity(record.processIdentity.pid)
        if (
          current?.state !== 'stopping' ||
          current.processIdentity === undefined ||
          !sameLinuxRuntimeProcessIdentity(current.processIdentity, ownerIdentity)
        ) {
          throw identityError('Orphan Runtime identity changed before signal')
        }
        sendSignal(-record.processIdentity.processGroupId, 'SIGKILL')
        if (!(await waitForNamespaceEmpty(record.processIdentity, listMembers, Date.parse(deadlineAt), now))) {
          throw new Error('Orphan Runtime process group remains populated')
        }
      }
      options.registry.remove(record.ownerId, 'stopping')
      stopped += 1
    } catch (error) {
      const current = options.registry.get(record.ownerId)
      if (isMissingProcess(error) && current !== undefined) {
        try {
          const listMembers =
            options.listPidNamespaceMembers ??
            listLinuxPidNamespaceMembers
          const members = await listMembers(record.processIdentity)
          if (members.length === 0) {
            options.registry.remove(record.ownerId, current.state)
            stopped += 1
          } else {
            // Without the recorded leader identity there is no safe process
            // to match immediately before a group signal.
            options.registry.remove(record.ownerId, current.state)
            unknown += 1
          }
        } catch {
          const latest = options.registry.get(record.ownerId)
          if (latest !== undefined) options.registry.remove(record.ownerId, latest.state)
          unknown += 1
        }
      } else if (error instanceof DirectLinuxStdioProcessOwnerError && error.code === 'identity') {
        if (current !== undefined) options.registry.remove(record.ownerId, current.state)
        conflicts += 1
      } else {
        if (current !== undefined) options.registry.remove(record.ownerId, current.state)
        unknown += 1
      }
    }
  }
  return { inspected: records.length, stopped, conflicts, unknown }
}

export function bindDirectOwnerToken(
  profileInput: OpenCodeLaunchProfile,
  ownerToken: string
): OpenCodeLaunchProfile {
  const profile = validateProfile(profileInput)
  if (
    !/^[a-f0-9]{32}$/u.test(ownerToken) ||
    profile.args.includes(OWNER_TOKEN_ENVIRONMENT_NAME) ||
    profile.env[OWNER_TOKEN_ENVIRONMENT_NAME] !== undefined
  ) {
    throw identityError('Runtime owner token marker is invalid or duplicated')
  }
  if (profile.workMode === 'execute') {
    return {
      ...profile,
      env: {
        ...profile.env,
        [OWNER_TOKEN_ENVIRONMENT_NAME]: ownerToken
      }
    }
  }
  const separator = profile.args.indexOf('--')
  return {
    ...profile,
    args: [
      ...profile.args.slice(0, separator),
      '--setenv',
      OWNER_TOKEN_ENVIRONMENT_NAME,
      ownerToken,
      ...profile.args.slice(separator)
    ],
    env: { ...profile.env }
  }
}

export async function listLinuxPidNamespaceMembers(
  owner: Pick<
    LinuxRuntimeProcessIdentity,
    'bootId' | 'processGroupId'
  >,
  options: { procRoot?: string } = {}
): Promise<LinuxRuntimeProcessIdentity[]> {
  const procRoot = options.procRoot ?? '/proc'
  const entries = await readdir(procRoot, { withFileTypes: true })
  const identities: LinuxRuntimeProcessIdentity[] = []
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/u.test(entry.name))
      .map(async (entry) => {
        try {
          const identity = await readLinuxRuntimeProcessIdentity(Number(entry.name), {
            procRoot,
            bootId: owner.bootId
          })
          if (identity.processGroupId === owner.processGroupId) {
            identities.push(identity)
          }
        } catch (error) {
          if (!isMissingProcess(error)) throw error
        }
      })
  )
  return identities.sort((left, right) => left.pid - right.pid)
}

function resolveProfile(
  options: DirectLinuxStdioProcessOwnerOptions,
  manifest: RemoteRuntimeBundleManifest
): OpenCodeLaunchProfile {
  if ((options.profile === undefined) === (options.profileInput === undefined)) {
    throw identityError('Exactly one Runtime launch profile source is required')
  }
  return validateProfile(
    options.profile ??
      createOpenCodeLaunchProfile({ manifest, ...options.profileInput! })
  )
}

function validateProfile(profile: OpenCodeLaunchProfile): OpenCodeLaunchProfile {
  if (
    !posix.isAbsolute(profile.executable) ||
    posix.normalize(profile.executable) !== profile.executable ||
    !posix.isAbsolute(profile.processExecutable) ||
    posix.normalize(profile.processExecutable) !==
      profile.processExecutable ||
    !posix.isAbsolute(profile.cwd) ||
    posix.normalize(profile.cwd) !== profile.cwd ||
    profile.args.length === 0 ||
    profile.args.some((argument) => typeof argument !== 'string' || argument.includes('\0')) ||
    Object.entries(profile.env).some(
      ([name, value]) =>
        name.includes('\0') ||
        (value !== undefined && value.includes('\0'))
    )
  ) {
    throw identityError('Runtime launch profile is malformed')
  }
  if (
    profile.workMode === 'ask' &&
    (
      profile.executable !== OPENCODE_BWRAP_EXECUTABLE ||
      profile.args.includes(['--die', 'with-parent'].join('-')) ||
      !profile.args.includes('--unshare-all') ||
      !profile.args.includes('--new-session') ||
      !profile.args.includes('--clearenv') ||
      !profile.args.includes('--ro-bind') ||
      profile.args.filter((argument) => argument === '--').length !== 1
    )
  ) {
    throw identityError('Ask Runtime launch profile is not read-only')
  }
  if (
    profile.workMode === 'execute' &&
    (
      profile.executable === OPENCODE_BWRAP_EXECUTABLE ||
      profile.args.includes('--unshare-all') ||
      profile.args.includes('--clearenv') ||
      profile.args.includes('--ro-bind') ||
      profile.args.includes('--bind')
    )
  ) {
    throw identityError('Execute Runtime launch profile must run directly')
  }
  return {
    executable: profile.executable,
    processExecutable: profile.processExecutable,
    args: [...profile.args],
    cwd: profile.cwd,
    env: { ...profile.env },
    workMode: profile.workMode
  }
}

function assertLaunchedIdentity(
  identity: LinuxRuntimeProcessIdentity,
  profile: OpenCodeLaunchProfile
): void {
  if (
    identity.executablePath !== profile.processExecutable ||
    identity.processGroupId !== identity.pid
  ) {
    throw identityError('Spawned Runtime does not match the launch identity')
  }
}

function supervisorDigest(input: {
  installationId: string
  ownerId: string
  ownerToken: string
  processIdentity: LinuxRuntimeProcessIdentity
  profile: OpenCodeLaunchProfile
}): string {
  return canonicalDigest({
    installationId: input.installationId,
    ownerId: input.ownerId,
    ownerToken: input.ownerToken,
    processIdentity: {
      ...input.processIdentity,
      startTimeTicks: input.processIdentity.startTimeTicks.toString()
    },
    profile: input.profile
  })
}

function canonicalDigest(value: unknown): string {
  return sha256DigestSchema.parse(
    `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
  )
}

function defaultSpawn(
  executable: string,
  args: readonly string[],
  options: Parameters<DirectLinuxStdioSpawn>[2]
): DirectLinuxStdioChild {
  return nodeSpawn(executable, [...args], options)
}

async function waitForSpawn(
  child: DirectLinuxStdioChild,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      callback()
    }
    const abort = (): void => finish(() => reject(
      new DirectLinuxStdioProcessOwnerError('Runtime launch was cancelled', 'deadline')
    ))
    const timer = setTimeout(abort, timeoutMs)
    timer.unref?.()
    child.once('spawn', () => finish(resolve))
    child.once('error', (error) => finish(() => reject(error)))
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function waitForNamespaceEmpty(
  identity: LinuxRuntimeProcessIdentity,
  listMembers: typeof listLinuxPidNamespaceMembers,
  deadline: number,
  now: () => number
): Promise<boolean> {
  while (now() < deadline) {
    if ((await listMembers(identity)).length === 0) return true
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())))
  }
  return (await listMembers(identity)).length === 0
}

async function writeWithBackpressure(stream: Writable, payload: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let callbackComplete = false
    let drained = true
    let settled = false
    const cleanup = (): void => {
      stream.removeListener('drain', onDrain)
      stream.removeListener('error', onError)
      stream.removeListener('close', onClose)
    }
    const finish = (): void => {
      if (settled || !callbackComplete || !drained) return
      settled = true
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onClose = (): void => onError(
      new DirectLinuxStdioProcessOwnerError('Runtime stdin closed during write', 'closed')
    )
    const onDrain = (): void => {
      drained = true
      finish()
    }
    stream.once('error', onError)
    stream.once('close', onClose)
    if (!stream.write(payload, (error?: Error | null) => {
      if (error != null) onError(error)
      else {
        callbackComplete = true
        finish()
      }
    })) {
      drained = false
      stream.once('drain', onDrain)
    }
  })
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw capacityError(`${label} must be positive`)
  return value
}

function remainingMilliseconds(deadlineAt: string, now: number): number {
  const deadline = Date.parse(deadlineAt)
  const remaining = deadline - now
  if (!Number.isFinite(deadline) || !Number.isSafeInteger(remaining) || remaining <= 0) {
    throw new DirectLinuxStdioProcessOwnerError('Runtime operation deadline elapsed', 'deadline')
  }
  return Math.min(remaining, 120_000)
}

function enforceablePromptLimits(manifest: RemoteRuntimeBundleManifest): {
  maximumPromptRuntimeMilliseconds: number
  maximumPromptInputBytes: number
} {
  return {
    maximumPromptRuntimeMilliseconds:
      manifest.limits.maximumPromptRuntimeMilliseconds,
    maximumPromptInputBytes:
      manifest.limits.maximumPromptInputBytes
  }
}

function boundedPromptDeadline(
  requestedDeadlineAt: string,
  now: number,
  maximumRuntimeMilliseconds: number
): string {
  const requested = Date.parse(requestedDeadlineAt)
  if (!Number.isFinite(requested) || requested <= now) {
    throw new DirectLinuxStdioProcessOwnerError(
      'Runtime operation deadline elapsed',
      'deadline'
    )
  }
  return new Date(
    Math.min(requested, now + maximumRuntimeMilliseconds)
  ).toISOString()
}

function capacityError(message: string): DirectLinuxStdioProcessOwnerError {
  return new DirectLinuxStdioProcessOwnerError(message, 'capacity')
}

function identityError(message: string): DirectLinuxStdioProcessOwnerError {
  return new DirectLinuxStdioProcessOwnerError(message, 'identity')
}

function isMissingProcess(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    ['ENOENT', 'ESRCH'].includes(String(error.code))
  )
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
