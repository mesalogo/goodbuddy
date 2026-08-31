import { randomUUID } from 'node:crypto'
import { constants as fileSystemConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import * as nodePty from 'node-pty'
import type { IDisposable, IPty } from 'node-pty'
import {
  TERMINAL_LIMITS,
  type TerminalError,
  type TerminalEvent,
  type TerminalExit,
  type TerminalSize,
  type TerminalSnapshot,
  type TerminalTarget
} from '../../shared/terminal-contracts'
import { requestProcessTreeTermination } from '../agent/child-process-termination'
import { runtimeProviderEnvironmentNames } from '../agent/process-environment'

export type LocalTerminalTarget = Extract<
  TerminalTarget,
  { type: 'local' | 'project' }
>

export type LocalTerminalLaunch = {
  cwd: string
  shell: string
  shellLabel: string
  env: NodeJS.ProcessEnv
}

export type LocalPtySpawn = (
  file: string,
  args: string[],
  options: nodePty.IPtyForkOptions
) => IPty

export type LocalTerminalDependencies = {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  homeDirectory?: () => string
  executableExists?: (path: string) => Promise<boolean>
  directoryExists?: (path: string) => Promise<boolean>
  spawn?: LocalPtySpawn
  terminate?: (pty: IPty, platform: NodeJS.Platform) => Promise<void>
}

export type LocalTerminalSessionOptions = {
  sessionId?: string
  target: LocalTerminalTarget
  targetLabel: string
  title: string
  size: TerminalSize
  projectDirectory?: string
  dependencies?: LocalTerminalDependencies
}

export type LocalTerminalEventListener = (event: TerminalEvent) => void
type UnsequencedTerminalEvent<T> = T extends TerminalEvent
  ? Omit<T, 'sessionId' | 'sequence'>
  : never
type LocalTerminalEvent = UnsequencedTerminalEvent<TerminalEvent>

const CONTROL_EVENT_RESERVE = 2
const PAUSE_PENDING_EVENT_COUNT =
  TERMINAL_LIMITS.maximumPendingEvents - CONTROL_EVENT_RESERVE
const RESUME_PENDING_EVENT_COUNT = Math.floor(
  PAUSE_PENDING_EVENT_COUNT / 2
)
const CLOSE_WAIT_MS = 1_500
const FORCE_WAIT_MS = 250

const credentialEnvironmentNames = new Set([
  ...runtimeProviderEnvironmentNames,
  'DEEPSEEK_API_KEY',
  'DASHSCOPE_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'CEREBRAS_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN'
])

function isCredentialEnvironmentName(name: string): boolean {
  const upperName = name.toUpperCase()
  return (
    upperName.startsWith('GOODBUDDY_') ||
    upperName.startsWith('FACTORY_') ||
    credentialEnvironmentNames.has(upperName)
  )
}

/**
 * Keep the user's normal interactive environment while removing credentials
 * inherited by Electron Main for GoodBuddy and model-provider operation.
 */
export function buildLocalTerminalEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !isCredentialEnvironmentName(name)) {
      environment[name] = value
    }
  }
  return environment
}

async function defaultExecutableExists(path: string): Promise<boolean> {
  try {
    await access(
      path,
      process.platform === 'win32'
        ? fileSystemConstants.F_OK
        : fileSystemConstants.X_OK
    )
    return true
  } catch {
    return false
  }
}

