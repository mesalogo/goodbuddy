import { describe, expect, it, vi } from 'vitest'
import { BigtokenAgentRuntime } from './bigtoken-runtime'

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

describe('BigtokenAgentRuntime', () => {
  it('uses the Anthropic messages endpoint and streams text deltas', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      return new Response(createEventStream('真实模型回答'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    })
    const runtime = new BigtokenAgentRuntime({
      apiKey: 'test-key',
      baseUrl: 'https://bigtoken.ai',
      model: 'sonnet-5',
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
    }
    expect(body).toMatchObject({
      model: 'sonnet-5',
      stream: true
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: '真实模型回答'
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })
})
