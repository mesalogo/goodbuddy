import { describe, expect, it, vi } from 'vitest'
import { ModelAgentRuntime } from './model-runtime'

function createEventStream(text: string): string {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"message-1"}}',
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text }
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
})
