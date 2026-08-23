import path from 'node:path'
import {
  EMBEDDING_INFERENCE_MAX_ERROR_LENGTH,
  EMBEDDING_INFERENCE_MAX_IN_FLIGHT,
  embeddingInferenceProtocolBase,
  parseEmbeddingInferenceRequest,
  validateEmbeddingInferenceVectors,
  type EmbeddingInferenceRequest,
  type EmbeddingInferenceResponse,
  type EmbeddingInferenceRole
} from './embedding-inference-contracts'

export interface EmbeddingTokenizer {
  tokenize(options: {
    readonly texts: readonly string[]
    readonly role: EmbeddingInferenceRole
    readonly signal: AbortSignal
  }): Promise<unknown>
}

export interface EmbeddingOnnxRuntime {
  run(options: {
    readonly modelDirectory: string
    readonly inputs: unknown
    readonly signal: AbortSignal
  }): Promise<unknown>
}

/**
 * Production engines must own both a tokenizer and an ONNX runtime. This
 * boundary deliberately supplies no fallback or synthetic vector engine.
 */
export interface EmbeddingInferenceEngine {
  readonly tokenizer: EmbeddingTokenizer
  readonly onnx: EmbeddingOnnxRuntime
  embed(options: {
    readonly modelDirectory: string
    readonly texts: readonly string[]
    readonly role: EmbeddingInferenceRole
    readonly signal: AbortSignal
  }): Promise<readonly (readonly number[])[]>
  dispose?(): void | Promise<void>
}

export interface EmbeddingInferenceWorkerPort {
  postMessage(message: EmbeddingInferenceResponse): void
  onMessage(listener: (message: unknown) => void): () => void
}

export interface EmbeddingInferenceWorkerOptions {
  /**
   * Trusted Main configuration, never read from a protocol message.
   */
  readonly modelDirectory: string
  readonly engine: EmbeddingInferenceEngine
  readonly port: EmbeddingInferenceWorkerPort
}

type RunningRequest = {
  readonly controller: AbortController
  readonly done: Promise<void>
}

function trustedModelDirectory(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 4_096 ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError('modelDirectory must be a bounded absolute path')
  }
  return path.normalize(value)
}

function boundedMessage(value: string): string {
  return value.slice(0, EMBEDDING_INFERENCE_MAX_ERROR_LENGTH)
}

export class EmbeddingInferenceWorker {
  private readonly modelDirectory: string
  private readonly engine: EmbeddingInferenceEngine
  private readonly port: EmbeddingInferenceWorkerPort
  private readonly running = new Map<string, RunningRequest>()
  private readonly removeMessageListener: () => void
  private shuttingDown = false
  private disposed = false
  private shutdownTask?: Promise<void>

  constructor(options: EmbeddingInferenceWorkerOptions) {
    this.modelDirectory = trustedModelDirectory(options.modelDirectory)
    this.engine = options.engine
    this.port = options.port
    if (
      typeof options.engine.tokenizer?.tokenize !== 'function' ||
      typeof options.engine.onnx?.run !== 'function'
    ) {
      throw new TypeError('engine must provide tokenizer and ONNX implementations')
    }
    this.removeMessageListener = this.port.onMessage((message) => {
      this.handleMessage(message)
    })
  }

  async shutdown(): Promise<void> {
    await this.stop(false)
  }

  private handleMessage(rawMessage: unknown): void {
    if (this.disposed) {
      return
    }
    const message = parseEmbeddingInferenceRequest(rawMessage)
    if (!message) {
      this.protocolViolation()
      return
    }
    if (message.type === 'shutdown') {
      if (this.shuttingDown) {
        this.protocolViolation()
        return
      }
      this.shuttingDown = true
      void this.stop(true).then(
        () => undefined,
        () => {
          this.post({
            ...embeddingInferenceProtocolBase(),
            type: 'fatal',
            code: 'PROTOCOL_VIOLATION'
          })
        }
      )
      return
    }
    if (message.type === 'cancel') {
      this.running.get(message.requestId)?.controller.abort()
      return
    }
    this.startEmbedding(message)
  }

