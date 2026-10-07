import { Worker } from 'node:worker_threads'
import type { EventEmitter } from 'node:events'
import { z } from 'zod'
import type { ReviewManifestReader } from './assistant/supervision-review-store'

// Request correlation shared by the read-only query workers and the desktop
// storage utility process. A worker opens its own read-only WAL connection, so it
// observes committed data only; business writes stay with the storage owner.

export type ReadonlyQueryKind = 'assistant' | 'knowledge'

/** Worker infrastructure failure; the owner reports it without a SQL fallback. */
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

type Waiting = { start: () => void; cancel: () => void; fail: (error: Error) => void }

/** The utility-process adapter uses the same request correlation as read workers. */
export type QueryTransport = Pick<EventEmitter, 'on' | 'once'> & Pick<Worker, 'postMessage' | 'ref' | 'unref' | 'terminate'>
export interface QueryTransportOptions {
  createTransport: () => QueryTransport
  /** Optional test or caller policy; production storage leaves this unset. */
  maxPending?: number
}

const DEFAULT_MAX_PENDING = Number.POSITIVE_INFINITY
const RESTART_BACKOFF_MS = 30_000

export function deserializeWorkerError(error: { name: string; message: string; issues?: unknown; code?: string; cause?: Parameters<typeof deserializeWorkerError>[0] }): Error {
  if (error.name === 'ZodError' && Array.isArray(error.issues)) {
    return new z.ZodError(error.issues as z.core.$ZodIssue[])
  }
  const Constructor = error.name === 'RangeError' ? RangeError
    : error.name === 'TypeError' ? TypeError : Error
  const result = new Constructor(error.message)
  if (result.name !== error.name) result.name = error.name
  if (error.code) Object.assign(result, { code: error.code })
  if (error.cause) result.cause = deserializeWorkerError(error.cause)
  return result
}

export class ReadonlyQueryReader {
  private worker?: QueryTransport
  private nextId = 0
  private disabledUntil = 0
  private closed = false
  private readonly pending = new Map<number, Pending>()
  private readonly waiting: Waiting[] = []
  private highWaterOperations = 0
  private closePromise?: Promise<void>
  private drained?: () => void
  private stopping?: Promise<void>

  constructor(
    private readonly kind: ReadonlyQueryKind,
    private readonly databasePath: string,
    private readonly workerPath: string,
    private readonly now: () => number = Date.now,
    private readonly transportOptions?: QueryTransportOptions
  ) {}

  private get maxPending(): number { return this.transportOptions?.maxPending ?? DEFAULT_MAX_PENDING }

  /** False while backing off after a crash or startup failure. */
  get available(): boolean {
    return !this.closed && !this.stopping && this.now() >= this.disabledUntil
  }

  get pendingCount(): number { return this.pending.size }
  get waitingCount(): number { return this.waiting.length }
  get admissionHighWaterOperations(): number { return this.highWaterOperations }

  reviewManifest(runId: string): ReviewManifestReader {
    return {
      scan: (state, signal) => this.call('reviewManifestScan', [runId, state], signal),
      page: (offset, signal) => this.call('reviewManifestPage', [runId, offset], signal),
      release: () => this.call('reviewManifestRelease', [runId]),
      changedSource: (rows, signal) => this.call('reviewChangedSource', [rows], signal)
    }
  }

  call<T>(op: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new ReadonlyWorkerUnavailableError('Readonly query reader closed'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.pending.size < this.maxPending && !this.waiting.length) return this.dispatch(op, args, signal)
    // Read workers keep their original busy rejection; storage requests wait in order.
    if (!this.transportOptions) return Promise.reject(new ReadonlyWorkerUnavailableError('Readonly query worker is busy'))
    return new Promise<T>((resolve, reject) => {
      const entry: Waiting = {
          start: () => { signal?.removeEventListener('abort', entry.cancel); this.dispatch<T>(op, args, signal).then(resolve, reject) },
          cancel: () => {
            const index = this.waiting.indexOf(entry)
            if (index >= 0) this.waiting.splice(index, 1)
            reject(signal?.reason)
          },
          fail: error => {
            const index = this.waiting.indexOf(entry)
            if (index >= 0) this.waiting.splice(index, 1)
            reject(error)
          }
        }
      signal?.addEventListener('abort', entry.cancel, { once: true })
      this.waiting.push(entry)
    })
  }

