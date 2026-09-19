import { createCanvas } from '@napi-rs/canvas'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultHttpOcrSettings } from '../shared/document-parsing-contracts'
import { HttpDocumentOcr } from './http-document-ocr'

afterEach(() => vi.unstubAllGlobals())

function page(text: string, images: Record<string, string> = {}) {
  return { prunedResult: {}, markdown: { text, images } }
}

describe('HTTP document OCR', () => {
  it('uses changed restructuring output with all source pages and retains page-local images', async () => {
    const bytes = createCanvas(4, 4).toBuffer('image/png').toString('base64')
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ result: { layoutParsingResults: [
      page('first ![figure](a)', { a: bytes }), page('second')
    ] } })).mockResolvedValueOnce(Response.json({ result: { layoutParsingResults: [page('merged ![figure](a)', { a: bytes })] } }))
    vi.stubGlobal('fetch', fetch)
    const result = await new HttpDocumentOcr({ ...defaultHttpOcrSettings, baseUrl: 'http://ocr.test', mergeTables: true })
      .recognize(Buffer.from('pdf'), 0, [5, 6])
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]).toMatchObject({ sourcePages: [5, 6], content: expect.stringContaining('merged') })
    expect(result.sections[0]).not.toHaveProperty('pageNumber')
    expect(result.images?.[0]?.pageNumber).toBe(5)
    expect(result.restructure?.changed).toBe(true)
  })

  it('retains page results and reports a restructuring HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ result: { layoutParsingResults: [page('first'), page('second')] } }))
      .mockResolvedValueOnce(new Response('', { status: 503 })))
    const result = await new HttpDocumentOcr({ ...defaultHttpOcrSettings, baseUrl: 'http://ocr.test', mergeTables: true })
      .recognize(Buffer.from('pdf'), 0, [1, 2])
    expect(result.sections.map(section => section.content)).toEqual(['first', 'second'])
    expect(result.warnings[0]).toContain('HTTP 503')
  })

  it('does not start restructuring when cancellation arrives after layout', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async () => { controller.abort(new Error('cancelled')); return Response.json({ result: { layoutParsingResults: [page('first')] } }) })
    vi.stubGlobal('fetch', fetch)
    await expect(new HttpDocumentOcr({ ...defaultHttpOcrSettings, baseUrl: 'http://ocr.test', mergeTables: true })
      .recognize(Buffer.from('pdf'), 0, [1], controller.signal)).rejects.toThrow('cancelled')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('preserves page-local image identity, rewrites HTML and Markdown, and omits confidence', async () => {
    const bytes = createCanvas(4, 4).toBuffer('image/png').toString('base64')
    const fetch = vi.fn(async () => Response.json({ result: { layoutParsingResults: [
      page('<img src="imgs/a.png">', { 'imgs/a.png': bytes }),
      page('![figure](imgs/a.png)', { 'imgs/a.png': bytes })
    ] } }))
    vi.stubGlobal('fetch', fetch)
    const provider = new HttpDocumentOcr({ ...defaultHttpOcrSettings, baseUrl: 'http://ocr.test', filterMode: 'all' })
    const result = await provider.recognize(Buffer.from('pdf'), 0, [3, 4])
    expect(result.images).toHaveLength(2)
    expect(result.images![0]!.id).not.toBe(result.images![1]!.id)
    expect(result.images!.map((image) => image.pageNumber)).toEqual([3, 4])
    expect(result.sections[0]!.content).toContain(`asset:${result.images![0]!.id}`)
    expect(result.sections[1]!.content).toContain(`asset:${result.images![1]!.id}`)
    expect(result.sections[0]).not.toHaveProperty('confidence')
    const request = (fetch.mock.calls as unknown as [string, RequestInit][])[0]![1]
    expect(JSON.parse(request.body as string)).toMatchObject({ markdownIgnoreLabels: [], returnMarkdownImages: true, visualize: false })
  })

  it('does not fetch URL images and replaces broken references with an explicit warning', async () => {
    const fetch = vi.fn(async () => Response.json({ result: { layoutParsingResults: [page('<img src="figure"> text', { figure: 'http://never.test/private' })] } }))
    vi.stubGlobal('fetch', fetch)
    const result = await new HttpDocumentOcr({ ...defaultHttpOcrSettings, baseUrl: 'http://ocr.test' })
      .recognize(Buffer.from('image'), 1, [1])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result.images).toEqual([])
    expect(result.warnings[0]).toContain('未返回内联图片')
    expect(result.sections[0]!.content).not.toContain('<img')
  })

  it.each([401, 429, 503])('preserves HTTP %s without returning provider secrets', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret response', { status })))
    await expect(new HttpDocumentOcr({ ...defaultHttpOcrSettings, baseUrl: 'http://ocr.test' })
      .recognize(Buffer.from('image'), 1, [1])).rejects.toThrow(`HTTP ${status}`)
  })

  it('does not dispatch after cancellation or with missing credentials', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const provider = new HttpDocumentOcr({ ...defaultHttpOcrSettings, baseUrl: 'http://ocr.test', authentication: 'bearer' })
    await expect(provider.recognize(Buffer.from('image'), 1, [1])).rejects.toThrow('凭据未配置')
    await expect(provider.recognize(Buffer.from('image'), 1, [1], AbortSignal.abort())).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
