import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { VersionCheckFile } from '../shared/application-settings-contracts'
import { fetchModelDownloadResponse } from './model-download-transport'
import { cleanupFailedUpdateFile } from './desktop-update-cache'

export type DesktopUpdateDownloadJob = {
  url: string
  file: VersionCheckFile
  destination: string
  verifyOnly?: boolean
}

export type DesktopUpdateProgress = { status: 'downloading' | 'verifying'; transferred: number }
export class DesktopUpdateVerificationError extends Error {}

export async function verifyDesktopUpdateFile(path: string, file: VersionCheckFile): Promise<void> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += (chunk as Buffer).length
    if (size > file.size) throw new DesktopUpdateVerificationError('更新文件大小与发布清单不一致')
    hash.update(chunk as Buffer)
  }
  if (size !== file.size || hash.digest('hex') !== file.sha256) {
    throw new DesktopUpdateVerificationError('更新文件校验失败，请重新下载')
  }
}

/** Runs in the update worker; hashing and file IO never block Electron Main. */
export async function downloadDesktopUpdate(
  job: DesktopUpdateDownloadJob,
  report: (progress: DesktopUpdateProgress) => void,
  transport: typeof fetch = globalThis.fetch
): Promise<void> {
  if (job.verifyOnly) {
    try { await verifyDesktopUpdateFile(job.destination, job.file) } catch (error) {
      if (error instanceof DesktopUpdateVerificationError) await cleanupFailedUpdateFile(job.destination, error)
      throw error
    }
    return
  }
  // Old managed artifacts are removed by the service before this worker starts.
  // Never recursively remove unrelated files a user may have placed in the cache.
  await mkdir(dirname(job.destination), { recursive: true })
  const partial = `${job.destination}.partial`
  await rm(partial, { force: true })
  try {
    await stat(job.destination)
    report({ status: 'verifying', transferred: job.file.size })
    await verifyDesktopUpdateFile(job.destination, job.file)
    return
  } catch (error) {
    if (error instanceof DesktopUpdateVerificationError) await cleanupFailedUpdateFile(job.destination, error)
    else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  report({ status: 'downloading', transferred: 0 })
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const resetTimeout = (): void => {
    clearTimeout(timeout)
    timeout = setTimeout(() => controller.abort(new Error('更新下载长时间未收到数据，请重试')), 60_000)
  }
  resetTimeout()
  let transferred = 0
  let failure: unknown
  let failed = false
  try {
    const response = await fetchModelDownloadResponse({
      transport, initialUrl: job.url,
      redirectHosts: new URL(job.url).hostname === 'github.com' ? ['release-assets.githubusercontent.com'] : [],
      signal: controller.signal, modelLabel: '应用更新'
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`更新下载失败：HTTP ${response.status}`)
    }
    if (!response.body) throw new Error('更新下载响应没有内容')
    const declaredSize = response.headers.get('content-length')
    if (declaredSize !== null && Number(declaredSize) !== job.file.size) {
      await response.body.cancel()
      throw new Error('更新下载大小与发布清单不一致')
    }
    const reader = response.body.getReader()
    const handle = await open(partial, 'wx')
    let lastReport = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        resetTimeout()
        transferred += value.byteLength
        if (transferred > job.file.size) throw new Error('更新下载超过发布清单大小')
        let offset = 0
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset)
          if (bytesWritten === 0) throw new Error('无法写入更新文件')
          offset += bytesWritten
        }
        if (Date.now() - lastReport >= 250) {
          report({ status: 'downloading', transferred })
          lastReport = Date.now()
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      await handle.close()
    }
    clearTimeout(timeout)
    report({ status: 'verifying', transferred })
    await verifyDesktopUpdateFile(partial, job.file)
    await rm(job.destination, { force: true })
    await rename(partial, job.destination)
  } catch (error) {
    failed = true
    failure = error
  } finally {
    clearTimeout(timeout)
    controller.abort()
    if (failed) {
      await cleanupFailedUpdateFile(partial, failure)
    } else await rm(partial, { force: true })
  }
  if (failed) throw failure
}
