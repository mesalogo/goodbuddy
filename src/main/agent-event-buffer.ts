import type { AgentEvent } from '../shared/contracts'

type BufferedAgentEvent = Extract<
  AgentEvent,
  { type: 'text' | 'reasoning' }
>

export type AgentEventBufferOptions = {
  onEvent(event: AgentEvent): void
  onError?(error: unknown): void
  flushIntervalMs?: number
  maximumBufferedBytes?: number
}

const DEFAULT_FLUSH_INTERVAL_MS = 32
const DEFAULT_MAXIMUM_BUFFERED_BYTES = 64 * 1024

export class AgentEventBuffer {
  private readonly onEvent: (event: AgentEvent) => void
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly flushIntervalMs: number
  private readonly maximumBufferedBytes: number
  private pending: BufferedAgentEvent | undefined
  private pendingBytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(options: AgentEventBufferOptions) {
    this.onEvent = options.onEvent
    this.onError = options.onError
    this.flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this.maximumBufferedBytes =
      options.maximumBufferedBytes ??
      DEFAULT_MAXIMUM_BUFFERED_BYTES
    if (this.flushIntervalMs <= 0) {
      throw new Error('flushIntervalMs must be positive')
    }
    if (this.maximumBufferedBytes <= 0) {
      throw new Error('maximumBufferedBytes must be positive')
    }
  }

  push(event: AgentEvent): void {
    if (this.closed) {
      return
    }
    if (event.type !== 'text' && event.type !== 'reasoning') {
      this.flush()
      this.onEvent(event)
      return
    }

    const eventBytes = Buffer.byteLength(event.delta)
    const matchesPending =
      this.pending?.requestId === event.requestId &&
      this.pending.type === event.type
    if (!matchesPending) {
      this.flush()
    } else if (
      this.pendingBytes + eventBytes >
      this.maximumBufferedBytes
    ) {
      this.flush()
    }

    if (eventBytes > this.maximumBufferedBytes) {
      this.onEvent(event)
      return
    }
    if (this.pending) {
      this.pending = {
        ...this.pending,
        delta: this.pending.delta + event.delta
      }
      this.pendingBytes += eventBytes
      return
    }

    this.pending = { ...event }
    this.pendingBytes = eventBytes
    this.scheduleFlush()
  }

  flush(): void {
    this.clearTimer()
    const event = this.pending
    this.pending = undefined
    this.pendingBytes = 0
    if (event) {
      this.onEvent(event)
    }
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.flush()
  }

  private scheduleFlush(): void {
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      try {
        this.flush()
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
