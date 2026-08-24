import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import { ModelCallOperationStore } from './model-call-operation-store'
import {
  createModelCallOperationId,
  createResolvedModelProfileDigest,
  RemoteModelGateway,
  type RemoteModelGatewayDispatchContext
} from './remote-model-gateway'

const stores: ModelCallOperationStore[] = []
const storePaths = new Map<ModelCallOperationStore, string>()

const anthropicProfile: ResolvedModelProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Anthropic',
  baseUrl: 'https://provider.example',
  modelName: 'claude-test',
  protocol: 'anthropic-messages',
  authentication: 'api-key',
  apiKey: 'main-only-secret'
}

const context: RemoteModelGatewayDispatchContext = {
  requestId: 'request-1',
  bindingId: 'binding-1',
  promptOperationId: 'prompt-1',
  promptSequence: 0,
  roundIndex: 0,
  modelProfileDigest: createResolvedModelProfileDigest(anthropicProfile),
  modelProfile: anthropicProfile
}

const request = {
  method: 'POST',
  path: '/v1/messages',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json'
  },
  bodyBase64: Buffer.from(
    JSON.stringify({ model: 'claude-test', messages: [] })
  ).toString('base64')
} as const

afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) {
    store.close()
  }
})

async function createStore(): Promise<ModelCallOperationStore> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-gateway-'))
  const path = join(directory, 'operations.sqlite')
  const store = new ModelCallOperationStore(path)
  stores.push(store)
  storePaths.set(store, path)
  return store
}

