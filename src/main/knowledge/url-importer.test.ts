import { describe, expect, it, vi } from 'vitest'
import {
  isPublicAddress,
  normalizeSourceUrl,
  UrlImporter
} from './url-importer'

const publicAddress = [{ address: '93.184.216.34', family: 4 }]

describe('URL importer', () => {
  it('rejects local protocols, hosts and private address ranges', async () => {
    expect(() => normalizeSourceUrl('file:///etc/passwd')).toThrow('HTTP')
    expect(() => normalizeSourceUrl('http://localhost/admin')).toThrow(
      '不允许'
    )
    expect(isPublicAddress('127.0.0.1')).toBe(false)
    expect(isPublicAddress('10.0.0.1')).toBe(false)
    expect(isPublicAddress('169.254.169.254')).toBe(false)
    expect(isPublicAddress('::1')).toBe(false)
    expect(isPublicAddress('fc00::1')).toBe(false)
    expect(isPublicAddress('93.184.216.34')).toBe(true)

    const importer = new UrlImporter({
      lookup: async () => [{ address: '192.168.1.2', family: 4 }],
      transport: vi.fn()
    })
    await expect(
      importer.import('https://example.com', new AbortController().signal)
    ).rejects.toThrow('私网')
  })

  it('rejects mixed public and private DNS answers', async () => {
    const importer = new UrlImporter({
      lookup: async () => [
        ...publicAddress,
        { address: '127.0.0.1', family: 4 }
      ],
      transport: vi.fn()
    })
    await expect(
      importer.import('https://example.com', new AbortController().signal)
    ).rejects.toThrow('私网')
  })

  it('imports HTML and discovers only same-origin links', async () => {
    const transport = vi.fn(async () => ({
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        etag: '"v1"'
      },
      body: Buffer.from(`
        <html><head><title>产品 知识</title></head>
        <body><main>GoodBuddy 文档正文</main>
        <a href="/guide">指南</a>
        <a href="https://outside.example/private">外站</a></body></html>
      `)
    }))
    const importer = new UrlImporter({
      lookup: async () => publicAddress,
      transport
    })
    const result = await importer.import(
      'https://example.com/docs#top',
      new AbortController().signal
    )

    expect(result.title).toBe('产品 知识')
    expect(result.document.content).toContain('GoodBuddy 文档正文')
    expect(result.discoveredUrls).toEqual(['https://example.com/guide'])
    expect(result.etag).toBe('"v1"')
  })

  it('validates every redirect and response content type', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'http://internal.example/secret' },
        body: Buffer.alloc(0)
      })
    const importer = new UrlImporter({
      lookup: async (hostname) =>
        hostname === 'internal.example'
          ? [{ address: '10.0.0.2', family: 4 }]
          : publicAddress,
      transport
    })
    await expect(
      importer.import('https://example.com', new AbortController().signal)
    ).rejects.toThrow('私网')

    const binaryImporter = new UrlImporter({
      lookup: async () => publicAddress,
      transport: async () => ({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('binary')
      })
    })
    await expect(
      binaryImporter.import(
        'https://example.com/archive',
        new AbortController().signal
      )
    ).rejects.toThrow('响应类型')
  })
})
