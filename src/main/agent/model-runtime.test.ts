import { describe, expect, it, vi } from 'vitest'
import { ModelAgentRuntime } from './model-runtime'

function createEventStream(text: string): string {
  return [
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'message-1',
        model: 'claude-sonnet-provider',
        usage: {
          input_tokens: 23,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7
        }
      }
    })}`,
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text }
    })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 11 }
    })}`,
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    ''
  ].join('\n')
}

describe('ModelAgentRuntime', () => {
  it('performs a real minimal request when testing the connection', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        content: [{ type: 'text', text: 'OK' }]
      })
    )
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://bigtoken.ai',
      model: 'sonnet-5',
      protocol: 'anthropic-messages',
      authentication: 'api-key',
      fetcher
    })

    await expect(runtime.testConnection()).resolves.toMatchObject({
      available: true,
      id: 'model'
    })
    const body = JSON.parse(
      fetcher.mock.calls[0]?.[1]?.body as string
    ) as { max_tokens: number; stream: boolean }
    expect(body).toMatchObject({ max_tokens: 1, stream: false })
  })

  it('uses the Anthropic messages endpoint and streams text deltas', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      return new Response(createEventStream('真实模型回答'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    })
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://bigtoken.ai',
      model: 'sonnet-5',
      protocol: 'anthropic-messages',
      authentication: 'api-key',
      skillInstructions: '# 文档写作',
      fetcher
    })
    const events = []

    for await (const event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed125',
        conversationId: 'conversation-1',
        prompt: '你好'
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    expect(fetcher).toHaveBeenCalledOnce()
    const [input, init] = fetcher.mock.calls[0] ?? []
    expect(input?.toString()).toBe('https://bigtoken.ai/v1/messages')
    expect(init?.method).toBe('POST')

    const body = JSON.parse(init?.body as string) as {
      model: string
      stream: boolean
      system: string
    }
    expect(body).toMatchObject({
      model: 'sonnet-5',
      stream: true
    })
    expect(body.system).toContain('# 文档写作')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: '真实模型回答'
      })
    )
    expect(events.filter((event) => event.type === 'model-usage')).toEqual([
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed125',
        type: 'model-usage',
        callId: 'message-1',
        runtime: 'model',
        provider: 'anthropic',
        model: 'claude-sonnet-provider',
        inputTokens: 23,
        outputTokens: 11,
        cacheReadTokens: 7,
        cacheWriteTokens: 5
      }
    ])
    expect(events.at(-2)).toMatchObject({ type: 'model-usage' })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('rejects a stream that ends without message_stop', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      return new Response(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        }
      )
    })
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://bigtoken.ai',
      model: 'sonnet-5',
      protocol: 'anthropic-messages',
      authentication: 'api-key',
      fetcher
    })

    const consume = async (): Promise<void> => {
      for await (const _event of runtime.run(
        {
          requestId: 'a431666e-5ec8-45e6-beb4-654132eed126',
          conversationId: 'conversation-2',
          prompt: '你好'
        },
        new AbortController().signal
      )) {
        void _event
      }
    }

    await expect(consume()).rejects.toThrow('意外中断')
  })

  it('redacts credentials from provider error messages', async () => {
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://bigtoken.ai',
      model: 'claude-sonnet-5',
      protocol: 'anthropic-messages',
      authentication: 'api-key',
      fetcher: vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            error: {
              message:
                'upstream failed Authorization: Bearer secret-token'
            }
          },
          { status: 502 }
        )
      )
    })
    const consume = async (): Promise<void> => {
      for await (const _event of runtime.run(
        {
          requestId: crypto.randomUUID(),
          conversationId: crypto.randomUUID(),
          prompt: 'test'
        },
        new AbortController().signal
      )) {
        void _event
      }
    }

    await expect(consume()).rejects.toThrow(
      'upstream failed Authorization: [REDACTED]'
    )
  })

  it('uses OpenAI Chat Completions SSE and omits auth for Ollama', async () => {
    const stream = [
      `data: ${JSON.stringify({
        choices: [{ delta: { content: '本机回答' } }]
      })}`,
      '',
      `data: ${JSON.stringify({
        id: 'chatcmpl-provider-1',
        model: 'qwen3-provider',
        choices: [],
        usage: {
          prompt_tokens: 31,
          completion_tokens: 9,
          total_tokens: 40,
          prompt_tokens_details: { cached_tokens: 13 },
          cache_write_tokens: 4
        }
      })}`,
      '',
      'data: [DONE]',
      '',
      ''
    ].join('\n')
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      fetcher
    })
    const events = []

    for await (const event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed127',
        conversationId: 'conversation-3',
        prompt: '你好'
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    const [input, init] = fetcher.mock.calls[0] ?? []
    expect(input?.toString()).toBe(
      'http://127.0.0.1:11434/v1/chat/completions'
    )
    expect(init?.headers).toEqual({
      'content-type': 'application/json'
    })
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: 'qwen3',
      stream: true,
      stream_options: {
        include_usage: true
      },
      messages: [
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: '你好' })
      ]
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: '本机回答'
      })
    )
    expect(events.filter((event) => event.type === 'model-usage')).toEqual([
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed127',
        type: 'model-usage',
        callId: 'chatcmpl-provider-1',
        runtime: 'model',
        provider: 'openai',
        model: 'qwen3-provider',
        inputTokens: 31,
        outputTokens: 9,
        cacheReadTokens: 13,
        cacheWriteTokens: 4,
        reportedTotalTokens: 40
      }
    ])
    expect(events.at(-2)).toMatchObject({ type: 'model-usage' })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('generates a bounded image through the BigToken-compatible endpoint', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00
    ]).toString('base64')
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'image-provider-1',
        model: 'gpt-image-provider',
        usage: {
          input_tokens: 17,
          output_tokens: 29,
          total_tokens: 46
        },
        data: [{ b64_json: png }]
      })
    )
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://bigtoken.ai/v1',
      model: 'gpt-image-2',
      protocol: 'openai-images-generations',
      authentication: 'api-key',
      fetcher
    })
    const events = []

    for await (const event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed128',
        conversationId: 'conversation-image',
        prompt: '一只在窗边睡觉的猫'
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    const [input, init] = fetcher.mock.calls[0] ?? []
    expect(input?.toString()).toBe(
      'https://bigtoken.ai/v1/images/generations'
    )
    expect(init?.headers).toEqual({
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    })
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'gpt-image-2',
      prompt: '一只在窗边睡觉的猫',
      n: 1,
      response_format: 'b64_json'
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'generated-image',
        mimeType: 'image/png',
        data: png
      })
    )
    expect(events.filter((event) => event.type === 'model-usage')).toEqual([
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed128',
        type: 'model-usage',
        callId: 'image-provider-1',
        runtime: 'model',
        provider: 'openai',
        model: 'gpt-image-provider',
        inputTokens: 17,
        outputTokens: 29,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedTotalTokens: 46
      }
    ])
    expect(events.findIndex((event) => event.type === 'model-usage')).toBeLessThan(
      events.findIndex((event) => event.type === 'generated-image')
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('rejects remote image URLs instead of fetching provider output', async () => {
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://bigtoken.ai/v1',
      model: 'gpt-image-2',
      protocol: 'openai-images-generations',
      authentication: 'api-key',
      fetcher: vi.fn<typeof fetch>(async () =>
        Response.json({
          data: [{ url: 'https://untrusted.example/image.png' }]
        })
      )
    })

    const consume = async (): Promise<void> => {
      for await (const _event of runtime.run(
        {
          requestId: 'a431666e-5ec8-45e6-beb4-654132eed129',
          conversationId: 'conversation-image-url',
          prompt: '测试图片'
        },
        new AbortController().signal
      )) {
        void _event
      }
    }

    await expect(consume()).rejects.toThrow('未返回 base64 图片')
  })

  it('accepts a bounded inline image data URL from compatible gateways', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00
    ]).toString('base64')
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://bigtoken.ai/v1',
      model: 'gpt-image-2',
      protocol: 'openai-images-generations',
      authentication: 'api-key',
      fetcher: vi.fn<typeof fetch>(async () =>
        Response.json({
          data: [{ url: `data:image/png;base64,${png}` }]
        })
      )
    })
    const events = []

    for await (const event of runtime.run(
      {
        requestId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        prompt: '测试内联图片'
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'generated-image',
        mimeType: 'image/png',
        data: png
      })
    )
  })

  it.each([
    {
      body: JSON.stringify({
        error: {
          message:
            'upstream unavailable Authorization: Bearer secret-token'
        }
      }),
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'image-request-502'
      },
      expected:
        'upstream unavailable Authorization: [REDACTED]（HTTP 502，请求 ID image-request-502）'
    },
    {
      body: '<html>Bad Gateway</html>',
      headers: { 'content-type': 'text/html' },
      expected: '图像生成请求失败（HTTP 502）'
    },
    {
      body: JSON.stringify({
        error: '模型接口请求失败（HTTP 502）'
      }),
      headers: { 'content-type': 'application/json' },
      expected:
        '上游图像服务暂时不可用，请稍后重试或联系服务商（HTTP 502）'
    }
  ])(
    'retains HTTP status for image gateway failures',
    async ({ body, headers, expected }) => {
      const runtime = new ModelAgentRuntime({
        apiKey: 'test-key',
        baseUrl: 'https://bigtoken.ai/v1',
        model: 'gpt-image-2',
        protocol: 'openai-images-generations',
        authentication: 'api-key',
        fetcher: vi.fn<typeof fetch>(async () =>
          new Response(body, { status: 502, headers })
        )
      })
      const consume = async (): Promise<void> => {
        for await (const _event of runtime.run(
          {
            requestId: crypto.randomUUID(),
            conversationId: crypto.randomUUID(),
            prompt: '测试网关错误'
          },
          new AbortController().signal
        )) {
          void _event
        }
      }

      await expect(consume()).rejects.toThrow(expected)
    }
  )

  it.runIf(
    process.env.GOODBUDDY_BIGTOKEN_IMAGE_INTEGRATION === '1'
  )(
    'generates a real synthetic image with BigToken gpt-image-2',
    async () => {
      const apiKey = process.env.GOODBUDDY_BIGTOKEN_API_KEY
      if (!apiKey) {
        throw new Error('GOODBUDDY_BIGTOKEN_API_KEY is required')
      }
      const runtime = new ModelAgentRuntime({
        apiKey,
        baseUrl: 'https://bigtoken.ai/v1',
        model: 'gpt-image-2',
        protocol: 'openai-images-generations',
        authentication: 'api-key'
      })
      const events = []
      for await (const event of runtime.run(
        {
          requestId: crypto.randomUUID(),
          conversationId: crypto.randomUUID(),
          prompt:
            'A simple solid blue circle centered on a plain white background.'
        },
        new AbortController().signal
      )) {
        events.push(event)
      }
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'generated-image',
          mimeType: expect.stringMatching(/^image\//u)
        })
      )
      await runtime.dispose()
    },
    180_000
  )
})
