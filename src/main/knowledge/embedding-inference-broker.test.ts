import { describe, expect, it, vi } from 'vitest'
import { localInferenceService } from '../local-inference-service'
import { EmbeddingInferenceWorker } from './embedding-inference-worker'
import {
  EMBEDDING_INFERENCE_MAX_IN_FLIGHT,
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
  it('drops exited process resources and uses the replacement transport after restart', async () => {
    const first = new TestTransport()
    const second = new TestTransport()
    const resourceTransport = (transport: TestTransport, pid: number): EmbeddingInferenceTransport => Object.assign(transport, {
      getResources: () => ({ scope: 'service-process' as const, pid, sampledAt: 1, workingSetBytes: 1024 })
    })
    const factory = vi.fn().mockReturnValueOnce(resourceTransport(first, 42)).mockReturnValueOnce(resourceTransport(second, 43))
    const broker = new EmbeddingInferenceBroker({ createTransport: factory })
    expect(broker.getResources()).toMatchObject({ scope: 'unavailable' })
    await broker.start()
    expect(broker.getResources()).toMatchObject({ pid: 42 })
    first.crash()
    expect(broker.getResources()).toMatchObject({ scope: 'unavailable' })
    await broker.start()
    expect(broker.getResources()).toMatchObject({ pid: 43 })
    await broker.stop()
    expect(broker.getResources()).toMatchObject({ scope: 'unavailable' })
  })

  it('keeps source-cancelled computation in stop impact until the worker returns', async () => {
    const transport = new TestTransport()
    let finish!: (vectors: number[][]) => void
    let workerSignal!: AbortSignal
    const engine = {
      tokenizer: { tokenize: vi.fn() },
      onnx: { run: vi.fn() },
      embed: vi.fn(({ signal }: { signal: AbortSignal }) => {
        workerSignal = signal
        return new Promise<number[][]>((resolve) => { finish = resolve })
      })
    }
    const worker = new EmbeddingInferenceWorker({
      modelDirectory: process.cwd(), engine,
      port: {
        postMessage: (message) => transport.receive(message),
        onMessage: (listener) => {
          const spy = vi.spyOn(transport, 'postMessage').mockImplementation((message) => {
            transport.sent.push(message)
            listener(message)
          })
          return () => spy.mockRestore()
        }
      }
    })
    const broker = new EmbeddingInferenceBroker({ createTransport: () => transport })
    const act = vi.fn(async () => undefined)
    const unregister = localInferenceService.register('embedding', {
      snapshot: () => ({ id: 'embedding', name: 'Embedding', engine: 'ONNX', detail: '', ownership: 'managed-process', state: 'running', actions: ['stop', 'restart'] }),
      act
    })
    try {
      const controller = new AbortController()
      const pending = broker.embed(['delayed computation'], 'query', controller.signal)
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => expect(engine.embed).toHaveBeenCalledOnce())
      const task = (await localInferenceService.snapshot()).tasks.find((entry) => entry.serviceId === 'embedding' && entry.finishedAt === undefined)!
      controller.abort()
      await rejection
      expect(workerSignal.aborted).toBe(true)
      const activeTask = (await localInferenceService.snapshot()).tasks.find((entry) => entry.id === task.id)!
      expect(activeTask.state).toBe('cancelling')
      expect(activeTask.finishedAt).toBeUndefined()
      await expect(localInferenceService.act({ serviceId: 'embedding', action: 'stop', confirmedTaskIds: [] })).rejects.toThrow('任务已变化')
      await expect(localInferenceService.act({ serviceId: 'embedding', action: 'restart', confirmedTaskIds: [] })).rejects.toThrow('任务已变化')
      localInferenceService.cancel(task.id)
      expect(transport.sent.filter((message) => message.type === 'cancel')).toHaveLength(1)
      expect(act).not.toHaveBeenCalled()
      expect(transport.close).not.toHaveBeenCalled()
      finish([[1, 2]])
      await vi.waitFor(async () => {
        expect((await localInferenceService.snapshot()).tasks.find((entry) => entry.id === task.id)).toMatchObject({ state: 'cancelled', finishedAt: expect.any(Number) })
      })
      await localInferenceService.act({ serviceId: 'embedding', action: 'stop', confirmedTaskIds: [] })
      expect(act).toHaveBeenCalledOnce()
    } finally {
      unregister()
      finish?.([[1, 2]])
      await worker.shutdown()
      await broker.stop()
    }
  })

  it.each([
    ['abort', 'acknowledgement'], ['abort', 'late result'], ['abort', 'process exit'],
    ['timeout', 'acknowledgement'], ['timeout', 'late result'], ['timeout', 'process exit']
  ] as const)('keeps execution cancelling after %s until %s', async (cause, completion) => {
    vi.useFakeTimers()
    const transport = new TestTransport()
    const broker = new EmbeddingInferenceBroker({ createTransport: () => transport, timeoutMs: 100 })
    try {
      const controller = new AbortController()
      const pending = broker.embed(['cancelled work'], 'query', controller.signal)
      const rejection = expect(pending).rejects.toMatchObject({ name: cause === 'abort' ? 'AbortError' : 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(0)
      const request = embedRequest(transport)
      const task = (await localInferenceService.snapshot()).tasks.find((entry) => entry.serviceId === 'embedding' && entry.finishedAt === undefined)!
      if (cause === 'abort') controller.abort()
      else await vi.advanceTimersByTimeAsync(100)
      await rejection
      await vi.advanceTimersByTimeAsync(10_000)
      const activeTask = (await localInferenceService.snapshot()).tasks.find((entry) => entry.id === task.id)!
      expect(activeTask.state).toBe('cancelling')
      expect(activeTask.finishedAt).toBeUndefined()
      expect(transport.close).not.toHaveBeenCalled()
      expect(transport.sent.filter((message) => message.type === 'cancel')).toHaveLength(1)
      if (completion === 'process exit') transport.crash()
      else transport.receive(response(completion === 'late result'
        ? { type: 'result', requestId: request.requestId, vectors: [[1, 2]] }
        : { type: 'error', requestId: request.requestId, code: 'CANCELLED', message: 'cancelled' }))
      await vi.advanceTimersByTimeAsync(0)
      expect((await localInferenceService.snapshot()).tasks.find((entry) => entry.id === task.id)).toMatchObject({
        state: cause === 'abort' ? 'cancelled' : 'failed',
        error: cause === 'abort' ? 'Embedding inference was cancelled' : 'Embedding inference timed out',
        finishedAt: expect.any(Number)
      })
    } finally {
      await broker.stop()
      vi.useRealTimers()
    }
  })

  it('keeps rejected work active through an unconfirmed stop until process exit', async () => {
    const transport = new TestTransport()
    transport.close.mockRejectedValue(new Error('exit not confirmed'))
    const broker = new EmbeddingInferenceBroker({ createTransport: () => transport })
    const pending = broker.embed(['still computing'], 'query')
    const rejection = expect(pending).rejects.toThrow('停止')
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
    const task = (await localInferenceService.snapshot()).tasks.find((entry) => entry.serviceId === 'embedding' && entry.finishedAt === undefined)!
    await expect(broker.stop()).rejects.toThrow('exit not confirmed')
    await rejection
    expect((await localInferenceService.snapshot()).tasks.find((entry) => entry.id === task.id)?.finishedAt).toBeUndefined()
    transport.crash()
    await vi.waitFor(async () => {
      expect((await localInferenceService.snapshot()).tasks.find((entry) => entry.id === task.id)).toMatchObject({ state: 'failed', finishedAt: expect.any(Number) })
    })
  })

  it('keeps cancelled requests within the in-flight bound until acknowledgement', async () => {
    const transport = new TestTransport()
    const broker = new EmbeddingInferenceBroker({ createTransport: () => transport })
    const controller = new AbortController()
    try {
      const callers = Array.from({ length: EMBEDDING_INFERENCE_MAX_IN_FLIGHT }, () =>
        expect(broker.embed(['pending'], 'query', controller.signal)).rejects.toMatchObject({ name: 'AbortError' }))
      await vi.waitFor(() => expect(transport.sent).toHaveLength(EMBEDDING_INFERENCE_MAX_IN_FLIGHT))
      controller.abort()
      await Promise.all(callers)
      await expect(broker.embed(['over capacity'], 'query')).rejects.toMatchObject({ code: 'OVERLOADED' })
      for (const request of transport.sent.filter((message) => message.type === 'embed')) {
        transport.receive(response({ type: 'error', requestId: request.requestId, code: 'CANCELLED', message: 'cancelled' }))
      }
      const next = broker.embed(['capacity released'], 'query')
      await vi.waitFor(() => expect(transport.sent.at(-1)?.type).toBe('embed'))
      const request = transport.sent.at(-1)!
      if (request.type !== 'embed') throw new Error('No next embed request was sent')
      transport.receive(response({ type: 'result', requestId: request.requestId, vectors: [[1, 2]] }))
      await expect(next).resolves.toEqual([[1, 2]])
    } finally {
      await broker.stop()
    }
  })

  it('keeps execution active after shutdown grace and close timeout until process exit', async () => {
    vi.useFakeTimers()
    const transport = new TestTransport()
    transport.close.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error('exit not confirmed')), 5000)
    }))
    const broker = new EmbeddingInferenceBroker({ createTransport: () => transport })
    try {
      const controller = new AbortController()
      const rejection = expect(broker.embed(['still computing'], 'query', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(0)
      const task = (await localInferenceService.snapshot()).tasks.find((entry) => entry.serviceId === 'embedding' && entry.finishedAt === undefined)!
      controller.abort()
      await rejection
      const shutdown = broker.shutdown()
      await vi.advanceTimersByTimeAsync(1000)
      await shutdown
      expect(transport.close).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(5000)
      expect(broker.getManagementError()).toBe('exit not confirmed')
      const activeTask = (await localInferenceService.snapshot()).tasks.find((entry) => entry.id === task.id)!
      expect(activeTask.state).toBe('cancelling')
      expect(activeTask.finishedAt).toBeUndefined()
      transport.crash()
      await vi.advanceTimersByTimeAsync(0)
      expect((await localInferenceService.snapshot()).tasks.find((entry) => entry.id === task.id)).toMatchObject({ state: 'cancelled', finishedAt: expect.any(Number) })
    } finally {
      transport.crash()
      vi.useRealTimers()
    }
  })

  it('retains a live transport and reports a failed stop instead of claiming stopped', async () => {
    const transport: EmbeddingInferenceTransport = {
      postMessage: vi.fn(), onMessage: () => () => undefined, onClose: () => () => undefined,
      close: vi.fn(async () => { throw new Error('exit not confirmed') })
    }
    const broker = new EmbeddingInferenceBroker({ createTransport: () => transport })
    await broker.start()
    await expect(broker.stop()).rejects.toThrow('exit not confirmed')
    expect(broker.getManagementState()).toBe('running')
    expect(broker.getManagementError()).toBe('exit not confirmed')
  })

  it('reports startup failures and supports an explicit retry', async () => {
    const factory = vi.fn().mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValue(new TestTransport())
    const broker = new EmbeddingInferenceBroker({ createTransport: factory })
    await expect(broker.start()).rejects.toThrow('START_FAILURE')
    expect(broker.getManagementState()).toBe('error')
    await broker.start()
    expect(broker.getManagementState()).toBe('running')
    expect(broker.getManagementError()).toBeUndefined()
    await broker.stop()
  })
  it('management cancellation waits for worker acknowledgement without closing shared transport', async () => {
    const transport = new TestTransport()
    const broker = new EmbeddingInferenceBroker({ createTransport: () => transport })
    const pending = broker.embed(['cancel this'], 'query')
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
    const request = embedRequest(transport)
    const task = (await localInferenceService.snapshot()).tasks.find((entry) => entry.serviceId === 'embedding' && entry.finishedAt === undefined)!
    localInferenceService.cancel(task.id)
    expect((await localInferenceService.snapshot()).tasks.find((entry) => entry.id === task.id)?.state).toBe('cancelling')
    expect(transport.close).not.toHaveBeenCalled()
    transport.receive(response({ type: 'error', requestId: request.requestId, code: 'CANCELLED', message: 'cancelled' }))
    await rejection
    expect((await localInferenceService.snapshot()).tasks.find((entry) => entry.id === task.id)?.state).toBe('cancelled')
    await broker.stop()
  })

  it('stops shared execution, rejects work until explicitly started, and never replays', async () => {
    const transports: TestTransport[] = []
    const broker = new EmbeddingInferenceBroker({ createTransport: () => { const transport = new TestTransport(); transports.push(transport); return transport } })
    const pending = broker.embed(['interrupted'], 'document')
    const rejection = expect(pending).rejects.toThrow('停止')
    await vi.waitFor(() => expect(transports[0]?.sent).toHaveLength(1))
    await broker.stop()
    await rejection
    expect(transports[0]!.close).toHaveBeenCalledOnce()
    await expect(broker.embed(['blocked'], 'query')).rejects.toMatchObject({ code: 'CLOSED' })
    await broker.start()
    expect(transports).toHaveLength(2)
    expect(transports[1]!.sent).toEqual([])
    await broker.stop()
  })
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
