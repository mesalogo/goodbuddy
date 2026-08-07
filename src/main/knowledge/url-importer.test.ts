import { describe, expect, it, vi } from 'vitest'
import { normalizeSourceUrl, UrlImporter } from './url-importer'

const publicAddress = [{ address: '93.184.216.34', family: 4 }]

describe('URL importer', () => {
  it('accepts HTTP(S) sources and rejects other protocols', () => {
    expect(() => normalizeSourceUrl('file:///etc/passwd')).toThrow('HTTP')
    expect(() => normalizeSourceUrl('不是 URL')).toThrow('有效')
    expect(normalizeSourceUrl('http://localhost/admin').href).toBe(
      'http://localhost/admin'
    )
    expect(normalizeSourceUrl('https://example.com/docs#top').href).toBe(
      'https://example.com/docs'
    )
  })

  it('imports intranet URLs that resolve to private addresses', async () => {
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('内部知识')
    }))
    const importer = new UrlImporter({
      lookup: async () => [{ address: '192.168.10.25', family: 4 }],
      transport
    })

    await expect(
      importer.import(
        'http://knowledge.internal/guide',
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      url: 'http://knowledge.internal/guide',
      contentType: 'text/plain'
    })
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'knowledge.internal' }),
      { address: '192.168.10.25', family: 4 },
      expect.any(AbortSignal),
      expect.any(Number)
    )
  })

  it('fails when a hostname resolves to no address', async () => {
    const importer = new UrlImporter({
      lookup: async () => [],
      transport: vi.fn()
    })
    await expect(
      importer.import('https://example.com', new AbortController().signal)
    ).rejects.toThrow('无法解析')
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

  it('follows redirects across hosts and validates content type', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'http://internal.example/guide' },
        body: Buffer.alloc(0)
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('内部文档')
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
    ).resolves.toMatchObject({
      url: 'http://internal.example/guide'
    })

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
