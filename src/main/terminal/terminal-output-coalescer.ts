import { TERMINAL_LIMITS } from '../../shared/terminal-contracts'

/**
 * Minimum spacing between timer-driven flushes. Output arriving while the
 * coalescer is idle is flushed immediately (leading edge), so interactive
 * echo gets no added latency; bursts inside the window are merged.
 */
export const TERMINAL_OUTPUT_FLUSH_INTERVAL_MS = 8

/** A full batch is flushed without waiting for the timer. */
export const TERMINAL_OUTPUT_MAXIMUM_BATCH_BYTES =
  TERMINAL_LIMITS.maximumEventBytes

type TimerHandle = ReturnType<typeof setTimeout>

export type TerminalOutputCoalescerOptions = {
  /** Receives ordered chunks of at most `maximumBatchBytes` UTF-8 bytes. */
  emit: (data: string) => void
  flushIntervalMs?: number
  maximumBatchBytes?: number
}

/**
 * Splits text into ordered chunks of at most `maximumBytes` UTF-8 bytes without
 * cutting a multi-byte sequence.
 */
export function splitUtf8Bounded(
  data: string,
  maximumBytes: number
): string[] {
  const encoded = Buffer.from(data)
  if (encoded.byteLength <= maximumBytes) {
    return encoded.byteLength === 0 ? [] : [data]
  }
  const chunks: string[] = []
  let offset = 0
  while (offset < encoded.byteLength) {
    let end = Math.min(offset + maximumBytes, encoded.byteLength)
    if (end < encoded.byteLength) {
      while (end > offset && (encoded[end]! & 0xc0) === 0x80) {
        end -= 1
      }
    }
    if (end === offset) {
      end = Math.min(offset + 1, encoded.byteLength)
    }
    chunks.push(encoded.subarray(offset, end).toString('utf8'))
    offset = end
  }
  return chunks
}

/**
 * Per-terminal output buffer in Main. It never holds more than one batch
 * (`maximumBatchBytes`), so a slow renderer is handled by the session's
 * ACK-based backpressure rather than by growing this buffer.
 */
export class TerminalOutputCoalescer {
  private readonly emitChunk: (data: string) => void
  private readonly flushIntervalMs: number
  private readonly maximumBatchBytes: number
  private chunks: string[] = []
  private bytes = 0
  private timer: TimerHandle | undefined
  private disposed = false

  constructor(options: TerminalOutputCoalescerOptions) {
    this.emitChunk = options.emit
    this.flushIntervalMs =
      options.flushIntervalMs ?? TERMINAL_OUTPUT_FLUSH_INTERVAL_MS
    this.maximumBatchBytes =
      options.maximumBatchBytes ?? TERMINAL_OUTPUT_MAXIMUM_BATCH_BYTES
  }

  /** UTF-8 bytes received but not yet emitted. */
  get bufferedBytes(): number {
    return this.bytes
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  push(data: string): void {
    if (this.disposed || data.length === 0) {
      return
    }
    this.chunks.push(data)
    this.bytes += Buffer.byteLength(data)
    if (this.timer === undefined) {
      this.flush()
      this.startWindow()
      return
    }
    if (this.bytes >= this.maximumBatchBytes) {
      this.emitFullBatches()
    }
  }

  /** Emits everything buffered, in order. Safe to call re-entrantly. */
  flush(): void {
    if (this.disposed || this.bytes === 0) {
      return
    }
    const data = this.take()
    for (const chunk of splitUtf8Bounded(data, this.maximumBatchBytes)) {
      if (this.disposed) {
        return
      }
      this.emitChunk(chunk)
    }
  }

  /** Drops buffered data and cancels the timer. Further input is ignored. */
  dispose(): void {
    this.disposed = true
    this.chunks = []
    this.bytes = 0
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private emitFullBatches(): void {
    const parts = splitUtf8Bounded(this.take(), this.maximumBatchBytes)
    const last = parts.at(-1)
    if (last !== undefined && Buffer.byteLength(last) < this.maximumBatchBytes) {
      parts.pop()
      this.chunks = [last]
      this.bytes = Buffer.byteLength(last)
    }
    for (const chunk of parts) {
      if (this.disposed) {
        return
      }
      this.emitChunk(chunk)
    }
  }

  private take(): string {
    const data = this.chunks.length === 1 ? this.chunks[0]! : this.chunks.join('')
    this.chunks = []
    this.bytes = 0
    return data
  }

  private startWindow(): void {
    if (this.disposed) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.bytes > 0) {
        this.flush()
        this.startWindow()
      }
    }, this.flushIntervalMs)
    this.timer.unref?.()
  }
}
