import { spawn } from 'node:child_process'

export type SpawnResult = {
  exitCode: number
  stdout: string
  stderr: string
  signal?: NodeJS.Signals
  terminationReason?: 'timeout' | 'aborted'
}

export type StructuredCommandOptions = {
  env?: Readonly<NodeJS.ProcessEnv>
  signal?: AbortSignal
  timeoutMs?: number
  terminationGraceMs?: number
}

export interface StructuredCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: StructuredCommandOptions
  ): Promise<SpawnResult>
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const MAXIMUM_COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_TERMINATION_GRACE_MS = 1_000
const MAXIMUM_TERMINATION_GRACE_MS = 10_000

export class NodeStructuredCommandRunner implements StructuredCommandRunner {
  async run(
    executable: string,
    args: readonly string[],
    options: StructuredCommandOptions = {}
  ): Promise<SpawnResult> {
    const timeoutMs = boundedDuration(
      options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      'Command timeout',
      MAXIMUM_COMMAND_TIMEOUT_MS
    )
    const terminationGraceMs = boundedDuration(
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
      'Command termination grace',
      MAXIMUM_TERMINATION_GRACE_MS
    )
    if (options.signal?.aborted === true) {
      return {
        exitCode: -1,
        stdout: '',
        stderr: '',
        terminationReason: 'aborted'
      }
    }
    return await new Promise<SpawnResult>((resolveResult) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.env === undefined ? {} : { env: options.env })
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      const maximumBytes = 64 * 1024
      let settled = false
      let terminationReason: SpawnResult['terminationReason']
      const timeout = setTimeout(() => terminate('timeout'), timeoutMs)
      let escalation: NodeJS.Timeout | undefined
      let closeDeadline: NodeJS.Timeout | undefined
      let spawnError: Error | undefined
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutBytes < maximumBytes) {
          const bounded = chunk.subarray(0, maximumBytes - stdoutBytes)
          stdout.push(bounded)
          stdoutBytes += bounded.byteLength
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes < maximumBytes) {
          const bounded = chunk.subarray(0, maximumBytes - stderrBytes)
          stderr.push(bounded)
          stderrBytes += bounded.byteLength
        }
      })
      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null
      ): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (escalation !== undefined) {
          clearTimeout(escalation)
        }
        if (closeDeadline !== undefined) {
          clearTimeout(closeDeadline)
        }
        options.signal?.removeEventListener('abort', abort)
        const capturedStderr = Buffer.concat(stderr).toString('utf8')
        resolveResult({
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr:
            capturedStderr ||
            (spawnError === undefined ? '' : spawnError.message),
          ...(signal === null ? {} : { signal }),
          ...(terminationReason === undefined ? {} : { terminationReason })
        })
      }
      const terminate = (
        reason: NonNullable<SpawnResult['terminationReason']>
      ): void => {
        if (settled || terminationReason !== undefined) {
          return
        }
        terminationReason = reason
        if (child.exitCode !== null || child.signalCode !== null) {
          return
        }
        child.kill('SIGTERM')
        escalation = setTimeout(() => {
          if (
            settled ||
            child.exitCode !== null ||
            child.signalCode !== null
          ) {
            return
          }
          child.kill('SIGKILL')
          closeDeadline = setTimeout(
            () => finish(child.exitCode, child.signalCode),
            terminationGraceMs
          )
        }, terminationGraceMs)
      }
      const abort = (): void => terminate('aborted')
      child.once('error', (error) => {
        spawnError = error
      })
      child.once('close', finish)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted === true) {
        abort()
      }
    })
  }
}

export function formatSpawnFailure(
  command: string,
  result: SpawnResult
): string {
  const status =
    result.terminationReason === 'timeout'
      ? 'timed out'
      : result.terminationReason === 'aborted'
        ? 'was cancelled'
        : result.signal !== undefined
          ? `terminated by ${result.signal}`
          : `exited with status ${result.exitCode}`
  return `${command} ${status}: ${boundedError(result.stderr)}`
}

function boundedDuration(
  value: number,
  name: string,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum} milliseconds`)
  }
  return value
}

function boundedError(error: string): string {
  const normalized = error.replaceAll(/\s+/gu, ' ').trim()
  return normalized.slice(0, 1000) || 'unknown error'
}
