import { constants } from 'node:fs'
import {
  lstat,
  open,
  rename
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { agentIdentifierSchema } from '../shared/agent-protocol'
import {
  boundedInteger,
  isNodeError,
  settleWithin
} from './async-utils'
import {
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  ensurePrivateDirectoryTree,
  readPrivateFile,
  unlinkOwnedPrivateFile
} from './managed-paths'

export const AGENT_DIAGNOSTIC_DIRECTORY_NAME = 'diagnostics'
export const AGENT_DIAGNOSTIC_FILE_NAME = 'agent-diagnostics.jsonl'
export const DEFAULT_AGENT_DIAGNOSTIC_MAXIMUM_FILE_BYTES = 64 * 1024
export const DEFAULT_AGENT_DIAGNOSTIC_FILE_COUNT = 3
export const DEFAULT_AGENT_DIAGNOSTIC_MAXIMUM_QUEUED_RECORDS = 64
export const DEFAULT_AGENT_DIAGNOSTIC_FLUSH_TIMEOUT_MS = 1_000
const AGENT_DIAGNOSTIC_LOCK_FILE_NAME = '.agent-diagnostics.lock'
const AGENT_DIAGNOSTIC_LOCK_ATTEMPTS = 10
const AGENT_DIAGNOSTIC_LOCK_RETRY_MS = 10

export type AgentDiagnosticEvent =
  | 'daemon.starting'
  | 'daemon.ready'
  | 'daemon.start.failed'
  | 'daemon.stopping'
  | 'daemon.stopped'
  | 'daemon.stop.failed'
  | 'detached.launching'
  | 'detached.spawned'
  | 'connection.attached'
  | 'connection.closed'
  | 'connection.failed'
  | 'recovery.started'
  | 'recovery.succeeded'
  | 'recovery.failed'
  | 'runtime.starting'
  | 'runtime.started'
  | 'runtime.start.failed'
  | 'runtime.exited'

export type AgentDiagnosticRecord = {
  formatVersion: 1
  timestamp: string
  level: 'info' | 'error'
  event: AgentDiagnosticEvent
  pid: number
  daemonBootId?: string
  reason?: string
  runtimeId?: string
  workMode?: 'ask' | 'execute'
  outcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'outcome-unknown'
  error?: {
    name: string
    code?: string
  }
}

export type AgentDiagnosticInput = {
  daemonBootId?: string
  reason?: string
  runtimeId?: string
  workMode?: 'ask' | 'execute'
  outcome?: AgentDiagnosticRecord['outcome']
  error?: unknown
}

export type AgentDiagnosticLogOptions = {
  maximumFileBytes?: number
  fileCount?: number
  maximumQueuedRecords?: number
  now?: () => number
  pid?: number
}

/**
 * A small, process-safe-enough JSONL diagnostic trail for detached operation.
 *
 * Callers can provide only fixed operational metadata. Arbitrary error
 * messages are deliberately not persisted because they can contain prompts,
 * credentials, command lines, paths, environment values, or Runtime output.
 */
export class AgentDiagnosticLog {
  readonly directoryPath: string
  readonly currentFilePath: string
  readonly #maximumFileBytes: number
  readonly #fileCount: number
  readonly #maximumQueuedRecords: number
  readonly #now: () => number
  readonly #pid: number
  readonly #queuedLines: string[] = []
  #pendingRecordCount = 0
  #drainPromise?: Promise<void>
  #disposed = false

  constructor(
    stateDirectoryInput: string,
    options: AgentDiagnosticLogOptions = {}
  ) {
    const stateDirectory = resolve(stateDirectoryInput)
    this.directoryPath = diagnosticDirectoryForStateDirectory(stateDirectory)
    this.currentFilePath = resolve(
      this.directoryPath,
      AGENT_DIAGNOSTIC_FILE_NAME
    )
    this.#maximumFileBytes = boundedInteger(
      options.maximumFileBytes ??
        DEFAULT_AGENT_DIAGNOSTIC_MAXIMUM_FILE_BYTES,
      512,
      1024 * 1024,
      'Agent diagnostic file size'
    )
    this.#fileCount = boundedInteger(
      options.fileCount ?? DEFAULT_AGENT_DIAGNOSTIC_FILE_COUNT,
      1,
      8,
      'Agent diagnostic file count'
    )
    this.#maximumQueuedRecords = boundedInteger(
      options.maximumQueuedRecords ??
        DEFAULT_AGENT_DIAGNOSTIC_MAXIMUM_QUEUED_RECORDS,
      1,
      256,
      'Agent diagnostic queue size'
    )
    this.#now = options.now ?? Date.now
    this.#pid = boundedInteger(
      options.pid ?? process.pid,
      1,
      Number.MAX_SAFE_INTEGER,
      'Agent diagnostic process ID'
    )
  }

  record(event: AgentDiagnosticEvent, input: AgentDiagnosticInput = {}): void {
    if (this.#disposed) {
      throw new Error('Agent diagnostic log is disposed')
    }
    const line = this.#normalizeLine(event, input)
    if (!this.#enqueue(line)) {
      throw new Error('Agent diagnostic queue is full')
    }
  }

  tryRecord(
    event: AgentDiagnosticEvent,
    input: AgentDiagnosticInput = {}
  ): void {
    try {
      if (this.#disposed) {
        return
      }
      // Normalize now so the queue retains only bounded JSON, never the
      // original Error object or any message that it may contain.
      this.#enqueue(this.#normalizeLine(event, input))
    } catch {
      // Diagnostics must never interfere with daemon, attach, or Runtime I/O.
    }
  }

  async flush(
    timeoutMs = DEFAULT_AGENT_DIAGNOSTIC_FLUSH_TIMEOUT_MS
  ): Promise<void> {
    const boundedTimeout = boundedInteger(
      timeoutMs,
      1,
      30_000,
      'Agent diagnostic flush timeout'
    )
    await settleWithin(this.#waitForIdle(), boundedTimeout)
  }

  async dispose(
    timeoutMs = DEFAULT_AGENT_DIAGNOSTIC_FLUSH_TIMEOUT_MS
  ): Promise<void> {
    this.#disposed = true
    await this.flush(timeoutMs)
  }

  read(): AgentDiagnosticRecord[] {
    return readAgentDiagnostics(resolve(this.directoryPath, '..'), {
      maximumFileBytes: this.#maximumFileBytes,
      fileCount: this.#fileCount
    })
  }

  #normalizeLine(
    event: AgentDiagnosticEvent,
    input: AgentDiagnosticInput
  ): string {
    const record: AgentDiagnosticRecord = {
      formatVersion: 1,
      timestamp: new Date(this.#now()).toISOString(),
      level: event.endsWith('.failed') ? 'error' : 'info',
      event,
      pid: this.#pid,
      ...optionalToken('daemonBootId', input.daemonBootId, 128),
      ...optionalToken('reason', input.reason, 96),
      ...optionalToken('runtimeId', input.runtimeId, 64),
      ...(input.workMode === undefined
        ? {}
        : { workMode: input.workMode }),
      ...(input.outcome === undefined
        ? {}
        : { outcome: input.outcome }),
      ...(input.error === undefined
        ? {}
        : { error: summarizeDiagnosticError(input.error) })
    }
    const line = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(line, 'utf8') > this.#maximumFileBytes) {
      throw new Error('Agent diagnostic record exceeds its file bound')
    }
    return line
  }

  #enqueue(line: string): boolean {
    if (this.#pendingRecordCount >= this.#maximumQueuedRecords) {
      return false
    }
    this.#queuedLines.push(line)
    this.#pendingRecordCount += 1
    this.#scheduleDrain()
    return true
  }

  #scheduleDrain(): void {
    if (this.#drainPromise !== undefined) {
      return
    }
    this.#drainPromise = Promise.resolve()
      .then(async () => await this.#drain())
      .catch(() => {
        // Diagnostic write failures are deliberately isolated from callers.
      })
      .finally(() => {
        this.#drainPromise = undefined
        if (this.#queuedLines.length > 0) {
          this.#scheduleDrain()
        }
      })
  }

  async #drain(): Promise<void> {
    while (this.#queuedLines.length > 0) {
      const lines = this.#queuedLines.splice(0)
      try {
        await this.#writeLines(lines)
      } catch {
        // Drop this bounded batch. Diagnostics may not affect the protocol.
      } finally {
        this.#pendingRecordCount -= lines.length
      }
    }
  }

  async #waitForIdle(): Promise<void> {
    while (this.#pendingRecordCount > 0) {
      const drain = this.#drainPromise
      if (drain === undefined) {
        this.#scheduleDrain()
      } else {
        await drain
      }
    }
  }

  async #writeLines(lines: readonly string[]): Promise<void> {
    ensurePrivateDirectory(resolve(this.directoryPath, '..'), {
      create: false
    })
    ensurePrivateDirectoryTree(
      this.directoryPath,
      resolve(this.directoryPath, '..')
    )
    const releaseLock = await acquireDiagnosticLock(
      resolve(this.directoryPath, AGENT_DIAGNOSTIC_LOCK_FILE_NAME)
    )
    try {
      let nextLine = 0
      while (nextLine < lines.length) {
        let currentBytes = await privateFileSize(this.currentFilePath)
        if (currentBytes >= this.#maximumFileBytes) {
          await this.#rotate()
          currentBytes = 0
        }
        const availableBytes = this.#maximumFileBytes - currentBytes
        let batchBytes = 0
        let batchEnd = nextLine
        while (batchEnd < lines.length) {
          const lineBytes = Buffer.byteLength(lines[batchEnd]!, 'utf8')
          if (batchBytes + lineBytes > availableBytes) {
            break
          }
          batchBytes += lineBytes
          batchEnd += 1
        }
        if (batchEnd === nextLine) {
          await this.#rotate()
          continue
        }
        await appendPrivateFile(
          this.currentFilePath,
          lines.slice(nextLine, batchEnd).join('')
        )
        nextLine = batchEnd
      }
    } finally {
      releaseLock()
    }
  }

  async #rotate(): Promise<void> {
    const oldest = rotatedPath(
      this.currentFilePath,
      this.#fileCount - 1
    )
    try {
      unlinkOwnedPrivateFile(oldest)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error
      }
    }
    for (let index = this.#fileCount - 2; index >= 0; index -= 1) {
      const source = rotatedPath(this.currentFilePath, index)
      const target = rotatedPath(this.currentFilePath, index + 1)
      try {
        assertPrivateRegularFile(source)
        await rename(source, target)
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw error
        }
      }
    }
  }
}

