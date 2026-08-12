import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '../shared/ipc-channels'
import { DocumentOcrBroker } from './document-ocr-broker'

function request() {
  return {
    modelId: 'pp-ocrv6-tiny',
    fileName: 'scan.pdf',
    mimeType: 'application/pdf' as const,
    data: new ArrayBuffer(8),
    maximumPages: 10,
    pageNumbers: [1],
    pageTimeoutSeconds: 60
  }
}

describe('DocumentOcrBroker', () => {
  it('forwards an AbortSignal cancellation to the renderer', async () => {
    const send = vi.fn()
    const broker = new DocumentOcrBroker({
      isDestroyed: vi.fn(() => false),
      webContents: { send }
    } as never)
    const controller = new AbortController()
    const result = broker.recognize(request(), controller.signal)
    const ocrRequest = send.mock.calls.find(
      ([channel]) => channel === ipcChannels.documentParsingOcrRequest
    )?.[1] as { requestId: string }

    controller.abort()

    await expect(result).rejects.toThrow('OCR 解析已取消')
    expect(send).toHaveBeenCalledWith(
      ipcChannels.documentParsingOcrCancel,
      ocrRequest.requestId
    )
    broker.dispose()
  })

  it('rejects a request that is already cancelled', () => {
    const broker = new DocumentOcrBroker({
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() }
    } as never)
    const controller = new AbortController()
    controller.abort()

    expect(() =>
      broker.recognize(request(), controller.signal)
    ).toThrow('OCR 解析已取消')
    broker.dispose()
  })

  it('rejects requests whose selected OCR pages exceed the limit', () => {
    const broker = new DocumentOcrBroker({
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() }
    } as never)

    expect(() =>
      broker.recognize({
        ...request(),
        maximumPages: 1,
        pageNumbers: [1, 2]
      })
    ).toThrow('OCR 页数超过当前文档限制')
    broker.dispose()
  })

  it('queues OCR requests and starts timeout accounting on dispatch', async () => {
    const send = vi.fn()
    const broker = new DocumentOcrBroker({
      isDestroyed: vi.fn(() => false),
      webContents: { send }
    } as never)
    const first = broker.recognize(request())
    const second = broker.recognize({
      ...request(),
      fileName: 'second.pdf'
    })
    const requests = send.mock.calls.filter(
      ([channel]) => channel === ipcChannels.documentParsingOcrRequest
    )

    expect(requests).toHaveLength(1)
    const firstRequest = requests[0]?.[1] as {
      requestId: string
    }
    broker.respond({
      requestId: firstRequest.requestId,
      sections: [],
      pageCount: 1,
      warnings: []
    })
    await expect(first).resolves.toEqual(
      expect.objectContaining({ requestId: firstRequest.requestId })
    )

    const dispatched = send.mock.calls.filter(
      ([channel]) => channel === ipcChannels.documentParsingOcrRequest
    )
    expect(dispatched).toHaveLength(2)
    const secondRequest = dispatched[1]?.[1] as {
      requestId: string
    }
    broker.respond({
      requestId: secondRequest.requestId,
      sections: [],
      pageCount: 1,
      warnings: []
    })
    await expect(second).resolves.toEqual(
      expect.objectContaining({ requestId: secondRequest.requestId })
    )
    broker.dispose()
  })

  it('cancels a queued request without interrupting the active request', async () => {
    const send = vi.fn()
    const broker = new DocumentOcrBroker({
      isDestroyed: vi.fn(() => false),
      webContents: { send }
    } as never)
    const active = broker.recognize(request())
    const controller = new AbortController()
    const queued = broker.recognize(
      { ...request(), fileName: 'queued.pdf' },
      controller.signal
    )

    controller.abort()

    await expect(queued).rejects.toThrow('OCR 解析已取消')
    expect(
      send.mock.calls.filter(
        ([channel]) => channel === ipcChannels.documentParsingOcrCancel
      )
    ).toHaveLength(0)
    broker.dispose()
    await expect(active).rejects.toThrow('OCR 解析已取消')
  })
})
