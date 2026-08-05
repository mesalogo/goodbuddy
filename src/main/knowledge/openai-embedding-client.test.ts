import { describe, expect, it, vi } from 'vitest'
import { OpenAIEmbeddingClient } from './openai-embedding-client'

describe('OpenAIEmbeddingClient', () => {
  it('sends bounded OpenAI-compatible requests with an optional bearer key', async () => {
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        input: string[]
      }
      return new Response(
        JSON.stringify({
          data: body.input.map((_, index) => ({
            index,
            embedding: [index + 1, 2, 3]
          }))
        })
      )
    })
    const client = new OpenAIEmbeddingClient({
      endpoint: 'https://vectors.example/custom/embeddings',
      model: 'vendor/embed-large',
      apiKey: 'vector-secret',
      batchSize: 2,
      fetch: transport
    })

    await expect(client.embed(['alpha', 'beta', 'gamma'])).resolves.toEqual([
      [1, 2, 3],
      [2, 2, 3],
      [1, 2, 3]
    ])
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls[0]?.[0]).toBe(
      'https://vectors.example/custom/embeddings'
    )
    expect(transport.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer vector-secret'
    })
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'vendor/embed-large',
      input: ['alpha', 'beta']
    })
  })

  it('accepts unauthenticated endpoints and restores response index order', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [4, 5] },
            { index: 0, embedding: [2, 3] }
          ]
        })
      )
    )
    const client = new OpenAIEmbeddingClient({
      endpoint: 'http://127.0.0.1:11434/v1/embeddings',
      model: 'nomic-embed-text',
      fetch: transport
    })

    await expect(client.embed(['first', 'second'])).resolves.toEqual([
      [2, 3],
      [4, 5]
    ])
    expect(transport.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'authorization'
    )
  })

  it('rejects unsafe endpoints and malformed vectors', async () => {
    expect(
      () =>
        new OpenAIEmbeddingClient({
          endpoint: 'https://user:secret@vectors.example/embeddings',
          model: 'model'
        })
    ).toThrow('must not contain credentials')

    const malformed = new OpenAIEmbeddingClient({
      endpoint: 'https://vectors.example/v1/embeddings',
      model: 'model',
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: [1, Number.NaN] }]
          })
        )
    })
    await expect(malformed.embed(['safe synthetic input'])).rejects.toThrow(
      'finite numbers'
    )
  })
})