async function acquireDiagnosticLock(
  path: string
): Promise<() => void> {
  for (
    let attempt = 0;
    attempt < AGENT_DIAGNOSTIC_LOCK_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const descriptor = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600
      )
      try {
        if (process.platform !== 'win32') {
          await descriptor.chmod(0o600)
        }
      } finally {
        await descriptor.close()
      }
      assertPrivateRegularFile(path)
      return () => {
        unlinkOwnedPrivateFile(path)
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error
      }
      assertPrivateRegularFile(path)
      await new Promise<void>((resolveRetry) => {
        setTimeout(resolveRetry, AGENT_DIAGNOSTIC_LOCK_RETRY_MS)
      })
    }
  }
  throw new Error('Agent diagnostic file is busy')
}

async function privateFileSize(path: string): Promise<number> {
  try {
    assertPrivateRegularFile(path)
    return (await lstat(path)).size
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error
    }
    return 0
  }
}

async function appendPrivateFile(
  path: string,
  contents: string
): Promise<void> {
  const descriptor = await open(
    path,
    constants.O_CREAT |
      constants.O_APPEND |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600
  )
  try {
    if (process.platform !== 'win32') {
      await descriptor.chmod(0o600)
    }
    await descriptor.writeFile(contents, 'utf8')
  } finally {
    await descriptor.close()
  }
  assertPrivateRegularFile(path)
}

