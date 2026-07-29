import { describe, expect, it } from 'vitest'
import { DemoAgentRuntime } from './demo-runtime'

describe('DemoAgentRuntime', () => {
  it('streams a complete response with the original prompt', async () => {
    const runtime = new DemoAgentRuntime()
    const events = []

    for await (const event of runtime.run(
      {
        requestId: '95dd315d-9616-43b4-8929-e84643d063c4',
        conversationId: 'conversation-1',
        prompt: '测试问题'
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    const content = events
      .filter((event) => event.type === 'text')
      .map((event) => (event.type === 'text' ? event.delta : ''))
      .join('')

    expect(events[0]).toMatchObject({ type: 'status' })
    expect(content).toContain('测试问题')
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })
})
