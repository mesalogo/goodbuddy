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
  request: DocumentOcrRequest
  resolve: (result: DocumentOcrResult) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  timeoutMs: number
  detachAbort: () => void
  dispatched: boolean
}

const maximumPendingRequests = 4
const maximumTotalTimeoutMs = 10 * 60 * 1_000
const workerStartupTimeoutMs = 60 * 1_000

export class DocumentOcrBroker {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly queue: string[] = []
  private activeRequestId?: string
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
    const pageCount =
      request.pageNumbers?.length ?? request.maximumPages
    const timeoutMs = Math.min(
      maximumTotalTimeoutMs,
      Math.max(
        request.pageTimeoutSeconds * 1_000,
        workerStartupTimeoutMs +
          request.pageTimeoutSeconds *
            pageCount *
            1_000
      )
    )
    return new Promise<DocumentOcrResult>((resolve, reject) => {
      const onAbort = (): void =>
        this.cancelRequest(request.requestId, 'OCR 解析已取消')
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(request.requestId, {
        request,
        resolve,
        reject,
        timeoutMs,
        detachAbort: () =>
          signal?.removeEventListener('abort', onAbort),
        dispatched: false
      })
      this.queue.push(request.requestId)
      if (signal?.aborted) {
        this.cancelRequest(request.requestId, 'OCR 解析已取消')
        return
      }
      this.dispatchNext()
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
    if (!pending || !pending.dispatched) {
      return
    }
    if (result.success) {
      if (
        pending.request.mimeType === 'application/pdf' &&
        result.data.sections.some(
          (section) =>
            section.pageNumber === undefined ||
            section.pageNumber > result.data.pageCount ||
            (
              pending.request.pageNumbers !== undefined &&
              !pending.request.pageNumbers.includes(section.pageNumber)
            )
        )
      ) {
        this.finishRequest(requestId, () =>
          pending.reject(new Error('OCR 响应页码无效'))
        )
        return
      }
      this.finishRequest(requestId, () =>
        pending.resolve(result.data)
      )
    } else {
      if (!failure?.success) {
        this.finishRequest(requestId, () =>
          pending.reject(new Error('OCR 响应无效'))
        )
        return
      }
      this.finishRequest(requestId, () =>
        pending.reject(new Error(failure.data.error))
      )
    }
  }

  dispose(): void {
    this.disposed = true
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      pending.detachAbort()
      pending.reject(new Error('OCR 解析已取消'))
    }
    this.pending.clear()
    this.queue.length = 0
    this.activeRequestId = undefined
  }

  private dispatchNext(): void {
    if (
      this.disposed ||
      this.activeRequestId ||
      this.window.isDestroyed()
    ) {
      return
    }
    let requestId = this.queue.shift()
    while (requestId && !this.pending.has(requestId)) {
      requestId = this.queue.shift()
    }
    if (!requestId) {
      return
    }
    const pending = this.pending.get(requestId)
    if (!pending) {
      return
    }
    this.activeRequestId = requestId
    pending.dispatched = true
    pending.timer = setTimeout(() => {
      this.cancelRequest(requestId, 'OCR 解析超时')
    }, pending.timeoutMs)
    try {
      this.window.webContents.send(
        ipcChannels.documentParsingOcrRequest,
        pending.request
      )
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'OCR 渲染服务不可用'
      this.finishRequest(requestId, () =>
        pending.reject(new Error(detail))
      )
    }
  }

  private cancelRequest(requestId: string, message: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) {
      return
    }
    if (pending.dispatched && !this.window.isDestroyed()) {
      this.window.webContents.send(
        ipcChannels.documentParsingOcrCancel,
        requestId
      )
    }
    this.finishRequest(requestId, () =>
      pending.reject(new Error(message))
    )
  }

  private finishRequest(
    requestId: string,
    settle: () => void
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending) {
      return
    }
    if (pending.timer) {
      clearTimeout(pending.timer)
    }
    pending.detachAbort()
    this.pending.delete(requestId)
    if (this.activeRequestId === requestId) {
      this.activeRequestId = undefined
    }
    settle()
    this.dispatchNext()
  }
}
