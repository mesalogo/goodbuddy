import { describe, expect, it, vi } from 'vitest'
import { CohereRerankClient } from './cohere-rerank-client'

function response(results: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify({ results }), init)
}

describe('CohereRerankClient', () => {
  it('posts the exact Cohere/Jina request to the exact configured endpoint', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      response([
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.4 }
      ])
    )
    const client = new CohereRerankClient({
      endpoint: 'https://rerank.example/custom/v1/rerank?version=2',
      model: 'vendor/rerank-large',
      apiKey: 'rerank-secret',
      fetch: transport
    })

    await expect(
      client.rerank('find this', ['first', 'second'], 2)
    ).resolves.toEqual([
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.4 }
    ])
    expect(transport).toHaveBeenCalledTimes(1)
    const [endpoint, init] = transport.mock.calls[0] ?? []
    expect(endpoint).toBe(
      'https://rerank.example/custom/v1/rerank?version=2'
    )
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error'
    })
    expect(init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: 'Bearer rerank-secret'
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'vendor/rerank-large',
      query: 'find this',
      documents: ['first', 'second'],
      top_n: 2,
      return_documents: false
    })
  })

  it('uses safe defaults and supports endpoints without authentication', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      response([{ index: 0, relevance_score: 1 }])
    )
    const client = new CohereRerankClient({ fetch: transport })

    await client.rerank('query', ['document'], 1)
    expect(transport.mock.calls[0]?.[0]).toBe(
      'https://api.cohere.com/v1/rerank'
    )
    expect(transport.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'authorization'
    )
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toMatchObject(
      { model: 'rerank-v3.5' }
    )
  })

  it('distinguishes timeout from caller cancellation', async () => {
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
    const client = new CohereRerankClient({
      timeoutMs: 10,
      fetch: waitForAbort
    })
    await expect(client.rerank('query', ['document'], 1)).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Rerank request timed out'
    })

    const caller = new AbortController()
    const cancelled = client.rerank('query', ['document'], 1, caller.signal)
    caller.abort(new Error('secret caller reason'))
    await expect(cancelled).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Rerank request was cancelled'
    })

    const preCancelled = new AbortController()
    preCancelled.abort(new Error('cancel before transport'))
    await expect(
      client.rerank('query', ['document'], 1, preCancelled.signal)
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Rerank request was cancelled'
    })
    expect(waitForAbort).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 404, 429, 500, 503])(
    'reports HTTP %i without reading or exposing the response body',
    async (status) => {
      const secretBody = 'secret response body from https://private.example'
      const client = new CohereRerankClient({
        endpoint: 'https://rerank.example/v1/rerank',
        apiKey: 'secret-key',
        fetch: async () => new Response(secretBody, { status })
      })
      const error = await client
        .rerank('query', ['document'], 1)
        .catch((caught: unknown) => caught)
      expect(error).toMatchObject({
        message: `Rerank request failed with HTTP ${status}`
      })
      expect(String(error)).not.toContain(secretBody)
      expect(String(error)).not.toContain('secret-key')
      expect(String(error)).not.toContain('rerank.example')
    }
  )

  it.each([
    ['invalid JSON', () => new Response('{')],
    ['missing results', () => new Response('{}')],
    [
      'extra root fields',
      () => new Response('{"results":[],"meta":{"secret":true}}')
    ],
    [
      'provider documents',
      () =>
        response([
          {
            index: 0,
            relevance_score: 0.8,
            document: { text: 'must not be consumed' }
          }
        ])
    ],
    [
      'duplicate indexes',
      () =>
        response([
          { index: 0, relevance_score: 0.8 },
          { index: 0, relevance_score: 0.7 }
        ])
    ],
    [
      'out-of-range indexes',
      () => response([{ index: 2, relevance_score: 0.8 }])
    ],
    [
      'scores above one',
      () => response([{ index: 0, relevance_score: 1.1 }])
    ],
    [
      'non-numeric scores',
      () => response([{ index: 0, relevance_score: 'NaN' }])
    ]
  ])('rejects malformed response: %s', async (_name, makeResponse) => {
    const client = new CohereRerankClient({
      fetch: async () => makeResponse()
    })
    const documents =
      _name === 'duplicate indexes' ? ['one', 'two'] : ['one']
    await expect(
      client.rerank('query', documents, documents.length)
    ).rejects.toThrow()
  })

  it('rejects non-finite scores encoded with overflowing JSON numbers', async () => {
    for (const relevanceScore of ['1e400', '-1e400']) {
      const client = new CohereRerankClient({
        fetch: async () =>
          new Response(
            `{"results":[{"index":0,"relevance_score":${relevanceScore}}]}`
          )
      })
      await expect(client.rerank('query', ['one'], 1)).rejects.toThrow(
        'invalid score'
      )
    }
  })

  it('requires exactly topN unique results and allows that to be fewer than candidates', async () => {
    const accepted = new CohereRerankClient({
      fetch: async () =>
        response([
          { index: 3, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.8 }
        ])
    })
    await expect(
      accepted.rerank('query', ['zero', 'one', 'two', 'three'], 2)
    ).resolves.toHaveLength(2)

    for (const count of [1, 3, 4]) {
      const rejected = new CohereRerankClient({
        fetch: async () =>
          response(
            Array.from({ length: count }, (_, index) => ({
              index,
              relevance_score: 1 - index / 10
            }))
          )
      })
      await expect(
        rejected.rerank('query', ['zero', 'one', 'two', 'three'], 2)
      ).rejects.toThrow('exactly 2 results')
    }
  })

  it('sorts scores descending and ties by original document index', async () => {
    const client = new CohereRerankClient({
      fetch: async () =>
        response([
          { index: 3, relevance_score: 0.5 },
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: 0.9 }
        ])
    })
    await expect(
      client.rerank('query', ['zero', 'one', 'two', 'three'], 4)
    ).resolves.toEqual([
      { index: 1, relevanceScore: 0.9 },
      { index: 2, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.5 },
      { index: 3, relevanceScore: 0.5 }
    ])
  })

  it('enforces query, candidate, document and encoded body bounds', async () => {
    const transport = vi.fn<typeof fetch>()
    const client = new CohereRerankClient({ fetch: transport })
    await expect(client.rerank('x'.repeat(4_001), ['one'], 1)).rejects.toThrow(
      'query must be at most 4000'
    )
    await expect(client.rerank('query', [], 1)).rejects.toThrow(
      'documents must contain'
    )
    await expect(
      client.rerank('query', Array.from({ length: 101 }, () => 'x'), 1)
    ).rejects.toThrow('documents must contain')
    await expect(client.rerank('query', ['x'.repeat(8_001)], 1)).rejects.toThrow(
      'documents[0] must be at most 8000'
    )
    // UTF-8 can exceed the body bound while every string remains under its
    // character limit.
    await expect(
      client.rerank(
        'query',
        Array.from({ length: 100 }, () => '汉'.repeat(8_000)),
        100
      )
    ).rejects.toThrow('request body is too large')
    expect(transport).not.toHaveBeenCalled()
  })

  it('bounds declared and streamed response bodies to one MiB', async () => {
    const declared = new CohereRerankClient({
      fetch: async () =>
        new Response('{}', {
          headers: { 'content-length': String(1024 * 1024 + 1) }
        })
    })
    await expect(declared.rerank('query', ['one'], 1)).rejects.toThrow(
      'response is too large'
    )

    const streamed = new CohereRerankClient({
      fetch: async () =>
        new Response(new Uint8Array(1024 * 1024 + 1))
    })
    await expect(streamed.rerank('query', ['one'], 1)).rejects.toThrow(
      'response is too large'
    )
  })

  it('rejects unsafe endpoints without echoing their value', () => {
    const endpoint = 'file:///private/secret'
    expect(() => new CohereRerankClient({ endpoint })).toThrow(
      'endpoint must use HTTP or HTTPS'
    )
    try {
      new CohereRerankClient({ endpoint: 'not-a-url secret-token' })
    } catch (error) {
      expect(String(error)).not.toContain('secret-token')
    }
  })
})
