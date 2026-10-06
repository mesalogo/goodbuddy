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

  it('commits buffered events once and reports them in order', async () => {
    const persist = vi.fn((entries: readonly { event: string }[]) =>
      entries.map(({ event }) => event !== 'replayed'))
    const committed: Array<[string, boolean]> = []
    const batcher = new RemoteEventBatcher<string>({ persist })
    for (const [index, event] of ['a', 'replayed', 'b'].entries()) {
      await batcher.add(provenance(index), event, (value, inserted) => committed.push([value, inserted]))
    }
    expect(persist).not.toHaveBeenCalled()
    await batcher.flush()
    await batcher.flush()
    expect(persist).toHaveBeenCalledOnce()
    expect(committed).toEqual([['a', true], ['replayed', false], ['b', true]])
    batcher.dispose()
  })

  it('flushes at the size cap and on the safety timer', async () => {
    vi.useFakeTimers()
    const persist = vi.fn((entries: readonly unknown[]) => entries.map(() => true))
    const batcher = new RemoteEventBatcher<number>({ persist, maximumEvents: 2, flushIntervalMs: 50 })
    await batcher.add(provenance(0), 0)
    await batcher.add(provenance(1), 1)
    expect(persist).toHaveBeenCalledTimes(1)
    await batcher.add(provenance(2), 2)
    await vi.advanceTimersByTimeAsync(49)
    expect(persist).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[1]![0]).toHaveLength(1)
    batcher.dispose()
  })

  it('commits (and so forwards) streamed events within one frame by default', async () => {
    vi.useFakeTimers()
    expect(REMOTE_EVENT_BATCH_FLUSH_INTERVAL_MS).toBe(16)
    const persist = vi.fn((entries: readonly unknown[]) => entries.map(() => true))
    const committed: string[] = []
    const batcher = new RemoteEventBatcher<string>({ persist })
    await batcher.add(provenance(0), 'a', (event) => committed.push(event))
    await batcher.add(provenance(1), 'b', (event) => committed.push(event))
    await vi.advanceTimersByTimeAsync(15)
    // Nothing is forwarded before it is persisted.
    expect(committed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(persist).toHaveBeenCalledOnce()
    expect(committed).toEqual(['a', 'b'])
    batcher.dispose()
  })

  it('reports a timer flush after its events committed, and not after a failed one', async () => {
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
    await batcher.add(provenance(0), 'a', (event) => order.push(event))
    await vi.advanceTimersByTimeAsync(REMOTE_EVENT_BATCH_FLUSH_INTERVAL_MS)
    expect(order).toEqual(['a', 'flushed'])
    // Explicit flushes leave forwarding to the caller.
    await batcher.add(provenance(1), 'b', (event) => order.push(event))
    await batcher.flush()
    expect(order).toEqual(['a', 'flushed', 'b'])
    fail = true
    await batcher.add(provenance(2), 'c', (event) => order.push(event))
    await vi.advanceTimersByTimeAsync(REMOTE_EVENT_BATCH_FLUSH_INTERVAL_MS)
    expect(order).toEqual(['a', 'flushed', 'b', 'error'])
    batcher.dispose()
  })

  it('rethrows a failed commit and stays failed so later checkpoints are never committed', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const persist = vi.fn((): boolean[] => {
      throw new Error('disk full')
    })
    const onCommitted = vi.fn()
    const batcher = new RemoteEventBatcher<string>({ persist, onError })
    await batcher.add(provenance(0), 'a', onCommitted)
    await vi.advanceTimersByTimeAsync(REMOTE_EVENT_BATCH_FLUSH_INTERVAL_MS)
    expect(onError).toHaveBeenCalledWith(new Error('disk full'))
    await expect(batcher.add(provenance(1), 'checkpoint')).rejects.toThrow('disk full')
    await expect(batcher.flush()).rejects.toThrow('disk full')
    expect(persist).toHaveBeenCalledOnce()
    expect(onCommitted).not.toHaveBeenCalled()
    batcher.dispose()
  })

  it('waits for an in-flight commit before forwarding or completing a checkpoint flush', async () => {
    vi.useFakeTimers()
    let release!: (inserted: boolean[]) => void
    const persist = vi.fn(() => new Promise<boolean[]>(resolve => { release = resolve }))
    const forwarded = vi.fn()
    const timerFlushed = vi.fn()
    const batcher = new RemoteEventBatcher<string>({ persist, maximumEvents: 1, onTimerFlushed: timerFlushed })
    const first = batcher.add(provenance(0), 'first', forwarded)
    const checkpoint = batcher.flush()
    let settled = false
    void checkpoint.then(() => { settled = true })
    await Promise.resolve()
    expect(forwarded).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    expect(persist).toHaveBeenCalledOnce()
    release([true])
    await Promise.all([first, checkpoint])
    expect(forwarded).toHaveBeenCalledWith('first', true)
    expect(settled).toBe(true)
    batcher.dispose()
  })

  it('reports a delayed timer rejection and rejects a concurrent checkpoint without forwarding', async () => {
    vi.useFakeTimers()
    let reject!: (error: Error) => void
    const onError = vi.fn(), forwarded = vi.fn()
    const batcher = new RemoteEventBatcher<string>({
      persist: () => new Promise<boolean[]>((_, fail) => { reject = fail }), onError
    })
    await batcher.add(provenance(0), 'first', forwarded)
    await vi.advanceTimersByTimeAsync(16)
    const checkpoint = expect(batcher.flush()).rejects.toThrow('delayed failure')
    reject(new Error('delayed failure'))
    await checkpoint
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(new Error('delayed failure'))
    expect(forwarded).not.toHaveBeenCalled()
    await expect(batcher.add(provenance(1), 'late')).rejects.toThrow('delayed failure')
    batcher.dispose()
  })
})
