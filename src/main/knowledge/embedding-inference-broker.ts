import { randomUUID } from 'node:crypto'
import { localInferenceService } from '../local-inference-service'
import type { InferenceResources } from '../../shared/local-inference-contracts'
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

export interface EmbeddingInferenceTransport {
  getResources?(): InferenceResources
  postMessage(message: EmbeddingInferenceRequest): void
  onMessage(listener: (message: unknown) => void): () => void
  onClose(listener: () => void): () => void
  close(): void | Promise<void>
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
  readonly rejectCaller: (error: Error) => void
  callerError?: Error
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
      | 'OVERLOADED',
    detail?: string
  ) {
    super(`Embedding inference failed (${code})${detail ? `: ${detail}` : ''}`)
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
  private active?: ActiveTransport
  private starting?: Promise<ActiveTransport>
  private restarts = 0
  private everStarted = false
  private closed = false
  private shutdownComplete?: () => void
  private paused = false
  private stopping = false
  private managementError?: string

  getManagementState(): 'stopped' | 'stopping' | 'starting' | 'running' | 'idle' | 'error' {
    if (this.stopping) return 'stopping'
    if (this.paused || this.closed) return 'stopped'
    if (this.starting) return 'starting'
    if (this.active) return 'running'
    return this.managementError ? 'error' : 'idle'
  }

  getManagementError(): string | undefined { return this.managementError }

  getResources(): InferenceResources {
    return this.active?.transport.getResources?.() ?? {
      scope: 'unavailable', reason: this.active ? '当前执行端未提供进程指标' : '服务进程未运行'
    }
  }

  async start(): Promise<void> {
    if (this.closed) throw new EmbeddingInferenceBrokerError('CLOSED')
    this.paused = false
    this.restarts = 0
    try {
      await this.ensureTransport()
      this.managementError = undefined
    } catch (error) {
      this.managementError = String(error)
      throw error
    }
  }

  async stop(): Promise<void> {
    this.paused = true
    this.stopping = true
    const error = new Error('向量执行服务已由用户停止；任务不会自动重放')
    this.rejectCallers(error)
    try {
      if (this.starting) await this.starting.catch(() => undefined)
      const active = this.active
      if (!active) return
      await active.transport.close()
      this.disposeTransport(active.transport, false)
      this.rejectAll(error)
    } catch (error) {
      this.paused = false
      this.managementError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.stopping = false
    }
  }

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
    const controller = new AbortController()
    return new Promise<number[][]>((resolve, reject) => {
      // Track worker execution separately from prompt caller cancellation/timeout.
      void localInferenceService.run('embedding', role === 'query' ? '向量请求 · 查询' : '向量请求 · 文档',
        (markCancelling) => this.embedRequest(texts, role, signal, controller.signal, (error) => {
          markCancelling()
          reject(error)
        }),
        { cancel: () => controller.abort() }).then(resolve, reject)
    })
  }

  private async embedRequest(
    texts: readonly string[], role: EmbeddingInferenceRole, signal: AbortSignal | undefined,
    managementSignal: AbortSignal,
    rejectCaller: (error: Error) => void
  ): Promise<number[][]> {
    const normalizedTexts = validateEmbeddingInferenceTexts(texts)
    if (role !== 'query' && role !== 'document') {
      throw new TypeError('role must be query or document')
    }
    if (this.closed || this.paused) {
      throw new EmbeddingInferenceBrokerError('CLOSED')
    }
    if (signal?.aborted) {
      throw abortError()
    }
    if (this.pending.size >= EMBEDDING_INFERENCE_MAX_IN_FLIGHT) {
      throw new EmbeddingInferenceBrokerError('OVERLOADED')
    }

    const active = await this.ensureTransport()
    if (this.closed || this.paused) {
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
        rejectCaller,
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

      const requestCancellation = (): void => {
        // Management cancellation waits for the worker's result or CANCELLED response.
        try {
          active.transport.postMessage({ ...embeddingInferenceProtocolBase(), type: 'cancel', requestId })
        } catch {
          this.failTransport(active.transport, new EmbeddingInferenceBrokerError('PROCESS_CLOSED'))
        }
      }
      const removeSourceAbort = pending.removeAbortListener
      pending.removeAbortListener = () => {
        removeSourceAbort?.()
        managementSignal.removeEventListener('abort', requestCancellation)
      }
      managementSignal.addEventListener('abort', requestCancellation, { once: true })

      try {
        active.transport.postMessage({
          ...embeddingInferenceProtocolBase(),
          type: 'embed',
          requestId,
          role,
          texts: normalizedTexts
        })
        if (managementSignal.aborted) requestCancellation()
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
    this.rejectCallers(new EmbeddingInferenceBrokerError('CLOSED'))

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
          void Promise.resolve(transport.close()).catch(() => undefined)
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
              new EmbeddingInferenceBrokerError('PROCESS_CLOSED'),
              true
            )
          )
        }
        this.active = active
        return active
      })
      .catch((error: unknown) => {
        this.managementError = error instanceof Error ? error.message : String(error)
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
      this.rejectAll(new EmbeddingInferenceBrokerError('CLOSED'))
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
          : new EmbeddingInferenceBrokerError(message.code, message.message)
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
    if (!pending || pending.callerError) {
      return
    }
    pending.callerError = error
    clearTimeout(pending.timeout)
    pending.rejectCaller(error)
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
    error = pending.callerError ?? error
    if (error) {
      pending.reject(error)
    } else {
      pending.resolve(vectors as number[][])
    }
  }

  private failTransport(
    transport: EmbeddingInferenceTransport,
    error: Error,
    closed = false
  ): void {
    if (this.active?.transport !== transport) {
      return
    }
    this.rejectCallers(error)
    if (closed) {
      this.disposeTransport(transport, false)
      this.rejectAll(error)
      this.shutdownComplete?.()
      return
    }
    this.managementError = error.message
    this.disposeTransport(transport, true)
  }

  private disposeTransport(
    transport: EmbeddingInferenceTransport,
    close: boolean
  ): void {
    const active = this.active
    if (!active || active.transport !== transport) {
      return
    }
    if (close) {
      try {
        void Promise.resolve(transport.close()).then(() => {
          if (this.active !== active) return
          this.disposeTransport(transport, false)
          this.rejectAll(new EmbeddingInferenceBrokerError('PROCESS_CLOSED'))
        }).catch((error: unknown) => {
          this.managementError = error instanceof Error ? error.message : String(error)
        })
      } catch (error) {
        this.managementError = error instanceof Error ? error.message : String(error)
      }
      return
    }
    this.active = undefined
    active.removeMessageListener()
    active.removeCloseListener()
  }

  private rejectCallers(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.callerError ??= error
      clearTimeout(pending.timeout)
      pending.rejectCaller(pending.callerError)
    }
  }

  private rejectAll(error: Error): void {
    for (const requestId of [...this.pending.keys()]) {
      this.finishPending(requestId, error)
    }
  }
}
