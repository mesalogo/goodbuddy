import type { BrowserWindow } from 'electron'
import { ipcChannels } from '../shared/ipc-channels'
import {
  documentOcrFailureSchema,
  documentOcrRequestSchema,
  documentOcrResultSchema,
  type DocumentOcrRequest,
  type DocumentOcrResult
} from '../shared/document-parsing-contracts'

type PendingRequest = {
  resolve: (result: DocumentOcrResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  detachAbort: () => void
}

const maximumPendingRequests = 4
const maximumTotalTimeoutMs = 10 * 60 * 1_000

export class DocumentOcrBroker {
  private readonly pending = new Map<string, PendingRequest>()
  private disposed = false

  constructor(private readonly window: BrowserWindow) {}

  recognize(
    input: Omit<DocumentOcrRequest, 'requestId'>,
    signal?: AbortSignal
  ): Promise<DocumentOcrResult> {
    if (this.disposed || this.window.isDestroyed()) {
      throw new Error('OCR 渲染服务不可用')
    }
    if (this.pending.size >= maximumPendingRequests) {
      throw new Error('OCR 任务过多，请稍后重试')
    }
    const request = documentOcrRequestSchema.parse({
      ...input,
      requestId: crypto.randomUUID()
    })
    if (signal?.aborted) {
      throw new Error('OCR 解析已取消')
    }
    const timeoutMs = Math.min(
      maximumTotalTimeoutMs,
      Math.max(
        request.pageTimeoutSeconds * 1_000,
        request.pageTimeoutSeconds *
          request.maximumPages *
          1_000
      )
    )
    return new Promise<DocumentOcrResult>((resolve, reject) => {
      const cancel = (message: string): void => {
        const pending = this.pending.get(request.requestId)
        if (!pending) {
          return
        }
        clearTimeout(pending.timer)
        pending.detachAbort()
        this.pending.delete(request.requestId)
        this.window.webContents.send(
          ipcChannels.documentParsingOcrCancel,
          request.requestId
        )
        reject(new Error(message))
      }
      const timer = setTimeout(() => {
        cancel('OCR 解析超时')
      }, timeoutMs)
      const onAbort = (): void => cancel('OCR 解析已取消')
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(request.requestId, {
        resolve,
        reject,
        timer,
        detachAbort: () =>
          signal?.removeEventListener('abort', onAbort)
      })
      if (signal?.aborted) {
        cancel('OCR 解析已取消')
        return
      }
      this.window.webContents.send(
        ipcChannels.documentParsingOcrRequest,
        request
      )
    })
  }

  respond(input: unknown): void {
    const result = documentOcrResultSchema.safeParse(input)
    const failure = result.success
      ? undefined
      : documentOcrFailureSchema.safeParse(input)
    const requestId = result.success
      ? result.data.requestId
      : failure?.success
        ? failure.data.requestId
        : undefined
    if (!requestId) {
      throw new Error('OCR 响应无效')
    }
    const pending = this.pending.get(requestId)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    pending.detachAbort()
    this.pending.delete(requestId)
    if (result.success) {
      pending.resolve(result.data)
    } else {
      if (!failure?.success) {
        pending.reject(new Error('OCR 响应无效'))
        return
      }
      pending.reject(new Error(failure.data.error))
    }
  }

  dispose(): void {
    this.disposed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.detachAbort()
      pending.reject(new Error('OCR 解析已取消'))
    }
    this.pending.clear()
  }
}
