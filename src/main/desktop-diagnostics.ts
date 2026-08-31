import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_MAXIMUM_FILE_BYTES = 256 * 1024
const DEFAULT_MAXIMUM_FILES = 4
const DEFAULT_MAXIMUM_RECORDS = 1_000
export const MAXIMUM_PENDING_DESKTOP_DIAGNOSTIC_WRITES = 32
const DIAGNOSTIC_FILE_NAME = 'desktop-diagnostics.ndjson'
const allowedStages = new Set([
  'startup',
  'create',
  'status',
  'connection-test',
  'native-snapshot',
  'compact',
  'run',
  'connect',
  'disconnect'
])
const allowedCodes = new Set([
  'desktop.startup.failed',
  'runtime.operation.failed',
  'runtime.run.failed',
  'remote.connection.network',
  'remote.connection.host-invalidated',
  'remote.connection.host-identity',
  'remote.connection.authentication',
  'remote.connection.installation',
  'remote.connection.protocol',
  'remote.connection.daemon-status',
  'remote.connection.platform',
  'remote.connection.capability',
  'remote.connection.shutdown',
  'remote.connection.lost'
])

const safeErrorTypes = new Set([
  'AbortError',
  'AggregateError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'RemoteAgentConnectionError',
  'StartupPrerequisiteError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError'
])

export type DesktopDiagnosticComponent =
  | 'desktop'
  | 'runtime'
  | 'remote-agent'

export type DesktopDiagnosticFailure = Readonly<{
  component: DesktopDiagnosticComponent
  stage: string
  code: string
  error: unknown
}>

export type DesktopDiagnosticFailureObserver = (
  failure: DesktopDiagnosticFailure
) => void

export type DesktopDiagnosticRecord = Readonly<{
  timestamp: string
  component: DesktopDiagnosticComponent
  stage: string
  code: string
  errorType: string
  message: string
}>

export type DesktopDiagnosticsOptions = Readonly<{
  maximumFileBytes?: number
  maximumFiles?: number
  maximumRecords?: number
  now?: () => Date
}>

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'NonError'
  }
  let name: unknown
  try {
    name = error.name
  } catch {
    return 'Error'
  }
  return typeof name === 'string' && safeErrorTypes.has(name)
    ? name
    : 'Error'
}

function fixedMessage(
  component: DesktopDiagnosticComponent,
  stage: string
): string {
  if (component === 'desktop') {
    return 'Desktop startup failed'
  }
  if (component === 'remote-agent') {
    return stage === 'disconnect'
      ? 'Remote connection was lost'
      : 'Remote connection failed'
  }
  return stage === 'run'
    ? 'Runtime request failed'
    : 'Runtime operation failed'
}

function safeComponent(component: unknown): DesktopDiagnosticComponent {
  switch (component) {
    case 'runtime':
    case 'remote-agent':
      return component
    default:
      return 'desktop'
  }
}

function safeStage(stage: unknown): string {
  return typeof stage === 'string' && allowedStages.has(stage)
    ? stage
    : 'unknown'
}

function safeCode(code: unknown): string {
  return typeof code === 'string' && allowedCodes.has(code)
    ? code
    : 'diagnostic.failure'
}

function safeStoredErrorType(errorType: unknown): string {
  return typeof errorType === 'string' &&
    (errorType === 'NonError' || safeErrorTypes.has(errorType))
    ? errorType
    : 'Error'
}

export function normalizeDesktopDiagnosticRecord(
  value: unknown
): DesktopDiagnosticRecord | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = value as Partial<DesktopDiagnosticRecord>
  if (typeof candidate.timestamp !== 'string') {
    return undefined
  }
  const timestamp = new Date(candidate.timestamp)
  if (Number.isNaN(timestamp.valueOf())) {
    return undefined
  }
  const component = safeComponent(candidate.component)
  const stage = safeStage(candidate.stage)
  return Object.freeze({
    timestamp: timestamp.toISOString(),
    component,
    stage,
    code: safeCode(candidate.code),
    errorType: safeStoredErrorType(candidate.errorType),
    message: fixedMessage(component, stage)
  })
}

function ignoreMissing(error: unknown): void {
  if (
    !(error instanceof Error) ||
    !('code' in error) ||
    error.code !== 'ENOENT'
  ) {
    throw error
  }
}

export class DesktopDiagnostics {
  readonly #directoryPath: string
  readonly #maximumFileBytes: number
  readonly #maximumFiles: number
  readonly #maximumRecords: number
  readonly #now: () => Date
  #handle: FileHandle | undefined
  #currentBytes = 0
  #initialized = false
  #accepting = true
  #pendingWrites = 0
  #queue: Promise<void> = Promise.resolve()

