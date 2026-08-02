import { describe, expect, it, vi } from 'vitest'
import { OllamaEmbeddingClient } from './ollama-embedding-client'

describe('OllamaEmbeddingClient', () => {
  it('batches bounded embed requests and validates consistent vectors', async () => {
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        input: string[]
        model: string
      }
      return new Response(
        JSON.stringify({
          embeddings: body.input.map((_, index) => [index + 1, 2, 3])
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
    })
    const client = new OllamaEmbeddingClient({
      url: 'http://embedding.test:11434',
      model: 'synthetic-model',
      batchSize: 2,
      fetch: transport
    })

    const result = await client.embed(['alpha', 'beta', 'gamma'])

    expect(result).toEqual([
      [1, 2, 3],
      [2, 2, 3],
      [1, 2, 3]
    ])
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls[0]?.[0]).toBe(
      'http://embedding.test:11434/api/embed'
    )
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'synthetic-model',
      input: ['alpha', 'beta'],
      truncate: true
    })
  })

  it('rejects invalid inputs and malformed or oversized responses', async () => {
    expect(
      () =>
        new OllamaEmbeddingClient({
          url: 'file:///tmp/ollama.sock',
          model: 'model'
        })
    ).toThrow('HTTP or HTTPS')

    const malformed = new OllamaEmbeddingClient({
      url: 'https://embedding.test',
      model: 'model',
      fetch: async () =>
        new Response(JSON.stringify({ embeddings: [[1, Number.NaN]] }))
    })
    await expect(malformed.embed(['safe synthetic input'])).rejects.toThrow(
      'finite numbers'
    )

    const oversized = new OllamaEmbeddingClient({
      url: 'https://embedding.test',
      model: 'model',
      fetch: async () =>
        new Response('ignored', {
          headers: { 'content-length': String(16 * 1024 * 1024 + 1) }
        })
    })
    await expect(oversized.embed(['safe synthetic input'])).rejects.toThrow(
      'too large'
    )
    await expect(
      malformed.embed(['x'.repeat(16_001)])
    ).rejects.toThrow('at most 16000')
  })

  it('honors caller cancellation without exposing request input', async () => {
    const controller = new AbortController()
    controller.abort()
    const transport = vi.fn<typeof fetch>()
    const client = new OllamaEmbeddingClient({
      url: 'https://embedding.test',
      model: 'model',
      fetch: transport
    })

    await expect(
      client.embed(['synthetic cancellation text'], controller.signal)
    ).rejects.toBeDefined()
    expect(transport).not.toHaveBeenCalled()
  })

  it.runIf(
    ['1', 'true'].includes(
      process.env.GOODBUDDY_OLLAMA_INTEGRATION?.toLowerCase() ?? ''
    )
  )(
    'embeds synthetic text against an explicitly configured Ollama instance',
    async () => {
      const url = process.env.GOODBUDDY_OLLAMA_URL
      const model = process.env.GOODBUDDY_OLLAMA_MODEL
      if (!url || !model) {
        throw new Error(
          'GOODBUDDY_OLLAMA_URL and GOODBUDDY_OLLAMA_MODEL are required'
        )
      }
      const client = new OllamaEmbeddingClient({
        url,
        model,
        timeoutMs: 30_000
      })
      const vectors = await client.embed([
        'A cat is sleeping peacefully on a sunny windowsill.',
        'A database transaction uses indexes and rollback logs.',
        'Where is the sleeping cat resting?'
      ])
      const cosine = (left: number[], right: number[]): number => {
        const dot = left.reduce(
          (total, value, index) =>
            total + value * (right[index] ?? 0),
          0
        )
        const magnitude = (vector: number[]): number =>
          Math.sqrt(
            vector.reduce(
              (total, value) => total + value * value,
              0
            )
          )
        return dot / (magnitude(left) * magnitude(right))
      }
      expect(vectors).toHaveLength(3)
      expect(vectors[0]?.length).toBeGreaterThan(0)
      expect(vectors[1]?.length).toBe(vectors[0]?.length)
      expect(vectors[2]?.length).toBe(vectors[0]?.length)
      expect(cosine(vectors[2]!, vectors[0]!)).toBeGreaterThan(
        cosine(vectors[2]!, vectors[1]!)
      )
    },
    40_000
  )
})
