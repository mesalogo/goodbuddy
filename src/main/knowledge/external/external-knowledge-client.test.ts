import { describe, expect, it, vi } from 'vitest'
import {
  ExternalKnowledgeClient,
  ExternalKnowledgeError
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

  it('filters FastGPT folders and maps searchTest results', async () => {
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
      items: [{ id: 'dataset-1', name: 'Products' }]
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