describe('RemoteModelGateway', () => {
  it('prepares and claims before one authenticated provider fetch', async () => {
    const store = await createStore()
    const order: string[] = []
    const prepare = vi.spyOn(store, 'prepare')
    prepare.mockImplementation(function (input) {
      order.push('prepare')
      return ModelCallOperationStore.prototype.prepare.call(store, input)
    })
    const begin = vi.spyOn(store, 'beginDispatch')
    begin.mockImplementation(function (id, metadata) {
      order.push('begin')
      return ModelCallOperationStore.prototype.beginDispatch.call(
        store,
        id,
        metadata
      )
    })
    const complete = vi.spyOn(store, 'complete')
    let sentHeaders: Headers | undefined
    let sentBody: Record<string, unknown> | undefined
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      order.push('fetch')
      expect(url.toString()).toBe(
        'https://provider.example/v1/messages'
      )
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      sentHeaders = new Headers(init?.headers)
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          id: 'message-1',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            cache_read_input_tokens: 3
          }
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'request-provider-1',
            authorization: 'must-not-return'
          }
        }
      )
    })
    const gateway = new RemoteModelGateway({ store, fetcher })

    const result = await gateway.dispatch(
      context,
      request,
      new AbortController().signal
    )

    expect(order).toEqual(['prepare', 'begin', 'fetch'])
    expect(fetcher).toHaveBeenCalledOnce()
    expect(sentHeaders?.get('x-api-key')).toBe('main-only-secret')
    expect(sentHeaders?.get('anthropic-version')).toBe('2023-06-01')
    expect(sentBody).toEqual({
      model: 'claude-test',
      messages: []
    })
    expect(result.status).toBe(200)
    expect(result.headers).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'request-provider-1'
    })
    expect(JSON.stringify(result)).not.toContain('main-only-secret')
    const completed = complete.mock.results[0]?.value
    expect(completed?.status).toBe('completed')
    expect(completed?.terminalEvidence).toMatchObject({
      status: 'completed',
      providerRequestId: 'request-provider-1',
      providerResponseId: 'message-1',
      result: {
        finishReason: 'end_turn',
        outputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
      },
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: 3
      }
    })
    expect(JSON.stringify(completed)).not.toContain('main-only-secret')
    expect(JSON.stringify(completed)).not.toContain('"messages"')
  })

  it('does not clamp Runtime-selected provider output parameters', async () => {
    const store = await createStore()
    let sentBody: Record<string, unknown> | undefined
    const gateway = new RemoteModelGateway({
      store,
      fetcher: async (_url, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >
        return new Response('{}')
      }
    })
    const requestWithProviderMaximum = {
      ...request,
      bodyBase64: Buffer.from(
        JSON.stringify({
          model: 'claude-test',
          messages: [],
          max_tokens: 1_000_000
        })
      ).toString('base64')
    }

    await gateway.dispatch(
      context,
      requestWithProviderMaximum,
      new AbortController().signal
    )

    expect(sentBody).toMatchObject({ max_tokens: 1_000_000 })
  })

  it('does not persist endpoints, credentials, or provider bodies', async () => {
    const store = await createStore()
    const gateway = new RemoteModelGateway({
      store,
      fetcher: async () =>
        new Response(JSON.stringify({ private_response_field: 'secret' }))
    })
    await gateway.dispatch(context, request, new AbortController().signal)
    store.close()

    const databaseBytes = await readFile(storePaths.get(store)!)
    const persisted = databaseBytes.toString('utf8')
    expect(persisted).not.toContain('https://provider.example')
    expect(persisted).not.toContain('main-only-secret')
    expect(persisted).not.toContain('"messages"')
    expect(persisted).not.toContain('private_response_field')
  })

  it('completes the ledger for a full HTTP 4xx response', async () => {
    const store = await createStore()
    const complete = vi.spyOn(store, 'complete')
    const gateway = new RemoteModelGateway({
      store,
      fetcher: async () =>
        new Response(JSON.stringify({ error: { type: 'invalid_request' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
    })

    const result = await gateway.dispatch(
      context,
      request,
      new AbortController().signal
    )

    expect(result.status).toBe(400)
    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.results[0]?.value.status).toBe('completed')
  })

  it('permits only one fetch for duplicate canonical dispatches', async () => {
    const store = await createStore()
    const fetcher = vi.fn(async () => new Response('{}'))
    const gateway = new RemoteModelGateway({ store, fetcher })

    await gateway.dispatch(context, request, new AbortController().signal)
    await expect(
      gateway.dispatch(context, request, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'already-dispatched'
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('uses profile-independent round identity and rejects a profile swap', async () => {
    const store = await createStore()
    const fetcher = vi.fn(async () => new Response('{}'))
    const gateway = new RemoteModelGateway({ store, fetcher })
    await gateway.dispatch(context, request, new AbortController().signal)
    const swappedProfile = {
      ...anthropicProfile,
      id: '00000000-0000-4000-8000-000000000002',
      modelName: 'claude-other'
    }

    await expect(
      gateway.dispatch(
        {
          ...context,
          modelProfile: swappedProfile,
          modelProfileDigest:
            createResolvedModelProfileDigest(swappedProfile)
        },
        {
          ...request,
          bodyBase64: Buffer.from(
            JSON.stringify({ model: 'claude-other', messages: [] })
          ).toString('base64')
        },
        new AbortController().signal
      )
    ).rejects.toThrow('different identity or evidence')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('validates the Main profile snapshot digest before ledger preparation', async () => {
    const store = await createStore()
    const prepare = vi.spyOn(store, 'prepare')
    const fetcher = vi.fn(async () => new Response('{}'))
    const gateway = new RemoteModelGateway({ store, fetcher })

    await expect(
      gateway.dispatch(
        { ...context, modelProfileDigest: `sha256:${'f'.repeat(64)}` },
        request,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'model-profile-digest-mismatch' })
    expect(prepare).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fails closed on a different request for the same bound call', async () => {
    const store = await createStore()
    const fetcher = vi.fn(async () => new Response('{}'))
    const gateway = new RemoteModelGateway({ store, fetcher })

    await gateway.dispatch(context, request, new AbortController().signal)
    await expect(
      gateway.dispatch(
        context,
        {
          ...request,
          bodyBase64: Buffer.from(
            JSON.stringify({
              model: 'claude-test',
              messages: [{ role: 'user', content: 'different' }]
            })
          ).toString('base64')
        },
        new AbortController().signal
      )
    ).rejects.toThrow('different identity or evidence')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('rejects illegal paths, headers, and protocol mismatches before prepare', async () => {
    const store = await createStore()
    const prepare = vi.spyOn(store, 'prepare')
    const fetcher = vi.fn(async () => new Response('{}'))
    const gateway = new RemoteModelGateway({ store, fetcher })

    for (const invalidRequest of [
      { ...request, path: 'https://attacker.example/v1/messages' },
      {
        ...request,
        headers: { authorization: 'Bearer remote-secret' }
      },
      { ...request, path: '/v1/responses' },
      {
        ...request,
        bodyBase64: Buffer.from(
          JSON.stringify({ model: 'untrusted-model' })
        ).toString('base64')
      },
      { ...request, path: '/v1/responses' }
    ]) {
      await expect(
        gateway.dispatch(
          context,
          invalidRequest as typeof request,
          new AbortController().signal
        )
      ).rejects.toThrow()
    }
    expect(prepare).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(store.listUnresolved()).toEqual([])
  })

  it('enforces the trusted profile image-input policy before prepare', async () => {
    const store = await createStore()
    const prepare = vi.spyOn(store, 'prepare')
    const fetcher = vi.fn(async () => new Response('{}'))
    const gateway = new RemoteModelGateway({ store, fetcher })
    const imageRequest = {
      ...request,
      bodyBase64: Buffer.from(
        JSON.stringify({
          model: 'claude-test',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'AA=='
                  }
                }
              ]
            }
          ]
        })
      ).toString('base64')
    }

    await expect(
      gateway.dispatch(
        context,
        imageRequest,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'request-policy-mismatch' })
    expect(prepare).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()

    await expect(
      gateway.dispatch(
        {
          ...context,
          modelProfile: {
            ...anthropicProfile,
            supportsImageInput: true
          },
          modelProfileDigest: createResolvedModelProfileDigest({
            ...anthropicProfile,
            supportsImageInput: true
          })
        },
        imageRequest,
        new AbortController().signal
      )
    ).resolves.toMatchObject({ status: 200 })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([
    { background: true },
    { store: true },
    { service_tier: 'priority' },
    { web_search_options: {} },
    {
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search'
        }
      ]
    }
  ])(
    'rejects independently billed provider capabilities before prepare',
    async (providerCapability) => {
      const store = await createStore()
      const prepare = vi.spyOn(store, 'prepare')
      const fetcher = vi.fn(async () => new Response('{}'))
      const gateway = new RemoteModelGateway({ store, fetcher })

      await expect(
        gateway.dispatch(
          context,
          {
            ...request,
            bodyBase64: Buffer.from(
              JSON.stringify({
                model: 'claude-test',
                messages: [],
                ...providerCapability
              })
            ).toString('base64')
          },
          new AbortController().signal
        )
      ).rejects.toMatchObject({ code: 'request-policy-mismatch' })
      expect(prepare).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it('allows ordinary client-defined tools within the token policy', async () => {
    const store = await createStore()
    const fetcher = vi.fn(async () => new Response('{}'))
    const gateway = new RemoteModelGateway({ store, fetcher })

    await expect(
      gateway.dispatch(
        context,
        {
          ...request,
          bodyBase64: Buffer.from(
            JSON.stringify({
              model: 'claude-test',
              messages: [],
              tools: [
                {
                  name: 'read_file',
                  description: 'Read a file',
                  input_schema: { type: 'object' }
                }
              ]
            })
          ).toString('base64')
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ status: 200 })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'network failure',
      expectedCode: 'network-error',
      run: async () => {
        throw new Error('socket exposed sensitive upstream details')
      }
    },
    {
      name: 'timeout',
      expectedCode: 'timeout',
      run: async (_url: URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true }
          )
        }),
      timeoutMs: 5
    }
  ])(
    'marks $name after dispatch as outcome unknown',
    async ({ expectedCode, run, timeoutMs }) => {
      const store = await createStore()
      const gateway = new RemoteModelGateway({
        store,
        fetcher: run,
        ...(timeoutMs ? { timeoutMs } : {})
      })

      await expect(
        gateway.dispatch(context, request, new AbortController().signal)
      ).rejects.toMatchObject({
        code: expectedCode,
        message: expect.not.stringContaining('sensitive')
      })
      expect(store.listUnresolved()).toHaveLength(1)
      expect(store.listUnresolved()[0]).toMatchObject({
        status: 'outcome-unknown',
        terminalEvidence: {
          status: 'outcome-unknown',
          reason: { code: expectedCode, retryable: false }
        }
      })
    }
  )

  it('marks caller cancellation after dispatch as outcome unknown', async () => {
    const store = await createStore()
    const controller = new AbortController()
    const gateway = new RemoteModelGateway({
      store,
      fetcher: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          controller.abort()
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true }
          )
          if (init?.signal?.aborted) {
            reject(init.signal.reason)
          }
        })
    })

    await expect(
      gateway.dispatch(context, request, controller.signal)
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(store.listUnresolved()[0]?.status).toBe('outcome-unknown')
  })

  it('marks an oversized response as outcome unknown', async () => {
    const store = await createStore()
    const gateway = new RemoteModelGateway({
      store,
      fetcher: async () =>
        new Response(Buffer.alloc(768 * 1024 + 1), {
          headers: {
            'content-length': String(768 * 1024 + 1)
          }
        })
    })

    await expect(
      gateway.dispatch(context, request, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'response-too-large' })
    expect(store.listUnresolved()[0]).toMatchObject({
      status: 'outcome-unknown',
      terminalEvidence: {
        reason: {
          code: 'response-too-large',
          retryable: false
        }
      }
    })
  })

  it('keeps completion pending until delivery ACK and then permits the next round', async () => {
    const store = await createStore()
    const fetcher = vi.fn(async () => new Response('{}'))
    const gateway = new RemoteModelGateway({ store, fetcher })
    await gateway.dispatch(context, request, new AbortController().signal)
    const nextContext = { ...context, roundIndex: 1 }

    await expect(
      gateway.dispatch(nextContext, request, new AbortController().signal)
    ).rejects.toThrow('not been completed and delivered')
    expect(fetcher).toHaveBeenCalledOnce()
    const pending = store.listStartupRecords().records
    expect(pending).toMatchObject([{ status: 'completed' }])
    expect(pending[0]).not.toHaveProperty('responseDeliveredAt')

    gateway.markResponseDelivered(context)
    await gateway.dispatch(
      nextContext,
      request,
      new AbortController().signal
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('permits sequential responses without a cumulative output allowance', async () => {
    const store = await createStore()
    const gateway = new RemoteModelGateway({
      store,
      fetcher: async () => new Response('{}')
    })
    for (let roundIndex = 0; roundIndex < 12; roundIndex += 1) {
      const round = { ...context, roundIndex }
      await gateway.dispatch(
        round,
        request,
        new AbortController().signal
      )
      gateway.markResponseDelivered(round)
    }
    expect(store.get(
      createModelCallOperationId({ ...context, roundIndex: 11 })
    )).toMatchObject({
      status: 'completed',
      responseDeliveredAt: expect.any(Number)
    })
  })

  it('marks schema-invalid bridge responses unknown before terminal completion', async () => {
    const store = await createStore()
    const response = new Response('{}')
    const gateway = new RemoteModelGateway({
      store,
      fetcher: async () =>
        ({
          status: 999,
          headers: response.headers,
          body: response.body
        }) as Response
    })

    await expect(
      gateway.dispatch(context, request, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invalid-bridge-response' })
    expect(store.listStartupRecords().records).toMatchObject([
      {
        status: 'outcome-unknown',
        terminalEvidence: {
          reason: { code: 'invalid-bridge-response' }
        }
      }
    ])
  })

  it('injects OpenAI bearer auth without returning or persisting it', async () => {
    const store = await createStore()
    const profile: ResolvedModelProfile = {
      ...anthropicProfile,
      baseUrl: 'https://openai.example/v1',
      protocol: 'openai-responses'
    }
    let authorization: string | null = null
    const gateway = new RemoteModelGateway({
      store,
      fetcher: async (_url, init) => {
        authorization = new Headers(init?.headers).get('authorization')
        return new Response('{}')
      }
    })

    const result = await gateway.dispatch(
      {
        ...context,
        modelProfile: profile,
        modelProfileDigest: createResolvedModelProfileDigest(profile)
      },
      { ...request, path: '/v1/responses' },
      new AbortController().signal
    )

    expect(authorization).toBe('Bearer main-only-secret')
    expect(JSON.stringify(result)).not.toContain('main-only-secret')
  })
})
