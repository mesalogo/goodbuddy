import koffi from 'koffi'
import { realpathSync } from 'node:fs'

export type DarwinProcessIdentity = {
  pid: number
  starttime: string
  executablePath: string
  processGroupId: number
  parentPid: number
}

let binding: ReturnType<typeof createBinding> | undefined

function createBinding() {
  const library = koffi.load('/usr/lib/libSystem.B.dylib')
  return {
    info: library.func('proc_pidinfo', 'int', [
      'int', 'int', 'uint64_t', 'void *', 'int'
    ]),
    path: library.func('proc_pidpath', 'int', ['int', 'void *', 'uint32_t']),
    list: library.func('proc_listpids', 'int', ['uint32_t', 'uint32_t', 'void *', 'int']),
    sysctl: library.func('sysctlbyname', 'int', [
      'str', 'void *', 'void *', 'void *', 'size_t'
    ])
  }
}

function native() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Darwin process inspection requires macOS arm64')
  }
  return binding ??= createBinding()
}

export function inspectDarwinProcess(pid: number): DarwinProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process ID')
  const api = native()
  const info = Buffer.alloc(136)
  const size = api.info(pid, 3, 0, info, info.length) as number
  if (size === 0 && [3, 2].includes(koffi.errno())) return undefined
  if (size !== info.length || info.readUInt32LE(12) !== pid) {
    throw new Error(`proc_pidinfo failed (${koffi.errno()})`)
  }
  const path = Buffer.alloc(4096)
  if ((api.path(pid, path, path.length) as number) <= 0) {
    if ([3, 2].includes(koffi.errno())) return undefined
    throw new Error(`proc_pidpath failed (${koffi.errno()})`)
  }
  const starttime = info.readBigUInt64LE(120) * 1_000_000n +
    info.readBigUInt64LE(128)
  return {
    pid,
    starttime: starttime.toString(),
    executablePath: realpathSync(path.subarray(0, path.indexOf(0)).toString('utf8')),
    processGroupId: info.readUInt32LE(100),
    parentPid: info.readUInt32LE(16)
  }
}

export function darwinBootId(): string {
  const bytes = Buffer.alloc(128)
  const size = Buffer.alloc(8)
  size.writeBigUInt64LE(BigInt(bytes.length))
  if (native().sysctl('kern.bootsessionuuid', bytes, size, null, 0) !== 0) {
    throw new Error(`Boot session lookup failed (${koffi.errno()})`)
  }
  const value = bytes.subarray(0, bytes.indexOf(0)).toString('ascii').toLowerCase()
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) {
    throw new Error('Invalid Darwin boot session identity')
  }
  return value
}

export function listDarwinProcessGroup(groupId: number): number[] {
  return listDarwinPids(2, groupId)
}

function listDarwinPids(kind: number, parent: number): number[] {
  const api = native()
  if (!Number.isSafeInteger(parent) || parent <= 0) throw new Error('Invalid process group')
  const required = api.list(kind, parent, null, 0) as number
  if (required < 0) throw new Error('Process group enumeration failed')
  const buffer = Buffer.alloc(required + 4096)
  const size = api.list(kind, parent, buffer, buffer.length) as number
  if (size < 0 || size >= buffer.length || size % 4 !== 0) {
    throw new Error('Process group enumeration was incomplete')
  }
  const pids: number[] = []
  for (let offset = 0; offset < size; offset += 4) {
    const pid = buffer.readInt32LE(offset)
    if (pid > 0) pids.push(pid)
  }
  return pids
}

export async function stopDarwinDescendants(
  ownerPid: number,
  deadline: number
): Promise<void> {
  const descendants: DarwinProcessIdentity[] = []
  const pending = [ownerPid]
  const seen = new Set(pending)
  while (pending.length > 0) {
    const parentPid = pending.pop()!
    for (const pid of listDarwinPids(6, parentPid)) {
      if (seen.has(pid)) continue
      seen.add(pid)
      const identity = inspectDarwinProcess(pid)
      if (!identity || identity.parentPid !== parentPid) continue
      descendants.push(identity)
      pending.push(pid)
    }
  }
  const matches = (identity: DarwinProcessIdentity): boolean => {
    const current = inspectDarwinProcess(identity.pid)
    return current !== undefined &&
      current.starttime === identity.starttime &&
      current.executablePath === identity.executablePath
  }
  const signal = (identity: DarwinProcessIdentity, value: NodeJS.Signals): void => {
    if (!matches(identity)) return
    try { process.kill(identity.pid, value) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
  }
  for (const identity of [...descendants].reverse()) signal(identity, 'SIGTERM')
  const grace = Math.min(deadline, Date.now() + 500)
  while (Date.now() < grace && descendants.some(matches)) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  for (const identity of [...descendants].reverse()) signal(identity, 'SIGKILL')
  while (Date.now() < deadline && descendants.some(matches)) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (descendants.some(matches)) {
    throw new Error('Runtime child process cleanup could not be verified')
  }
}
