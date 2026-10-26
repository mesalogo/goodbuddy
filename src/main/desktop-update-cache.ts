import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compareStrictSemVer } from './version-checker'
import type { DesktopUpdateDownloadJob } from './desktop-update-download'

export type DesktopUpdateCacheMode = 'stale' | 'all'
export type DesktopUpdateCacheJob = {
  kind: 'cleanup'
  directory: string
  legacyDirectory?: string
  currentVersion: string
  mode: DesktopUpdateCacheMode
  protectedPaths?: string[]
}
export type DesktopUpdateWorkerJob = DesktopUpdateDownloadJob | DesktopUpdateCacheJob

// Only release artifacts written by this feature, never arbitrary user files or directories.
const packageName = /^GoodBuddy-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)-(?:windows|mac|macos|linux)-(?:x64|arm64)(?:-setup\.exe|-portable\.zip|\.dmg|\.zip|\.AppImage|\.deb|\.rpm)(\.partial)?$/u

export function updateCacheFileVersion(name: string): { version: string; partial: boolean } | undefined {
  const match = packageName.exec(name)
  if (!match) return undefined
  try { compareStrictSemVer(match[1]!, match[1]!) } catch { return undefined }
  return { version: match[1]!, partial: Boolean(match[2]) }
}

/** Runs in the existing update worker, including startup recovery and manual cleanup. */
export async function cleanupDesktopUpdateCache(
  job: DesktopUpdateCacheJob,
  remove: (path: string) => Promise<void> = path => rm(path, { force: true })
): Promise<void> {
  const pathKey = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  const protectedPaths = new Set((job.protectedPaths ?? []).map(pathKey))
  const failures: string[] = []
  for (const directory of new Set([job.directory, ...(job.legacyDirectory ? [job.legacyDirectory] : [])])) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      failures.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      const artifact = updateCacheFileVersion(entry.name)
      if (!artifact || (!artifact.partial && job.mode === 'stale' && compareStrictSemVer(artifact.version, job.currentVersion) > 0)) continue
      const path = join(directory, entry.name)
      if (protectedPaths.has(pathKey(path))) continue
      try { await remove(path) } catch (error) {
        failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  if (failures.length) throw new Error(`更新缓存尚未清理完成（文件可能被占用）：${failures.join('；')}`)
}

export async function cleanupFailedUpdateFile(path: string, originalError: unknown): Promise<void> {
  try { await rm(path, { force: true }) } catch (cleanupError) {
    throw new AggregateError([originalError, cleanupError], `${originalError instanceof Error ? originalError.message : String(originalError)}；清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: cleanupError })
  }
}
