import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  EMBEDDING_INFERENCE_PROTOCOL,
  EMBEDDING_INFERENCE_PROTOCOL_VERSION,
  type EmbeddingInferenceRequest,
  type EmbeddingInferenceResponse
} from './embedding-inference-contracts'
import {
  EmbeddingInferenceWorker,
  type EmbeddingInferenceEngine,
  type EmbeddingInferenceWorkerPort
} from './embedding-inference-worker'

const FIRST_ID = '123e4567-e89b-42d3-a456-426614174000'
const SECOND_ID = '123e4567-e89b-42d3-a456-426614174001'

type RequestWithoutBase<T> = T extends unknown
  ? Omit<T, 'protocol' | 'version'>
  : never

class TestPort implements EmbeddingInferenceWorkerPort {
  readonly sent: EmbeddingInferenceResponse[] = []
  private readonly listeners = new Set<(message: unknown) => void>()

  postMessage(message: EmbeddingInferenceResponse): void {
    this.sent.push(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  receive(message: unknown): void {
    for (const listener of this.listeners) {
      listener(message)
    }
  }
}

function request(
  message: RequestWithoutBase<EmbeddingInferenceRequest>
): EmbeddingInferenceRequest {
  return {
    protocol: EMBEDDING_INFERENCE_PROTOCOL,
    version: EMBEDDING_INFERENCE_PROTOCOL_VERSION,
    ...message
  } as EmbeddingInferenceRequest
}

function engine(
  embed: EmbeddingInferenceEngine['embed']
): EmbeddingInferenceEngine {
  return {
    tokenizer: { tokenize: async () => ({}) },
    onnx: { run: async () => ({}) },
    embed
  }
}

describe('EmbeddingInferenceWorker', () => {
  it('uses only its trusted model directory and forwards role to the engine', async () => {
    const port = new TestPort()
    const modelDirectory = path.resolve('trusted-model')
    const embed = vi.fn<EmbeddingInferenceEngine['embed']>(
      async () => [[1, 2, 3]]
    )
    const worker = new EmbeddingInferenceWorker({
      modelDirectory,
      engine: engine(embed),
      port
    })

    port.receive(
      request({
        type: 'embed',
        requestId: FIRST_ID,
        role: 'document',
        texts: ['bounded text']
      })
    )
    await vi.waitFor(() => expect(port.sent).toHaveLength(1))

    expect(embed).toHaveBeenCalledWith({
      modelDirectory,
      texts: ['bounded text'],
      role: 'document',
      signal: expect.any(AbortSignal)
    })
    expect(port.sent[0]).toMatchObject({
      type: 'result',
      requestId: FIRST_ID,
      vectors: [[1, 2, 3]]
    })
    await worker.shutdown()
  })

  it('rejects invalid engine output instead of fabricating vectors', async () => {
    const port = new TestPort()
    const worker = new EmbeddingInferenceWorker({
      modelDirectory: path.resolve('trusted-model'),
      engine: engine(async () => [[Number.NaN]]),
      port
    })

    port.receive(
      request({
        type: 'embed',
        requestId: FIRST_ID,
        role: 'query',
        texts: ['input']
      })
    )
    await vi.waitFor(() =>
      expect(port.sent[0]).toMatchObject({
        type: 'error',
        requestId: FIRST_ID,
        code: 'INVALID_RESULT'
      })
    )
    await worker.shutdown()
  })

  it('aborts an active engine request when cancelled', async () => {
    const port = new TestPort()
    let observedSignal: AbortSignal | undefined
    const worker = new EmbeddingInferenceWorker({
      modelDirectory: path.resolve('trusted-model'),
      engine: engine(
        async ({ signal }) =>
          new Promise<readonly (readonly number[])[]>((_resolve, reject) => {
            observedSignal = signal
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true
            })
          })
      ),
      port
    })

    port.receive(
      request({
        type: 'embed',
        requestId: FIRST_ID,
        role: 'query',
        texts: ['input']
      })
    )
    port.receive(request({ type: 'cancel', requestId: FIRST_ID }))
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true))
    await vi.waitFor(() =>
      expect(port.sent[0]).toMatchObject({
        type: 'error',
        requestId: FIRST_ID,
        code: 'CANCELLED'
      })
    )
    await worker.shutdown()
  })

  it('treats malformed, credential-bearing, and duplicate requests as violations', async () => {
    const malformedPort = new TestPort()
    const malformedWorker = new EmbeddingInferenceWorker({
      modelDirectory: path.resolve('trusted-model'),
      engine: engine(async () => [[1]]),
      port: malformedPort
    })
    malformedPort.receive({
      ...request({
        type: 'embed',
        requestId: FIRST_ID,
        role: 'query',
        texts: ['input']
      }),
      apiKey: 'must-not-cross-boundary'
    })
    await vi.waitFor(() =>
      expect(malformedPort.sent[0]).toMatchObject({
        type: 'fatal',
        code: 'PROTOCOL_VIOLATION'
      })
    )
    await malformedWorker.shutdown()

    let finish:
      | ((vectors: readonly (readonly number[])[]) => void)
      | undefined
    const duplicatePort = new TestPort()
    const duplicateWorker = new EmbeddingInferenceWorker({
      modelDirectory: path.resolve('trusted-model'),
      engine: engine(
        async () =>
          new Promise<readonly (readonly number[])[]>((resolve) => {
            finish = resolve
          })
      ),
      port: duplicatePort
    })
    const duplicate = request({
      type: 'embed',
      requestId: SECOND_ID,
      role: 'query',
      texts: ['input']
    })
    duplicatePort.receive(duplicate)
    duplicatePort.receive(duplicate)
    await vi.waitFor(() =>
      expect(duplicatePort.sent[0]).toMatchObject({
        type: 'fatal',
        code: 'PROTOCOL_VIOLATION'
      })
    )
    finish?.([[1]])
    await duplicateWorker.shutdown()
  })

  it('acknowledges shutdown only after disposing its engine', async () => {
    const port = new TestPort()
    const dispose = vi.fn(async () => undefined)
    new EmbeddingInferenceWorker({
      modelDirectory: path.resolve('trusted-model'),
      engine: {
        ...engine(async () => [[1]]),
        dispose
      },
      port
    })

    port.receive(request({ type: 'shutdown' }))
    await vi.waitFor(() =>
      expect(port.sent[0]).toMatchObject({ type: 'shutdown-complete' })
    )
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('requires explicit tokenizer and ONNX engine implementations', () => {
    expect(
      () =>
        new EmbeddingInferenceWorker({
          modelDirectory: path.resolve('trusted-model'),
          engine: {
            tokenizer: undefined,
            onnx: undefined,
            embed: async () => [[1]]
          } as unknown as EmbeddingInferenceEngine,
          port: new TestPort()
        })
    ).toThrow('tokenizer and ONNX')
  })
})
