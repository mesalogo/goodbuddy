import { constants as fileSystemConstants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import {
  isAbsolute,
  relative,
  resolve,
  sep,
  win32
} from 'node:path'
import spawn from 'cross-spawn'
import { z } from 'zod'
import type { WorkspaceAccess } from '../workspace'
import {
  terminateProcessTreeAndWait,
  type WaitableProcessTreeChild
} from './child-process-termination'
import { buildCredentialFilteredUserEnvironment } from './process-environment'

const DEFAULT_TIMEOUT_MS = 120_000
const MAXIMUM_TIMEOUT_MS = 10 * 60_000
const MAXIMUM_OUTPUT_BYTES = 96 * 1024
const RETAINED_OUTPUT_EDGE_BYTES = MAXIMUM_OUTPUT_BYTES / 2
const TERMINATION_WAIT_MS = 2_000

export const DIRECT_MODEL_PROCESS_TRUNCATION_MARKER =
  '\n...[GoodBuddy output truncated]...\n'

export const processExecuteInputSchema = z
  .object({
    command: z.string().trim().min(1).max(100_000),
    cwd: z.string().trim().min(1).max(4_096).optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(MAXIMUM_TIMEOUT_MS)
      .default(DEFAULT_TIMEOUT_MS)
  })
  .strict()

export type ProcessExecuteInput = z.input<
  typeof processExecuteInputSchema
>

type ParsedProcessExecuteInput = z.output<
  typeof processExecuteInputSchema
>

export type ProcessShellSummary = {
  kind: 'powershell' | 'bash' | 'sh'
  label: string
}

export type ProcessExecuteResult = {
  shell: ProcessShellSummary
  cwd: string
  exitCode: number | null
  signal?: string
  terminationReason?: 'timeout' | 'cancelled'
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export type DirectModelProcessCapability =
  | {
      available: true
      shell: ProcessShellSummary
    }
  | {
      available: false
      reason: string
    }

export type DirectModelProcessExecutionContext = {
  conversationId: string
  workspace: WorkspaceAccess
  signal: AbortSignal
}

export interface DirectModelProcessService {
  getCapability(): Promise<DirectModelProcessCapability>
  execute(
    input: ProcessExecuteInput,
    context: DirectModelProcessExecutionContext
  ): Promise<ProcessExecuteResult>
  releaseConversation(conversationId: string): Promise<void>
  dispose(): Promise<void>
}

type ProcessOutput = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  removeListener?(
    event: 'error',
    listener: (error: Error) => void
  ): unknown
}

export type DirectModelProcessChild = WaitableProcessTreeChild & {
  signalCode?: NodeJS.Signals | null
  stdout?: ProcessOutput | null
  stderr?: ProcessOutput | null
}

export type DirectModelProcessSpawn = (
  executable: string,
  args: string[],
  options: {
    cwd: string
    detached: boolean
    env: NodeJS.ProcessEnv
    shell: false
    stdio: ['ignore', 'pipe', 'pipe']
    windowsHide: true
  }
) => DirectModelProcessChild

export type LocalDirectModelProcessServiceOptions = {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  toolBinDirectory?: string
  spawnProcess?: DirectModelProcessSpawn
  executableExists?: (path: string) => Promise<boolean>
  terminateProcessTree?: typeof terminateProcessTreeAndWait
  now?: () => number
  terminationWaitMs?: number
}

type ResolvedProcessShell = ProcessShellSummary & {
  executable: string
}

type ActiveCall = {
  controller: AbortController
  done: Promise<void>
  finish: () => void
}

/**
 * Preserve the user's ordinary command environment without forwarding
 * credentials inherited by Electron Main for GoodBuddy or model providers.
 */
export function buildDirectModelProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  toolBinDirectory?: string,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const environment = buildCredentialFilteredUserEnvironment(source)
  if (toolBinDirectory) {
    const pathName =
      source.PATH !== undefined
        ? 'PATH'
        : source.Path !== undefined
          ? 'Path'
          : source.path !== undefined
            ? 'path'
            : 'PATH'
    const existingPath = environment[pathName]
    const pathDelimiter = platform === 'win32' ? ';' : ':'
    environment[pathName] = existingPath
      ? `${toolBinDirectory}${pathDelimiter}${existingPath}`
      : toolBinDirectory
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
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
async function findWindowsExecutable(
  name: string,
  environment: NodeJS.ProcessEnv,
  exists: (path: string) => Promise<boolean>
): Promise<string | undefined> {
  const pathValue =
    environment.PATH ?? environment.Path ?? environment.path ?? ''
  const hasExtension = win32.extname(name) !== ''
  const extensions = hasExtension
    ? ['']
    : (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
  for (const directory of pathValue.split(';').filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = win32.join(directory, `${name}${extension}`)
      if (await exists(candidate)) {
        return candidate
      }
    }
  }
  return undefined
}

async function resolveProcessShell(
  options: LocalDirectModelProcessServiceOptions
): Promise<ResolvedProcessShell | undefined> {
  const platform = options.platform ?? process.platform
  const environment = buildDirectModelProcessEnvironment(
    options.environment ?? process.env,
    options.toolBinDirectory,
    platform
  )
  const exists = options.executableExists ?? defaultExecutableExists
  if (platform === 'win32') {
    const pwsh = await findWindowsExecutable(
      'pwsh',
      environment,
      exists
    )
    if (pwsh) {
      return {
        executable: pwsh,
        kind: 'powershell',
        label: 'pwsh'
      }
    }
    const windowsPowerShell =
      (await findWindowsExecutable(
        'powershell.exe',
        environment,
        exists
      )) ??
      (await findWindowsExecutable(
        'powershell',
        environment,
        exists
      ))
    return windowsPowerShell
      ? {
          executable: windowsPowerShell,
          kind: 'powershell',
          label: 'Windows PowerShell'
        }
      : undefined
  }
  if (await exists('/bin/bash')) {
    return {
      executable: '/bin/bash',
      kind: 'bash',
      label: 'Bash'
    }
  }
  if (await exists('/bin/sh')) {
    return {
      executable: '/bin/sh',
      kind: 'sh',
      label: 'sh'
    }
  }
  return undefined
}

class BoundedProcessOutput {
  private prefix = Buffer.alloc(0)
  private suffix = Buffer.alloc(0)
  private totalBytes = 0

  append(chunk: Buffer | string): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.totalBytes += value.byteLength

    if (this.prefix.byteLength < RETAINED_OUTPUT_EDGE_BYTES) {
      const remaining =
        RETAINED_OUTPUT_EDGE_BYTES - this.prefix.byteLength
      this.prefix = Buffer.concat([
        this.prefix,
        value.subarray(0, remaining)
      ])
    }

    if (value.byteLength >= RETAINED_OUTPUT_EDGE_BYTES) {
      this.suffix = Buffer.from(
        value.subarray(value.byteLength - RETAINED_OUTPUT_EDGE_BYTES)
      )
      return
    }
    const combined = Buffer.concat([this.suffix, value])
    this.suffix =
      combined.byteLength <= RETAINED_OUTPUT_EDGE_BYTES
        ? combined
        : Buffer.from(
            combined.subarray(
              combined.byteLength - RETAINED_OUTPUT_EDGE_BYTES
            )
          )
  }

  result(): { text: string; truncated: boolean } {
    if (this.totalBytes > MAXIMUM_OUTPUT_BYTES) {
      return {
        text: Buffer.concat([
          this.prefix,
          Buffer.from(DIRECT_MODEL_PROCESS_TRUNCATION_MARKER),
          this.suffix
        ]).toString('utf8'),
        truncated: true
      }
    }
    const overlap = Math.max(
      0,
      this.prefix.byteLength +
        this.suffix.byteLength -
        this.totalBytes
    )
    return {
      text: Buffer.concat([
        this.prefix,
        this.suffix.subarray(overlap)
      ]).toString('utf8'),
      truncated: false
    }
  }
}
function shellArguments(
  shell: ResolvedProcessShell,
  command: string
): string[] {
  return shell.kind === 'powershell'
    ? [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command
      ]
    : ['-c', command]
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

async function resolveWorkingDirectory(
  input: ParsedProcessExecuteInput,
  workspace: WorkspaceAccess
): Promise<{ canonicalPath: string; displayPath: string }> {
  if (input.cwd?.includes('\0')) {
    throw new Error('工作目录包含无效字符')
  }
  if (input.cwd && isAbsolute(input.cwd)) {
    throw new Error('工作目录必须相对于工作区')
  }

  const initialIdentity = await workspace.getIdentity()
  if (initialIdentity.kind !== 'local') {
    throw new Error('本机进程不能在远程工作区中运行')
  }
  const canonicalRoot = await realpath(
    initialIdentity.canonicalDisplayPath
  )
  if (!(await stat(canonicalRoot)).isDirectory()) {
    throw new Error('项目工作区不是目录')
  }
  const candidatePath = resolve(canonicalRoot, input.cwd ?? '.')
  const lexicalDifference = relative(canonicalRoot, candidatePath)
  if (
    lexicalDifference === '..' ||
    lexicalDifference.startsWith(`..${sep}`) ||
    isAbsolute(lexicalDifference)
  ) {
    throw new Error('工作目录不能超出项目工作区')
  }
  const canonicalPath = await realpath(candidatePath)
  const canonicalDifference = relative(canonicalRoot, canonicalPath)
  if (
    canonicalDifference === '..' ||
    canonicalDifference.startsWith(`..${sep}`) ||
    isAbsolute(canonicalDifference)
  ) {
    throw new Error('工作目录不能通过符号链接超出项目工作区')
  }
  if (!(await stat(canonicalPath)).isDirectory()) {
    throw new Error('工作目录不是目录')
  }

  const currentIdentity = await workspace.getIdentity()
  if (
    currentIdentity.kind !== initialIdentity.kind ||
    currentIdentity.id !== initialIdentity.id ||
    currentIdentity.canonicalDisplayPath !==
      initialIdentity.canonicalDisplayPath
  ) {
    throw new Error('工作区在进程启动前已发生变化')
  }
  return {
    canonicalPath,
    displayPath: canonicalDifference || '.'
  }
}

export class LocalDirectModelProcessService
  implements DirectModelProcessService
{
  private readonly activeCalls = new Map<string, Set<ActiveCall>>()
  private readonly shell: Promise<ResolvedProcessShell | undefined>
  private disposed = false
  private disposePromise?: Promise<void>

  constructor(
    private readonly options: LocalDirectModelProcessServiceOptions = {}
  ) {
    this.shell = resolveProcessShell(options)
  }

  async getCapability(): Promise<DirectModelProcessCapability> {
    const shell = await this.shell
    return shell
      ? {
          available: true,
          shell: { kind: shell.kind, label: shell.label }
        }
      : {
          available: false,
          reason:
            (this.options.platform ?? process.platform) === 'win32'
              ? '未找到可用的 PowerShell'
              : '未找到 /bin/bash 或 /bin/sh'
        }
  }

  async execute(
    input: ProcessExecuteInput,
    context: DirectModelProcessExecutionContext
  ): Promise<ProcessExecuteResult> {
    const parsed = processExecuteInputSchema.parse(input)
    if (this.disposed) {
      throw new Error('进程执行服务已关闭')
    }

    const controller = new AbortController()
    let finishActive!: () => void
    const done = new Promise<void>((resolveDone) => {
      finishActive = resolveDone
    })
    const active: ActiveCall = {
      controller,
      done,
      finish: finishActive
    }
    const calls =
      this.activeCalls.get(context.conversationId) ??
      new Set<ActiveCall>()
    calls.add(active)
    this.activeCalls.set(context.conversationId, calls)

    const cancelFromCaller = (): void => {
      controller.abort(context.signal.reason)
    }
    context.signal.addEventListener('abort', cancelFromCaller, {
      once: true
    })
    if (context.signal.aborted) {
      cancelFromCaller()
    }

    try {
      return await this.executeTracked(parsed, context, controller.signal)
    } finally {
      context.signal.removeEventListener('abort', cancelFromCaller)
      calls.delete(active)
      if (calls.size === 0) {
        this.activeCalls.delete(context.conversationId)
      }
      active.finish()
    }
  }

  private async executeTracked(
    input: ParsedProcessExecuteInput,
    context: DirectModelProcessExecutionContext,
    signal: AbortSignal
  ): Promise<ProcessExecuteResult> {
    signal.throwIfAborted()
    const shell = await this.shell
    if (!shell) {
      throw new Error('当前平台没有可用的命令 Shell')
    }
    signal.throwIfAborted()
    const workingDirectory = await resolveWorkingDirectory(
      input,
      context.workspace
    )
    signal.throwIfAborted()

    const platform = this.options.platform ?? process.platform
    const environment = buildDirectModelProcessEnvironment(
      this.options.environment ?? process.env,
      this.options.toolBinDirectory,
      platform
    )
    const startedAt = (this.options.now ?? Date.now)()
    let child: DirectModelProcessChild
    try {
      child = (
        this.options.spawnProcess ??
        (spawn as unknown as DirectModelProcessSpawn)
      )(shell.executable, shellArguments(shell, input.command), {
        cwd: workingDirectory.canonicalPath,
        detached: platform !== 'win32',
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      throw new Error('无法启动命令 Shell', { cause: error })
    }

    return await this.waitForProcess(
      child,
      shell,
      workingDirectory.displayPath,
      input.timeoutMs,
      signal,
      startedAt
    )
  }

  private waitForProcess(
    child: DirectModelProcessChild,
    shell: ResolvedProcessShell,
    cwd: string,
    timeoutMs: number,
    cancellationSignal: AbortSignal,
    startedAt: number
  ): Promise<ProcessExecuteResult> {
    const stdout = new BoundedProcessOutput()
    const stderr = new BoundedProcessOutput()
    child.stdout?.on('data', (chunk) => stdout.append(chunk))
    child.stderr?.on('data', (chunk) => stderr.append(chunk))

    return new Promise((resolveResult, rejectResult) => {
      let settled = false
      let cleanupStarted = false
      let failure: Error | undefined
      let terminationReason: 'timeout' | 'cancelled' | undefined
      let exitCode: number | null = null
      let exitSignal: string | undefined

      const removeListeners = (): void => {
        clearTimeout(timeout)
        cancellationSignal.removeEventListener('abort', cancel)
        child.stdout?.removeListener?.('error', failFromOutput)
        child.stderr?.removeListener?.('error', failFromOutput)
      }
      const result = (): ProcessExecuteResult => {
        const stdoutResult = stdout.result()
        const stderrResult = stderr.result()
        return {
          shell: { kind: shell.kind, label: shell.label },
          cwd,
          exitCode,
          ...(exitSignal ? { signal: exitSignal } : {}),
          ...(terminationReason ? { terminationReason } : {}),
          durationMs: Math.max(
            0,
            (this.options.now ?? Date.now)() - startedAt
          ),
          stdout: stdoutResult.text,
          stderr: stderrResult.text,
          stdoutTruncated: stdoutResult.truncated,
          stderrTruncated: stderrResult.truncated
        }
      }
      const finishResult = (): void => {
        if (settled) {
          return
        }
        settled = true
        removeListeners()
        resolveResult(result())
      }
      const finishFailure = (error: Error): void => {
        if (settled) {
          return
        }
        settled = true
        removeListeners()
        rejectResult(error)
      }
      const finishAfterCleanup = (): void => {
        exitCode = child.exitCode
        exitSignal = child.signalCode ?? exitSignal
        if (terminationReason) {
          finishResult()
        } else {
          finishFailure(failure ?? new Error('命令进程异常终止'))
        }
      }
      const startCleanup = (): void => {
        if (cleanupStarted || settled) {
          return
        }
        cleanupStarted = true
        clearTimeout(timeout)
        void (
          this.options.terminateProcessTree ??
          terminateProcessTreeAndWait
        )(child, {
          platform: this.options.platform ?? process.platform,
          processGroup:
            (this.options.platform ?? process.platform) !== 'win32',
          signal: 'SIGKILL',
          waitMs:
            this.options.terminationWaitMs ?? TERMINATION_WAIT_MS
        }).then(
          finishAfterCleanup,
          (error: unknown) => {
            if (!failure && error instanceof Error) {
              failure = error
            }
            finishAfterCleanup()
          }
        )
      }
      const cancel = (): void => {
        if (settled) {
          return
        }
        terminationReason = 'cancelled'
        startCleanup()
      }
      const failFromOutput = (error: Error): void => {
        if (settled || terminationReason) {
          return
        }
        failure = error
        startCleanup()
      }
      const timeout = setTimeout(() => {
        if (settled || terminationReason === 'cancelled') {
          return
        }
        terminationReason = 'timeout'
        startCleanup()
      }, timeoutMs)
      timeout.unref?.()

      child.stdout?.once('error', failFromOutput)
      child.stderr?.once('error', failFromOutput)
      child.once('error', (error: unknown) => {
        if (settled || terminationReason) {
          return
        }
        failure =
          error instanceof Error
            ? error
            : new Error('命令进程发生未知错误')
        startCleanup()
      })
      child.once('close', (...values: unknown[]) => {
        const [code, processSignal] = values
        exitCode = typeof code === 'number' ? code : child.exitCode
        exitSignal =
          typeof processSignal === 'string'
            ? processSignal
            : child.signalCode ?? undefined
        if (cleanupStarted) {
          return
        }
        finishResult()
      })
      cancellationSignal.addEventListener('abort', cancel, {
        once: true
      })
      if (cancellationSignal.aborted) {
        cancel()
      }
    })
  }

  async releaseConversation(conversationId: string): Promise<void> {
    const calls = [...(this.activeCalls.get(conversationId) ?? [])]
    for (const call of calls) {
      call.controller.abort(abortError('对话进程资源已释放'))
    }
    await Promise.all(calls.map((call) => call.done))
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce()
    return this.disposePromise
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true
    const calls = [...this.activeCalls.values()].flatMap((set) => [
      ...set
    ])
    for (const call of calls) {
      call.controller.abort(abortError('进程执行服务已关闭'))
    }
    await Promise.all(calls.map((call) => call.done))
  }
}
