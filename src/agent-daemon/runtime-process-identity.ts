import { readFile, readlink } from 'node:fs/promises'
import { posix } from 'node:path'

export type LinuxRuntimeProcessIdentity = {
  bootId: string
  pid: number
  startTimeTicks: bigint
  processGroupId: number
  executablePath: string
}

export type LinuxProcStat = {
  pid: number
  command: string
  state: string
  parentPid: number
  processGroupId: number
  sessionId: number
  startTimeTicks: bigint
}

export function parseLinuxProcStat(value: string): LinuxProcStat {
  const open = value.indexOf('(')
  const close = value.lastIndexOf(')')
  if (open < 1 || close <= open || value[close + 1] !== ' ') {
    throw new Error('Linux process stat is malformed')
  }
  const pid = positiveInteger(Number(value.slice(0, open).trim()), 'PID')
  const command = value.slice(open + 1, close)
  const fields = value.slice(close + 2).trim().split(/\s+/u)
  if (fields.length < 20 || !/^[A-Z]$/u.test(fields[0] ?? '')) {
    throw new Error('Linux process stat has too few fields')
  }
  const integerField = (index: number, label: string): number => {
    const text = fields[index]
    if (text === undefined || !/^-?\d+$/u.test(text)) {
      throw new Error(`Linux process ${label} is malformed`)
    }
    const parsed = Number(text)
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`Linux process ${label} is outside the safe range`)
    }
    return parsed
  }
  const startTime = fields[19]
  if (startTime === undefined || !/^\d+$/u.test(startTime)) {
    throw new Error('Linux process start time is malformed')
  }
  return {
    pid,
    command,
    state: fields[0]!,
    parentPid: nonnegativeInteger(integerField(1, 'parent PID'), 'Parent PID'),
    processGroupId: positiveInteger(integerField(2, 'process group'), 'Process group'),
    sessionId: positiveInteger(integerField(3, 'session'), 'Session'),
    startTimeTicks: BigInt(startTime)
  }
}

export async function readLinuxBootId(
  path = '/proc/sys/kernel/random/boot_id'
): Promise<string> {
  const value = (await readFile(path, 'utf8')).trim().toLowerCase()
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) {
    throw new Error('Linux boot identity is malformed')
  }
  return value
}

export async function readLinuxRuntimeProcessIdentity(
  pidInput: number,
  options: { procRoot?: string; bootId?: string } = {}
): Promise<LinuxRuntimeProcessIdentity> {
  const pid = positiveInteger(pidInput, 'PID')
  const procRoot = options.procRoot ?? '/proc'
  if (!posix.isAbsolute(procRoot) || procRoot.includes('\0')) {
    throw new Error('Linux proc root must be absolute')
  }
  const processRoot = posix.join(procRoot, String(pid))
  const [statText, executablePath] = await Promise.all([
    readFile(posix.join(processRoot, 'stat'), 'utf8'),
    readlink(posix.join(processRoot, 'exe'))
  ])
  const parsed = parseLinuxProcStat(statText)
  if (parsed.pid !== pid) {
    throw new Error('Linux process stat PID does not match its path')
  }
  return {
    bootId:
      options.bootId ??
      await readLinuxBootId(
        posix.join(procRoot, 'sys', 'kernel', 'random', 'boot_id')
      ),
    pid,
    startTimeTicks: parsed.startTimeTicks,
    processGroupId: parsed.processGroupId,
    executablePath
  }
}

export function sameLinuxRuntimeProcessIdentity(
  expected: LinuxRuntimeProcessIdentity,
  actual: LinuxRuntimeProcessIdentity
): boolean {
  return (
    expected.bootId === actual.bootId &&
    expected.pid === actual.pid &&
    expected.startTimeTicks === actual.startTimeTicks &&
    expected.processGroupId === actual.processGroupId &&
    expected.executablePath === actual.executablePath
  )
}

export function serializeLinuxRuntimeProcessIdentity(
  identity: LinuxRuntimeProcessIdentity
): string {
  return JSON.stringify({
    ...identity,
    startTimeTicks: identity.startTimeTicks.toString()
  })
}

export function parseSerializedLinuxRuntimeProcessIdentity(
  value: string
): LinuxRuntimeProcessIdentity {
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored Runtime process identity is malformed')
  }
  const row = parsed as Record<string, unknown>
  if (
    typeof row.bootId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(row.bootId) ||
    typeof row.pid !== 'number' ||
    typeof row.processGroupId !== 'number' ||
    typeof row.startTimeTicks !== 'string' ||
    !/^\d+$/u.test(row.startTimeTicks) ||
    typeof row.executablePath !== 'string' ||
    !posix.isAbsolute(row.executablePath)
  ) {
    throw new Error('Stored Runtime process identity is malformed')
  }
  return {
    bootId: row.bootId,
    pid: positiveInteger(row.pid, 'PID'),
    startTimeTicks: BigInt(row.startTimeTicks),
    processGroupId: positiveInteger(row.processGroupId, 'Process group'),
    executablePath: row.executablePath
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`)
  }
  return value
}
