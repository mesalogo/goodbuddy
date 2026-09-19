// @vitest-environment node
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { HttpDocumentOcr } from './http-document-ocr'
import { defaultHttpOcrSettings } from '../shared/document-parsing-contracts'

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
