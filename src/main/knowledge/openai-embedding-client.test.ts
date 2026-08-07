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

  it('distinguishes its request timeout from caller cancellation', async () => {
    const waitForAbort = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true }
          )
        })
    )
    const timedClient = new OpenAIEmbeddingClient({
      endpoint: 'http://127.0.0.1:11434/v1/embeddings',
      model: 'nomic-embed-text',
      timeoutMs: 100,
      fetch: waitForAbort
    })

    await expect(
      timedClient.embed(['safe synthetic input'])
    ).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Embedding request timed out'
    })

    const caller = new AbortController()
    const cancelled = timedClient.embed(
      ['safe synthetic input'],
      caller.signal
    )
    caller.abort(new Error('caller cancelled'))
    await expect(cancelled).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Embedding request was cancelled'
    })

    let rejectTransport:
      | ((reason?: unknown) => void)
      | undefined
    let transportSignal: AbortSignal | null | undefined
    const delayedTransport = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          transportSignal = init?.signal
          rejectTransport = reject
        })
    )
    const delayedClient = new OpenAIEmbeddingClient({
      endpoint: 'http://127.0.0.1:11434/v1/embeddings',
      model: 'nomic-embed-text',
      timeoutMs: 100,
      fetch: delayedTransport
    })
    const lateCaller = new AbortController()
    const timeoutThenCancellation = delayedClient.embed(
      ['safe synthetic input'],
      lateCaller.signal
    )
    await vi.waitFor(
      () => {
        expect(transportSignal?.aborted).toBe(true)
        expect(transportSignal?.reason).toMatchObject({
          name: 'TimeoutError'
        })
      },
      { interval: 5, timeout: 500 }
    )
    lateCaller.abort()
    rejectTransport?.(transportSignal?.reason)
    await expect(timeoutThenCancellation).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Embedding request timed out'
    })

    const preCancelled = new AbortController()
    preCancelled.abort(new Error('caller cancelled before request'))
    await expect(
      delayedClient.embed(
        ['safe synthetic input'],
        preCancelled.signal
      )
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Embedding request was cancelled'
    })
    expect(delayedTransport).toHaveBeenCalledTimes(1)
  })

  it('accepts credentials and still rejects malformed vectors', async () => {
    expect(
      () =>
        new OpenAIEmbeddingClient({
          endpoint: 'http://user:password@10.0.0.25/embeddings?format=float',
          model: 'model'
        })
    ).not.toThrow()

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