  private dispatch<T>(op: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new ReadonlyWorkerUnavailableError('Readonly query reader closed'))
    if (signal?.aborted) return Promise.reject(signal.reason as Error)
    if (this.stopping || this.now() < this.disabledUntil) {
      return Promise.reject(new ReadonlyWorkerUnavailableError('Readonly query worker is backing off'))
    }
    let worker: QueryTransport
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
        // Storage keeps the slot until the host settles: a write may still commit.
        if (this.transportOptions) worker.postMessage({ type: 'cancel', id })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: value => !this.transportOptions && signal?.aborted ? reject(signal.reason) : resolve(value as T),
        reject: error => reject(!this.transportOptions && signal?.aborted ? signal.reason : error),
        cleanup: () => signal?.removeEventListener('abort', onAbort)
      })
      this.highWaterOperations = Math.max(this.highWaterOperations, this.pending.size)
      // Keep the process alive only while a request is outstanding.
      worker.ref()
      try {
        worker.postMessage({ type: 'query', id, op, args, cancel } satisfies ReadonlyQueryRequest)
      } catch (error) {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        if (this.pending.size === 0) worker.unref()
        // Posting failures must reject; callers must not repeat the operation in SQL.
        reject(new ReadonlyWorkerUnavailableError('Readonly query could not be posted', { cause: error }))
        this.startWaiting()
      }
    })
  }

  private startWaiting(): void {
    while (this.waiting.length && this.pending.size < this.maxPending) this.waiting.shift()!.start()
  }

  private ensureWorker(): QueryTransport {
    if (this.worker) return this.worker
    const worker = this.transportOptions?.createTransport() ?? new Worker(this.workerPath, {
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
      this.startWaiting()
      if (this.pending.size === 0) this.drained?.()
    })
    const failed = (error: Error): void => {
      if (this.worker !== worker) return
      this.worker = undefined
      // Restart lazily on a later request, after a short backoff.
      this.disabledUntil = this.now() + RESTART_BACKOFF_MS
      const pending = [...this.pending.values()]
      this.pending.clear()
      const reject = (): void => {
        for (const request of pending) {
          request.cleanup()
          request.reject(this.transportOptions
            ? Object.assign(new Error('Storage process lost; unconfirmed writes require domain reconciliation', { cause: error }), { code: 'STORAGE_UNCONFIRMED' })
            : new ReadonlyWorkerUnavailableError(error.message, { cause: error }))
        }
        // Waiting requests were never sent; they fail as unavailable, not unconfirmed.
        for (const waiting of this.waiting.splice(0)) waiting.start()
        this.drained?.()
      }
      this.stopping = worker.terminate().then(reject, reject).finally(() => { this.stopping = undefined })
    }
    worker.once('error', failed)
    worker.once('exit', (code) => failed(new Error(`Readonly query worker exited (${code})`)))
    worker.unref()
    return worker
  }

  /** Settle storage requests when its utility transport is lost. */
  failTransport(error: Error): void {
    if (this.closed || !this.transportOptions || !this.worker) return
    this.worker = undefined
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const request of pending) {
      request.cleanup()
      request.reject(Object.assign(new Error('Storage process lost; unconfirmed writes require domain reconciliation', { cause: error }), { code: 'STORAGE_UNCONFIRMED' }))
    }
    for (const waiting of this.waiting.splice(0)) waiting.fail(new ReadonlyWorkerUnavailableError('Storage process lost before request dispatch', { cause: error }))
    this.drained?.()
  }

  /** Test hook: simulate a crash by terminating the worker. */
  async terminateWorkerForTest(): Promise<void> {
    await this.worker?.terminate()
    await this.stopping
  }

  /** Test hook: end the post-crash backoff. */
  resetBackoffForTest(): void {
    this.disabledUntil = 0
  }

  close(terminateTransport = true): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    for (const waiting of this.waiting.splice(0)) waiting.start()
    if (this.transportOptions) {
      this.closePromise = (async () => {
        if (this.pending.size) await new Promise<void>(resolve => { this.drained = resolve })
        await this.stopping
        const worker = this.worker
        this.worker = undefined
        if (terminateTransport) await worker?.terminate()
      })()
      return this.closePromise
    }
    const worker = this.worker
    this.worker = undefined
    const pending = [...this.pending.values()]
    this.pending.clear()
    const reject = (): void => {
      for (const request of pending) {
        request.cleanup()
        request.reject(new ReadonlyWorkerUnavailableError('Readonly query reader closed'))
      }
    }
    const terminated = worker?.terminate()
    this.closePromise = Promise.all([terminated, this.stopping]).then(reject)
    return this.closePromise
  }
}
