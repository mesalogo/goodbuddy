// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanupDesktopUpdateCache, cleanupFailedUpdateFile, updateCacheFileVersion } from './desktop-update-cache'

let root: string
let directory: string
const old = 'GoodBuddy-1.0.0-windows-x64-setup.exe'
const current = 'GoodBuddy-1.0.1-windows-x64-setup.exe'
const future = 'GoodBuddy-1.0.2-windows-x64-setup.exe'
beforeEach(async () => {
  await mkdir(resolve('temp'), { recursive: true })
  root = await mkdtemp(resolve('temp/desktop-update-cache-'))
  directory = join(root, 'package')
  await mkdir(directory)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('owned desktop update cache', () => {
  it('cleans installed versions and abandoned partials in current and earlier cache locations', async () => {
    for (const name of [old, current, future, `${future}.partial`, 'my-backup.zip']) await writeFile(join(directory, name), name)
    await writeFile(join(root, old), 'earlier cache layout')
    await writeFile(join(root, 'settings.json'), 'user data')
    await mkdir(join(directory, 'unknown-directory'))
    await writeFile(join(directory, 'unknown-directory', old), 'nested user file')
    await cleanupDesktopUpdateCache({ kind: 'cleanup', directory, legacyDirectory: root, currentVersion: '1.0.1', mode: 'stale' })
    for (const path of [join(directory, old), join(directory, current), join(directory, `${future}.partial`), join(root, old)]) {
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await readFile(join(directory, future), 'utf8')).toBe(future)
    expect(await readFile(join(directory, 'my-backup.zip'), 'utf8')).toBe('my-backup.zip')
    expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('user data')
    expect(await readFile(join(directory, 'unknown-directory', old), 'utf8')).toBe('nested user file')
  })

  it('manual cleanup and replacement remove managed candidates but preserve an executable in use', async () => {
    const running = join(directory, 'GoodBuddy-1.0.1-linux-x64.AppImage')
    await writeFile(running, 'running AppImage')
    await writeFile(join(directory, future), 'abandoned update')
    await mkdir(join(directory, old))
    await cleanupDesktopUpdateCache({ kind: 'cleanup', directory, currentVersion: '1.0.1', mode: 'all', protectedPaths: [running] })
    expect(await readFile(running, 'utf8')).toBe('running AppImage')
    expect((await stat(join(directory, old))).isDirectory()).toBe(true)
    await expect(stat(join(directory, future))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recognizes only release artifact names, including prereleases and macOS packages', () => {
    expect(updateCacheFileVersion('GoodBuddy-1.0.0-rc.1+build-mac-arm64.dmg.partial')).toEqual({ version: '1.0.0-rc.1+build', partial: true })
    for (const name of ['data', 'settings.json', 'GoodBuddy-user-backup.zip', 'GoodBuddy-01.0.0-windows-x64-setup.exe']) {
      expect(updateCacheFileVersion(name)).toBeUndefined()
    }
  })

  it('continues cleaning other files after a removal failure and reports the failed file', async () => {
    await writeFile(join(directory, old), 'locked')
    await writeFile(join(directory, current), 'removable')
    await expect(cleanupDesktopUpdateCache({ kind: 'cleanup', directory, currentVersion: '1.0.1', mode: 'stale' }, async path => {
      if (path.endsWith(old)) throw new Error('EBUSY')
      await rm(path)
    })).rejects.toThrow(old)
    expect(await readFile(join(directory, old), 'utf8')).toBe('locked')
    await expect(stat(join(directory, current))).rejects.toMatchObject({ code: 'ENOENT' })
    await cleanupDesktopUpdateCache({ kind: 'cleanup', directory, currentVersion: '1.0.1', mode: 'stale' })
    await expect(stat(join(directory, old))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform !== 'win32')('preserves a real Windows-locked installer and deletes it once the holder exits', async () => {
    const locked = join(directory, current)
    const ready = join(root, 'lock-ready')
    const release = join(root, 'lock-release')
    await writeFile(locked, 'installer bytes')
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; $handle=[System.IO.File]::Open(${quote(locked)},'Open','Read','None'); try { [System.IO.File]::WriteAllText(${quote(ready)},'ready'); while (-not [System.IO.File]::Exists(${quote(release)})) { Start-Sleep -Milliseconds 20 } } finally { $handle.Dispose() }`
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const exited = new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject) })
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await stat(ready); break } catch { await new Promise(done => setTimeout(done, 25)) }
      }
      expect(await readFile(ready, 'utf8'), output).toBe('ready')
      const job = { kind: 'cleanup' as const, directory, currentVersion: '1.0.1', mode: 'stale' as const }
      await expect(cleanupDesktopUpdateCache(job)).rejects.toThrow(current)
      await expect(cleanupFailedUpdateFile(locked, new Error('HTTP 503'))).rejects.toThrow('HTTP 503；清理失败')
      expect((await stat(locked)).size).toBeGreaterThan(0)
      await writeFile(release, 'release')
      expect(await exited, output).toBe(0)
      await cleanupDesktopUpdateCache(job)
      await expect(stat(locked)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await writeFile(release, 'release')
      await exited
      clearTimeout(timeout)
    }
  }, 15_000)
})
