import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentOcrRequest } from '../../shared/document-parsing-contracts'

class TestWorker extends EventTarget {
  static instances: TestWorker[] = []
  terminate = vi.fn()
  postMessage = vi.fn((message: { type: string }) => {
    if (message.type === 'initialize') {
      this.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' } }))
    }
  })

  constructor() {
    super()
    TestWorker.instances.push(this)
  }

  finish(requestId: string): void {
    this.dispatchEvent(new MessageEvent('message', {
      data: { type: 'result', result: { requestId, sections: [], pageCount: 1, warnings: [] } }
    }))
  }
}

function request(): DocumentOcrRequest {
  return {
    requestId: crypto.randomUUID(),
    modelId: 'pp-ocrv6-tiny',
    fileName: 'scan.png',
    mimeType: 'image/png',
    data: new ArrayBuffer(1),
    maximumPages: 1,
    pageTimeoutSeconds: 300
  }
}

let dispose: (() => void) | undefined

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  TestWorker.instances = []
  vi.stubGlobal('Worker', TestWorker)
})

afterEach(async () => {
  dispose?.()
  dispose = undefined
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function setup() {
  let receive!: (request: DocumentOcrRequest) => void
  let cancel!: (requestId: string) => void
  const getOcrAssets = vi.fn(async (modelId: string) => ({
    modelId, detection: new ArrayBuffer(1), recognition: new ArrayBuffer(1), dictionary: new ArrayBuffer(1)
  }))
  const respondOcr = vi.fn(async () => undefined)
  const removeRequest = vi.fn()
  const removeCancel = vi.fn()
  vi.stubGlobal('goodbuddy', {
    documentParsing: {
      getOcrAssets, respondOcr,
      onOcrRequest: (listener: typeof receive) => { receive = listener; return removeRequest },
      onOcrCancel: (listener: typeof cancel) => { cancel = listener; return removeCancel }
    }
  })
  const { installDocumentOcrBridge } = await import('./document-ocr-bridge')
  dispose = installDocumentOcrBridge()
  const start = async () => {
    const input = request()
    receive(input)
    await vi.advanceTimersByTimeAsync(0)
    return input
  }
  const finish = async (input: DocumentOcrRequest) => {
    TestWorker.instances.at(-1)!.finish(input.requestId)
    await vi.advanceTimersByTimeAsync(0)
  }
  return { start, finish, receive, cancel, getOcrAssets, respondOcr, removeRequest, removeCancel }
}

describe('document OCR worker idle release', () => {
  it('releases after 60 idle seconds and reloads the model for the next request', async () => {
    const api = await setup()
    const input = await api.start()
    const worker = TestWorker.instances[0]!
    await api.finish(input)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(worker.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(worker.terminate).toHaveBeenCalledOnce()
    const next = await api.start()
    expect(TestWorker.instances).toHaveLength(2)
    expect(api.getOcrAssets).toHaveBeenCalledTimes(2)
    await api.finish(next)
  })

  it('cancels the idle timer for new work and reuses the loaded worker', async () => {
    const api = await setup()
    await api.finish(await api.start())
    await vi.advanceTimersByTimeAsync(59_000)
    const next = await api.start()
    const worker = TestWorker.instances[0]!
    await vi.advanceTimersByTimeAsync(61_000)
    expect(worker.terminate).not.toHaveBeenCalled()
    expect(api.getOcrAssets).toHaveBeenCalledOnce()
    await api.finish(next)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('does not release while a second request is queued or running', async () => {
    const api = await setup()
    const first = await api.start()
    const second = await api.start()
    const worker = TestWorker.instances[0]!
    await vi.advanceTimersByTimeAsync(61_000)
    expect(worker.terminate).not.toHaveBeenCalled()
    await api.finish(first)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(worker.terminate).not.toHaveBeenCalled()
    await api.finish(second)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(api.respondOcr).toHaveBeenCalledTimes(2)
  })

  it('clears the idle timer on disposal and removes subscriptions', async () => {
    const api = await setup()
    await api.finish(await api.start())
    const worker = TestWorker.instances[0]!
    dispose?.()
    dispose = undefined
    expect(api.removeRequest).toHaveBeenCalledOnce()
    expect(api.removeCancel).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('still terminates immediately on cancellation', async () => {
    const api = await setup()
    const input = await api.start()
    const worker = TestWorker.instances[0]!
    api.cancel(input.requestId)
    await vi.advanceTimersByTimeAsync(0)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(api.respondOcr).toHaveBeenCalledWith({
      requestId: input.requestId, error: '本地 OCR 解析已取消'
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
