/**
 * Renderer-side terminal output batching (P3): output arriving while idle is
 * written to the emulator at once (no added echo latency); output arriving
 * within the same frame after that is merged and written on the next
 * animation frame, in sequence order.
 * Each batch is acknowledged with its highest sequence after the emulator's
 * write callback, which is what Main's ACK-based backpressure expects.
 */

/** Requests `callback` once; the returned function cancels the request. */
export type TerminalFrameScheduler = (callback: () => void) => () => void

/**
 * Animation frames stop while the window is minimized or occluded, so a timer
 * fallback keeps output (and ACKs) flowing for hidden terminals. Without it
 * Main would pause the PTY until the window became visible again.
 */
export const TERMINAL_FRAME_FALLBACK_MS = 100

export const scheduleTerminalFrame: TerminalFrameScheduler = (callback) => {
  let settled = false
  let frame: number | undefined
  const run = (): void => {
    if (settled) {
      return
    }
    settled = true
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
    }
    clearTimeout(timer)
    callback()
  }
  const timer = setTimeout(run, TERMINAL_FRAME_FALLBACK_MS)
  if (typeof requestAnimationFrame === 'function') {
    frame = requestAnimationFrame(run)
  }
  return () => {
    settled = true
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
    }
    clearTimeout(timer)
  }
}

export type TerminalOutputBatcherOptions = {
  /** Writes data to the emulator; `done` must run after it is processed. */
  write: (data: string, done: () => void) => void
  /** Acknowledges every output event up to and including `sequence`. */
  acknowledge: (sessionId: string, sequence: number) => void
  schedule?: TerminalFrameScheduler
}

export class TerminalOutputBatcher {
  private readonly writeData: TerminalOutputBatcherOptions['write']
  private readonly acknowledge: TerminalOutputBatcherOptions['acknowledge']
  private readonly schedule: TerminalFrameScheduler
  private pending: string[] = []
  private pendingSessionId: string | undefined
  private pendingSequence = 0
  private cancelFrame: (() => void) | undefined
  private lastWrite: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(options: TerminalOutputBatcherOptions) {
    this.writeData = options.write
    this.acknowledge = options.acknowledge
    this.schedule = options.schedule ?? scheduleTerminalFrame
  }

  get hasPending(): boolean {
    return this.pending.length > 0
  }

  /**
   * Queues output; events must be pushed in increasing sequence order.
   *
   * Leading edge: output arriving while idle (no write in the current frame
   * window) is written at once, so keystroke echo does not wait for a frame.
   * Output arriving after that within the same frame is merged and written
   * when the frame runs; a steady stream thus writes at most once per frame.
   */
  push(sessionId: string, sequence: number, data: string): void {
    if (this.disposed) {
      return
    }
    if (this.pendingSessionId !== undefined && this.pendingSessionId !== sessionId) {
      // Never mix streams: the previous session's output is obsolete.
      this.reset()
    }
    this.pendingSessionId = sessionId
    this.pendingSequence = sequence
    this.pending.push(data)
    if (this.cancelFrame) {
      return
    }
    void this.writePending()
    this.openFrameWindow()
  }

  /** Until the frame runs, further output is merged instead of written. */
  private openFrameWindow(): void {
    this.cancelFrame = this.schedule(() => {
      this.cancelFrame = undefined
      if (this.disposed || this.pending.length === 0) {
        // Nothing arrived during the frame: idle again.
        return
      }
      void this.writePending()
      this.openFrameWindow()
    })
  }

  /**
   * Writes queued output now and resolves after every write issued so far has
   * been processed by the emulator (so callers can order control events).
   */
  flush(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    this.cancelFrame?.()
    this.cancelFrame = undefined
    return this.writePending()
  }

  private writePending(): Promise<void> {
    if (this.pending.length > 0) {
      const data = this.pending.length === 1 ? this.pending[0]! : this.pending.join('')
      const sessionId = this.pendingSessionId!
      const sequence = this.pendingSequence
      this.pending = []
      this.pendingSessionId = undefined
      this.lastWrite = new Promise<void>((resolve) => {
        let finished = false
        const done = (): void => {
          if (finished) {
            return
          }
          finished = true
          if (!this.disposed) {
            this.acknowledge(sessionId, sequence)
          }
          resolve()
        }
        try {
          this.writeData(data, done)
        } catch {
          done()
        }
      })
    }
    return this.lastWrite
  }

  /**
   * Drops queued (unwritten) output when the session is replaced. The dropped
   * events are still acknowledged so Main does not keep them counted against
   * that session's backpressure window.
   */
  reset(): void {
    const sessionId = this.pendingSessionId
    const sequence = this.pendingSequence
    this.dropPending()
    if (!this.disposed && sessionId !== undefined) {
      this.acknowledge(sessionId, sequence)
    }
  }

  dispose(): void {
    this.disposed = true
    this.dropPending()
  }

  private dropPending(): void {
    this.cancelFrame?.()
    this.cancelFrame = undefined
    this.pending = []
    this.pendingSessionId = undefined
  }
}
