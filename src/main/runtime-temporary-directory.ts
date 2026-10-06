import { randomUUID } from 'node:crypto'
import fs, { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const prefixes = ['goodbuddy-opencode-', 'goodbuddy-continue-', 'goodbuddy-opencode-plugin-', 'goodbuddy-native-dsh-']
const ownerPath = (directory: string): string => join(dirname(directory), `.${basename(directory)}.owner.json`)

/** Computing the application run path must not create anything at startup. */
export function runtimeTemporaryRoot(userDataPath: string, version: string, runId: string = randomUUID()): string {
  if (![version, runId].every(value => /^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/u.test(value))) {
    throw new Error('Invalid runtime temporary directory identity')
  }
  return join(userDataPath, 'temp', 'goodbuddy-runtime', version, runId, 'goodbuddy-runtime-launch')
}

export async function createRuntimeTemporaryDirectory(root: string, prefix: string): Promise<string> {
  await ensureRuntimeTemporaryRoot(root)
  const directory = await mkdtemp(join(root, prefix))
  try {
    // A missing child PID is deliberately ambiguous if the creator dies during spawn.
    await writeFile(ownerPath(directory), JSON.stringify({ creatorPid: process.pid, childPid: null }), { mode: 0o600 })
    return directory
  } catch (error) {
    await removeRuntimeTemporaryDirectory(directory)
    throw error
  }
}

export async function ensureRuntimeTemporaryRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (basename(root) !== 'goodbuddy-runtime-launch') return
  await writeFile(ownerPath(root), JSON.stringify({ creatorPid: process.pid }), { flag: 'wx', mode: 0o600 })
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
}

export async function recordRuntimeTemporaryChild(directory: string, childPid: number | undefined): Promise<void> {
  await writeFile(ownerPath(directory), JSON.stringify({ creatorPid: process.pid, childPid: childPid ?? null }), { mode: 0o600 })
}

export async function removeRuntimeTemporaryDirectory(directory: string): Promise<void> {
  // Keep the owner outside the tree so a partial recursive deletion cannot erase retry evidence.
  await fs.rm(directory, { recursive: true, force: true })
  await rm(ownerPath(directory), { force: true })
}

export function runtimeTemporaryProcessIsActive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Access denial and PID reuse retain material rather than guessing ownership.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Called in background after the single-instance check, never awaited by first paint. */
export async function cleanupRuntimeTemporaryDirectories(options: {
  userDataPath: string
  legacyTempRoot?: string
  signal?: AbortSignal
  maximumEntries?: number
  isProcessActive?: (pid: number) => boolean
}): Promise<{ removed: string[]; retained: string[] }> {
  const result = { removed: [] as string[], retained: [] as string[] }
  let remaining = options.maximumEntries ?? 256
  const active = options.isProcessActive ?? runtimeTemporaryProcessIsActive
  async function* directories(root: string): AsyncGenerator<string> {
    const handle = await fs.opendir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') result.retained.push(root)
      return undefined
    })
    if (!handle) return
    for await (const entry of handle) {
      if (options.signal?.aborted || remaining-- <= 0) return
      if (entry.isDirectory() && !entry.isSymbolicLink()) yield entry.name
    }
  }
  async function clean(directory: string): Promise<void> {
    try {
      const owner = JSON.parse(await readFile(ownerPath(directory), 'utf8')) as { creatorPid?: number; childPid?: number }
      if (![owner.creatorPid, owner.childPid].every(pid => Number.isSafeInteger(pid) && pid! > 0) ||
          active(owner.creatorPid!) || active(owner.childPid!)) {
        result.retained.push(directory)
        return
      }
      await removeRuntimeTemporaryDirectory(directory)
      result.removed.push(directory)
    } catch {
      result.retained.push(directory)
    }
  }
  const root = join(options.userDataPath, 'temp', 'goodbuddy-runtime')
  for await (const version of directories(root)) {
    for await (const run of directories(join(root, version))) {
      const launch = join(root, version, run, 'goodbuddy-runtime-launch')
      const retainedBefore = result.retained.length
      for await (const name of directories(launch)) {
        if (prefixes.some(prefix => name.startsWith(prefix))) await clean(join(launch, name))
      }
      if (remaining > 0 && !options.signal?.aborted && result.retained.length === retainedBefore) {
        try {
          const owner = JSON.parse(await readFile(ownerPath(launch), 'utf8')) as { creatorPid: number }
          if (Number.isSafeInteger(owner.creatorPid) && owner.creatorPid > 0 && !active(owner.creatorPid)) {
            await removeRuntimeTemporaryDirectory(launch)
            result.removed.push(launch)
          }
        } catch { /* Unmarked roots and failed removals remain for a later start. */ }
      }
      // Never recursively remove an unmarked run or version parent.
      await rmdir(launch).catch(() => undefined)
      await rmdir(join(root, version, run)).catch(() => undefined)
    }
    await rmdir(join(root, version)).catch(() => undefined)
  }
  for await (const name of directories(options.legacyTempRoot ?? tmpdir())) {
    if (prefixes.some(prefix => name.startsWith(prefix))) await clean(join(options.legacyTempRoot ?? tmpdir(), name))
  }
  return result
}