export function diagnosticDirectoryForStateDirectory(
  stateDirectoryInput: string
): string {
  return resolve(stateDirectoryInput, AGENT_DIAGNOSTIC_DIRECTORY_NAME)
}

export function readAgentDiagnostics(
  stateDirectoryInput: string,
  options: Pick<
    AgentDiagnosticLogOptions,
    'maximumFileBytes' | 'fileCount'
  > = {}
): AgentDiagnosticRecord[] {
  const directory = diagnosticDirectoryForStateDirectory(
    resolve(stateDirectoryInput)
  )
  const current = resolve(directory, AGENT_DIAGNOSTIC_FILE_NAME)
  const maximumFileBytes =
    boundedInteger(
      options.maximumFileBytes ??
        DEFAULT_AGENT_DIAGNOSTIC_MAXIMUM_FILE_BYTES,
      512,
      1024 * 1024,
      'Agent diagnostic file size'
    )
  const fileCount =
    boundedInteger(
      options.fileCount ?? DEFAULT_AGENT_DIAGNOSTIC_FILE_COUNT,
      1,
      8,
      'Agent diagnostic file count'
    )
  const output: AgentDiagnosticRecord[] = []
  for (let index = fileCount - 1; index >= 0; index -= 1) {
    const path = rotatedPath(current, index)
    let contents: string
    try {
      contents = readPrivateFile(path, maximumFileBytes).toString('utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        continue
      }
      throw error
    }
    for (const line of contents.split('\n')) {
      if (line.length === 0) {
        continue
      }
      const parsed = parseDiagnosticRecord(line)
      if (parsed !== undefined) {
        output.push(parsed)
      }
    }
  }
  return output
}

