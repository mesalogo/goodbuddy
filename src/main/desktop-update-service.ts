import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { UpdateSource, VersionCheckFile, VersionCheckResult } from '../shared/application-settings-contracts'
import type { DesktopUpdateSnapshot } from '../shared/desktop-update-contracts'
import type { DesktopUpdateDownloadJob, DesktopUpdateProgress } from './desktop-update-download'
import type { DesktopUpdateCacheMode, DesktopUpdateWorkerJob } from './desktop-update-cache'

export function desktopUpdateUrl(source: UpdateSource, version: string, file: VersionCheckFile): string {
  const root = source === 'github'
    ? 'https://github.com/mesalogo/goodbuddy/releases/download/'
    : 'https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/'
  return `${root}v${encodeURIComponent(version)}/${encodeURIComponent(file.name)}`
}

export function suggestedUpdateFile(result: VersionCheckResult, portable: boolean): string | undefined {
  const suffix = result.target.platform === 'windows'
    ? portable ? '-portable.zip' : '-setup.exe'
    : result.target.platform === 'macos' ? '.dmg' : undefined
  return suffix ? result.target.files.find(file => file.name.endsWith(suffix))?.name : undefined
}

export type UpdateWorkerTask = { completion: Promise<void>; cancel: () => Promise<void> }

export function runUpdateWorker(
  workerPath: string, job: DesktopUpdateWorkerJob, report: (progress: DesktopUpdateProgress) => void
): UpdateWorkerTask {
  const worker = new Worker(workerPath, { workerData: job })
  let finished = false
  let failure: Error | undefined
  const completion = new Promise<void>((resolve, reject) => {
    worker.on('message', (message: { progress?: DesktopUpdateProgress; error?: string; done?: boolean }) => {
      if (message.progress) report(message.progress)
      if (message.error) failure = new Error(message.error)
      if (message.done) finished = true
    })
    worker.on('error', error => { failure = error instanceof Error ? error : new Error(String(error)) })
    // Resolve only after the worker has released file handles, also on cancellation.
    worker.once('exit', code => {
      if (failure) reject(failure)
      else if (!finished || code !== 0) reject(new Error('更新下载已停止'))
      else resolve()
    })
  })
  return { completion, cancel: async () => { await worker.terminate() } }
}

export class DesktopUpdateService {
  private snapshot: DesktopUpdateSnapshot = { revision: 0, status: 'idle', transferred: 0 }
  private listeners = new Set<(snapshot: DesktopUpdateSnapshot) => void>()
  private operation?: Promise<void>
  private task?: UpdateWorkerTask
  private cancelled = false
  private opening = false
  private closed = false
  private prepareRestart?: () => Promise<() => void>
  private cacheOperation?: Promise<void>
  private cacheTask?: UpdateWorkerTask
  private cleanupRetry?: ReturnType<typeof setTimeout>
  private startupCleanupStarted = false

  constructor(private readonly options: {
    directory: string
    portable: boolean
    cleanup: (mode: DesktopUpdateCacheMode, keepFileName?: string) => UpdateWorkerTask
    run: (job: DesktopUpdateDownloadJob, report: (progress: DesktopUpdateProgress) => void) => UpdateWorkerTask
    openPath: (path: string) => Promise<string>
    showItemInFolder: (path: string) => void
    requestRestart?: (installerPath: string) => void
  }) {}

  getSnapshot(): DesktopUpdateSnapshot { return this.snapshot }

  private clearCleanupRetry(): void {
    clearTimeout(this.cleanupRetry)
    this.cleanupRetry = undefined
  }

