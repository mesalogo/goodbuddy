// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeStaleRuntimeCaches, staleRuntimeCacheDirectories } from './stale-runtime-cache-cleanup'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('stale runtime cache cleanup', () => {
  it('selects only older app-version and Continue layout directories', () => {
    expect(staleRuntimeCacheDirectories({
      opencode: ['0.12.8', '0.15.8', '0.15.9', '0.16.0-beta.1', 'cache', 'custom', '1.0'],
      continueHost: ['host-v1-1.5.47-a', 'host-v6-1.5.47-a', 'host-v7-1.5.47-a', 'host-v7-1.6.0-b',
        'host-v8-1.5.47-a', 'isolated-global', 'isolated-global-123', 'host-v7-1.5.47-a.staging-x', 'sessions']
    }, { appVersion: '0.15.9', continueHostLayoutVersion: 7 })).toEqual({
      opencode: ['0.12.8', '0.15.8', '0.16.0-beta.1'],
      continueHost: ['host-v1-1.5.47-a', 'host-v6-1.5.47-a']
    })
  })

  it('removes stale directories and leaves everything else in the user data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-cache-cleanup-'))
    directories.push(root)
    const make = async (path: string): Promise<void> => {
      await mkdir(join(root, path), { recursive: true })
      await writeFile(join(root, path, 'file.txt'), 'x')
    }
    await make('opencode-runtime/0.15.8/config')
    await make('opencode-runtime/0.15.9/config')
    await make('continue-host/host-v6-1.5.47-a/dist')
    await make('continue-host/host-v7-1.5.47-a/dist')
    await make('continue-host/isolated-global')
    await make('continue-host/sessions')
    await writeFile(join(root, 'continue-host', 'config.yaml'), 'x')
    await make('models/embedding')

    const { removed } = await removeStaleRuntimeCaches({
      userDataPath: root, appVersion: '0.15.9', continueHostLayoutVersion: 7
    })

    expect(removed.map((path) => path.slice(root.length + 1).replaceAll('\\', '/')).sort())
      .toEqual(['continue-host/host-v6-1.5.47-a', 'opencode-runtime/0.15.8'])
    for (const kept of ['opencode-runtime/0.15.9/config/file.txt', 'continue-host/host-v7-1.5.47-a/dist/file.txt',
      'continue-host/isolated-global/file.txt', 'continue-host/sessions/file.txt', 'continue-host/config.yaml',
      'models/embedding/file.txt']) {
      expect(existsSync(join(root, kept))).toBe(true)
    }
  })

  it('does nothing when the cache roots do not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-cache-cleanup-'))
    directories.push(root)
    await expect(removeStaleRuntimeCaches({ userDataPath: root, appVersion: '0.15.9', continueHostLayoutVersion: 7 }))
      .resolves.toEqual({ removed: [] })
  })
})
