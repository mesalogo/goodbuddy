import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  ExternalKnowledgeClient,
  ExternalKnowledgeError,
  type ExternalKnowledgeRetrievalConfig
} from './external-knowledge-client'

const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, { status })

describe('ExternalKnowledgeClient', () => {
  it('lists and retrieves Dify knowledge without sending retrieval overrides', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'dataset-1', name: 'Policies', description: 'Internal policies' }],
        total: 1,
        has_more: false
      }))
      .mockResolvedValueOnce(jsonResponse({
        query: 'leave policy',
        records: [{
          score: 0.91,
          segment: {
            id: 'segment-1',
            content: 'Annual leave policy',
            position: 2,
            document: { id: 'document-1', name: 'HR handbook' }
          }
        }]
      }))
    const client = new ExternalKnowledgeClient({
      provider: 'dify',
      baseUrl: 'https://dify.example/v1',
      apiKey: 'secret',
      fetcher
    })

    await expect(client.listKnowledgeBases()).resolves.toMatchObject({
      items: [{ id: 'dataset-1', name: 'Policies' }],
      hasMore: false
    })
    await expect(client.retrieve('dataset-1', 'leave policy', {
      provider: 'dify',
      useDatasetDefaults: true
    })).resolves.toEqual([expect.objectContaining({
      documentTitle: 'HR handbook',
      snippet: 'Annual leave policy',
      remoteChunkId: 'segment-1',
      providerScore: 0.91
    })])

    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://dify.example/v1/datasets?page=1&limit=100')
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ query: 'leave policy' })
  })

  it('retains FastGPT folders for navigation and maps searchTest results', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        code: 200,
        data: [
          { _id: 'folder-1', name: 'Folder', type: 'folder' },
          { _id: 'dataset-1', name: 'Products', intro: 'Product docs', type: 'dataset' }
        ]
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 200,
        data: {
          list: [{
            id: 'chunk-1',
            q: 'Question',
            a: 'Answer',
            sourceName: 'Manual',
            sourceId: 'document-1',
            chunkIndex: 3,
            score: 0.8
          }]
        }
      }))
    const client = new ExternalKnowledgeClient({
      provider: 'fastgpt',
      baseUrl: 'https://fastgpt.example/api',
      apiKey: 'secret',
      fetcher
    })

    await expect(client.listKnowledgeBases()).resolves.toMatchObject({
      items: [{ id: 'folder-1', kind: 'folder' }, { id: 'dataset-1', name: 'Products', kind: 'dataset' }]
    })
    await expect(client.retrieve('dataset-1', 'pricing', {
      provider: 'fastgpt',
      searchMode: 'mixedRecall',
      tokenLimit: 2_000,
      similarity: 0.2,
      usingRerank: false
    })).resolves.toEqual([expect.objectContaining({
      snippet: 'Question\nAnswer',
      remoteDocumentId: 'document-1',
      remoteChunkId: 'chunk-1'
    })])

    expect(String(fetcher.mock.calls[1]?.[0])).toBe('https://fastgpt.example/api/core/dataset/searchTest')
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ parentId: null })
  })

  it.each(['current', 'legacy'] as const)('preserves typed FastGPT scores and result order in the %s envelope', async (envelope) => {
    const scores = [{ type: 'fullText', value: 12.4, index: 2 }, { type: 'embedding', value: 0.8, index: 0 }, { type: 'reRank', value: 0.3, index: 1 }]
    const list = [{ q: 'First', score: scores, id: 'first' }, { q: 'Second', score: 0.99 }]
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ code: 200, data: envelope === 'legacy' ? list : { list } }))
    const client = new ExternalKnowledgeClient({ provider: 'fastgpt', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher })
    const results = await client.retrieve('dataset', 'query', { provider: 'fastgpt', searchMode: 'mixedRecall', tokenLimit: 2000, similarity: 0.2, usingRerank: true })
    expect(results.map((item) => item.snippet)).toEqual(['First', 'Second'])
    expect(results[0]).toMatchObject({ providerScores: scores, remoteChunkId: 'first' })
    expect(results[0]?.providerScore).toBeUndefined()
    expect(results[0]?.remoteDocumentId).toBeUndefined()
    expect(results[1]?.providerScore).toBe(0.99)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ datasetId: 'dataset', text: 'query', limit: 2000, similarity: 0.2, searchMode: 'mixedRecall', usingReRank: true })
  })

  it.each([
    { code: 200, data: { data: [] } },
    { code: 500, data: [] },
    { code: 200, data: [{ a: 'Answer without main text' }] },
    { code: 200, data: [{ q: 'Text', score: [{ type: 'embedding', value: '0.8' }] }] }
  ])('rejects unsupported FastGPT envelopes and malformed evidence', async (body) => {
    const client = new ExternalKnowledgeClient({ provider: 'fastgpt', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body)) })
    await expect(client.retrieve('dataset', 'query', { provider: 'fastgpt', searchMode: 'embedding', tokenLimit: 2000, similarity: 0, usingRerank: false })).rejects.toMatchObject({ code: 'EXTERNAL_KB_INVALID_RESPONSE' })
  })

  it('paginates FastGPT directory results locally and traverses parent IDs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ code: 200, data: [
      { _id: 'folder', name: 'Folder', type: 'folder' },
      { _id: 'one', name: 'One', type: 'dataset' },
      { _id: 'two', name: 'Two', type: 'dataset' }
    ] }))
    const client = new ExternalKnowledgeClient({ provider: 'fastgpt', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher })
    await expect(client.listKnowledgeBases(undefined, { parentId: 'parent', page: 2, pageSize: 2 })).resolves.toMatchObject({ items: [{ id: 'two' }], total: 3, hasMore: false })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ parentId: 'parent' })
    await expect(client.listKnowledgeBases(undefined, { search: 'one', pageSize: 1 })).resolves.toMatchObject({ items: [{ id: 'one' }], total: 1, hasMore: false })
  })

  it.each(['dify', 'ragflow'] as const)('requests subsequent %s pages and keeps continuation when local search has no matches', async (provider) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(provider === 'dify'
      ? { data: [{ id: 'one', name: 'One' }], total: 5, has_more: true }
      : { code: 0, data: [{ id: 'one', name: 'One' }], total_datasets: 5 }))
    const client = new ExternalKnowledgeClient({ provider, baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher })
    await expect(client.listKnowledgeBases(undefined, { page: 2, pageSize: 1, search: 'missing' })).resolves.toMatchObject({ items: [], hasMore: true })
    const url = new URL(String(fetcher.mock.calls[0]?.[0]))
    expect(url.searchParams.get('page')).toBe('2')
    expect(url.searchParams.get(provider === 'dify' ? 'limit' : 'page_size')).toBe('1')
  })

  it.each(['dify', 'fastgpt', 'ragflow'] as const)('reads %s details through its fixed read endpoint', async (provider) => {
    const record = { id: 'dataset', _id: 'dataset', name: 'Dataset', type: 'dataset', graphrag_task_finish_at: '2026-09-10T10:00:00Z', compilation_template_group_id: 'template' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(provider === 'dify' ? record : { code: provider === 'fastgpt' ? 200 : 0, data: provider === 'fastgpt' ? record : [record] }))
    const client = new ExternalKnowledgeClient({ provider, baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher })
    const detail = await client.getKnowledgeBase('dataset')
    expect(detail).toMatchObject({ id: 'dataset', name: 'Dataset', kind: 'dataset' })
    if (provider === 'ragflow') expect(detail).toMatchObject({ graphEnabled: true, knowledgeCompilationEnabled: true })
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://kb.example${provider === 'dify' ? '/v1/datasets/dataset' : provider === 'fastgpt' ? '/api/core/dataset/detail?id=dataset' : '/api/v1/datasets?id=dataset'}`)
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET')
  })

  it('distinguishes missing RAGFlow details and unsupported old Dify details', async () => {
    const ragflow = new ExternalKnowledgeClient({ provider: 'ragflow', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ code: 0, data: [] })) })
    await expect(ragflow.getKnowledgeBase('missing')).rejects.toMatchObject({ code: 'EXTERNAL_KB_NOT_FOUND' })
    const dify = new ExternalKnowledgeClient({ provider: 'dify', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 405 })) })
    await expect(dify.getKnowledgeBase('old')).rejects.toMatchObject({ code: 'EXTERNAL_KB_INCOMPATIBLE' })
  })

  it('sends complete explicit Dify configuration and rejects missing reranking identifiers before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ records: [] }))
    const client = new ExternalKnowledgeClient({ provider: 'dify', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher })
    const retrievalModel = { search_method: 'hybrid_search', reranking_enable: true, top_k: 4, score_threshold_enabled: true, score_threshold: 0.2, reranking_mode: 'reranking_model', reranking_model: { reranking_provider_name: 'provider', reranking_model_name: 'model' } } as const
    await client.retrieve('dataset', 'query', { provider: 'dify', useDatasetDefaults: false, retrievalModel })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ query: 'query', retrieval_model: retrievalModel })
    await expect(client.retrieve('dataset', 'query', { provider: 'dify', useDatasetDefaults: false, retrievalModel: { ...retrievalModel, reranking_model: undefined } } as ExternalKnowledgeRetrievalConfig)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not fetch when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('private reason'))
    const fetcher = vi.fn<typeof fetch>()
    const client = new ExternalKnowledgeClient({ provider: 'dify', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher })
    const operation = client.listKnowledgeBases(controller.signal)
    await expect(operation).rejects.toMatchObject({ code: 'EXTERNAL_KB_CANCELLED' })
    await expect(operation).rejects.not.toHaveProperty('cause')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['headers', 'body'] as const)('distinguishes cancellation and timeout while reading %s', async (phase) => {
    for (const cancellation of [true, false]) {
      const controller = new AbortController()
      const cancelBody = vi.fn()
      let started!: () => void
      const ready = new Promise<void>((resolve) => { started = resolve })
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        if (phase === 'headers') return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          started()
        })
        return new Response(new ReadableStream({ pull() { started() }, cancel: cancelBody }))
      })
      const client = new ExternalKnowledgeClient({ provider: 'dify', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher, timeoutMs: cancellation ? 1000 : 20 })
      const operation = client.listKnowledgeBases(controller.signal)
      const assertion = expect(operation).rejects.toMatchObject({ code: cancellation ? 'EXTERNAL_KB_CANCELLED' : 'EXTERNAL_KB_TIMEOUT' })
      await ready
      if (cancellation) controller.abort()
      await assertion
      if (phase === 'body') expect(cancelBody).toHaveBeenCalledTimes(1)
    }
  })

  it('maps body transport failures to a sanitized network error', async () => {
    const client = new ExternalKnowledgeClient({ provider: 'dify', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ pull(controller) { controller.error(new Error('private transport detail')) } }))) })
    const operation = client.listKnowledgeBases()
    await expect(operation).rejects.toMatchObject({ code: 'EXTERNAL_KB_NETWORK' })
    await expect(operation).rejects.not.toHaveProperty('cause')
  })

  it.each([200, 401])('cancels a response body when cancellation races with HTTP %s headers', async (status) => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { status })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort()
      return response
    })
    const client = new ExternalKnowledgeClient({ provider: 'dify', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher })
    await expect(client.listKnowledgeBases(controller.signal)).rejects.toMatchObject({ code: 'EXTERNAL_KB_CANCELLED' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
  })

  it.each(['headers', 'body'] as const)('aborts real HTTP requests stalled at %s on cancellation and timeout', async (phase) => {
    for (const cancellation of [true, false]) {
      let started!: () => void
      const ready = new Promise<void>((resolve) => { started = resolve })
      const server = createServer((_request, response) => {
        if (phase === 'body') {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.write('{"data":[')
        }
        started()
      })
      try {
        await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing test server address')
        const controller = new AbortController()
        const client = new ExternalKnowledgeClient({ provider: 'dify', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', timeoutMs: cancellation ? 2000 : 200 })
        const assertion = expect(client.listKnowledgeBases(controller.signal)).rejects.toMatchObject({ code: cancellation ? 'EXTERNAL_KB_CANCELLED' : 'EXTERNAL_KB_TIMEOUT' })
        await ready
        if (cancellation) controller.abort()
        await assertion
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()) })
      }
    }
  })

  it.each(['dify', 'fastgpt', 'ragflow'] as const)('validates %s scalar scores without clamping or treating zero as missing', async (provider) => {
    for (const score of [0, 12.4, -0.5, undefined, null, '0.8', {}, true]) {
      const body = provider === 'dify' ? { records: [{ segment: { content: 'Text' }, score }] }
        : provider === 'fastgpt' ? { code: 200, data: { list: [{ q: 'Text', score }] } }
          : { code: 0, data: { chunks: [{ content: 'Text', similarity: score }] } }
      const config: ExternalKnowledgeRetrievalConfig = provider === 'dify' ? { provider, useDatasetDefaults: true }
        : provider === 'fastgpt' ? { provider, searchMode: 'embedding', tokenLimit: 2000, similarity: 0, usingRerank: false }
          : { provider, similarityThreshold: 0, vectorSimilarityWeight: 0.3, knnTopK: 128, useKg: false, includeKnowledgeCompilation: false }
      const client = new ExternalKnowledgeClient({ provider, baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body)) })
      const operation = client.retrieve('dataset', 'query', config)
      if (score === undefined || score === null || typeof score === 'number') {
        await expect(operation).resolves.toEqual([expect.objectContaining({ providerScore: score ?? undefined })])
      } else {
        await expect(operation).rejects.toMatchObject({ code: 'EXTERNAL_KB_INVALID_RESPONSE' })
      }
    }
  })

  it('counts Unicode code points for the Dify API query limit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ records: [] }))
    const client = new ExternalKnowledgeClient({ provider: 'dify', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher })
    const query = '\u{20000}'.repeat(250)
    await expect(client.retrieve('dataset', query, { provider: 'dify', useDatasetDefaults: true })).resolves.toEqual([])
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ query })
    await expect(client.retrieve('dataset', `${query}a`, { provider: 'dify', useDatasetDefaults: true })).rejects.toThrow('250 characters')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not infer RAGFlow capabilities from configuration alone or invalid completion times', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ code: 0, data: ['0', '0.0', '', 'invalid'].map((time, index) => ({ id: String(index), name: 'Dataset', graphrag_task_finish_at: time, parser_config: { graphrag: { use_graphrag: true } } })) }))
    const client = new ExternalKnowledgeClient({ provider: 'ragflow', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher })
    const page = await client.listKnowledgeBases()
    expect(page.items).toHaveLength(4)
    for (const item of page.items) expect(item).toMatchObject({ graphEnabled: false, knowledgeCompilationEnabled: false })
  })

  it('sends Dify weighted configuration without merging and rejects inconsistent weights', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ records: [] }))
    const client = new ExternalKnowledgeClient({ provider: 'dify', baseUrl: 'https://kb.example', apiKey: 'test-key', fetcher })
    const retrievalModel = { search_method: 'hybrid_search', reranking_enable: true, top_k: 4, score_threshold_enabled: false, reranking_mode: 'weighted_score', weights: { weight_type: 'customized', vector_setting: { vector_weight: 0.7, embedding_provider_name: 'provider', embedding_model_name: 'model' }, keyword_setting: { keyword_weight: 0.3 } } } as const
    await client.retrieve('dataset', 'query', { provider: 'dify', useDatasetDefaults: false, retrievalModel })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ query: 'query', retrieval_model: retrievalModel })
    await expect(client.retrieve('dataset', 'query', { provider: 'dify', useDatasetDefaults: false, retrievalModel: { ...retrievalModel, weights: { ...retrievalModel.weights, keyword_setting: { keyword_weight: 0.7 } } } })).rejects.toThrow('weights must sum to one')
    await expect(client.retrieve('dataset', 'q'.repeat(251), { provider: 'dify', useDatasetDefaults: true })).rejects.toThrow('250 characters')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('cancels oversized response streams (declared length: %s)', async (declared) => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('123456')) }, cancel }), { headers: declared ? { 'content-length': '6' } : {} })
    const client = new ExternalKnowledgeClient({ provider: 'dify', baseUrl: 'https://kb.example', apiKey: 'test-key', maximumResponseBytes: 5, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response) })
    await expect(client.listKnowledgeBases()).rejects.toMatchObject({ code: 'EXTERNAL_KB_INVALID_RESPONSE' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
  })

  it('maps RAGFlow graph capability and retrieval fields', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        total_datasets: 1,
        data: [{
          id: 'dataset-1',
          name: 'Engineering',
          graphrag_task_finish_at: 1_788_880_000,
          parser_config: { graphrag: { use_graphrag: true } }
        }]
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          chunks: [{
            id: 'chunk-1',
            document_id: 'document-1',
            document_keyword: 'Runbook',
            content: 'Deployment steps',
            similarity: 0.72,
            positions: [[1, 2, 3, 4, 5]]
          }],
          doc_aggs: [],
          total: 1
        }
      }))
    const client = new ExternalKnowledgeClient({
      provider: 'ragflow',
      baseUrl: 'http://ragflow.internal:7080/api/v1',
      apiKey: 'secret',
      fetcher
    })

    await expect(client.listKnowledgeBases()).resolves.toMatchObject({
      items: [{ id: 'dataset-1', graphEnabled: true }]
    })
    await expect(client.retrieve('dataset-1', 'deploy', {
      provider: 'ragflow',
      similarityThreshold: 0.2,
      vectorSimilarityWeight: 0.3,
      knnTopK: 128,
      useKg: true,
      includeKnowledgeCompilation: false
    })).resolves.toEqual([expect.objectContaining({
      documentTitle: 'Runbook',
      snippet: 'Deployment steps',
      providerScore: 0.72
    })])

    const request = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))
    expect(request).toMatchObject({
      dataset_ids: ['dataset-1'],
      knn_top_k: 128,
      use_kg: true,
      include_knowledge_compilation: false
    })
    expect(request).not.toHaveProperty('top_k')
  })

  it('maps authentication failures without including response bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('credential details', { status: 401 })
    )
    const client = new ExternalKnowledgeClient({
      provider: 'dify',
      baseUrl: 'https://dify.example',
      apiKey: 'secret',
      fetcher
    })

    await expect(client.listKnowledgeBases()).rejects.toEqual(
      expect.objectContaining<Partial<ExternalKnowledgeError>>({
        code: 'EXTERNAL_KB_AUTH',
        message: 'External knowledge authentication failed'
      })
    )
  })

  it('rejects oversized and invalid JSON responses', async () => {
    const oversized = new ExternalKnowledgeClient({
      provider: 'dify',
      baseUrl: 'https://dify.example',
      apiKey: 'secret',
      maximumResponseBytes: 5,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('123456'))
    })
    await expect(oversized.listKnowledgeBases()).rejects.toMatchObject({
      code: 'EXTERNAL_KB_INVALID_RESPONSE'
    })

    const invalid = new ExternalKnowledgeClient({
      provider: 'dify',
      baseUrl: 'https://dify.example',
      apiKey: 'secret',
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('not-json'))
    })
    await expect(invalid.listKnowledgeBases()).rejects.toMatchObject({
      code: 'EXTERNAL_KB_INVALID_RESPONSE'
    })
  })
})
