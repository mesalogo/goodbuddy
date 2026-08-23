import { describe, expect, it, vi } from 'vitest'
import {
  EMBEDDING_INFERENCE_PROTOCOL,
  EMBEDDING_INFERENCE_PROTOCOL_VERSION,
  type EmbeddingInferenceRequest
} from './embedding-inference-contracts'
import {
  EmbeddingInferenceBroker,
  type EmbeddingInferenceTransport
} from './embedding-inference-broker'

class TestTransport implements EmbeddingInferenceTransport {
  readonly sent: EmbeddingInferenceRequest[] = []
  readonly close = vi.fn()
  private readonly messageListeners = new Set<(message: unknown) => void>()
  private readonly closeListeners = new Set<() => void>()

  postMessage(message: EmbeddingInferenceRequest): void {
    this.sent.push(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  receive(message: unknown): void {
    for (const listener of this.messageListeners) {
      listener(message)
    }
  }

  crash(): void {
    for (const listener of this.closeListeners) {
      listener()
    }
  }
}

function response(message: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: EMBEDDING_INFERENCE_PROTOCOL,
    version: EMBEDDING_INFERENCE_PROTOCOL_VERSION,
    ...message
  }
}

function embedRequest(transport: TestTransport): Extract<
  EmbeddingInferenceRequest,
  { type: 'embed' }
> {
  const request = transport.sent.find((item) => item.type === 'embed')
  if (!request || request.type !== 'embed') {
    throw new Error('No embed request was sent')
  }
  return request
}

describe('EmbeddingInferenceBroker', () => {
  it('uses UUID requests with roles and validates bounded results', async () => {
    const transport = new TestTransport()
    const broker = new EmbeddingInferenceBroker({
      createTransport: () => transport
    })

    const pending = broker.embed(['first', 'second'], 'query')
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
    const request = embedRequest(transport)

    expect(request).toMatchObject({
      type: 'embed',
      role: 'query',
      texts: ['first', 'second']
    })
    expect(request.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(request).not.toHaveProperty('modelDirectory')
    expect(request).not.toHaveProperty('env')

    transport.receive(
      response({
        type: 'result',
        requestId: request.requestId,
        vectors: [
          [1, 2],
          [3, 4]
        ]
      })
    )
    await expect(pending).resolves.toEqual([
      [1, 2],
      [3, 4]
    ])
    const shuttingDown = broker.shutdown()
    transport.receive(response({ type: 'shutdown-complete' }))
    await shuttingDown
  })

  it('rejects malformed input and untrusted vector responses', async () => {
    const transport = new TestTransport()
    const broker = new EmbeddingInferenceBroker({
      createTransport: () => transport
    })

    await expect(broker.embed([], 'document')).rejects.toThrow(
      'texts must contain'
    )
    const pending = broker.embed(['safe input'], 'document')
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
    const request = embedRequest(transport)
    transport.receive(
      response({
        type: 'result',
        requestId: request.requestId,
        vectors: [[0, 0]]
      })
    )

    await expect(pending).rejects.toMatchObject({
      code: 'PROTOCOL_VIOLATION'
    })
    expect(transport.close).toHaveBeenCalledOnce()
  })

  it('propagates cancellation and timeout without accepting late results', async () => {
    vi.useFakeTimers()
    try {
      const transport = new TestTransport()
      const broker = new EmbeddingInferenceBroker({
        createTransport: () => transport,
        timeoutMs: 100
      })
      const controller = new AbortController()
      const cancelled = broker.embed(
        ['cancel this'],
        'query',
        controller.signal
      )
      await vi.advanceTimersByTimeAsync(0)
      const cancelledRequest = embedRequest(transport)
      controller.abort()
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
      expect(transport.sent.at(-1)).toMatchObject({
        type: 'cancel',
        requestId: cancelledRequest.requestId
      })

      transport.receive(
        response({
          type: 'error',
          requestId: cancelledRequest.requestId,
          code: 'CANCELLED',
          message: 'Embedding inference was cancelled'
        })
      )
      expect(transport.close).not.toHaveBeenCalled()

      const timedOut = broker.embed(['time this'], 'document')
      await vi.advanceTimersByTimeAsync(0)
      const timedRequest = transport.sent.find(
        (item) =>
          item.type === 'embed' &&
          item.requestId !== cancelledRequest.requestId
      )
      if (!timedRequest || timedRequest.type !== 'embed') {
        throw new Error('No second embed request was sent')
      }
      const timedOutExpectation = expect(timedOut).rejects.toMatchObject({
        name: 'TimeoutError'
      })
      await vi.advanceTimersByTimeAsync(100)
      await timedOutExpectation
      expect(transport.sent.at(-1)).toMatchObject({
        type: 'cancel',
        requestId: timedRequest.requestId
      })
      const shuttingDown = broker.shutdown()
      transport.receive(response({ type: 'shutdown-complete' }))
      await shuttingDown
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects on process close and enforces its lifetime restart bound', async () => {
    const transports = [
      new TestTransport(),
      new TestTransport(),
      new TestTransport()
    ]
    const factory = vi.fn(() => {
      const transport = transports[factory.mock.calls.length - 1]
      if (!transport) {
        throw new Error('unexpected restart')
      }
      return transport
    })
    const broker = new EmbeddingInferenceBroker({
      createTransport: factory,
      maxRestarts: 1
    })

    const first = broker.embed(['first'], 'query')
    await vi.waitFor(() => expect(transports[0]?.sent).toHaveLength(1))
    transports[0]?.crash()
    await expect(first).rejects.toMatchObject({ code: 'PROCESS_CLOSED' })

    const second = broker.embed(['second'], 'document')
    await vi.waitFor(() => expect(transports[1]?.sent).toHaveLength(1))
    transports[1]?.crash()
    await expect(second).rejects.toMatchObject({ code: 'PROCESS_CLOSED' })

    await expect(broker.embed(['third'], 'query')).rejects.toMatchObject({
      code: 'RESTART_LIMIT'
    })
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('performs graceful shutdown and rejects future work', async () => {
    const transport = new TestTransport()
    const broker = new EmbeddingInferenceBroker({
      createTransport: () => transport
    })
    const pending = broker.embed(['active'], 'query')
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))

    const shuttingDown = broker.shutdown()
    await expect(pending).rejects.toMatchObject({ code: 'CLOSED' })
    expect(transport.sent.at(-1)).toMatchObject({ type: 'shutdown' })
    transport.receive(response({ type: 'shutdown-complete' }))
    await expect(shuttingDown).resolves.toBeUndefined()
    expect(transport.close).toHaveBeenCalledOnce()
    await expect(broker.embed(['late'], 'query')).rejects.toMatchObject({
      code: 'CLOSED'
    })
  })
})
