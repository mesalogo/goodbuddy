import { Worker } from 'node:worker_threads'
import { z } from 'zod'

// PERF-15/16 first slice: hot read paths run in a read-only worker per database
// file so a long scan does not block the Main event loop. The worker opens its
// own read-only connection (WAL), so it observes committed data only.

export type ReadonlyQueryKind = 'assistant' | 'knowledge'

/** Worker infrastructure failure; callers fall back to the synchronous path. */
export class ReadonlyWorkerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ReadonlyWorkerUnavailableError'
  }
}

export type ReadonlyQueryRequest = {
  type: 'query'
  id: number
  op: string
  args: unknown[]
  /** Int32Array(1) cancel flag, polled by the worker through `signal.throwIfAborted()`. */
  cancel: SharedArrayBuffer
}

export type ReadonlyQueryResponse =
  | { id: number; result: unknown }
  | { id: number; error: { name: string; message: string; issues?: unknown } }
  | { id: number; ready: true }

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}

const MAX_PENDING = 32
const RESTART_BACKOFF_MS = 30_000

export function deserializeWorkerError(error: { name: string; message: string; issues?: unknown }): Error {
  if (error.name === 'ZodError' && Array.isArray(error.issues)) {
    return new z.ZodError(error.issues as z.core.$ZodIssue[])
  }
  const Constructor = error.name === 'RangeError' ? RangeError
    : error.name === 'TypeError' ? TypeError : Error
  const result = new Constructor(error.message)
  if (result.name !== error.name) result.name = error.name
  return result
}

export class ReadonlyQueryReader {
  private worker?: Worker
  private nextId = 0
  private disabledUntil = 0
  private closed = false
  private readonly pending = new Map<number, Pending>()

  constructor(
    private readonly kind: ReadonlyQueryKind,
    private readonly databasePath: string,
    private readonly workerPath: string,
    private readonly now: () => number = Date.now
  ) {}

  /** False while backing off after a crash or startup failure. */
  get available(): boolean {
    return !this.closed && this.now() >= this.disabledUntil && this.pending.size < MAX_PENDING
  }

  get pendingCount(): number {
    return this.pending.size
  }

  call<T>(op: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new ReadonlyWorkerUnavailableError('Readonly query reader closed'))
    if (signal?.aborted) return Promise.reject(signal.reason as Error)
    if (this.now() < this.disabledUntil) {
      return Promise.reject(new ReadonlyWorkerUnavailableError('Readonly query worker is backing off'))
    }
    // Bound outstanding work; the caller runs the query synchronously instead.
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(new ReadonlyWorkerUnavailableError('Readonly query worker is busy'))
    }
    let worker: Worker
    try {
      worker = this.ensureWorker()
    } catch (error) {
      this.disabledUntil = this.now() + RESTART_BACKOFF_MS
      return Promise.reject(new ReadonlyWorkerUnavailableError('Readonly query worker failed to start', { cause: error }))
    }
    const id = ++this.nextId
    const cancel = new SharedArrayBuffer(4)
    const flag = new Int32Array(cancel)
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        Atomics.store(flag, 0, 1)
        const request = this.pending.get(id)
        if (!request) return
        this.pending.delete(id)
        request.cleanup()
        if (this.pending.size === 0) worker.unref()
        reject(signal!.reason as Error)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort)
      })
      // Keep the process alive only while a request is outstanding.
      worker.ref()
      try {
        worker.postMessage({ type: 'query', id, op, args, cancel } satisfies ReadonlyQueryRequest)
      } catch (error) {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        if (this.pending.size === 0) worker.unref()
        // DataCloneError etc. are caller errors, but stay safe and let the caller fall back.
        reject(new ReadonlyWorkerUnavailableError('Readonly query could not be posted', { cause: error }))
      }
    })
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.workerPath, {
      workerData: { kind: this.kind, databasePath: this.databasePath }
    })
    this.worker = worker
    worker.on('message', (message: ReadonlyQueryResponse) => {
      if ('ready' in message) return
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      request.cleanup()
      if (this.pending.size === 0) worker.unref()
      if ('error' in message) request.reject(deserializeWorkerError(message.error))
      else request.resolve(message.result)
    })
    const failed = (error: Error): void => {
      if (this.worker !== worker) return
      this.worker = undefined
      // Restart lazily on a later request, after a short backoff.
      this.disabledUntil = this.now() + RESTART_BACKOFF_MS
      const pending = [...this.pending.values()]
      this.pending.clear()
      for (const request of pending) {
        request.cleanup()
        request.reject(new ReadonlyWorkerUnavailableError(error.message, { cause: error }))
      }
      void worker.terminate()
    }
    worker.once('error', failed)
    worker.once('exit', (code) => failed(new Error(`Readonly query worker exited (${code})`)))
    worker.unref()
    return worker
  }

  /** Test hook: simulate a crash by terminating the worker. */
  async terminateWorkerForTest(): Promise<void> {
    await this.worker?.terminate()
  }

  /** Test hook: end the post-crash backoff. */
  resetBackoffForTest(): void {
    this.disabledUntil = 0
  }

  close(): void {
    this.closed = true
    const worker = this.worker
    this.worker = undefined
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const request of pending) {
      request.cleanup()
      request.reject(new ReadonlyWorkerUnavailableError('Readonly query reader closed'))
    }
    if (worker) void worker.terminate()
  }
}

/**
 * Runs `op` in the worker when available, otherwise synchronously. Worker
 * infrastructure failures fall back to the synchronous path; query errors and
 * aborts propagate unchanged.
 */
export async function readWithFallback<T>(
  reader: ReadonlyQueryReader | undefined,
  op: string,
  args: unknown[],
  signal: AbortSignal | undefined,
  sync: () => T
): Promise<T> {
  signal?.throwIfAborted()
  if (!reader?.available) return sync()
  try {
    return await reader.call<T>(op, args, signal)
  } catch (error) {
    if (error instanceof ReadonlyWorkerUnavailableError && !signal?.aborted) return sync()
    throw error
  }
}