  constructor(
    directoryPath: string,
    options: DesktopDiagnosticsOptions = {}
  ) {
    this.#directoryPath = directoryPath
    this.#maximumFileBytes =
      options.maximumFileBytes ?? DEFAULT_MAXIMUM_FILE_BYTES
    this.#maximumFiles =
      options.maximumFiles ?? DEFAULT_MAXIMUM_FILES
    this.#maximumRecords =
      options.maximumRecords ?? DEFAULT_MAXIMUM_RECORDS
    this.#now = options.now ?? (() => new Date())
    if (
      !Number.isSafeInteger(this.#maximumFileBytes) ||
      this.#maximumFileBytes < 256 ||
      !Number.isSafeInteger(this.#maximumFiles) ||
      this.#maximumFiles < 1 ||
      this.#maximumFiles > 16 ||
      !Number.isSafeInteger(this.#maximumRecords) ||
      this.#maximumRecords < 1 ||
      this.#maximumRecords > 10_000
    ) {
      throw new RangeError('Invalid desktop diagnostic bounds')
    }
  }

  initialize(): Promise<void> {
    return this.#enqueue(async () => this.#ensureInitialized())
  }

  get pendingWriteCount(): number {
    return this.#pendingWrites
  }

  recordFailure(
    failure: DesktopDiagnosticFailure
  ): Promise<void> {
    if (!this.#accepting) {
      return Promise.resolve()
    }
    let record: DesktopDiagnosticRecord
    try {
      const normalized = normalizeDesktopDiagnosticRecord({
        timestamp: this.#now().toISOString(),
        component: failure.component,
        stage: failure.stage,
        code: failure.code,
        errorType: safeErrorType(failure.error)
      })
      if (normalized === undefined) {
        return Promise.reject(
          new Error('Desktop diagnostic record is invalid')
        )
      }
      record = normalized
    } catch (error) {
      return Promise.reject(error)
    }
    if (
      this.#pendingWrites >=
      MAXIMUM_PENDING_DESKTOP_DIAGNOSTIC_WRITES
    ) {
      return Promise.resolve()
    }
    this.#pendingWrites += 1
    return this.#enqueue(async () => {
      try {
        await this.#ensureInitialized()
        const encoded = Buffer.from(
          `${JSON.stringify(record)}\n`,
          'utf8'
        )
        if (encoded.byteLength > this.#maximumFileBytes) {
          throw new RangeError(
            'Desktop diagnostic record exceeds file bound'
          )
        }
        if (
          this.#currentBytes > 0 &&
          this.#currentBytes + encoded.byteLength >
            this.#maximumFileBytes
        ) {
          await this.#rotate()
        }
        await this.#handle!.write(encoded)
        this.#currentBytes += encoded.byteLength
      } finally {
        this.#pendingWrites -= 1
      }
    })
  }

  readRecent(
    limit = this.#maximumRecords
  ): Promise<readonly DesktopDiagnosticRecord[]> {
    const requestedLimit = Number.isFinite(limit)
      ? Math.trunc(limit)
      : this.#maximumRecords
    const boundedLimit = Math.min(
      Math.max(0, requestedLimit),
      this.#maximumRecords
    )
    if (boundedLimit === 0) {
      return Promise.resolve([])
    }
    return this.#enqueue(async () => {
      await this.#ensureInitialized()
      await this.#handle!.sync()
      const records: DesktopDiagnosticRecord[] = []
      for (let index = this.#maximumFiles - 1; index >= 0; index -= 1) {
        const contents = await this.#readFile(index)
        if (contents === undefined) {
          continue
        }
        for (const line of contents.split('\n')) {
          if (line.length === 0) {
            continue
          }
          try {
            const parsed: unknown = JSON.parse(line)
            const record = normalizeDesktopDiagnosticRecord(parsed)
            if (record !== undefined) {
              records.push(record)
            }
          } catch {
            // Ignore a final partial or externally damaged record.
          }
        }
      }
      return Object.freeze(records.slice(-boundedLimit))
    })
  }

  async exportRecent(
    limit = this.#maximumRecords
  ): Promise<Buffer> {
    const records = await this.readRecent(limit)
    return Buffer.from(
      records.map((record) => JSON.stringify(record)).join('\n') +
        (records.length > 0 ? '\n' : ''),
      'utf8'
    )
  }

  flush(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#handle) {
        await this.#handle.sync()
      }
    })
  }

  dispose(): Promise<void> {
    if (!this.#accepting) {
      return this.#queue
    }
    this.#accepting = false
    return this.#enqueue(async () => {
      const handle = this.#handle
      this.#handle = undefined
      this.#initialized = false
      if (handle) {
        await handle.sync()
        await handle.close()
      }
    })
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation)
    this.#queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#initialized) {
      return
    }
    await mkdir(this.#directoryPath, { recursive: true })
    const currentPath = this.#filePath(0)
    this.#handle = await open(currentPath, 'a+')
    this.#currentBytes = (await this.#handle.stat()).size
    this.#initialized = true
    if (this.#currentBytes > this.#maximumFileBytes) {
      await this.#handle.close()
      this.#handle = undefined
      await unlink(currentPath)
      this.#handle = await open(currentPath, 'a+')
      this.#currentBytes = 0
    }
  }

  async #rotate(): Promise<void> {
    const handle = this.#handle
    this.#handle = undefined
    if (handle) {
      await handle.close()
    }
    await unlink(this.#filePath(this.#maximumFiles - 1)).catch(
      ignoreMissing
    )
    for (
      let index = this.#maximumFiles - 2;
      index >= 0;
      index -= 1
    ) {
      await rename(
        this.#filePath(index),
        this.#filePath(index + 1)
      ).catch(ignoreMissing)
    }
    this.#handle = await open(this.#filePath(0), 'a+')
    this.#currentBytes = 0
  }

  async #readFile(index: number): Promise<string | undefined> {
    try {
      return await readFile(this.#filePath(index), 'utf8')
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined
      }
      throw error
    }
  }

  #filePath(index: number): string {
    return join(
      this.#directoryPath,
      index === 0
        ? DIAGNOSTIC_FILE_NAME
        : `${DIAGNOSTIC_FILE_NAME}.${index}`
    )
  }
}