async function defaultDirectoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function findExecutableOnPath(
  name: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => Promise<boolean>
): Promise<string | undefined> {
  const pathApi = platform === 'win32' ? win32 : posix
  if (pathApi.isAbsolute(name)) {
    return (await exists(name)) ? name : undefined
  }
  const pathValue =
    environment.PATH ?? environment.Path ?? environment.path ?? ''
  const extensions =
    platform === 'win32'
      ? (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : ['']
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${name}${extension}`)
      if (await exists(candidate)) {
        return candidate
      }
    }
  }
  return undefined
}

export async function resolveLocalTerminalShell(
  dependencies: LocalTerminalDependencies = {}
): Promise<{ shell: string; shellLabel: string }> {
  const platform = dependencies.platform ?? process.platform
  const environment = dependencies.environment ?? process.env
  const exists = dependencies.executableExists ?? defaultExecutableExists
  let shell: string | undefined

  if (platform === 'win32') {
    shell =
      (await findExecutableOnPath(
        'pwsh',
        environment,
        platform,
        exists
      )) ??
      (await findExecutableOnPath(
        'powershell',
        environment,
        platform,
        exists
      ))
    if (!shell) {
      const comspec = environment.COMSPEC?.trim()
      shell = comspec
        ? await findExecutableOnPath(
            comspec,
            environment,
            platform,
            exists
          )
        : undefined
    }
  } else {
    const configuredShell = environment.SHELL?.trim()
    if (
      configuredShell &&
      posix.isAbsolute(configuredShell) &&
      (await exists(configuredShell))
    ) {
      shell = configuredShell
    } else {
      const fallbacks =
        platform === 'darwin'
          ? ['/bin/zsh', '/bin/bash', '/bin/sh']
          : ['/bin/bash', '/bin/sh']
      for (const candidate of fallbacks) {
        if (await exists(candidate)) {
          shell = candidate
          break
        }
      }
    }
  }

  if (!shell) {
    throw new Error('No supported interactive shell is available')
  }
  return {
    shell,
    shellLabel:
      platform === 'win32'
        ? win32.basename(shell)
        : posix.basename(shell)
  }
}

export async function resolveLocalTerminalWorkingDirectory(
  projectDirectory: string | undefined,
  dependencies: LocalTerminalDependencies = {}
): Promise<string> {
  const isDirectory =
    dependencies.directoryExists ?? defaultDirectoryExists
  const home = (dependencies.homeDirectory ?? homedir)()
  if (
    projectDirectory?.trim() &&
    (await isDirectory(projectDirectory))
  ) {
    return projectDirectory
  }
  if (await isDirectory(home)) {
    return home
  }
  throw new Error('No valid local terminal working directory is available')
}

export async function resolveLocalTerminalLaunch(
  projectDirectory: string | undefined,
  dependencies: LocalTerminalDependencies = {}
): Promise<LocalTerminalLaunch> {
  const [shell, cwd] = await Promise.all([
    resolveLocalTerminalShell(dependencies),
    resolveLocalTerminalWorkingDirectory(
      projectDirectory,
      dependencies
    )
  ])
  return {
    ...shell,
    cwd,
    env: buildLocalTerminalEnvironment(
      dependencies.environment ?? process.env
    )
  }
}

function splitBoundedOutput(data: string): string[] {
  const encoded = Buffer.from(data)
  const chunks: string[] = []
  let offset = 0
  while (offset < encoded.byteLength) {
    let end = Math.min(
      offset + TERMINAL_LIMITS.maximumEventBytes,
      encoded.byteLength
    )
    if (end < encoded.byteLength) {
      while (
        end > offset &&
        (encoded[end]! & 0xc0) === 0x80
      ) {
        end -= 1
      }
    }
    if (end === offset) {
      end = Math.min(offset + 1, encoded.byteLength)
    }
    chunks.push(encoded.subarray(offset, end).toString('utf8'))
    offset = end
  }
  return chunks
}

async function waitUntil(
  predicate: () => boolean,
  milliseconds: number
): Promise<void> {
  if (predicate()) {
    return
  }
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearInterval(interval)
      clearTimeout(timeout)
      resolve()
    }
    const interval = setInterval(() => {
      if (predicate()) {
        finish()
      }
    }, 10)
    const timeout = setTimeout(finish, milliseconds)
    interval.unref?.()
    timeout.unref?.()
  })
}

async function defaultTerminate(
  pty: IPty,
  platform: NodeJS.Platform
): Promise<void> {
  let exited = false
  const exitSubscription = pty.onExit(() => {
    exited = true
  })
  requestProcessTreeTermination(
    {
      pid: pty.pid,
      killed: false,
      exitCode: null,
      kill: (signal) =>
        platform === 'win32' ? pty.kill() : pty.kill(signal)
    },
    {
      platform,
      processGroup: platform !== 'win32',
      waitMs: CLOSE_WAIT_MS
    }
  )
  await waitUntil(() => exited, CLOSE_WAIT_MS)
  if (!exited) {
    requestProcessTreeTermination(
      {
        pid: pty.pid,
        killed: false,
        exitCode: null,
        kill: () =>
          platform === 'win32'
            ? pty.kill()
            : pty.kill('SIGKILL')
      },
      {
        platform,
        processGroup: platform !== 'win32',
        signal: 'SIGKILL',
        waitMs: FORCE_WAIT_MS
      }
    )
    await waitUntil(() => exited, FORCE_WAIT_MS)
  }
  exitSubscription.dispose()
}

export class LocalTerminalSession {
  static async create(
    options: LocalTerminalSessionOptions
  ): Promise<LocalTerminalSession> {
    const session = new LocalTerminalSession(options)
    await session.start()
    return session
  }

  readonly sessionId: string
  private readonly options: LocalTerminalSessionOptions
  private readonly dependencies: LocalTerminalDependencies
  private readonly listeners = new Set<LocalTerminalEventListener>()
  private readonly pendingEvents: TerminalEvent[] = []
  private readonly subscriptions: IDisposable[] = []
  private pty: IPty | undefined
  private state: TerminalSnapshot['state'] = 'starting'
  private launch: LocalTerminalLaunch | undefined
  private size: TerminalSize
  private lastSequence = 0
  private pendingOutputBytes = 0
  private paused = false
  private exit: TerminalExit | null = null
  private error: TerminalError | null = null
  private closePromise: Promise<TerminalSnapshot> | undefined

  private constructor(options: LocalTerminalSessionOptions) {
    this.options = options
    this.dependencies = options.dependencies ?? {}
    this.sessionId = options.sessionId ?? randomUUID()
    this.size = { ...options.size }
    this.emit({ type: 'state', state: 'starting' })
  }

  private async start(): Promise<void> {
    try {
      this.launch = await resolveLocalTerminalLaunch(
        this.options.target.type === 'project'
          ? this.options.projectDirectory
          : undefined,
        this.dependencies
      )
      const spawn = this.dependencies.spawn ?? nodePty.spawn
      this.pty = spawn(this.launch.shell, [], {
        name: 'xterm-256color',
        cols: this.size.cols,
        rows: this.size.rows,
        cwd: this.launch.cwd,
        env: this.launch.env
      })
      this.subscriptions.push(
        this.pty.onData((data) => this.handleOutput(data)),
        this.pty.onExit((result) =>
          this.handleExit(result.exitCode, result.signal)
        )
      )
      this.state = 'running'
      this.emit({ type: 'state', state: 'running' })
    } catch (cause) {
      this.fail(
        'launch-failed',
        cause instanceof Error
          ? cause.message
          : 'Failed to launch the local terminal'
      )
    }
  }

  snapshot(): TerminalSnapshot {
    const launch = this.launch
    return {
      sessionId: this.sessionId,
      target: this.options.target,
      targetLabel: this.options.targetLabel,
      title: this.options.title,
      state: this.state,
      shell: launch?.shellLabel ?? '未知',
      workingDirectory:
        launch?.cwd ??
        this.options.projectDirectory ??
        (this.dependencies.homeDirectory ?? homedir)(),
      size: { ...this.size },
      lastSequence: this.lastSequence,
      exit: this.exit,
      error: this.error
    }
  }

  onEvent(listener: LocalTerminalEventListener): () => void {
    this.listeners.add(listener)
    for (const event of this.pendingEvents) {
      listener(event)
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  write(data: string): boolean {
    if (this.state !== 'running' || !this.pty) {
      return false
    }
    this.pty.write(data)
    return true
  }

  resize(size: TerminalSize): boolean {
    if (this.state !== 'running' || !this.pty) {
      return false
    }
    if (
      this.size.cols === size.cols &&
      this.size.rows === size.rows
    ) {
      return true
    }
    this.pty.resize(size.cols, size.rows)
    this.size = { ...size }
    return true
  }

  acknowledge(sequence: number): void {
    while (
      this.pendingEvents[0] &&
      this.pendingEvents[0].sequence <= sequence
    ) {
      const event = this.pendingEvents.shift()
      if (event?.type === 'output') {
        this.pendingOutputBytes -= Buffer.byteLength(event.data)
      }
    }
    if (
      this.paused &&
      this.pendingEvents.length <= RESUME_PENDING_EVENT_COUNT &&
      this.pendingOutputBytes <=
        TERMINAL_LIMITS.maximumBufferedOutputBytes / 2
    ) {
      this.paused = false
      this.pty?.resume()
    }
  }

  close(): Promise<TerminalSnapshot> {
    if (this.closePromise) {
      return this.closePromise
    }
    this.closePromise = this.closeInternal()
    return this.closePromise
  }

  private async closeInternal(): Promise<TerminalSnapshot> {
    if (
      this.state === 'exited' ||
      this.state === 'interrupted' ||
      (this.state === 'failed' && !this.pty)
    ) {
      return this.snapshot()
    }
    const preserveFailedState = this.state === 'failed'
    if (!preserveFailedState) {
      this.state = 'closing'
      this.emit({ type: 'state', state: 'closing' })
    }
    const pty = this.pty
    if (pty) {
      try {
        await (
          this.dependencies.terminate ?? defaultTerminate
        )(pty, this.dependencies.platform ?? process.platform)
      } catch (cause) {
        this.error = {
          code: 'internal-error',
          message: this.boundErrorMessage(cause),
          retryable: false
        }
        this.emit({ type: 'error', error: this.error })
      } finally {
        if (preserveFailedState) {
          this.disposeSubscriptions()
        }
      }
    }
    if (this.state === 'closing') {
      this.handleExit(null, 'SIGTERM')
    }
    return this.snapshot()
  }

  private handleOutput(data: string): void {
    if (this.state !== 'running' || data.length === 0) {
      return
    }
    for (const chunk of splitBoundedOutput(data)) {
      if (
        this.pendingEvents.length >= PAUSE_PENDING_EVENT_COUNT ||
        this.pendingOutputBytes + Buffer.byteLength(chunk) >
          TERMINAL_LIMITS.maximumBufferedOutputBytes
      ) {
        this.fail(
          'output-limit-exceeded',
          'Terminal output exceeded the bounded Main process buffer'
        )
        void this.close()
        return
      }
      this.pendingOutputBytes += Buffer.byteLength(chunk)
      this.emit({ type: 'output', data: chunk })
      this.updateBackpressure()
    }
  }

  private updateBackpressure(): void {
    if (
      !this.paused &&
      (this.pendingEvents.length >= PAUSE_PENDING_EVENT_COUNT ||
        this.pendingOutputBytes >=
          TERMINAL_LIMITS.maximumBufferedOutputBytes)
    ) {
      this.paused = true
      this.pty?.pause()
    }
  }

  private handleExit(
    exitCode: number | null,
    signal?: number | string
  ): void {
    if (this.state === 'exited' || this.state === 'failed') {
      return
    }
    this.disposeSubscriptions()
    this.exit = {
      exitCode:
        typeof exitCode === 'number' &&
        Number.isSafeInteger(exitCode)
          ? exitCode
          : null,
      signal:
        signal === undefined || signal === null
          ? null
          : String(signal)
    }
    if (this.exit.exitCode === null && this.exit.signal === null) {
      this.exit.signal = 'unknown'
    }
    this.state = 'exited'
    this.emit({ type: 'exit', exit: this.exit })
    this.emit({ type: 'state', state: 'exited' })
  }

  private fail(
    code: TerminalError['code'],
    message: string
  ): void {
    if (this.state === 'failed' || this.state === 'exited') {
      return
    }
    this.error = {
      code,
      message: Buffer.from(message)
        .subarray(0, TERMINAL_LIMITS.maximumErrorMessageBytes)
        .toString('utf8') || 'Local terminal failed',
      retryable: code === 'launch-failed'
    }
    this.state = 'failed'
    this.emit({ type: 'error', error: this.error })
    this.emit({ type: 'state', state: 'failed' })
  }

  private emit(
    event: LocalTerminalEvent
  ): void {
    if (this.lastSequence >= Number.MAX_SAFE_INTEGER) {
      this.state = 'failed'
      this.error = {
        code: 'internal-error',
        message: 'Terminal event sequence was exhausted',
        retryable: false
      }
      return
    }
    const sequenced = {
      ...event,
      sessionId: this.sessionId,
      sequence: ++this.lastSequence
    } as TerminalEvent
    this.pendingEvents.push(sequenced)
    for (const listener of this.listeners) {
      listener(sequenced)
    }
  }

  private boundErrorMessage(cause: unknown): string {
    const message =
      cause instanceof Error
        ? cause.message
        : 'Failed to close the local terminal'
    return (
      Buffer.from(message)
        .subarray(0, TERMINAL_LIMITS.maximumErrorMessageBytes)
        .toString('utf8') || 'Failed to close the local terminal'
    )
  }

  private disposeSubscriptions(): void {
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose()
    }
  }
}
