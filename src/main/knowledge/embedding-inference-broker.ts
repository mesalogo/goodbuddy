import { randomUUID } from 'node:crypto'
import {
  EMBEDDING_INFERENCE_MAX_IN_FLIGHT,
  embeddingInferenceProtocolBase,
  parseEmbeddingInferenceResponse,
  validateEmbeddingInferenceTexts,
  validateEmbeddingInferenceVectors,
  type EmbeddingInferenceRequest,
  type EmbeddingInferenceRole
} from './embedding-inference-contracts'

const DEFAULT_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 300_000
const DEFAULT_MAX_RESTARTS = 2
const MAX_RESTARTS = 10
const SHUTDOWN_GRACE_MS = 1_000
const MAX_RETIRED_REQUESTS = 256

export interface EmbeddingInferenceTransport {
  postMessage(message: EmbeddingInferenceRequest): void
  onMessage(listener: (message: unknown) => void): () => void
  onClose(listener: () => void): () => void
  close(): void
}

export type EmbeddingInferenceTransportFactory = () =>
  | EmbeddingInferenceTransport
  | Promise<EmbeddingInferenceTransport>

export interface EmbeddingInferenceBrokerOptions {
  readonly createTransport: EmbeddingInferenceTransportFactory
  readonly timeoutMs?: number
  /**
   * Maximum replacement processes over this broker's lifetime. The initial
   * process is not a restart and failed requests are never replayed.
   */
  readonly maxRestarts?: number
}

type PendingRequest = {
  readonly expectedCount: number
  readonly resolve: (vectors: number[][]) => void
  readonly reject: (error: Error) => void
  readonly timeout: ReturnType<typeof setTimeout>
  removeAbortListener?: () => void
}

type ActiveTransport = {
  readonly transport: EmbeddingInferenceTransport
  readonly removeMessageListener: () => void
  readonly removeCloseListener: () => void
}

export class EmbeddingInferenceBrokerError extends Error {
  constructor(
    readonly code:
      | 'CLOSED'
      | 'PROCESS_CLOSED'
      | 'PROTOCOL_VIOLATION'
      | 'RESTART_LIMIT'
      | 'START_FAILURE'
      | 'ENGINE_FAILURE'
      | 'INVALID_RESULT'
      | 'OVERLOADED'
  ) {
    super(`Embedding inference failed (${code})`)
    this.name = 'EmbeddingInferenceBrokerError'
  }
}

function boundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${field} must be an integer between ${minimum} and ${maximum}`
    )
  }
  return value
}

function abortError(): Error {
  const error = new Error('Embedding inference was cancelled')
  error.name = 'AbortError'
  return error
}

function timeoutError(): Error {
  const error = new Error('Embedding inference timed out')
  error.name = 'TimeoutError'
  return error
}

export class EmbeddingInferenceBroker {
  private readonly createTransport: EmbeddingInferenceTransportFactory
  private readonly timeoutMs: number
  private readonly maxRestarts: number
  private readonly pending = new Map<string, PendingRequest>()
  private readonly retiredRequestIds = new Set<string>()
  private active?: ActiveTransport
  private starting?: Promise<ActiveTransport>
  private restarts = 0
  private everStarted = false
  private closed = false
  private shutdownComplete?: () => void

  constructor(options: EmbeddingInferenceBrokerOptions) {
    if (typeof options.createTransport !== 'function') {
      throw new TypeError('createTransport must be a function')
    }
    this.createTransport = options.createTransport
    this.timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeoutMs',
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    )
    this.maxRestarts = boundedInteger(
      options.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      'maxRestarts',
      0,
      MAX_RESTARTS
    )
  }

  async embed(
    texts: readonly string[],
    role: EmbeddingInferenceRole,
    signal?: AbortSignal
  ): Promise<number[][]> {
    const normalizedTexts = validateEmbeddingInferenceTexts(texts)
    if (role !== 'query' && role !== 'document') {
      throw new TypeError('role must be query or document')
    }
    if (this.closed) {
      throw new EmbeddingInferenceBrokerError('CLOSED')
    }
    if (signal?.aborted) {
      throw abortError()
    }
    if (this.pending.size >= EMBEDDING_INFERENCE_MAX_IN_FLIGHT) {
      throw new EmbeddingInferenceBrokerError('OVERLOADED')
    }

    const active = await this.ensureTransport()
    if (this.closed) {
      throw new EmbeddingInferenceBrokerError('CLOSED')
    }
    if (signal?.aborted) {
      throw abortError()
    }
    if (this.pending.size >= EMBEDDING_INFERENCE_MAX_IN_FLIGHT) {
      throw new EmbeddingInferenceBrokerError('OVERLOADED')
    }

    const requestId = randomUUID()
    return new Promise<number[][]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cancelPending(requestId, timeoutError())
      }, this.timeoutMs)
      const pending: PendingRequest = {
        expectedCount: normalizedTexts.length,
        resolve,
        reject,
        timeout
      }
      if (signal) {
        const onAbort = (): void => {
          this.cancelPending(requestId, abortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        pending.removeAbortListener = () =>
          signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(requestId, pending)

      try {
        active.transport.postMessage({
          ...embeddingInferenceProtocolBase(),
          type: 'embed',
          requestId,
          role,
          texts: normalizedTexts
        })
      } catch {
        this.failTransport(
          active.transport,
          new EmbeddingInferenceBrokerError('PROCESS_CLOSED')
        )
      }
    })
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const requestId of this.pending.keys()) {
      this.retireRequestId(requestId)
    }
    this.rejectAll(new EmbeddingInferenceBrokerError('CLOSED'))

    let active = this.active
    if (!active && this.starting) {
      try {
        active = await this.starting
      } catch {
        return
      }
    }
    if (!active || this.active !== active) {
      return
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        this.shutdownComplete = undefined
        this.disposeTransport(active.transport, true)
        resolve()
      }
      const timeout = setTimeout(finish, SHUTDOWN_GRACE_MS)
      this.shutdownComplete = finish
      try {
        active.transport.postMessage({
          ...embeddingInferenceProtocolBase(),
          type: 'shutdown'
        })
      } catch {
        finish()
      }
    })
  }

  private async ensureTransport(): Promise<ActiveTransport> {
    if (this.active) {
      return this.active
    }
    if (this.starting) {
      return this.starting
    }
    if (this.everStarted && this.restarts >= this.maxRestarts) {
      throw new EmbeddingInferenceBrokerError('RESTART_LIMIT')
    }
    if (this.everStarted) {
      this.restarts += 1
    }
    this.everStarted = true

    const starting = Promise.resolve()
      .then(() => this.createTransport())
      .then((transport) => {
        if (this.closed) {
          transport.close()
          throw new EmbeddingInferenceBrokerError('CLOSED')
        }
        const active: ActiveTransport = {
          transport,
          removeMessageListener: transport.onMessage((message) =>
            this.handleMessage(transport, message)
          ),
          removeCloseListener: transport.onClose(() =>
            this.failTransport(
              transport,
              new EmbeddingInferenceBrokerError('PROCESS_CLOSED')
            )
          )
        }
        this.active = active
        return active
      })
      .catch((error: unknown) => {
        if (error instanceof EmbeddingInferenceBrokerError) {
          throw error
        }
        throw new EmbeddingInferenceBrokerError('START_FAILURE')
      })
      .finally(() => {
        if (this.starting === starting) {
          this.starting = undefined
        }
      })
    this.starting = starting
    return starting
  }

  private handleMessage(
    transport: EmbeddingInferenceTransport,
    rawMessage: unknown
  ): void {
    if (this.active?.transport !== transport) {
      return
    }
    const message = parseEmbeddingInferenceResponse(rawMessage)
    if (!message) {
      this.failTransport(
        transport,
        new EmbeddingInferenceBrokerError('PROTOCOL_VIOLATION')
      )
      return
    }
    if (message.type === 'shutdown-complete') {
      if (!this.closed || !this.shutdownComplete) {
        this.failTransport(
          transport,
          new EmbeddingInferenceBrokerError('PROTOCOL_VIOLATION')
        )
        return
      }
      this.shutdownComplete()
      return
    }
    if (message.type === 'fatal') {
      this.failTransport(
        transport,
        new EmbeddingInferenceBrokerError('PROTOCOL_VIOLATION')
      )
      return
    }

    const pending = this.pending.get(message.requestId)
    if (!pending) {
      if (this.retiredRequestIds.delete(message.requestId)) {
        return
      }
      this.failTransport(
        transport,
        new EmbeddingInferenceBrokerError('PROTOCOL_VIOLATION')
      )
      return
    }

    if (message.type === 'error') {
      this.finishPending(
        message.requestId,
        message.code === 'CANCELLED'
          ? abortError()
          : new EmbeddingInferenceBrokerError(message.code)
      )
      return
    }
    try {
      const vectors = validateEmbeddingInferenceVectors(
        message.vectors,
        pending.expectedCount
      )
      this.finishPending(message.requestId, undefined, vectors)
    } catch {
      this.failTransport(
        transport,
        new EmbeddingInferenceBrokerError('PROTOCOL_VIOLATION')
      )
    }
  }

  private cancelPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId)
    if (!pending) {
      return
    }
    this.retireRequestId(requestId)
    this.finishPending(requestId, error)
    try {
      this.active?.transport.postMessage({
        ...embeddingInferenceProtocolBase(),
        type: 'cancel',
        requestId
      })
    } catch {
      if (this.active) {
        this.failTransport(
          this.active.transport,
          new EmbeddingInferenceBrokerError('PROCESS_CLOSED')
        )
      }
    }
  }

  private finishPending(
    requestId: string,
    error?: Error,
    vectors?: number[][]
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending) {
      return
    }
    this.pending.delete(requestId)
    clearTimeout(pending.timeout)
    pending.removeAbortListener?.()
    if (error) {
      pending.reject(error)
    } else {
      pending.resolve(vectors as number[][])
    }
  }

  private retireRequestId(requestId: string): void {
    this.retiredRequestIds.add(requestId)
    if (this.retiredRequestIds.size > MAX_RETIRED_REQUESTS) {
      const oldest = this.retiredRequestIds.values().next().value
      if (typeof oldest === 'string') {
        this.retiredRequestIds.delete(oldest)
      }
    }
  }

  private failTransport(
    transport: EmbeddingInferenceTransport,
    error: Error
  ): void {
    if (this.active?.transport !== transport) {
      return
    }
    this.disposeTransport(transport, true)
    this.rejectAll(error)
    this.shutdownComplete?.()
  }

  private disposeTransport(
    transport: EmbeddingInferenceTransport,
    close: boolean
  ): void {
    const active = this.active
    if (!active || active.transport !== transport) {
      return
    }
    this.active = undefined
    active.removeMessageListener()
    active.removeCloseListener()
    if (close) {
      try {
        transport.close()
      } catch {
        // The process is already unavailable.
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const requestId of [...this.pending.keys()]) {
      this.finishPending(requestId, error)
    }
  }
}
