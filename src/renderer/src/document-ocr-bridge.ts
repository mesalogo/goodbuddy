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
let workerLoaded = false
let workerError: string | undefined
let managementLoading = false
let startupTimer: number | undefined
let workerModelId: string | undefined
let workerReady: Promise<void> | undefined
let resolveWorkerReady: (() => void) | undefined
let rejectWorkerReady: ((error: Error) => void) | undefined
const pending = new Map<string, PendingWorkerRequest>()
const cancelledRequestIds = new Set<string>()
let activeRequestId: string | undefined
let requestQueue: Promise<void> = Promise.resolve()
let queuedRequestCount = 0
let idleTimer: number | undefined
const workerIdleTimeoutMs = 60_000

function clearIdleTimer(): void {
  window.clearTimeout(idleTimer)
  idleTimer = undefined
}

function scheduleIdleRelease(): void {
  clearIdleTimer()
  if (!worker || queuedRequestCount > 0 || activeRequestId || pending.size > 0) {
    return
  }
  idleTimer = window.setTimeout(() => {
    if (queuedRequestCount === 0 && !activeRequestId && pending.size === 0) {
      terminateWorker(new Error('本地 OCR 空闲资源已释放'))
    }
  }, workerIdleTimeoutMs)
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : '本地 OCR 解析失败'
}

function terminateWorker(error: Error): void {
  clearIdleTimer()
  window.clearTimeout(startupTimer)
  startupTimer = undefined
  worker?.terminate()
  rejectWorkerReady?.(error)
  worker = undefined
  workerLoaded = false
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
  workerModelId = modelId
  workerReady = new Promise<void>((resolve, reject) => {
    resolveWorkerReady = resolve
    rejectWorkerReady = reject
  })
  const ready = workerReady
  void ready.catch(() => undefined)
  // A worker that never becomes ready must not leave manual loading locked forever.
  startupTimer = window.setTimeout(() => {
    workerError = '本地 OCR 模型加载超时，请重试'
    terminateWorker(new Error(workerError))
  }, 120_000)
  worker.addEventListener(
    'message',
    (event: MessageEvent<WorkerOutput>) => {
      const output = event.data
      if (output.type === 'ready') {
        window.clearTimeout(startupTimer)
        startupTimer = undefined
        workerLoaded = true
        workerError = undefined
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
    workerError = event.message || '本地 OCR Worker 异常'
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
    await ready
  } catch (error) {
    workerError = safeError(error)
    terminateWorker(
      error instanceof Error ? error : new Error('本地 OCR 初始化失败')
    )
    throw error
  }
  return worker
}

export function getOcrInferenceState(): {
  state: 'idle' | 'running' | 'starting' | 'error'
  model?: string
  busy: boolean
  loaded: boolean
  error?: string
} {
  return {
    state: worker ? workerLoaded ? 'running' : 'starting' : workerError ? 'error' : 'idle',
    model: workerModelId, loaded: workerLoaded,
    busy: managementLoading || queuedRequestCount > 0 || Boolean(activeRequestId) || pending.size > 0,
    error: workerError
  }
}

export async function loadOcrInference(): Promise<void> {
  if (getOcrInferenceState().busy) throw new Error('OCR 正在处理任务，请等待完成后再加载')
  managementLoading = true
  try {
    const snapshot = await window.goodbuddy.documentParsing?.getSnapshot()
    if (!snapshot) throw new Error('文档解析服务不可用')
    if (!snapshot.status.localOcr.available) throw new Error(snapshot.status.localOcr.detail)
    await ensureWorker(snapshot.settings.localOcrModelId)
  } finally {
    managementLoading = false
    scheduleIdleRelease()
  }
}

export function releaseOcrInference(): void {
  if (getOcrInferenceState().busy) throw new Error('OCR 仍有活动或排队任务，无法释放共享 Worker；请等待任务结束')
  terminateWorker(new Error('用户已释放 OCR 模型'))
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
    clearIdleTimer()
    queuedRequestCount += 1
    requestQueue = requestQueue
      .then(() => handleRequest(request))
      .catch(() => undefined)
      .finally(() => {
        queuedRequestCount -= 1
        scheduleIdleRelease()
      })
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