  private cleanupCache(mode: DesktopUpdateCacheMode, retry: boolean, keepFileName?: string): Promise<void> {
    if (this.cacheOperation) return this.cacheOperation
    const operation = Promise.resolve().then(async () => {
      try {
        if (this.closed) return
        this.cacheTask = this.options.cleanup(mode, keepFileName)
        await this.cacheTask.completion
        this.publish({ ...this.snapshot, cleanupWarning: undefined })
      } catch (error) {
        if (this.closed || (this.cancelled && this.operation)) throw error
        this.publish({ ...this.snapshot, cleanupWarning: error instanceof Error ? error.message : String(error) })
        if (retry && !this.closed) {
          this.clearCleanupRetry()
          // NSIS may still be releasing the installer when the new app starts.
          // One deferred attempt; later startup/manual/download actions can retry.
          this.cleanupRetry = setTimeout(() => {
            this.cleanupRetry = undefined
            if (!this.closed && !this.operation && !this.opening && !this.snapshot.packageHandedOff && this.snapshot.status !== 'restarting') {
              void this.cleanupCache(mode, false).catch(() => undefined)
            }
          }, 30_000)
          this.cleanupRetry.unref?.()
        }
        throw error
      } finally {
        this.cacheTask = undefined
      }
    }).finally(() => {
      this.cacheOperation = undefined
      this.publish({ ...this.snapshot, cacheCleaning: false })
    })
    this.cacheOperation = operation
    this.publish({ ...this.snapshot, cacheCleaning: true })
    return operation
  }

  async cleanupStalePackages(): Promise<void> {
    if (this.startupCleanupStarted || this.closed) return
    this.startupCleanupStarted = true
    if (this.operation || this.opening || this.snapshot.packageHandedOff || this.snapshot.status === 'restarting') return
    await this.cleanupCache('stale', true).catch(() => undefined)
  }

  async clearCache(): Promise<void> {
    if (this.cacheOperation) await this.cacheOperation.catch(() => undefined)
    if (this.closed || this.operation || this.opening || this.snapshot.status === 'restarting' || this.snapshot.packageHandedOff) {
      throw new Error('更新文件正在使用，请先取消下载或完成安装后再清理')
    }
    this.clearCleanupRetry()
    this.publish({ ...this.snapshot, status: this.snapshot.result?.updateAvailable ? 'available' : 'idle', fileName: undefined, transferred: 0, error: undefined })
    await this.cleanupCache('all', true)
  }

  setRestartPreparation(prepare: () => Promise<() => void>): void {
    this.prepareRestart = prepare
  }