export function summarizeDiagnosticError(error: unknown): {
  name: string
  code?: string
} {
  const name = diagnosticErrorName(error)
  const candidate =
    error !== null && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
  const code =
    typeof candidate === 'string' &&
    SAFE_DIAGNOSTIC_ERROR_CODES.has(candidate)
      ? candidate
      : undefined
  return {
    name,
    ...(code === undefined ? {} : { code })
  }
}

function diagnosticErrorName(error: unknown): string {
  if (error instanceof TypeError) {
    return 'TypeError'
  }
  if (error instanceof RangeError) {
    return 'RangeError'
  }
  if (error instanceof SyntaxError) {
    return 'SyntaxError'
  }
  return error instanceof Error ? 'Error' : 'NonError'
}

const SAFE_DIAGNOSTIC_ERROR_CODES = new Set([
  'EACCES',
  'EADDRINUSE',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EIO',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENAMETOOLONG',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EPIPE',
  'EROFS',
  'ESRCH',
  'ETIMEDOUT'
] as const)

function parseDiagnosticRecord(line: string): AgentDiagnosticRecord | undefined {
  try {
    const value: unknown = JSON.parse(line)
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return undefined
    }
    const record = value as Partial<AgentDiagnosticRecord>
    if (
      record.formatVersion !== 1 ||
      typeof record.timestamp !== 'string' ||
      (record.level !== 'info' && record.level !== 'error') ||
      typeof record.event !== 'string' ||
      !isDiagnosticEvent(record.event) ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid ?? 0) <= 0
    ) {
      return undefined
    }
    return record as AgentDiagnosticRecord
  } catch {
    return undefined
  }
}

function rotatedPath(currentPath: string, index: number): string {
  return index === 0 ? currentPath : `${currentPath}.${index}`
}

function optionalToken<Key extends 'daemonBootId' | 'reason' | 'runtimeId'>(
  key: Key,
  value: string | undefined,
  maximumLength: number
): Partial<Record<Key, string>> {
  if (
    value === undefined ||
    value.length > maximumLength ||
    !agentIdentifierSchema.safeParse(value).success
  ) {
    return {}
  }
  return { [key]: value } as Record<Key, string>
}

function isDiagnosticEvent(value: string): value is AgentDiagnosticEvent {
  return DIAGNOSTIC_EVENTS.has(value as AgentDiagnosticEvent)
}

const DIAGNOSTIC_EVENTS = new Set<AgentDiagnosticEvent>([
  'daemon.starting',
  'daemon.ready',
  'daemon.start.failed',
  'daemon.stopping',
  'daemon.stopped',
  'daemon.stop.failed',
  'detached.launching',
  'detached.spawned',
  'connection.attached',
  'connection.closed',
  'connection.failed',
  'recovery.started',
  'recovery.succeeded',
  'recovery.failed',
  'runtime.starting',
  'runtime.started',
  'runtime.start.failed',
  'runtime.exited'
])
