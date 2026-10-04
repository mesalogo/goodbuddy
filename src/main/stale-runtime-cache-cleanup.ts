import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Removes runtime caches left by earlier GoodBuddy versions (PERF, disk).
 *
 * - `opencode-runtime/<app version>/`: OpenCode's shared config and skills
 *   are prepared per app version and only the current version's directory is
 *   ever used, so every other version-named directory is stale (~50 MB each).
 * - `continue-host/host-v<layout>-…/`: patched Continue host bundles; only
 *   the current layout is read. Older layouts are stale. Directories of the
 *   current layout (other Continue versions or digests) are left alone, as
 *   are run directories, logs, sessions and config files.
 *
 * Only names that match these exact patterns are touched, never anything
 * else in the user data directory. Failures (a file in use, permissions) are
 * ignored; the next start tries again.
 */
export type StaleRuntimeCacheCleanupOptions = {
  userDataPath: string
  appVersion: string
  continueHostLayoutVersion: number
}

const appVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const continueHostPattern = /^host-v(\d+)-/u

async function directoryNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export function staleRuntimeCacheDirectories(
  names: { opencode: readonly string[]; continueHost: readonly string[] },
  options: Pick<StaleRuntimeCacheCleanupOptions, 'appVersion' | 'continueHostLayoutVersion'>
): { opencode: string[]; continueHost: string[] } {
  return {
    opencode: names.opencode.filter((name) =>
      appVersionPattern.test(name) && name !== options.appVersion),
    continueHost: names.continueHost.filter((name) => {
      const match = continueHostPattern.exec(name)
      return match !== null && Number(match[1]) < options.continueHostLayoutVersion
    })
  }
}

export async function removeStaleRuntimeCaches(
  options: StaleRuntimeCacheCleanupOptions
): Promise<{ removed: string[] }> {
  const opencodeRoot = join(options.userDataPath, 'opencode-runtime')
  const continueRoot = join(options.userDataPath, 'continue-host')
  const stale = staleRuntimeCacheDirectories({
    opencode: await directoryNames(opencodeRoot),
    continueHost: await directoryNames(continueRoot)
  }, options)
  const targets = [
    ...stale.opencode.map((name) => join(opencodeRoot, name)),
    ...stale.continueHost.map((name) => join(continueRoot, name))
  ]
  const removed: string[] = []
  // One at a time: this runs in the background and should not compete for disk.
  for (const target of targets) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
      removed.push(target)
    } catch {
      // Left for the next start.
    }
  }
  return { removed }
}
