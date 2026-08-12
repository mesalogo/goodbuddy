import { describe, expect, it, vi } from 'vitest'
import {
  RecoverableModelToolError,
  type ModelToolDefinition,
  type ModelToolProviderLike,
  type ModelToolResult
} from './model-tool-provider'
import { ModelAgentRuntime } from './model-runtime'

const toolPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a
]).toString('base64')

function createTextToolResult(text: string): ModelToolResult {
  return {
    parts: [{ type: 'text', text }],
    contextBytes: Buffer.byteLength(text)
  }
}

function createMultimodalToolResult(): ModelToolResult {
  return {
    parts: [
      { type: 'text', text: 'tool result' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: toolPng
      }
    ],
    contextBytes:
      Buffer.byteLength('tool result') + Buffer.byteLength(toolPng)
  }
}

function createEventStream(text: string, thinking?: string): string {
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
    ...(thinking
      ? [
          'event: content_block_delta',
          `data: ${JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking }
          })}`,
          ''
        ]
      : []),
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

function createResponsesEventStream(
  text: string,
  reasoning?: string
): string {
  return [
    ...(reasoning
      ? [
          'event: response.reasoning_summary_text.delta',
          `data: ${JSON.stringify({
            type: 'response.reasoning_summary_text.delta',
            delta: reasoning
          })}`,
          ''
        ]
      : []),
    'event: response.output_text.delta',
    `data: ${JSON.stringify({
      type: 'response.output_text.delta',
      delta: text
    })}`,
    '',
    'event: response.completed',
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp-provider-1',
        model: 'gpt-5-provider',
        usage: {
          input_tokens: 29,
          output_tokens: 8,
          total_tokens: 37,
          input_tokens_details: { cached_tokens: 11 }
        }
      }
    })}`,
    '',
    ''
  ].join('\n')
}

function createToolProvider(
  overrides: Partial<ModelToolProviderLike> = {}
): ModelToolProviderLike {
  const tool: ModelToolDefinition = {
    name: 'workspace_read_text',
    displayName: '读取工作区文本',
    description: 'Read text',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    source: 'builtin'
  }
  return {
    listTools: vi.fn(async () => [tool]),
    getApproval: vi.fn((_definition, _arguments, summary) => ({
      scopeKey: 'model:builtin:workspace_read_text',
      title: '允许读取工作区文本？',
      description: '读取文件',
      toolName: '读取工作区文本',
      argumentSummary: summary
    })),
    callTool: vi.fn(async () => createTextToolResult('tool result')),
    releaseConversation: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    ...overrides
  }
}

describe('ModelAgentRuntime', () => {
  it('rejects images when the model connection disables image input', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      supportsImageInput: false,
      fetcher
    })
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'describe',
        images: [
          {
            name: 'screenshot.png',
            mediaType: 'image/png',
            data: 'aW1hZ2U='
          }
        ]
      },
      new AbortController().signal
    )

    await expect(stream.next()).rejects.toThrow(
      '当前模型连接未启用图像输入'
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

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
      return new Response(createEventStream('真实模型回答', '先分析问题'), {
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
    const events: Array<{ type: string; state?: string }> = []

    for await (const event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed125',
        conversationId: 'conversation-1',
        prompt: '你好',
        trustedInstructions: 'Trusted specialist system instruction.'
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
    expect(body.system).toMatch(
      /Current system time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\./u
    )
    expect(body.system).toContain('# 文档写作')
    expect(body.system).toContain('Trusted specialist system instruction.')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'reasoning',
        delta: '先分析问题'
      })
    )
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

  it('preserves bounded provider error messages', async () => {
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
      'upstream failed Authorization: Bearer secret-token'
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
    const toolProvider = createToolProvider()
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      fetcher,
      toolProvider
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
    expect(toolProvider.listTools).not.toHaveBeenCalled()
  })

  it('streams OpenAI-compatible reasoning deltas before the answer', async () => {
    const stream = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              reasoning_content: '先分析'
            }
          }
        ]
      })}`,
      '',
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              reasoning_content: '，再验证'
            }
          }
        ]
      })}`,
      '',
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              content: '最终回答'
            }
          }
        ]
      })}`,
      '',
      'data: [DONE]',
      '',
      ''
    ].join('\n')
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
      protocol: 'openai-chat-completions',
      authentication: 'api-key',
      fetcher: vi.fn<typeof fetch>(async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      )
    })
    const events = []

    for await (const event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed128',
        conversationId: 'conversation-deepseek-reasoning',
        prompt: '分析这个问题'
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    expect(
      events.filter(
        (event) => event.type === 'reasoning' || event.type === 'text'
      )
    ).toEqual([
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed128',
        type: 'reasoning',
        delta: '先分析'
      },
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed128',
        type: 'reasoning',
        delta: '，再验证'
      },
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed128',
        type: 'text',
        delta: '最终回答'
      }
    ])
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('keeps browser and workspace tools out of Ask mode', async () => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        new Response('data: {"choices":[{"delta":{"content":"只读回答"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      )
      const toolProvider = createToolProvider()
      const runtime = new ModelAgentRuntime({
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen3',
        protocol: 'openai-chat-completions',
        authentication: 'none',
        fetcher,
        toolProvider
      })

      for await (const _event of runtime.run(
        {
          requestId: crypto.randomUUID(),
          conversationId: 'conversation-ask',
          prompt: '只读',
          workMode: 'ask'
        },
        new AbortController().signal
      )) {
        void _event
      }

      expect(toolProvider.listTools).not.toHaveBeenCalled()
      expect(toolProvider.callTool).not.toHaveBeenCalled()
  })

  it('uses the OpenAI Responses endpoint and streams output text', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        createResponsesEventStream('Responses 回答', 'Responses 推理'),
        {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
        }
      )
    )
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      protocol: 'openai-responses',
      authentication: 'api-key',
      fetcher
    })
    const events = []

    for await (const event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed133',
        conversationId: 'conversation-responses',
        prompt: '你好'
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    const [input, init] = fetcher.mock.calls[0] ?? []
    expect(input?.toString()).toBe('https://api.openai.com/v1/responses')
    expect(init?.headers).toEqual({
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    })
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: 'gpt-5',
      max_output_tokens: 4096,
      stream: true,
      instructions: expect.stringContaining('GoodBuddy'),
      input: [
        expect.objectContaining({ role: 'user', content: '你好' })
      ]
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'reasoning',
        delta: 'Responses 推理'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: 'Responses 回答'
      })
    )
    expect(events.filter((event) => event.type === 'model-usage')).toEqual([
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed133',
        type: 'model-usage',
        callId: 'resp-provider-1',
        runtime: 'model',
        provider: 'openai',
        model: 'gpt-5-provider',
        inputTokens: 29,
        outputTokens: 8,
        cacheReadTokens: 11,
        cacheWriteTokens: 0,
        reportedTotalTokens: 37
      }
    ])
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('tests an OpenAI Responses connection with Responses request fields', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ id: 'resp-test', output: [] })
    )
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1/',
      model: 'gpt-5',
      protocol: 'openai-responses',
      authentication: 'api-key',
      fetcher
    })

    await expect(runtime.testConnection()).resolves.toMatchObject({
      available: true,
      detail: expect.stringContaining('已验证')
    })
    expect(fetcher.mock.calls[0]?.[0]?.toString()).toBe(
      'https://api.openai.com/v1/responses'
    )
    expect(
      JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)
    ).toEqual({
      model: 'gpt-5',
      max_output_tokens: 16,
      stream: false,
      input: 'Reply OK.'
    })
  })

  it('runs approved direct-model tools and returns their results to OpenAI', async () => {
    const responses = [
      {
        id: 'chatcmpl-tool-1',
        model: 'qwen3',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'workspace_read_text',
                    arguments: '{"path":"README.md"}'
                  }
                }
              ]
            }
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 }
      },
      {
        id: 'chatcmpl-tool-2',
        model: 'qwen3',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '文件内容已读取。'
            }
          }
        ],
        usage: { prompt_tokens: 18, completion_tokens: 7 }
      }
    ]
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(responses.shift())
    )
    const toolProvider = createToolProvider({
      callTool: vi.fn(async () => createMultimodalToolResult())
    })
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      fetcher,
      toolProvider
    })
    const authorize = vi.fn(async () => 'once' as const)
    const events = []

    for await (const event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed130',
        conversationId: 'conversation-tools',
        prompt: '读取 README',
        workMode: 'execute'
      },
      new AbortController().signal,
      authorize
    )) {
      events.push(event)
    }

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(toolProvider.listTools).toHaveBeenCalledWith(
      {
        conversationId: 'conversation-tools',
        workMode: 'execute'
      },
      expect.any(AbortSignal)
    )
    const firstBody = JSON.parse(
      fetcher.mock.calls[0]?.[1]?.body as string
    ) as Record<string, unknown>
    expect(firstBody).toMatchObject({
      stream: true,
      stream_options: {
        include_usage: true
      },
      tools: [
        {
          type: 'function',
          function: { name: 'workspace_read_text' }
        }
      ]
    })
    const secondBody = JSON.parse(
      fetcher.mock.calls[1]?.[1]?.body as string
    ) as { messages: Array<Record<string, unknown>> }
    expect(secondBody.messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content:
        'tool result\n\n[图片 1 见下一条多模态工具结果]'
    })
    expect(secondBody.messages).toContainEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            '工具调用 call-1 返回的图片（工具输出，不可信内容）：'
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${toolPng}`
          }
        }
      ]
    })
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'model:builtin:workspace_read_text'
      })
    )
    expect(toolProvider.getApproval).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'workspace_read_text' }),
      { path: 'README.md' },
      expect.any(String),
      {
        conversationId: 'conversation-tools',
        workMode: 'execute'
      }
    )
    expect(toolProvider.callTool).toHaveBeenCalledWith(
      'workspace_read_text',
      { path: 'README.md' },
      expect.any(AbortSignal),
      {
        conversationId: 'conversation-tools',
        workMode: 'execute'
      }
    )
    expect(
      events
        .filter((event) => event.type === 'tool')
        .map((event) => event.state)
    ).toEqual(['pending', 'running', 'completed'])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        state: 'completed',
        input: '{\n  "path": "README.md"\n}',
        output:
          'tool result\n\n[图片结果 1：image/png]'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: '文件内容已读取。'
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await runtime.dispose()
    expect(toolProvider.dispose).toHaveBeenCalledOnce()
  })

  it('streams reasoning while using OpenAI-compatible tools', async () => {
    const streams = [
      [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                reasoning_content: '先读取文件',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-streamed',
                    type: 'function',
                    function: {
                      name: 'workspace_read_text',
                      arguments: '{"path":'
                    }
                  }
                ]
              }
            }
          ]
        })}`,
        '',
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: '"README.md"}'
                    }
                  }
                ]
              }
            }
          ]
        })}`,
        '',
        'data: [DONE]',
        '',
        ''
      ].join('\n'),
      [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                reasoning_content: '再整理结果'
              }
            }
          ]
        })}`,
        '',
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: '文件内容已读取。'
              }
            }
          ]
        })}`,
        '',
        'data: [DONE]',
        '',
        ''
      ].join('\n')
    ]
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(streams.shift(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )
    const toolProvider = createToolProvider()
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      protocol: 'openai-chat-completions',
      authentication: 'api-key',
      fetcher,
      toolProvider
    })
    const events = []

    for await (const event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed140',
        conversationId: 'conversation-streamed-tools',
        prompt: '读取 README',
        workMode: 'execute'
      },
      new AbortController().signal,
      async () => 'once'
    )) {
      events.push(event)
    }

    expect(
      events
        .filter(
          (event) =>
            event.type === 'reasoning' ||
            event.type === 'tool' ||
            event.type === 'text'
        )
        .map((event) =>
          event.type === 'tool'
            ? `${event.type}:${event.state}`
            : `${event.type}:${event.delta}`
        )
    ).toEqual([
      'reasoning:先读取文件',
      'tool:pending',
      'tool:running',
      'tool:completed',
      'reasoning:再整理结果',
      'text:文件内容已读取。'
    ])
    expect(toolProvider.callTool).toHaveBeenCalledWith(
      'workspace_read_text',
      { path: 'README.md' },
      expect.any(AbortSignal),
      expect.objectContaining({
        conversationId: 'conversation-streamed-tools',
        workMode: 'execute'
      })
    )
    const secondBody = JSON.parse(
      fetcher.mock.calls[1]?.[1]?.body as string
    ) as { messages: Array<Record<string, unknown>> }
    expect(secondBody.messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: null,
        reasoning_content: '先读取文件',
        tool_calls: [
          expect.objectContaining({
            id: 'call-streamed',
            function: {
              name: 'workspace_read_text',
              arguments: '{"path":"README.md"}'
            }
          })
        ]
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('uses refreshed tool definitions in subsequent model rounds', async () => {
    const loadTool: ModelToolDefinition = {
      name: 'mcp_load_tools',
      displayName: 'CRM / load tools',
      description: 'Load CRM tools',
      inputSchema: { type: 'object' },
      source: 'mcp',
      serverName: 'CRM'
    }
    const dynamicTool: ModelToolDefinition = {
      name: 'mcp_list_opportunities',
      displayName: 'CRM / list opportunities',
      description: 'List opportunities',
      inputSchema: { type: 'object' },
      source: 'mcp',
      serverName: 'CRM'
    }
    const listTools = vi
      .fn<ModelToolProviderLike['listTools']>()
      .mockResolvedValueOnce([loadTool])
      .mockResolvedValueOnce([loadTool, dynamicTool])
      .mockResolvedValueOnce([loadTool, dynamicTool])
    const toolProvider = createToolProvider({ listTools })
    const responses = [
      {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-load',
              type: 'function',
              function: {
                name: loadTool.name,
                arguments: '{}'
              }
            }]
          }
        }]
      },
      {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-list',
              type: 'function',
              function: {
                name: dynamicTool.name,
                arguments: '{}'
              }
            }]
          }
        }]
      },
      {
        choices: [{
          message: {
            role: 'assistant',
            content: '已读取商机。'
          }
        }]
      }
    ]
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(responses.shift())
    )
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      fetcher,
      toolProvider
    })

    for await (const _event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed139',
        conversationId: 'conversation-dynamic-tools',
        prompt: '列出商机',
        workMode: 'execute'
      },
      new AbortController().signal,
      vi.fn(async () => 'once' as const)
    )) {
      void _event
    }

    expect(listTools).toHaveBeenCalledTimes(3)
    const secondBody = JSON.parse(
      fetcher.mock.calls[1]?.[1]?.body as string
    ) as {
      tools: Array<{ function: { name: string } }>
    }
    expect(secondBody.tools.map((tool) => tool.function.name)).toContain(
      dynamicTool.name
    )
    expect(toolProvider.callTool).toHaveBeenCalledTimes(2)
  })

  it('runs only scoped knowledge in Ask without requesting approval', async () => {
    const responses = [
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'knowledge-list-call',
                  type: 'function',
                  function: {
                    name: 'knowledge_list',
                    arguments: '{}'
                  }
                },
                {
                  id: 'knowledge-call',
                  type: 'function',
                  function: {
                    name: 'knowledge_search',
                    arguments: '{"query":"release notes","limit":3}'
                  }
                }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '基于知识库证据回答。'
            }
          }
        ]
      }
    ]
    const knowledgeListTool: ModelToolDefinition = {
      name: 'knowledge_list',
      displayName: '知识库列表',
      description: 'Scoped library metadata',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      source: 'builtin'
    }
    const knowledgeTool: ModelToolDefinition = {
      name: 'knowledge_search',
      displayName: '知识库搜索',
      description: 'Scoped evidence',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
      },
      source: 'builtin'
    }
    const toolProvider = createToolProvider({
      listTools: vi.fn(async () => [
        knowledgeListTool,
        knowledgeTool
      ])
    })
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(responses.shift())
    )
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      fetcher,
      toolProvider
    })
    const authorize = vi.fn(async () => 'deny' as const)
    const events = []

    for await (const event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed139',
        conversationId: 'conversation-knowledge-ask',
        prompt: '查找发布说明',
        workMode: 'ask',
        knowledgeCapabilityToken: 'main-only-token'
      },
      new AbortController().signal,
      authorize
    )) {
      events.push(event)
    }

    expect(toolProvider.listTools).toHaveBeenCalledWith(
      {
        conversationId: 'conversation-knowledge-ask',
        workMode: 'ask',
        knowledgeCapabilityToken: 'main-only-token'
      },
      expect.any(AbortSignal)
    )
    expect(toolProvider.callTool).toHaveBeenCalledWith(
      'knowledge_list',
      {},
      expect.any(AbortSignal),
      expect.objectContaining({
        workMode: 'ask',
        knowledgeCapabilityToken: 'main-only-token'
      })
    )
    expect(toolProvider.callTool).toHaveBeenCalledWith(
      'knowledge_search',
      { query: 'release notes', limit: 3 },
      expect.any(AbortSignal),
      expect.objectContaining({
        workMode: 'ask',
        knowledgeCapabilityToken: 'main-only-token'
      })
    )
    expect(authorize).not.toHaveBeenCalled()
    expect(toolProvider.getApproval).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('runs enabled web search in Ask without per-call approval', async () => {
    const responses = [
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'web-search-call',
                  type: 'function',
                  function: {
                    name: 'web_search',
                    arguments: '{"query":"current release","numResults":2}'
                  }
                }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '基于联网搜索结果回答。'
            }
          }
        ]
      }
    ]
    const webSearchTool: ModelToolDefinition = {
      name: 'web_search',
      displayName: '联网搜索',
      description: 'Search public web',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
      },
      source: 'builtin'
    }
    const toolProvider = createToolProvider({
      listTools: vi.fn(async () => [webSearchTool])
    })
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      fetcher: vi.fn<typeof fetch>(async () =>
        Response.json(responses.shift())
      ),
      toolProvider,
      webSearchEnabled: true
    })
    const authorize = vi.fn(async () => 'deny' as const)

    const events = []
    for await (const event of runtime.run(
      {
        requestId: 'f0370284-5933-4743-892c-98263b8a44ae',
        conversationId: 'conversation-web-search-ask',
        prompt: '查找当前版本',
        workMode: 'ask'
      },
      new AbortController().signal,
      authorize
    )) {
      events.push(event)
    }

    expect(toolProvider.callTool).toHaveBeenCalledWith(
      'web_search',
      { query: 'current release', numResults: 2 },
      expect.any(AbortSignal),
      expect.objectContaining({ workMode: 'ask' })
    )
    expect(authorize).not.toHaveBeenCalled()
    expect(toolProvider.getApproval).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('returns recoverable tool failures to the model instead of aborting the run', async () => {
    const responses = [
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-stale-ref',
                  type: 'function',
                  function: {
                    name: 'workspace_read_text',
                    arguments: '{"path":"README.md"}'
                  }
                }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '已获取新快照并继续。'
            }
          }
        ]
      }
    ]
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(responses.shift())
    )
    const toolProvider = createToolProvider({
      callTool: vi.fn(async () => {
        throw new RecoverableModelToolError(
          '浏览器元素引用已失效，请重新获取快照',
          '调用 browser_snapshot 后重试'
        )
      })
    })
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      fetcher,
      toolProvider
    })
    const events = []

    for await (const event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed130',
        conversationId: 'conversation-recoverable-tool-error',
        prompt: '继续浏览器操作',
        workMode: 'execute'
      },
      new AbortController().signal,
      async () => 'once'
    )) {
      events.push(event)
    }

    expect(fetcher).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse(
      fetcher.mock.calls[1]?.[1]?.body as string
    ) as { messages: Array<Record<string, unknown>> }
    const toolMessage = secondBody.messages.find(
      (message) => message.role === 'tool'
    )
    expect(JSON.parse(toolMessage?.content as string)).toEqual({
      ok: false,
      recoverable: true,
      error: '浏览器元素引用已失效，请重新获取快照',
      nextAction: '调用 browser_snapshot 后重试'
    })
    expect(
      events
        .filter((event) => event.type === 'tool')
        .map((event) => event.state)
    ).toEqual(['pending', 'running', 'recoverable'])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: '已获取新快照并继续。'
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('continues OpenAI Responses with function_call_output', async () => {
    const responses = [
      {
        id: 'resp-tool-1',
        model: 'gpt-5',
        output: [
          {
            id: 'msg-responses-1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: '先读取 README。'
              }
            ]
          },
          {
            id: 'fc-responses-1',
            type: 'function_call',
            call_id: 'call-responses-1',
            name: 'workspace_read_text',
            arguments: '{"path":"README.md"}'
          }
        ],
        usage: { input_tokens: 14, output_tokens: 3 }
      },
      {
        id: 'resp-tool-2',
        model: 'gpt-5',
        output: [
          {
            id: 'fc-responses-2',
            type: 'function_call',
            call_id: 'call-responses-2',
            name: 'workspace_read_text',
            arguments: '{"path":"DESIGN.md"}'
          }
        ],
        usage: { input_tokens: 21, output_tokens: 4 }
      },
      {
        id: 'resp-tool-3',
        model: 'gpt-5',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Responses 工具调用完成。'
              }
            ]
          }
        ],
        usage: { input_tokens: 30, output_tokens: 6 }
      }
    ]
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(responses.shift())
    )
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      protocol: 'openai-responses',
      authentication: 'api-key',
      fetcher,
      toolProvider: createToolProvider({
        callTool: vi.fn(async () => createMultimodalToolResult())
      })
    })
    const events = []

    for await (const event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed134',
        conversationId: 'conversation-responses-tools',
        prompt: '读取 README',
        workMode: 'execute'
      },
      new AbortController().signal,
      async () => 'once'
    )) {
      events.push(event)
    }

    const firstBody = JSON.parse(
      fetcher.mock.calls[0]?.[1]?.body as string
    ) as Record<string, unknown>
    expect(firstBody).toMatchObject({
      model: 'gpt-5',
      stream: false,
      tools: [
        {
          type: 'function',
          name: 'workspace_read_text',
          strict: false
        }
      ]
    })
    expect(firstBody).not.toHaveProperty('previous_response_id')
    const secondBody = JSON.parse(
      fetcher.mock.calls[1]?.[1]?.body as string
    ) as Record<string, unknown>
    expect(secondBody).toMatchObject({
      input: [
        {
          role: 'user',
          content: '读取 README'
        },
        {
          id: 'msg-responses-1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: '先读取 README。'
            }
          ]
        },
        {
          id: 'fc-responses-1',
          type: 'function_call',
          call_id: 'call-responses-1',
          name: 'workspace_read_text',
          arguments: '{"path":"README.md"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call-responses-1',
          output: [
            {
              type: 'input_text',
              text: 'tool result'
            },
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${toolPng}`
            }
          ]
        }
      ]
    })
    const thirdBody = JSON.parse(
      fetcher.mock.calls[2]?.[1]?.body as string
    ) as {
      input: Array<Record<string, unknown>>
    }
    expect(thirdBody.input).toEqual([
      ...(secondBody.input as Array<Record<string, unknown>>),
      {
        id: 'fc-responses-2',
        type: 'function_call',
        call_id: 'call-responses-2',
        name: 'workspace_read_text',
        arguments: '{"path":"DESIGN.md"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call-responses-2',
        output: [
          {
            type: 'input_text',
            text: 'tool result'
          },
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${toolPng}`
          }
        ]
      }
    ])
    for (const [, init] of fetcher.mock.calls) {
      expect(JSON.parse(init?.body as string)).not.toHaveProperty(
        'previous_response_id'
      )
    }
    expect(
      events
        .filter((event) => event.type === 'tool')
        .map((event) => event.state)
    ).toEqual([
      'pending',
      'running',
      'completed',
      'pending',
      'running',
      'completed'
    ])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: 'Responses 工具调用完成。'
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('fails closed when a direct-model tool is denied', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-denied',
                  type: 'function',
                  function: {
                    name: 'workspace_read_text',
                    arguments: '{"path":"secret.txt"}'
                  }
                }
              ]
            }
          }
        ]
      })
    )
    const toolProvider = createToolProvider()
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      fetcher,
      toolProvider
    })
    const events: Array<{ type: string; state?: string }> = []
    const consume = async (): Promise<void> => {
      for await (const event of runtime.run(
        {
          requestId: 'a431666e-5ec8-45e6-beb4-654132eed131',
          conversationId: 'conversation-denied',
          prompt: '读取 secret',
          workMode: 'execute'
        },
        new AbortController().signal,
        async () => 'deny'
      )) {
        events.push(event)
      }
    }

    await expect(consume()).rejects.toThrow('用户拒绝')
    expect(
      events
        .filter((event) => event.type === 'tool')
        .map((event) => event.state)
    ).toEqual(['pending', 'failed'])
    expect(toolProvider.callTool).not.toHaveBeenCalled()
  })

  it('uses Anthropic tool_use and tool_result messages in Execute mode', async () => {
    const responses = [
      {
        id: 'message-tool-1',
        model: 'claude',
        content: [
          {
            type: 'tool_use',
            id: 'toolu-1',
            name: 'workspace_read_text',
            input: { path: 'notes.md' }
          }
        ],
        usage: { input_tokens: 12, output_tokens: 3 }
      },
      {
        id: 'message-tool-2',
        model: 'claude',
        content: [{ type: 'text', text: '读取完成。' }],
        usage: { input_tokens: 20, output_tokens: 5 }
      }
    ]
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(responses.shift())
    )
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://bigtoken.ai',
      model: 'claude',
      protocol: 'anthropic-messages',
      authentication: 'api-key',
      fetcher,
      toolProvider: createToolProvider({
        callTool: vi.fn(async () => createMultimodalToolResult())
      })
    })

    for await (const _event of runtime.run(
      {
        requestId: 'a431666e-5ec8-45e6-beb4-654132eed132',
        conversationId: 'conversation-anthropic-tools',
        prompt: '读取 notes',
        workMode: 'execute'
      },
      new AbortController().signal,
      async () => 'once'
    )) {
      void _event
    }

    const firstBody = JSON.parse(
      fetcher.mock.calls[0]?.[1]?.body as string
    ) as Record<string, unknown>
    expect(firstBody).toMatchObject({
      stream: false,
      tools: [
        {
          name: 'workspace_read_text',
          input_schema: expect.objectContaining({ type: 'object' })
        }
      ]
    })
    const secondBody = JSON.parse(
      fetcher.mock.calls[1]?.[1]?.body as string
    ) as { messages: Array<Record<string, unknown>> }
    expect(secondBody.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu-1',
          content: [
            {
              type: 'text',
              text: 'tool result'
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: toolPng
              }
            }
          ]
        }
      ]
    })
  })

  it('does not issue a follow-up model request after tool cancellation', async () => {
    const response = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-aborted',
                type: 'function',
                function: {
                  name: 'workspace_read_text',
                  arguments: '{}'
                }
              }
            ]
          }
        }
      ]
    }
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response))
    const controller = new AbortController()
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      fetcher,
      toolProvider: createToolProvider({
        callTool: vi.fn(async () => {
          controller.abort()
          return createTextToolResult('late result')
        })
      })
    })
    const consume = async (): Promise<void> => {
      for await (const _event of runtime.run(
        {
          requestId: crypto.randomUUID(),
          conversationId: crypto.randomUUID(),
          prompt: 'run',
          workMode: 'execute'
        },
        controller.signal,
        async () => 'once'
      )) {
        void _event
      }
    }

    await expect(consume()).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('terminates repeated identical tool rounds without exhausting hard limits', async () => {
    let callId = 0
    const fetcher = vi.fn<typeof fetch>(async () => {
      callId += 1
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call-repeat-${callId}`,
                  type: 'function',
                  function: {
                    name: 'workspace_read_text',
                    arguments: '{"path":"README.md"}'
                  }
                }
              ]
            }
          }
        ]
      })
    })
    const toolProvider = createToolProvider()
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      fetcher,
      toolProvider
    })
    const consume = async (): Promise<void> => {
      for await (const _event of runtime.run(
        {
          requestId: crypto.randomUUID(),
          conversationId: 'conversation-repeat',
          prompt: 'repeat',
          workMode: 'execute'
        },
        new AbortController().signal,
        async () => 'once'
      )) {
        void _event
      }
    }

    await expect(consume()).rejects.toThrow('没有取得进展')
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(toolProvider.callTool).toHaveBeenCalledTimes(2)
  })

  it('releases provider state for only the requested conversation', async () => {
    const toolProvider = createToolProvider()
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      toolProvider
    })

    await runtime.releaseConversation('conversation-release')

    expect(toolProvider.releaseConversation).toHaveBeenCalledOnce()
    expect(toolProvider.releaseConversation).toHaveBeenCalledWith(
      'conversation-release'
    )
  })

  it('releases known conversations before provider disposal and permits replacement reuse', async () => {
    const lifecycle: string[] = []
    const released = new Set<string>()
    const createProvider = (): ModelToolProviderLike =>
      createToolProvider({
        releaseConversation: vi.fn(async (conversationId) => {
          lifecycle.push(`release:${conversationId}`)
          released.add(conversationId)
        }),
        dispose: vi.fn(async () => {
          lifecycle.push('dispose')
        })
      })
    const createRuntime = (toolProvider: ModelToolProviderLike) =>
      new ModelAgentRuntime({
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen3',
        protocol: 'openai-chat-completions',
        authentication: 'none',
        fetcher: vi.fn<typeof fetch>(async () =>
          new Response(
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
            {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
            }
          )
        ),
        toolProvider
      })
    const request = {
      requestId: crypto.randomUUID(),
      conversationId: 'conversation-replacement',
      prompt: 'hello',
      workMode: 'ask' as const
    }
    const firstProvider = createProvider()
    const firstRuntime = createRuntime(firstProvider)
    for await (const _event of firstRuntime.run(
      request,
      new AbortController().signal
    )) {
      void _event
    }

    await firstRuntime.dispose()
    expect(lifecycle).toEqual([
      'release:conversation-replacement',
      'dispose'
    ])
    expect(released).toContain('conversation-replacement')

    const replacement = createRuntime(createProvider())
    const replacementEvents = []
    for await (const event of replacement.run(
      { ...request, requestId: crypto.randomUUID() },
      new AbortController().signal
    )) {
      replacementEvents.push(event)
    }
    expect(replacementEvents.at(-1)).toMatchObject({ type: 'done' })
    await replacement.dispose()
  })

  it('counts image base64 data against the aggregate tool context limit', async () => {
    const response = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-large-image',
                type: 'function',
                function: {
                  name: 'workspace_read_text',
                  arguments: '{}'
                }
              }
            ]
          }
        }
      ]
    }
    const imageData = Buffer.alloc(1024 * 1024 + 1).toString('base64')
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response))
    const runtime = new ModelAgentRuntime({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai-chat-completions',
      authentication: 'none',
      fetcher,
      toolProvider: createToolProvider({
        callTool: vi.fn(async () => ({
          parts: [
            {
              type: 'image' as const,
              mimeType: 'image/png' as const,
              data: imageData
            }
          ],
          contextBytes: Buffer.byteLength(imageData)
        }))
      })
    })
    const consume = async (): Promise<void> => {
      for await (const _event of runtime.run(
        {
          requestId: crypto.randomUUID(),
          conversationId: crypto.randomUUID(),
          prompt: 'run',
          workMode: 'execute'
        },
        new AbortController().signal,
        async () => 'once'
      )) {
        void _event
      }
    }

    await expect(consume()).rejects.toThrow('结果总量超过 1MB')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('reports image configuration checks without pretending to generate', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const runtime = new ModelAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://bigtoken.ai/v1',
      model: 'gpt-image-2',
      protocol: 'openai-images-generations',
      authentication: 'api-key',
      imageGenerationQuality: 'medium',
      fetcher
    })

    await expect(runtime.testConnection()).resolves.toMatchObject({
      available: true,
      capability: 'image-generation',
      detail: expect.stringContaining(
        '发送提示词时执行实际生成验证'
      )
    })
    expect(fetcher).not.toHaveBeenCalled()
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
      imageGenerationQuality: 'high',
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
      quality: 'high',
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
        'upstream unavailable Authorization: Bearer secret-token（HTTP 502，请求 ID image-request-502）'
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