  private startEmbedding(
    message: Extract<EmbeddingInferenceRequest, { type: 'embed' }>
  ): void {
    if (
      this.shuttingDown ||
      this.running.has(message.requestId)
    ) {
      this.protocolViolation()
      return
    }
    if (this.running.size >= EMBEDDING_INFERENCE_MAX_IN_FLIGHT) {
      this.postError(
        message.requestId,
        'OVERLOADED',
        'Embedding inference worker is busy'
      )
      return
    }

    const controller = new AbortController()
    const done = this.runEmbedding(message, controller)
    this.running.set(message.requestId, { controller, done })
    void done.finally(() => {
      this.running.delete(message.requestId)
    })
  }

  private async runEmbedding(
    message: Extract<EmbeddingInferenceRequest, { type: 'embed' }>,
    controller: AbortController
  ): Promise<void> {
    try {
      const rawVectors = await this.engine.embed({
        modelDirectory: this.modelDirectory,
        texts: message.texts,
        role: message.role,
        signal: controller.signal
      })
      if (controller.signal.aborted) {
        this.postError(
          message.requestId,
          'CANCELLED',
          'Embedding inference was cancelled'
        )
        return
      }
      let vectors: number[][]
      try {
        vectors = validateEmbeddingInferenceVectors(
          rawVectors,
          message.texts.length
        )
      } catch {
        this.postError(
          message.requestId,
          'INVALID_RESULT',
          'Embedding engine returned an invalid result'
        )
        return
      }
      this.post({
        ...embeddingInferenceProtocolBase(),
        type: 'result',
        requestId: message.requestId,
        vectors
      })
    } catch {
      this.postError(
        message.requestId,
        controller.signal.aborted ? 'CANCELLED' : 'ENGINE_FAILURE',
        controller.signal.aborted
          ? 'Embedding inference was cancelled'
          : 'Embedding engine failed'
      )
    }
  }

  private postError(
    requestId: string,
    code: 'CANCELLED' | 'ENGINE_FAILURE' | 'INVALID_RESULT' | 'OVERLOADED',
    message: string
  ): void {
    this.post({
      ...embeddingInferenceProtocolBase(),
      type: 'error',
      requestId,
      code,
      message: boundedMessage(message)
    })
  }

  private protocolViolation(): void {
    if (this.disposed) {
      return
    }
    this.shuttingDown = true
    this.post({
      ...embeddingInferenceProtocolBase(),
      type: 'fatal',
      code: 'PROTOCOL_VIOLATION'
    })
    void this.shutdown()
  }

  private stop(sendCompletion: boolean): Promise<void> {
    if (this.shutdownTask) {
      return this.shutdownTask
    }
    this.shuttingDown = true
    const task = (async (): Promise<void> => {
      try {
        for (const request of this.running.values()) {
          request.controller.abort()
        }
        await Promise.allSettled(
          [...this.running.values()].map((request) => request.done)
        )
        await this.engine.dispose?.()
        if (sendCompletion) {
          this.post({
            ...embeddingInferenceProtocolBase(),
            type: 'shutdown-complete'
          })
        }
      } finally {
        this.disposed = true
        this.removeMessageListener()
      }
    })()
    this.shutdownTask = task
    return task
  }

  private post(message: EmbeddingInferenceResponse): void {
    try {
      this.port.postMessage(message)
    } catch {
      void this.shutdown()
    }
  }
}

export interface ElectronParentPortLike {
  postMessage(message: unknown): void
  on(
    event: 'message',
    listener: (event: { readonly data: unknown }) => void
  ): unknown
  removeListener(
    event: 'message',
    listener: (event: { readonly data: unknown }) => void
  ): unknown
}

export function createEmbeddingInferenceWorkerPort(
  parentPort: ElectronParentPortLike
): EmbeddingInferenceWorkerPort {
  return {
    postMessage: (message) => parentPort.postMessage(message),
    onMessage: (listener) => {
      const onMessage = (event: { readonly data: unknown }): void =>
        listener(event.data)
      parentPort.on('message', onMessage)
      return () => parentPort.removeListener('message', onMessage)
    }
  }
}
