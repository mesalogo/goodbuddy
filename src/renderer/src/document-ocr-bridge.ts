import type {
  DocumentOcrFailure,
  DocumentOcrRequest,
  DocumentOcrResult
} from '../../shared/document-parsing-contracts'

type WorkerOutput =
  | { type: 'ready' }
  | { type: 'progress'; requestId: string; pageNumber?: number }
  | { type: 'result'; result: DocumentOcrResult }
  | { type: 'error'; requestId?: string; error: string }

type PendingWorkerRequest = {
  resolve: (result: DocumentOcrResult) => void
  reject: (error: Error) => void
  timer: number
  timeoutMs: number
}

let worker: Worker | undefined
let workerModelId: string | undefined
let workerReady: Promise<void> | undefined
let resolveWorkerReady: (() => void) | undefined
let rejectWorkerReady: ((error: Error) => void) | undefined
const pending = new Map<string, PendingWorkerRequest>()
const cancelledRequestIds = new Set<string>()
let activeRequestId: string | undefined
let requestQueue: Promise<void> = Promise.resolve()

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : '本地 OCR 解析失败'
}

function terminateWorker(error: Error): void {
  worker?.terminate()
  rejectWorkerReady?.(error)
  worker = undefined
  workerModelId = undefined
  workerReady = undefined
  resolveWorkerReady = undefined
  rejectWorkerReady = undefined
  for (const request of pending.values()) {
    window.clearTimeout(request.timer)
    request.reject(error)
  }
  pending.clear()
}

function armPageTimeout(
  requestId: string,
  request: PendingWorkerRequest
): void {
  window.clearTimeout(request.timer)
  request.timer = window.setTimeout(() => {
    pending.delete(requestId)
    terminateWorker(new Error('单页 OCR 解析超时'))
    request.reject(new Error('单页 OCR 解析超时'))
  }, request.timeoutMs)
}

async function ensureWorker(modelId: string): Promise<Worker> {
  if (worker && workerReady && workerModelId === modelId) {
    await workerReady
    return worker
  }
  if (worker) {
    terminateWorker(new Error('本地 OCR 模型已切换'))
  }
  const api = window.goodbuddy.documentParsing
  if (!api) {
    throw new Error('文档解析服务不可用')
  }
  worker = new Worker(
    new URL('./document-ocr-worker.ts', import.meta.url),
    { type: 'module', name: 'goodbuddy-document-ocr' }
  )
  workerReady = new Promise<void>((resolve, reject) => {
    resolveWorkerReady = resolve
    rejectWorkerReady = reject
  })
  worker.addEventListener(
    'message',
    (event: MessageEvent<WorkerOutput>) => {
      const output = event.data
      if (output.type === 'ready') {
        resolveWorkerReady?.()
        return
      }
      if (output.type === 'progress') {
        const request = pending.get(output.requestId)
        if (request) {
          armPageTimeout(output.requestId, request)
        }
        return
      }
      if (output.type === 'error' && !output.requestId) {
        rejectWorkerReady?.(new Error(output.error))
        return
      }
      const requestId =
        output.type === 'result'
          ? output.result.requestId
          : output.requestId
      if (!requestId) {
        return
      }
      const request = pending.get(requestId)
      if (!request) {
        return
      }
      window.clearTimeout(request.timer)
      pending.delete(requestId)
      if (output.type === 'result') {
        request.resolve(output.result)
      } else {
        request.reject(new Error(output.error))
      }
    }
  )
  worker.addEventListener('error', (event) => {
    terminateWorker(
      new Error(event.message || '本地 OCR Worker 异常')
    )
  })
  try {
    const assets = await api.getOcrAssets(modelId)
    if (assets.modelId !== modelId) {
      throw new Error('本地 OCR 模型与请求不匹配')
    }
    workerModelId = modelId
    worker.postMessage(
      { type: 'initialize', assets },
      [
        assets.detection,
        assets.recognition,
        assets.dictionary
      ]
    )
    await workerReady
  } catch (error) {
    terminateWorker(
      error instanceof Error ? error : new Error('本地 OCR 初始化失败')
    )
    throw error
  }
  return worker
}

async function recognize(
  request: DocumentOcrRequest
): Promise<DocumentOcrResult> {
  const activeWorker = await ensureWorker(request.modelId)
  if (cancelledRequestIds.has(request.requestId)) {
    throw new Error('本地 OCR 解析已取消')
  }
  const timeoutMs = request.pageTimeoutSeconds * 1_000
  return new Promise<DocumentOcrResult>((resolve, reject) => {
    const workerRequest = {
      resolve,
      reject,
      timer: 0,
      timeoutMs
    }
    pending.set(request.requestId, workerRequest)
    armPageTimeout(request.requestId, workerRequest)
    activeWorker.postMessage(
      { type: 'recognize', request },
      [request.data]
    )
  })
}

async function handleRequest(request: DocumentOcrRequest): Promise<void> {
  const api = window.goodbuddy.documentParsing
  if (!api || cancelledRequestIds.has(request.requestId)) {
    cancelledRequestIds.delete(request.requestId)
    return
  }
  activeRequestId = request.requestId
  try {
    await api.respondOcr(await recognize(request))
  } catch (error) {
    const failure: DocumentOcrFailure = {
      requestId: request.requestId,
      error: safeError(error)
    }
    await api.respondOcr(failure).catch(() => undefined)
  } finally {
    activeRequestId = undefined
    cancelledRequestIds.delete(request.requestId)
  }
}

export function installDocumentOcrBridge(): () => void {
  const api = window.goodbuddy.documentParsing
  if (!api) {
    return () => undefined
  }
  const removeRequestListener = api.onOcrRequest((request) => {
    requestQueue = requestQueue
      .then(() => handleRequest(request))
      .catch(() => undefined)
  })
  const removeCancelListener = api.onOcrCancel((requestId) => {
    cancelledRequestIds.add(requestId)
    if (activeRequestId === requestId) {
      terminateWorker(new Error('本地 OCR 解析已取消'))
    }
  })
  return () => {
    removeRequestListener()
    removeCancelListener()
    cancelledRequestIds.clear()
    activeRequestId = undefined
    terminateWorker(new Error('本地 OCR 服务已关闭'))
  }
}
