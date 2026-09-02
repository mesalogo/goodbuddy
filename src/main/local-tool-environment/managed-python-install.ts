import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const OWNER_MARKER = '.goodbuddy-managed-python'
const OWNER_VALUE = 'GoodBuddy managed Python root\n'
const versionPattern = /^python-(\d+\.\d+\.\d+)$/u
const stagingPattern = /^\.managed-python-stage-[0-9a-f-]{36}$/u
const backupPattern = /^\.managed-python-backup-[0-9a-f-]{36}$/u

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError')
  }
}

function child(root: string, name: string): string {
  const path = resolve(root, name)
  if (dirname(path) !== resolve(root)) {
    throw new Error('Managed Python path escaped its owned root')
  }
  return path
}

function versionName(version: string): string {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('Managed Python version is invalid')
  }
  return `python-${version}`
}

async function ensureOwnedRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  const marker = child(root, OWNER_MARKER)
  try {
    const value = await readFile(marker, 'utf8')
    if (value !== OWNER_VALUE) {
      throw new Error('Managed Python root has an invalid ownership marker')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    const entries = await readdir(root)
    if (entries.length !== 0) {
      throw new Error('Refusing to adopt a non-empty Managed Python root', {
        cause: error
      })
    }
    const handle = await open(marker, 'wx')
    try {
      await handle.writeFile(OWNER_VALUE)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

export async function cleanupManagedPythonOperations(root: string): Promise<void> {
  await ensureOwnedRoot(root)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      (stagingPattern.test(entry.name) || backupPattern.test(entry.name)) &&
      entry.isDirectory() &&
      !entry.isSymbolicLink()
    ) {
      await rm(child(root, entry.name), { recursive: true, force: true })
    }
  }
}

async function pruneVersions(
  root: string,
  activeName: string,
  keepVersions: number
): Promise<void> {
  const candidates: { name: string; mtimeMs: number }[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      entry.name !== activeName &&
      versionPattern.test(entry.name) &&
      entry.isDirectory() &&
      !entry.isSymbolicLink()
    ) {
      const status = await lstat(child(root, entry.name))
      candidates.push({ name: entry.name, mtimeMs: status.mtimeMs })
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const candidate of candidates.slice(Math.max(0, keepVersions - 1))) {
    await rm(child(root, candidate.name), { recursive: true, force: true })
  }
}

export async function installManagedPython(options: {
  rootDirectory: string
  version: string
  stage: (stagingDirectory: string) => Promise<void>
  validate: (stagingDirectory: string) => Promise<void>
  signal?: AbortSignal
  keepVersions?: number
}): Promise<string> {
  const root = resolve(options.rootDirectory)
  const keepVersions = options.keepVersions ?? 1
  if (!Number.isInteger(keepVersions) || keepVersions < 1 || keepVersions > 3) {
    throw new Error('Managed Python retained version count must be between 1 and 3')
  }
  await ensureOwnedRoot(root)
  ensureNotAborted(options.signal)
  const destinationName = versionName(options.version)
  const destination = child(root, destinationName)
  const staging = child(root, `.managed-python-stage-${randomUUID()}`)
  const backup = child(root, `.managed-python-backup-${randomUUID()}`)
  await mkdir(staging)
  let movedExisting = false
  try {
    await options.stage(staging)
    ensureNotAborted(options.signal)
    await options.validate(staging)
    ensureNotAborted(options.signal)
    try {
      const status = await lstat(destination)
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new Error('Managed Python destination is not an owned directory')
      }
      await rename(destination, backup)
      movedExisting = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    try {
      await rename(staging, destination)
    } catch (error) {
      if (movedExisting) {
        await rename(backup, destination).catch(() => undefined)
      }
      throw error
    }
    if (movedExisting) {
      await rm(backup, { recursive: true, force: true })
    }
    await pruneVersions(root, destinationName, keepVersions)
    return destination
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function removeManagedPython(options: {
  rootDirectory: string
  version: string
}): Promise<void> {
  const root = resolve(options.rootDirectory)
  await ensureOwnedRoot(root)
  const destination = child(root, versionName(options.version))
  try {
    const status = await lstat(destination)
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error('Refusing to remove a non-directory Managed Python path')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  await rm(destination, { recursive: true, force: true })
}
