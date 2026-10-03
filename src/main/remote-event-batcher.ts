import type { RemoteSemanticEventProvenance } from './agent/runtime'

export type RemoteEventBatchEntry<TEvent> = {
  provenance: RemoteSemanticEventProvenance
  event: TEvent
}

export type RemoteEventCommitted<TEvent> = (
  event: TEvent,
  inserted: boolean
) => void

export type RemoteEventBatcherOptions<TEvent> = {
  /**
   * Durably stores every entry in ONE transaction and returns one flag per
   * entry: true when it was newly stored, false for an already stored replay.
   */
  persist(entries: readonly RemoteEventBatchEntry<TEvent>[]): readonly boolean[]
  /** Called when a timer-driven flush fails (for example to abort the run). */
  onError?(error: unknown): void
  /**
   * Called after a timer-driven flush committed (and its `onCommitted`
   * callbacks ran), e.g. to forward the committed events without waiting for
   * a second coalescing timer downstream.
   */
  onTimerFlushed?(): void
  /** Safety flush for buffered events that are not followed by a boundary. */
  flushIntervalMs?: number
  maximumEvents?: number
}

type PendingEntry<TEvent> = RemoteEventBatchEntry<TEvent> & {
  onCommitted?: RemoteEventCommitted<TEvent>
}

/**
 * One frame: committed events are forwarded to the renderer only after their
 * batch commits, so this bounds how long streamed remote text is held back.
 */
export const REMOTE_EVENT_BATCH_FLUSH_INTERVAL_MS = 16
export const REMOTE_EVENT_BATCH_MAXIMUM_EVENTS = 256

/**
 * Buffers remote semantic events so one SQLite transaction covers a whole
 * remote transcript sequence instead of one transaction per event.
 *
 * Callers must flush before any point where the producer may acknowledge the
 * buffered events (the remote semantic checkpoint), and before publishing any
 * unrelated event so renderer order is preserved. `onCommitted` callbacks run
 * after the commit, in the original order, with `inserted = false` for
 * replayed events that were already stored.
 *
 * A failed commit stores nothing from that batch and poisons the batcher:
 * every later `add` or `flush` rethrows the same error, so a later checkpoint
 * can never be committed (and acknowledged) after an earlier batch was lost.
 */
export class RemoteEventBatcher<TEvent> {
  private readonly persist: RemoteEventBatcherOptions<TEvent>['persist']
  private readonly onError: RemoteEventBatcherOptions<TEvent>['onError']
  private readonly onTimerFlushed: RemoteEventBatcherOptions<TEvent>['onTimerFlushed']
  private readonly flushIntervalMs: number
  private readonly maximumEvents: number
  private pending: PendingEntry<TEvent>[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private failure: { error: unknown } | undefined

  constructor(options: RemoteEventBatcherOptions<TEvent>) {
    this.persist = options.persist
    this.onError = options.onError
    this.onTimerFlushed = options.onTimerFlushed
    this.flushIntervalMs =
      options.flushIntervalMs ?? REMOTE_EVENT_BATCH_FLUSH_INTERVAL_MS
    this.maximumEvents =
      options.maximumEvents ?? REMOTE_EVENT_BATCH_MAXIMUM_EVENTS
    if (this.flushIntervalMs <= 0) {
      throw new Error('flushIntervalMs must be positive')
    }
    if (!Number.isSafeInteger(this.maximumEvents) || this.maximumEvents < 1) {
      throw new Error('maximumEvents must be a positive integer')
    }
  }

  get size(): number {
    return this.pending.length
  }

  add(
    provenance: RemoteSemanticEventProvenance,
    event: TEvent,
    onCommitted?: RemoteEventCommitted<TEvent>
  ): void {
    this.throwIfFailed()
    this.pending.push({ provenance, event, onCommitted })
    if (this.pending.length >= this.maximumEvents) {
      this.flush()
      return
    }
    this.scheduleFlush()
  }

  flush(): void {
    this.clearTimer()
    this.throwIfFailed()
    if (this.pending.length === 0) {
      return
    }
    const entries = this.pending
    this.pending = []
    let inserted: readonly boolean[]
    try {
      inserted = this.persist(
        entries.map(({ provenance, event }) => ({ provenance, event }))
      )
      if (inserted.length !== entries.length) {
        throw new Error('远程事件批量写入结果数量不匹配')
      }
    } catch (error) {
      this.failure = { error }
      throw error
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!
      entry.onCommitted?.(entry.event, inserted[index] === true)
    }
  }

  /** Stops the safety timer and drops uncommitted events. */
  dispose(): void {
    this.clearTimer()
    this.pending = []
  }

  private throwIfFailed(): void {
    if (this.failure) {
      throw this.failure.error
    }
  }

  private scheduleFlush(): void {
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      try {
        this.flush()
        this.onTimerFlushed?.()
      } catch (error) {
        this.onError?.(error)
      }
    }, this.flushIntervalMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (!this.timer) {
      return
    }
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
