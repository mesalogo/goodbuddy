import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, unlink, stat, chmod } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { officeDocumentSchema, type OfficeDocument } from '../shared/office-contracts'

export type OfficeFileJob =
  | { action: 'upload'; path: string; serverUrl: string }
  | { action: 'download'; path: string; serverUrl: string; document: OfficeDocument; expectedDigest?: string }

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
async function checkedFetch(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000), redirect: 'error' })
  if (!response.ok) throw new Error(`Office HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
  return response
}

export async function runOfficeFileJob(job: OfficeFileJob): Promise<{ document: OfficeDocument; digest: string }> {
  const base = `${job.serverUrl}/api/v1/office`
  if (job.action === 'upload') {
    const config = await (await checkedFetch(`${base}/config`)).json() as { enabled: boolean; maxBytes: number; versionedDownload?: boolean }
    if (!config.enabled || !config.versionedDownload) throw new Error('请启用并更新 ShareServer Office 服务（需要版本下载接口）')
    const info = await stat(job.path)
    if (!info.isFile() || info.size > config.maxBytes) throw new Error('文件类型或大小不符合服务器要求')
    const bytes = await readFile(job.path)
    if (bytes.length > config.maxBytes) throw new Error('文件超过服务器大小限制')
    const response = await checkedFetch(`${base}/documents?name=${encodeURIComponent(basename(job.path))}`, {
      method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' }
    })
    return { document: officeDocumentSchema.parse(await response.json()), digest: digest(bytes) }
  }
  const response = await checkedFetch(`${base}/documents/${job.document.id}/download?revision=${job.document.revision}`)
  const chunks: Uint8Array[] = []
  let size = 0
  if (!response.body) throw new Error('服务器未返回文档内容')
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > job.document.size) throw new Error('下载大小与保存版本不一致')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  if (size !== job.document.size || digest(bytes) !== job.document.digest) throw new Error('下载内容与保存版本不一致')
  const temporary = join(dirname(job.path), `.goodbuddy-office-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    if (job.expectedDigest) await chmod(temporary, (await stat(job.path)).mode)
    if (job.expectedDigest && digest(await readFile(job.path)) !== job.expectedDigest) {
      throw new Error('源文件已被其他程序修改。在线版本仍在服务器，请使用“另存为”。')
    }
    await rename(temporary, job.path)
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  return { document: job.document, digest: job.document.digest }
}
