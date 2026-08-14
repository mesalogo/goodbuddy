import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../shared/contracts'
import { AgentEventBuffer } from './agent-event-buffer'

const requestId = '00000000-0000-4000-8000-000000000001'

describe('AgentEventBuffer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('combines 100 adjacent text deltas into one event', () => {
    vi.useFakeTimers()
    const events: AgentEvent[] = []
    const buffer = new AgentEventBuffer({
      onEvent: (event) => events.push(event)
    })

    for (let index = 0; index < 100; index += 1) {
      buffer.push({ requestId, type: 'text', delta: `${index},` })
    }
    expect(events).toEqual([])

    buffer.close()
    expect(events).toEqual([
      {
        requestId,
        type: 'text',
        delta: Array.from({ length: 100 }, (_, index) => `${index},`).join(
          ''
        )
      }
    ])
  })

  it('preserves text, reasoning, and immediate tool order', () => {
    vi.useFakeTimers()
    const events: AgentEvent[] = []
    const buffer = new AgentEventBuffer({
      onEvent: (event) => events.push(event)
    })

    buffer.push({ requestId, type: 'text', delta: 'answer' })
    buffer.push({ requestId, type: 'reasoning', delta: 'thought' })
    buffer.push({
      requestId,
      type: 'tool',
      callId: 'call-1',
      name: 'read',
      state: 'completed',
      summary: 'read completed'
    })

    expect(events.map((event) => event.type)).toEqual([
      'text',
      'reasoning',
      'tool'
    ])
  })

  it('flushes before a combined delta exceeds the size bound', () => {
    vi.useFakeTimers()
    const events: AgentEvent[] = []
    const buffer = new AgentEventBuffer({
      maximumBufferedBytes: 5,
      onEvent: (event) => events.push(event)
    })

    buffer.push({ requestId, type: 'text', delta: '123' })
    buffer.push({ requestId, type: 'text', delta: '456' })
    expect(events).toEqual([
      { requestId, type: 'text', delta: '123' }
    ])

    buffer.close()
    expect(events).toEqual([
      { requestId, type: 'text', delta: '123' },
      { requestId, type: 'text', delta: '456' }
    ])
  })

  it('flushes buffered deltas when its timer expires', () => {
    vi.useFakeTimers()
    const events: AgentEvent[] = []
    const buffer = new AgentEventBuffer({
      flushIntervalMs: 32,
      onEvent: (event) => events.push(event)
    })

    buffer.push({ requestId, type: 'reasoning', delta: 'thinking' })
    vi.advanceTimersByTime(31)
    expect(events).toEqual([])
    vi.advanceTimersByTime(1)
    expect(events).toEqual([
      { requestId, type: 'reasoning', delta: 'thinking' }
    ])
  })

  it('supports frame-paced UI updates with coarser durable writes', () => {
    vi.useFakeTimers()
    const publicEvents: AgentEvent[] = []
    const persistedEvents: AgentEvent[] = []
    const publicBuffer = new AgentEventBuffer({
      flushIntervalMs: 16,
      onEvent: (event) => publicEvents.push(event)
    })
    const persistedBuffer = new AgentEventBuffer({
      flushIntervalMs: 32,
      onEvent: (event) => persistedEvents.push(event)
    })
    const first: AgentEvent = {
      requestId,
      type: 'text',
      delta: 'first'
    }
    publicBuffer.push(first)
    persistedBuffer.push(first)

    vi.advanceTimersByTime(16)
    expect(publicEvents).toEqual([first])
    expect(persistedEvents).toEqual([])

    const second: AgentEvent = {
      requestId,
      type: 'text',
      delta: 'second'
    }
    publicBuffer.push(second)
    persistedBuffer.push(second)
    publicBuffer.close()
    persistedBuffer.close()

    expect(publicEvents).toEqual([first, second])
    expect(persistedEvents).toEqual([
      {
        requestId,
        type: 'text',
        delta: 'firstsecond'
      }
    ])
  })

  it('closes idempotently and ignores events after close', () => {
    vi.useFakeTimers()
    const events: AgentEvent[] = []
    const buffer = new AgentEventBuffer({
      onEvent: (event) => events.push(event)
    })

    buffer.push({ requestId, type: 'text', delta: 'once' })
    buffer.close()
    buffer.close()
    buffer.push({ requestId, type: 'text', delta: 'late' })
    vi.runAllTimers()

    expect(events).toEqual([
      { requestId, type: 'text', delta: 'once' }
    ])
  })

  it('reports timer publication errors instead of throwing asynchronously', () => {
    vi.useFakeTimers()
    const error = new Error('database unavailable')
    const onError = vi.fn()
    const buffer = new AgentEventBuffer({
      flushIntervalMs: 32,
      onError,
      onEvent: () => {
        throw error
      }
    })

    buffer.push({ requestId, type: 'text', delta: 'pending' })
    expect(() => vi.advanceTimersByTime(32)).not.toThrow()
    expect(onError).toHaveBeenCalledWith(error)
  })
})
