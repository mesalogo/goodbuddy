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
})
