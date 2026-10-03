import { afterEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_EVENT_BATCH_FLUSH_INTERVAL_MS, RemoteEventBatcher } from './remote-event-batcher'

const provenance = (eventIndex: number) => ({
  source: 'remote-semantic-transcript' as const,
  bindingId: 'binding',
  operationId: 'operation',
  semanticSequence: '1',
  eventIndex
})

describe('RemoteEventBatcher', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('commits buffered events once and reports them in order', () => {
    const persist = vi.fn((entries: readonly { event: string }[]) =>
      entries.map(({ event }) => event !== 'replayed'))
    const committed: Array<[string, boolean]> = []
    const batcher = new RemoteEventBatcher<string>({ persist })
    for (const [index, event] of ['a', 'replayed', 'b'].entries()) {
      batcher.add(provenance(index), event, (value, inserted) => committed.push([value, inserted]))
    }
    expect(persist).not.toHaveBeenCalled()
    batcher.flush()
    batcher.flush()
    expect(persist).toHaveBeenCalledOnce()
    expect(committed).toEqual([['a', true], ['replayed', false], ['b', true]])
    batcher.dispose()
  })

  it('flushes at the size cap and on the safety timer', () => {
    vi.useFakeTimers()
    const persist = vi.fn((entries: readonly unknown[]) => entries.map(() => true))
    const batcher = new RemoteEventBatcher<number>({ persist, maximumEvents: 2, flushIntervalMs: 50 })
    batcher.add(provenance(0), 0)
    batcher.add(provenance(1), 1)
    expect(persist).toHaveBeenCalledTimes(1)
    batcher.add(provenance(2), 2)
    vi.advanceTimersByTime(49)
    expect(persist).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[1]![0]).toHaveLength(1)
    batcher.dispose()
  })

  it('commits (and so forwards) streamed events within one frame by default', () => {
    vi.useFakeTimers()
    expect(REMOTE_EVENT_BATCH_FLUSH_INTERVAL_MS).toBe(16)
    const persist = vi.fn((entries: readonly unknown[]) => entries.map(() => true))
    const committed: string[] = []
    const batcher = new RemoteEventBatcher<string>({ persist })
    batcher.add(provenance(0), 'a', (event) => committed.push(event))
    batcher.add(provenance(1), 'b', (event) => committed.push(event))
    vi.advanceTimersByTime(15)
    // Nothing is forwarded before it is persisted.
    expect(committed).toEqual([])
    vi.advanceTimersByTime(1)
    expect(persist).toHaveBeenCalledOnce()
    expect(committed).toEqual(['a', 'b'])
    batcher.dispose()
  })

  it('reports a timer flush after its events committed, and not after a failed one', () => {
    vi.useFakeTimers()
    const order: string[] = []
    let fail = false
    const batcher = new RemoteEventBatcher<string>({
      persist: (entries) => {
        if (fail) throw new Error('disk full')
        return entries.map(() => true)
      },
      onTimerFlushed: () => order.push('flushed'),
      onError: () => order.push('error')
    })
    batcher.add(provenance(0), 'a', (event) => order.push(event))
    vi.advanceTimersByTime(REMOTE_EVENT_BATCH_FLUSH_INTERVAL_MS)
    expect(order).toEqual(['a', 'flushed'])
    // Explicit flushes leave forwarding to the caller.
    batcher.add(provenance(1), 'b', (event) => order.push(event))
    batcher.flush()
    expect(order).toEqual(['a', 'flushed', 'b'])
    fail = true
    batcher.add(provenance(2), 'c', (event) => order.push(event))
    vi.advanceTimersByTime(REMOTE_EVENT_BATCH_FLUSH_INTERVAL_MS)
    expect(order).toEqual(['a', 'flushed', 'b', 'error'])
    batcher.dispose()
  })

  it('rethrows a failed commit and stays failed so later checkpoints are never committed', () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const persist = vi.fn((): boolean[] => {
      throw new Error('disk full')
    })
    const onCommitted = vi.fn()
    const batcher = new RemoteEventBatcher<string>({ persist, onError })
    batcher.add(provenance(0), 'a', onCommitted)
    vi.advanceTimersByTime(REMOTE_EVENT_BATCH_FLUSH_INTERVAL_MS)
    expect(onError).toHaveBeenCalledWith(new Error('disk full'))
    expect(() => batcher.add(provenance(1), 'checkpoint')).toThrow('disk full')
    expect(() => batcher.flush()).toThrow('disk full')
    expect(persist).toHaveBeenCalledOnce()
    expect(onCommitted).not.toHaveBeenCalled()
    batcher.dispose()
  })
})
