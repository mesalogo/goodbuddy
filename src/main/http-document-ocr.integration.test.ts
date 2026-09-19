// @vitest-environment node
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { expect, it } from 'vitest'
import { HttpDocumentOcr } from './http-document-ocr'
import { defaultHttpOcrSettings } from '../shared/document-parsing-contracts'
import { defaultDocumentParsingSettings } from './document-parsing-settings-store'
import { DocumentParsingService } from './document-parsing-service'
import { DocumentResultStorage } from './document-result-storage'

it('uses the production HTTP client for Bearer authentication, errors, cancellation and limits', async () => {
  const calls: Array<{ authorization?: string; path?: string }> = []
  const server = createServer(async (request, response) => {
    calls.push({ authorization: request.headers.authorization, path: request.url })
    for await (const _chunk of request) void _chunk
    if (request.headers.authorization !== 'Bearer synthetic-test-key') { response.writeHead(401); response.end('fixture'); return }
    if (request.url === '/health') { response.end('{}'); return }
    if (request.url === '/openapi.json') { response.end(JSON.stringify({ components: { schemas: { InferRequest: { properties: { useChartRecognition: {} } } } } })); return }
    if (request.url?.startsWith('/wait/')) { request.socket.once('close', () => response.destroy()); return }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ result: { layoutParsingResults: [{ prunedResult: {}, markdown: { text: 'Authenticated synthetic text', images: {} } }] } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const settings = { ...defaultHttpOcrSettings, baseUrl, authentication: 'bearer' as const }
    const client = new HttpDocumentOcr(settings, 'synthetic-test-key')
    expect((await client.check()).declaredOptions).toEqual(['useChartRecognition'])
    expect((await client.recognize(Buffer.from('fixture'), 1, [8])).sections[0]).toMatchObject({ pageNumber: 8, content: 'Authenticated synthetic text' })
    await expect(new HttpDocumentOcr(settings, 'wrong-key').recognize(Buffer.from('fixture'), 1, [1])).rejects.toThrow('HTTP 401')
    const controller = new AbortController()
    const pending = new HttpDocumentOcr({ ...settings, baseUrl: `${baseUrl}/wait` }, 'synthetic-test-key').recognize(Buffer.from('fixture'), 1, [1], controller.signal)
    const cancelled = expect(pending).rejects.toThrow('cancel fixture')
    while (calls.length < 5) await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort(new Error('cancel fixture'))
    await cancelled
    expect(calls.filter(call => call.authorization === 'Bearer synthetic-test-key')).toHaveLength(4)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it.each([false, true])('classifies missing-image warnings consistently through HTTP parsing and storage (text=%s)', async (hasText) => {
  const image = createCanvas(4, 4).toBuffer('image/png')
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-ocr-text-'))
  const results = new DocumentResultStorage(directory)
  const paths: string[] = []
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    paths.push(request.url ?? '')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ result: { layoutParsingResults: [{
      prunedResult: {},
      markdown: {
        text: `${hasText ? 'Recognized body\n' : ''}![valid](valid.png)\n![missing](missing.png)`,
        images: { 'valid.png': image.toString('base64') }
      }
    }] } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const settings = {
      ...defaultDocumentParsingSettings,
      ocrProvider: 'paddleocr-vl' as const,
      httpOcr: {
        ...defaultHttpOcrSettings,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      }
    }
    const parsed = await new HttpDocumentOcr(settings.httpOcr).recognize(image, 1, [1])
    expect(parsed.images).toHaveLength(1)
    expect(parsed.missingImages).toHaveLength(1)
    const saved = await results.save('scan.png', image, {
      ...parsed, title: 'scan.png', sourceFormat: '.png',
      content: parsed.sections.map(section => section.content).join('\n\n'),
      pageCount: 1
    }, settings, 0)
    expect((await results.get(saved.id)).completeness).toBe(hasText ? 'partial' : 'images-only')
    expect(saved.content).toContain('图片未保存')

    const service = new DocumentParsingService({
      forOperation: async () => ({ settings, apiKey: () => undefined })
    } as never, {} as never, {} as never)
    const extracted = service.extractImage('scan.png', image)
    if (hasText) {
      await expect(extracted).resolves.toMatchObject({ content: expect.stringContaining('Recognized body') })
    } else {
      await expect(extracted).rejects.toThrow('未提取到文字，原图片发送方式保持不变')
    }
    expect(paths).toEqual(['/layout-parsing', '/layout-parsing'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await results.close()
    await rm(directory, { recursive: true, force: true })
  }
})