  onChanged(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(next: Omit<DesktopUpdateSnapshot, 'revision'>): void {
    this.snapshot = { ...next, revision: this.snapshot.revision + 1 }
    for (const listener of this.listeners) listener(this.snapshot)
  }

  accept(result: VersionCheckResult, source: UpdateSource): void {
    if (this.operation || this.opening || this.closed || this.snapshot.packageHandedOff || this.snapshot.status === 'restarting') return
    this.publish({
      ...this.snapshot,
      status: result.updateAvailable ? 'available' : 'idle', result, source, transferred: 0,
      fileName: undefined, error: undefined,
      suggestedFileName: suggestedUpdateFile(result, this.options.portable),
      restartAvailable: Boolean(this.options.requestRestart && !this.options.portable && result.target.platform === 'windows')
    })
  }

  async download(fileName: string): Promise<void> {
    if (this.cacheOperation) await this.cacheOperation.catch(() => undefined)
    if (this.closed) throw new Error('更新服务已关闭')
    if (this.operation || this.opening || this.snapshot.packageHandedOff || this.snapshot.status === 'restarting') throw new Error('请等待当前更新操作或已打开的安装程序完成')
    const { result, source } = this.snapshot
    const file = result?.target.files.find(candidate => candidate.name === fileName)
    if (!result?.updateAvailable || !source || !file) throw new Error('请先检查更新并选择发布清单中的安装包')
    // Windows must retain its installed/portable distribution; macOS uses the published DMG here.
    const suggested = suggestedUpdateFile(result, this.options.portable)
    if (suggested && file.name !== suggested) throw new Error('更新包与当前安装方式不匹配')
    if (/[/\\\0]/u.test(file.name) || file.name === '.' || file.name === '..') throw new Error('更新文件名无效')
    const destination = join(this.options.directory, file.name)
    this.clearCleanupRetry()
    this.cancelled = false
    let downloaded = false
    this.publish({ ...this.snapshot, status: 'downloading', fileName, transferred: 0, error: undefined })
    // Schedule after ownership is assigned, including synchronous worker-launch failures.
    const operation = Promise.resolve().then(async () => {
      try {
        if (this.cancelled) return
        // Historical garbage must not prevent a new download; its warning remains
        // visible. The download worker still fails if its own target cannot be used.
        await this.cleanupCache('all', false, file.name).catch(() => undefined)
        if (this.cancelled || this.closed) return
        this.task = this.options.run({ file, destination, url: desktopUpdateUrl(source, result.latestVersion, file) }, progress => {
          if (!this.cancelled) this.publish({ ...this.snapshot, ...progress })
        })
        await this.task.completion
        downloaded = !this.cancelled
      } catch (error) {
        if (!this.cancelled) this.publish({ ...this.snapshot, status: 'error', error: error instanceof Error ? error.message : String(error) })
      } finally {
        this.task = undefined
        try {
          await rm(`${destination}.partial`, { force: true })
          if (this.cancelled || !downloaded) {
            await rm(destination, { force: true })
          }
          if (this.cancelled) {
            this.publish({ ...this.snapshot, status: 'available', transferred: 0, error: undefined })
          }
        } catch (error) {
          this.publish({ ...this.snapshot, status: 'error', cleanupWarning: `更新临时文件清理失败：${String(error)}` })
        }
      }
    })
    this.operation = operation
    try { await operation } finally {
      this.operation = undefined
      if (downloaded && !this.cancelled && this.snapshot.status !== 'error') {
        this.publish({ ...this.snapshot, status: 'ready', transferred: file.size })
      }
    }
  }

  async cancel(): Promise<void> {
    if (!this.operation) return
    this.cancelled = true
    this.publish({ ...this.snapshot, status: 'cancelling' })
    await this.cacheTask?.cancel()
    await this.task?.cancel()
    await this.operation
  }

  async openPackage(): Promise<void> {
    if (this.cacheOperation) await this.cacheOperation.catch(() => undefined)
    if (this.closed || this.operation || this.opening || this.snapshot.packageHandedOff || this.snapshot.status !== 'ready') throw new Error('更新包尚未准备完成或已交给安装程序')
    this.clearCleanupRetry()
    const file = this.snapshot.result?.target.files.find(candidate => candidate.name === this.snapshot.fileName)
    if (!file) throw new Error('没有已下载的更新包')
    this.opening = true
    const destination = join(this.options.directory, file.name)
    try {
      this.task = this.options.run({ file, destination, url: '', verifyOnly: true }, () => undefined)
      await this.task.completion
      if (this.closed) return
      if (file.name.endsWith('.zip') || file.name.endsWith('.AppImage')) {
        this.options.showItemInFolder(destination)
      } else {
        const error = await this.options.openPath(destination)
        if (error) throw new Error(error)
      }
      this.publish({ ...this.snapshot, packageHandedOff: true })
    } catch (error) {
      this.publish({ ...this.snapshot, status: 'error', error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally { this.opening = false; this.task = undefined }
  }

  async restart(): Promise<void> {
    if (this.cacheOperation) await this.cacheOperation.catch(() => undefined)
    if (this.closed || this.operation || this.opening || this.snapshot.packageHandedOff || this.snapshot.status !== 'ready') throw new Error('更新包尚未准备完成或已交给安装程序')
    this.clearCleanupRetry()
    if (!this.snapshot.restartAvailable || !this.options.requestRestart || !this.prepareRestart) throw new Error('当前安装方式不支持重启更新')
    const file = this.snapshot.result?.target.files.find(candidate => candidate.name === this.snapshot.fileName)
    if (!file?.name.endsWith('-setup.exe')) throw new Error('更新包不是当前安装方式对应的安装器')
    const destination = join(this.options.directory, file.name)
    this.opening = true
    this.publish({ ...this.snapshot, status: 'restarting', error: undefined })
    let verified = false
    let resume: (() => void) | undefined
    try {
      this.task = this.options.run({ file, destination, url: '', verifyOnly: true }, () => undefined)
      await this.task.completion
      if (this.closed) throw new Error('应用正在退出')
      verified = true
      resume = await this.prepareRestart()
      if (this.closed) throw new Error('应用正在退出')
      this.options.requestRestart(destination)
    } catch (error) {
      resume?.()
      if (!this.closed) this.publish({ ...this.snapshot, status: verified ? 'ready' : 'error', error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally { this.opening = false; this.task = undefined }
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.clearCleanupRetry()
    await this.cancel()
    await this.cacheTask?.cancel()
    await this.cacheOperation?.catch(() => undefined)
    await this.task?.cancel()
    this.listeners.clear()
  }
}
