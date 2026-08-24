import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { assertAbsoluteManagedPath } from './managed-paths'

const linuxProcessIdentitySchema = z
  .object({
    pid: z.number().int().positive().safe(),
    starttime: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    executablePath: z.string().min(1)
  })
  .strict()

export type LinuxProcessIdentity = z.infer<
  typeof linuxProcessIdentitySchema
>

export type LinuxProcessInspectorOptions = {
  procRoot?: string
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void
  fileSystem?: LinuxProcFileSystem
}

export interface LinuxProcFileSystem {
  readText(path: string): string
  readLink(path: string): string
  realpath(path: string): string
}

export class LinuxProcessInspector {
  readonly #procRoot: string
  readonly #kill: (pid: number, signal: NodeJS.Signals | 0) => void
  readonly #fileSystem: LinuxProcFileSystem

  constructor(options: LinuxProcessInspectorOptions = {}) {
    this.#procRoot = resolve(options.procRoot ?? '/proc')
    this.#kill = options.kill ?? process.kill
    this.#fileSystem = options.fileSystem ?? nodeProcFileSystem
  }

  inspect(pidInput: number): LinuxProcessIdentity | undefined {
    const pid = positivePid(pidInput)
    try {
      const starttime = parseStarttime(
        this.#fileSystem.readText(
          join(this.#procRoot, String(pid), 'stat')
        )
      )
      const executableLink = this.#fileSystem.readLink(
        join(this.#procRoot, String(pid), 'exe')
      )
      if (
        executableLink.includes('\0') ||
        !isAbsolute(executableLink) ||
        resolve(executableLink) !== executableLink
      ) {
        throw new Error('Linux process executable link is malformed')
      }
      return linuxProcessIdentitySchema.parse({
        pid,
        starttime,
        executablePath: assertAbsoluteManagedPath(
          this.#fileSystem.realpath(executableLink)
        )
      })
    } catch (error) {
      if (isMissingProcessError(error)) {
        return undefined
      }
      throw error
    }
  }

  matches(expectedInput: LinuxProcessIdentity): boolean {
    const expected = linuxProcessIdentitySchema.parse(expectedInput)
    const actual = this.inspect(expected.pid)
    return (
      actual !== undefined &&
      actual.starttime === expected.starttime &&
      actual.executablePath === expected.executablePath
    )
  }

  signal(
    expectedInput: LinuxProcessIdentity,
    signal: NodeJS.Signals
  ): boolean {
    const expected = linuxProcessIdentitySchema.parse(expectedInput)
    if (!this.matches(expected)) {
      return false
    }
    try {
      this.#kill(expected.pid, signal)
      return true
    } catch (error) {
      if (isNodeError(error) && error.code === 'ESRCH') {
        return false
      }
      throw error
    }
  }
}

export function currentLinuxProcessIdentity(
  options: LinuxProcessInspectorOptions = {}
): LinuxProcessIdentity {
  const identity = new LinuxProcessInspector(options).inspect(process.pid)
  if (identity === undefined) {
    throw new Error('Current Linux process identity is unavailable')
  }
  return identity
}

export function canonicalExecutablePath(path: string): string {
  const normalized = assertAbsoluteManagedPath(resolve(path))
  const stat = lstatSync(normalized)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Agent executable must be a regular file')
  }
  return assertAbsoluteManagedPath(realpathSync(normalized))
}

function parseStarttime(contents: string): string {
  const close = contents.lastIndexOf(')')
  if (close < 2 || contents[close + 1] !== ' ') {
    throw new Error('Linux process stat is malformed')
  }
  const starttime = contents
    .slice(close + 2)
    .trim()
    .split(/\s+/u)[19]
  if (
    starttime === undefined ||
    !/^(?:0|[1-9][0-9]*)$/u.test(starttime)
  ) {
    throw new Error('Linux process stat identity is malformed')
  }
  return starttime
}

const nodeProcFileSystem: LinuxProcFileSystem = {
  readText: (path) => readFileSync(path, 'utf8'),
  readLink: (path) => readlinkSync(path),
  realpath: (path) => realpathSync(path)
}

function positivePid(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Linux process ID is invalid')
  }
  return value
}

function isMissingProcessError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === 'ENOENT' || error.code === 'ESRCH')
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
