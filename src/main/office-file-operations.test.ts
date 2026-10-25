import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runOfficeFileJob } from './office-file-operations'
import type { OfficeDocument } from '../shared/office-contracts'

describe('Office file transfer', () => {
  let server: Server
  let root: string
  let url: string
  let body: Buffer
  let document: OfficeDocument
  let enabled: boolean
  let formats: string[]
  let uploads: number
  const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
  beforeEach(async () => {
    const parent = resolve('temp/office-file-tests')
    await mkdir(parent, { recursive: true })
    root = await mkdtemp(join(parent, 'run-'))
    body = Buffer.from('saved document')
    enabled = true
    formats = ['docx']
    uploads = 0
    document = { id: 'a'.repeat(32), name: 'file.docx', size: body.length, digest: hash(body), revision: 2, state: 'saved', updatedAt: 1 }
    server = createServer((request, response) => {
      if (request.url?.endsWith('/config')) {
        response.end(JSON.stringify({ enabled, formats, maxBytes: 1000, versionedDownload: true }))
      } else if (request.method === 'POST') {
        uploads++
        const chunks: Buffer[] = []
        request.on('data', chunk => chunks.push(chunk))
        request.on('end', () => {
          const uploaded = Buffer.concat(chunks)
          response.end(JSON.stringify({ ...document, digest: hash(uploaded), size: uploaded.length }))
        })
      } else if (request.url?.endsWith('/download?revision=2')) response.end(body)
      else { response.statusCode = 404; response.end() }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server address missing')
    url = `http://127.0.0.1:${address.port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { force: true, recursive: true })
  })
  it('uploads original bytes and writes the verified revision back to the source', async () => {
    const path = join(root, 'file.docx')
    await writeFile(path, 'original')
    const uploaded = await runOfficeFileJob({ action: 'upload', path, serverUrl: url })
    expect(uploaded.digest).toBe(hash('original'))
    await runOfficeFileJob({ action: 'download', path, serverUrl: url, document, expectedDigest: uploaded.digest })
    expect(await readFile(path)).toEqual(body)
    expect(await readdir(root)).toEqual(['file.docx'])
  })
  it('preserves an externally changed source and cleans staging', async () => {
    const path = join(root, 'file.docx')
    await writeFile(path, 'external edit')
    await expect(runOfficeFileJob({ action: 'download', path, serverUrl: url, document, expectedDigest: hash('original') })).rejects.toThrow('源文件已被其他程序修改')
    expect(await readFile(path, 'utf8')).toBe('external edit')
    expect(await readdir(root)).toEqual(['file.docx'])
  })
  it('does not read or upload a source when Office is disabled', async () => {
    enabled = false
    await expect(runOfficeFileJob({ action: 'upload', path: join(root, 'missing.docx'), serverUrl: url })).rejects.toThrow('尚未启用 Office')
    expect(uploads).toBe(0)
  })
  it('checks the advertised formats before reading or uploading', async () => {
    formats = ['xlsx']
    await expect(runOfficeFileJob({ action: 'upload', path: join(root, 'missing.docx'), serverUrl: url })).rejects.toThrow('不支持编辑')
    expect(uploads).toBe(0)
  })
  it('rejects a corrupt download before replacing a file', async () => {
    const path = join(root, 'file.docx')
    await writeFile(path, 'original')
    body = Buffer.from('wrong contents')
    await expect(runOfficeFileJob({ action: 'download', path, serverUrl: url, document })).rejects.toThrow('下载')
    expect(await readFile(path, 'utf8')).toBe('original')
  })
  it.each([['doc', 'docx'], ['xls', 'xlsx'], ['ppt', 'pptx']])('never writes converted %s contents back under the old extension', async (oldFormat, newFormat) => {
    const path = join(root, `original.${oldFormat}`)
    await writeFile(path, 'original legacy bytes')
    await expect(runOfficeFileJob({ action: 'download', path, serverUrl: url,
      document: { ...document, name: `original.${newFormat}`, originalName: `original.${oldFormat}`, requiresSaveAs: true } })).rejects.toThrow('扩展名必须')
    expect(await readFile(path, 'utf8')).toBe('original legacy bytes')
    expect(await readdir(root)).toEqual([`original.${oldFormat}`])
  })
})
