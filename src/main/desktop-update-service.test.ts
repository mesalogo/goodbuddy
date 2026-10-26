// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VersionCheckResult } from '../shared/application-settings-contracts'
import { DesktopUpdateService, desktopUpdateUrl, suggestedUpdateFile } from './desktop-update-service'
import type { DesktopUpdateDownloadJob } from './desktop-update-download'

let directory: string
beforeEach(async () => {
  await mkdir(resolve('temp'), { recursive: true })
  directory = await mkdtemp(resolve('temp/desktop-update-service-'))
})
afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }) })
const result: VersionCheckResult = {
  currentVersion: '1.0.0', latestVersion: '1.0.1', updateAvailable: true, releaseUrl: 'https://github.com/mesalogo/goodbuddy/releases/tag/v1.0.1',
  target: { platform: 'windows', arch: 'arm64', formats: ['nsis', 'portable'], files: [
    { name: 'GoodBuddy-1.0.1-windows-arm64-setup.exe', size: 20, sha256: 'a'.repeat(64) },
    { name: 'GoodBuddy-1.0.1-windows-arm64-portable.zip', size: 30, sha256: 'b'.repeat(64) }
  ] }
}
const setupFile = result.target.files[0]!
const portableFile = result.target.files[1]!

describe('desktop update service', () => {
  function setup(portable = false) {
    const run = vi.fn<(job: DesktopUpdateDownloadJob) => { completion: Promise<void>; cancel: () => Promise<void> }>(() => ({ completion: Promise.resolve(), cancel: vi.fn(async () => {}) }))
    const openPath = vi.fn(async () => '')
    const showItemInFolder = vi.fn()
    const cleanup = vi.fn(() => ({ completion: Promise.resolve(), cancel: vi.fn(async () => {}) }))
    const service = new DesktopUpdateService({ directory, portable, run, openPath, showItemInFolder, cleanup })
    service.accept(result, 'mirror')
    return { service, run, openPath, showItemInFolder, cleanup }
  }

  it('selects the architecture supplied by the checker and retains the installation format', async () => {
    const { service } = setup()
    expect(suggestedUpdateFile(result, false)).toBe(setupFile.name)
    expect(suggestedUpdateFile(result, true)).toBe(portableFile.name)
    await expect(service.download(portableFile.name)).rejects.toThrow('安装方式')
    await expect(service.download('../other.exe')).rejects.toThrow('发布清单')
  })

  it('freezes source and release while downloading and re-verifies before opening', async () => {
    const { service, run, openPath } = setup()
    let finish!: () => void
    run.mockReturnValueOnce({ completion: new Promise<void>(resolve => { finish = resolve }), cancel: vi.fn(async () => {}) })
    const download = service.download(setupFile.name)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    service.accept({ ...result, latestVersion: '1.0.2' }, 'github')
    expect(service.getSnapshot().source).toBe('mirror')
    expect(run.mock.calls[0]![0].url).toBe(desktopUpdateUrl('mirror', '1.0.1', setupFile))
    await expect(service.openPackage()).rejects.toThrow('尚未准备')
    await expect(service.download(setupFile.name)).rejects.toThrow('等待')
    finish()
    await download
    await service.openPackage()
    expect(run.mock.calls[1]![0].verifyOnly).toBe(true)
    expect(openPath).toHaveBeenCalledTimes(1)
  })

  it('awaits cancellation settlement before permitting retry', async () => {
    const { service, run } = setup()
    let finish!: () => void
    const cancel = vi.fn(async () => { finish() })
    run.mockReturnValueOnce({ completion: new Promise<void>(resolve => { finish = resolve }), cancel })
    const downloading = service.download(setupFile.name)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    await service.cancel()
    await downloading
    expect(cancel).toHaveBeenCalledOnce()
    expect(service.getSnapshot().status).toBe('available')
    await service.download(setupFile.name)
    expect(service.getSnapshot().status).toBe('ready')
  })

  it('handles cancel before worker launch and a synchronous launch failure', async () => {
    const { service, run } = setup()
    const download = service.download(setupFile.name)
    await service.cancel()
    await download
    expect(run).not.toHaveBeenCalled()
    expect(service.getSnapshot().status).toBe('available')
    run.mockImplementationOnce(() => { throw new Error('Worker unavailable') })
    await service.download(setupFile.name)
    expect(service.getSnapshot()).toMatchObject({ status: 'error', error: 'Worker unavailable' })
  })

  it('shows the portable archive without executing it', async () => {
    const { service, openPath, showItemInFolder } = setup(true)
    await service.download(portableFile.name)
    await service.openPackage()
    expect(openPath).not.toHaveBeenCalled()
    expect(showItemInFolder).toHaveBeenCalledOnce()
  })

  it('does not open an artifact that fails its second verification', async () => {
    const { service, run, openPath } = setup()
    await service.download(setupFile.name)
    run.mockImplementationOnce(() => ({ completion: Promise.reject(new Error('checksum mismatch')), cancel: vi.fn(async () => {}) }))
    await expect(service.openPackage()).rejects.toThrow('checksum mismatch')
    expect(openPath).not.toHaveBeenCalled()
    expect(service.getSnapshot().status).toBe('error')
  })

  it('re-verifies, prepares persistence, then requests restart and keeps the target frozen', async () => {
    const order: string[] = []
    const resume = vi.fn()
    const service = new DesktopUpdateService({ directory, portable: false,
      cleanup: () => ({ completion: Promise.resolve(), cancel: async () => {} }),
      run: job => ({ completion: Promise.resolve().then(() => { if (job.verifyOnly) order.push('verify') }), cancel: async () => {} }),
      openPath: async () => '', showItemInFolder: vi.fn(), requestRestart: () => { order.push('restart') } })
    service.setRestartPreparation(async () => { order.push('save'); return resume })
    service.accept(result, 'mirror')
    await service.download(setupFile.name)
    await service.restart()
    expect(order).toEqual(['verify', 'save', 'restart'])
    expect(service.getSnapshot().status).toBe('restarting')
    service.accept({ ...result, latestVersion: '1.0.2' }, 'github')
    expect(service.getSnapshot().result?.latestVersion).toBe('1.0.1')
    await expect(service.download(setupFile.name)).rejects.toThrow('等待')
    expect(resume).not.toHaveBeenCalled()
  })

  it('keeps a verified package retryable when persistence fails and never quits', async () => {
    const requestRestart = vi.fn()
    const service = new DesktopUpdateService({ directory, portable: false,
      cleanup: () => ({ completion: Promise.resolve(), cancel: async () => {} }),
      run: () => ({ completion: Promise.resolve(), cancel: async () => {} }),
      openPath: async () => '', showItemInFolder: vi.fn(), requestRestart })
    service.setRestartPreparation(async () => { throw new Error('save failed') })
    service.accept(result, 'mirror')
    await service.download(setupFile.name)
    await expect(service.restart()).rejects.toThrow('save failed')
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', error: 'save failed' })
    expect(requestRestart).not.toHaveBeenCalled()
  })

  it('retries startup cleanup once and leaves repeated failures visible without an endless timer', async () => {
    vi.useFakeTimers()
    const { service, cleanup } = setup()
    cleanup.mockImplementation(() => ({ completion: Promise.reject(new Error('file locked')), cancel: vi.fn(async () => {}) }))
    await service.cleanupStalePackages()
    expect(service.getSnapshot().cleanupWarning).toBe('file locked')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(cleanup).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(cleanup).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(cleanup).toHaveBeenCalledTimes(2)
    await service.dispose()
  })

  it('cancels stale cleanup retries before preparing a new package', async () => {
    vi.useFakeTimers()
    const { service, cleanup } = setup()
    cleanup.mockImplementationOnce(() => ({ completion: Promise.reject(new Error('locked')), cancel: vi.fn(async () => {}) }))
    await service.cleanupStalePackages()
    await service.download(setupFile.name)
    expect(service.getSnapshot().status).toBe('ready')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(service.getSnapshot().cleanupWarning).toBeUndefined()
    await service.dispose()
  })

  it('clears a startup cleanup warning when the single delayed retry succeeds', async () => {
    vi.useFakeTimers()
    const { service, cleanup } = setup()
    cleanup.mockImplementationOnce(() => ({ completion: Promise.reject(new Error('installer still closing')), cancel: vi.fn(async () => {}) }))
    await service.cleanupStalePackages()
    expect(service.getSnapshot().cleanupWarning).toBe('installer still closing')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(service.getSnapshot().cleanupWarning).toBeUndefined()
    expect(service.getSnapshot().cacheCleaning).toBe(false)
    await service.dispose()
  })

  it('invalidates a ready package when manually cleared, but protects files handed to the OS', async () => {
    const { service } = setup()
    await service.download(setupFile.name)
    await service.clearCache()
    expect(service.getSnapshot()).toMatchObject({ status: 'available', fileName: undefined, transferred: 0 })
    await service.download(setupFile.name)
    await service.openPackage()
    expect(service.getSnapshot().packageHandedOff).toBe(true)
    await expect(service.clearCache()).rejects.toThrow('正在使用')
    await expect(service.download(setupFile.name)).rejects.toThrow('完成')
    await service.dispose()
  })

  it('does not block a new download when an unrelated old cache file cannot be removed', async () => {
    const { service, cleanup, run } = setup()
    cleanup.mockImplementation(() => ({ completion: Promise.reject(new Error('old package is locked')), cancel: vi.fn(async () => {}) }))
    await service.download(setupFile.name)
    expect(run).toHaveBeenCalledOnce()
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', cleanupWarning: 'old package is locked' })
    await service.dispose()
  })
})
