import { describe, expect, it, vi } from 'vitest'
import type {
  ResolvedRuntimeSettings,
  RuntimeSettingsStore
} from '../runtime-settings-store'
import { RetryableGraphExtractionError } from './graph-extractor'
import { createModelGraphExtractor } from './model-extractor'

function store(
  overrides: Partial<ResolvedRuntimeSettings>
): RuntimeSettingsStore {
  const settings = {
    modelBaseUrl: 'http://10.0.0.25:8000/gateway',
    modelName: 'intranet-model',
    modelProtocol: 'anthropic-messages',
    modelAuthentication: 'none',
    ...overrides
  } as ResolvedRuntimeSettings
  return {
    getResolvedSettings: vi.fn(async () => settings)
  } as unknown as RuntimeSettingsStore
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('createModelGraphExtractor', () => {
  it('uses an unauthenticated Anthropic endpoint with its path and query', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        content: [{ type: 'text', text: '{"entities":[]}' }]
      })
    )
    const extract = createModelGraphExtractor(
      store({
        modelBaseUrl:
          'http://10.0.0.25:8000/gateway?api-version=2024-02-01'
      }),
      fetcher
    )

    await expect(
      extract('extract this', new AbortController().signal)
    ).resolves.toEqual({ entities: [] })
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({
        href:
          'http://10.0.0.25:8000/gateway/v1/messages?api-version=2024-02-01'
      }),
      expect.objectContaining({
        headers: {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      })
    )
  })

  it('supports an unauthenticated OpenAI chat-completions endpoint', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: [
                {
                  type: 'text',
                  text: '```json\n{"relations":[]}\n```'
                }
              ]
            }
          }
        ]
      })
    )
    const extract = createModelGraphExtractor(
      store({
        modelProtocol: 'openai-chat-completions',
        modelBaseUrl: 'http://192.168.1.50:11434/v1'
      }),
      fetcher
    )

    await expect(extract('extract this')).resolves.toEqual({
      relations: []
    })
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({
        href:
          'http://192.168.1.50:11434/v1/chat/completions'
      }),
      expect.objectContaining({
        headers: {
          'content-type': 'application/json'
        }
      })
    )
  })

  it('supports OpenAI Responses and sends a configured bearer token', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: '{"entities":[{"id":"one"}]}'
              }
            ]
          }
        ]
      })
    )
    const extract = createModelGraphExtractor(
      store({
        modelProtocol: 'openai-responses',
        modelAuthentication: 'api-key',
        apiKey: 'test-key'
      }),
      fetcher
    )

    await expect(extract('extract this')).resolves.toEqual({
      entities: [{ id: 'one' }]
    })
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/gateway/responses'
      }),
      expect.objectContaining({
        headers: {
          authorization: 'Bearer test-key',
          'content-type': 'application/json'
        }
      })
    )
  })

  it('accepts top-level output text from compatible Responses providers', async () => {
    const extract = createModelGraphExtractor(
      store({ modelProtocol: 'openai-responses' }),
      vi.fn(async () =>
        jsonResponse({
          output_text: '{"entities":[],"relations":[]}'
        })
      )
    )

    await expect(extract('extract this')).resolves.toEqual({
      entities: [],
      relations: []
    })
  })

  it('requires a key only for API-key authentication', async () => {
    const extract = createModelGraphExtractor(
      store({
        modelAuthentication: 'api-key',
        apiKey: undefined
      }),
      vi.fn()
    )

    await expect(extract('extract this')).rejects.toThrow('API Key')
  })

  it('classifies empty successful responses as retryable with diagnostics', async () => {
    const extract = createModelGraphExtractor(
      store({ modelProtocol: 'openai-chat-completions' }),
      vi.fn(async () =>
        jsonResponse({
          choices: [{
            finish_reason: 'length',
            message: { content: '' }
          }]
        })
      )
    )

    await expect(extract('extract this')).rejects.toMatchObject({
      name: 'RetryableGraphExtractionError',
      message: '模型未返回图谱内容（结束原因：length）'
    })
  })

  it('classifies request timeouts as retryable', async () => {
    const fetcher = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true }
          )
        })
    )
    const extract = createModelGraphExtractor(
      store({ modelProtocol: 'openai-chat-completions' }),
      fetcher,
      5
    )

    const result = extract('extract this')
    await expect(result).rejects.toBeInstanceOf(
      RetryableGraphExtractionError
    )
    await expect(result).rejects.toThrow(
      '模型图谱抽取响应超时'
    )
  })

  it('preserves non-retryable HTTP status with a malformed error body', async () => {
    const extract = createModelGraphExtractor(
      store({ modelProtocol: 'openai-chat-completions' }),
      vi.fn(async () =>
        new Response('<html>unauthorized</html>', { status: 401 })
      )
    )

    await expect(extract('extract this')).rejects.toMatchObject({
      name: 'Error',
      message: '模型图谱抽取失败（HTTP 401）'
    })
  })
})
