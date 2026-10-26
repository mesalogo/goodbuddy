// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadDesktopUpdate } from './desktop-update-download'

let directory: string
beforeEach(async () => {
  await mkdir(resolve('temp'), { recursive: true })
  directory = await mkdtemp(resolve('temp/desktop-update-test-'))
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('desktop update download', () => {
  const bytes = Buffer.from('test release artifact')
  const file = { name: 'GoodBuddy-1.0.1-windows-x64-setup.exe', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const job = () => ({ file, url: 'https://github.com/mesalogo/goodbuddy/releases/download/v1.0.0/test.exe', destination: join(directory, file.name) })

  it('writes and verifies real bytes before committing the package', async () => {
    const report = vi.fn()
    await downloadDesktopUpdate(job(), report, vi.fn(async () => new Response(bytes)))
    expect(await readFile(job().destination)).toEqual(bytes)
    expect(report).toHaveBeenLastCalledWith({ status: 'verifying', transferred: bytes.length })
    await expect(stat(`${job().destination}.partial`)).rejects.toThrow()
  })

  it.each([
    ['short body', () => new Response(bytes.subarray(1))],
    ['oversized body', () => new Response(Buffer.concat([bytes, bytes]))],
    ['wrong hash', () => new Response(Buffer.alloc(bytes.length))],
    ['wrong content length', () => new Response(bytes, { headers: { 'content-length': '2' } })],
    ['HTTP failure', () => new Response('unavailable', { status: 503 })]
  ])('rejects %s and removes incomplete bytes', async (_name, response) => {
    await expect(downloadDesktopUpdate(job(), vi.fn(), vi.fn(async () => response()))).rejects.toThrow()
    await expect(stat(job().destination)).rejects.toThrow()
    await expect(stat(`${job().destination}.partial`)).rejects.toThrow()
  })

  it('rejects an undeclared redirect without fetching it', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.org/package' } }))
    await expect(downloadDesktopUpdate(job(), vi.fn(), transport)).rejects.toThrow('未声明')
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('rechecks existing bytes without requesting the network', async () => {
    await downloadDesktopUpdate(job(), vi.fn(), vi.fn(async () => new Response(bytes)))
    const transport = vi.fn()
    await downloadDesktopUpdate({ ...job(), verifyOnly: true }, vi.fn(), transport)
    expect(transport).not.toHaveBeenCalled()
    const altered = { ...job(), file: { ...file, sha256: '0'.repeat(64) }, verifyOnly: true }
    await expect(downloadDesktopUpdate(altered, vi.fn(), transport)).rejects.toThrow('校验失败')
    await expect(stat(job().destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reuses an intact candidate after revalidation without downloading or removing user files', async () => {
    await writeFile(join(directory, 'personal.txt'), 'keep')
    await downloadDesktopUpdate(job(), vi.fn(), vi.fn(async () => new Response(bytes)))
    const transport = vi.fn()
    await downloadDesktopUpdate(job(), vi.fn(), transport)
    expect(transport).not.toHaveBeenCalled()
    expect(await readFile(job().destination)).toEqual(bytes)
    expect(await readFile(join(directory, 'personal.txt'), 'utf8')).toBe('keep')
  })

  it('cleans written partial data when the connection fails partway through a stream', async () => {
    let chunks = 0
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (chunks++ === 0) controller.enqueue(bytes.subarray(0, 5))
      else controller.error(new Error('ECONNRESET'))
    } })
    await expect(downloadDesktopUpdate(job(), vi.fn(), vi.fn(async () => new Response(body)))).rejects.toThrow('ECONNRESET')
    await expect(stat(`${job().destination}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(job().destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
