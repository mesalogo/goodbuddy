/// <reference lib="webworker" />

import * as ort from 'onnxruntime-web'
import wasmModuleUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url'
import wasmBinaryUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api'
import type {
  DocumentOcrAssets,
  DocumentOcrRequest,
  DocumentOcrResult
} from '../../shared/document-parsing-contracts'

type InitializeMessage = {
  type: 'initialize'
  assets: DocumentOcrAssets
}

type RecognizeMessage = {
  type: 'recognize'
  request: DocumentOcrRequest
}

type WorkerInput = InitializeMessage | RecognizeMessage

type WorkerOutput =
  | { type: 'ready' }
  | { type: 'result'; result: DocumentOcrResult }
  | { type: 'error'; requestId?: string; error: string }

type OcrService = InstanceType<
  typeof import('ppu-paddle-ocr/web').PaddleOcrService
>

const worker = self as DedicatedWorkerGlobalScope
let service: OcrService | undefined

function absoluteAssetUrl(value: string): string {
  return new URL(value, worker.location.href).href
}

ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false
ort.env.wasm.wasmPaths = {
  mjs: absoluteAssetUrl(wasmModuleUrl),
  wasm: absoluteAssetUrl(wasmBinaryUrl)
}

function safeWorkerError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : '本地 OCR 识别失败'
}

async function initialize(assets: DocumentOcrAssets): Promise<void> {
  await service?.destroy()
  const { PaddleOcrService } = await import('ppu-paddle-ocr/web')
  service = new PaddleOcrService({
    model: {
      detection: assets.detection,
      recognition: assets.recognition,
      charactersDictionary: assets.dictionary
    },
    session: {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'disabled'
    },
    processing: {
      engine: 'canvas-native'
    },
    recognition: {
      charactersDictionary: [],
      minimumConfidence: 0.5,
      strategy: 'per-line',
      recBatchSize: 4
    },
    detection: {
      maxSideLength: 1920
    }
  })
  await service.initialize()
}

async function recognizeImage(
  data: ArrayBuffer,
  locator: string
): Promise<DocumentOcrResult['sections'][number] | undefined> {
  if (!service?.isInitialized()) {
    throw new Error('本地 OCR 模型尚未初始化')
  }
  const result = await service.recognize(data)
  const content = result.text.replace(/\n{3,}/gu, '\n\n').trim()
  return content
    ? {
        locator,
        content,
        confidence: result.confidence
      }
    : undefined
}

async function renderPdfPage(
  page: PDFPageProxy
): Promise<ArrayBuffer> {
  const baseViewport = page.getViewport({ scale: 1 })
  const scale = Math.min(
    2,
    2200 / Math.max(baseViewport.width, baseViewport.height, 1)
  )
  const viewport = page.getViewport({ scale })
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.ceil(viewport.width)),
    Math.max(1, Math.ceil(viewport.height))
  )
  const context = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true
  })
  if (!context) {
    throw new Error('无法创建 PDF 页面渲染画布')
  }
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport
  }).promise
  const blob = await canvas.convertToBlob({
    type: 'image/png'
  })
  return blob.arrayBuffer()
}

async function recognizePdf(
  request: DocumentOcrRequest
): Promise<DocumentOcrResult> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(request.data)
  })
  const document = await loadingTask.promise
  const selectedPages = new Set(
    request.pageNumbers ??
      Array.from(
        { length: Math.min(document.numPages, request.maximumPages) },
        (_, index) => index + 1
      )
  )
  if (document.numPages > request.maximumPages) {
    await loadingTask.destroy()
    throw new Error(
      `PDF 共 ${document.numPages} 页，超过 ${request.maximumPages} 页限制`
    )
  }
  const sections: DocumentOcrResult['sections'] = []
  const warnings: string[] = []
  try {
    for (
      let pageNumber = 1;
      pageNumber <= document.numPages;
      pageNumber += 1
    ) {
      if (!selectedPages.has(pageNumber)) {
        continue
      }
      const page = await document.getPage(pageNumber)
      try {
        const section = await recognizeImage(
          await renderPdfPage(page),
          `第 ${pageNumber} 页`
        )
        if (section) {
          sections.push(section)
        } else {
          warnings.push(`第 ${pageNumber} 页未识别到文字`)
        }
      } finally {
        page.cleanup()
      }
    }
  } finally {
    await loadingTask.destroy()
  }
  return {
    requestId: request.requestId,
    sections,
    pageCount: document.numPages,
    warnings
  }
}

async function recognize(request: DocumentOcrRequest): Promise<DocumentOcrResult> {
  if (request.mimeType === 'application/pdf') {
    return recognizePdf(request)
  }
  const section = await recognizeImage(request.data, '图片')
  return {
    requestId: request.requestId,
    sections: section ? [section] : [],
    pageCount: 1,
    warnings: section ? [] : ['图片中未识别到文字']
  }
}

worker.addEventListener('message', (event: MessageEvent<WorkerInput>) => {
  const input = event.data
  if (input.type === 'initialize') {
    void initialize(input.assets).then(
      () => worker.postMessage({ type: 'ready' } satisfies WorkerOutput),
      (error: unknown) =>
        worker.postMessage({
          type: 'error',
          error: safeWorkerError(error)
        } satisfies WorkerOutput)
    )
    return
  }
  void recognize(input.request).then(
    (result) =>
      worker.postMessage({
        type: 'result',
        result
      } satisfies WorkerOutput),
    (error: unknown) =>
      worker.postMessage({
        type: 'error',
        requestId: input.request.requestId,
        error: safeWorkerError(error)
      } satisfies WorkerOutput)
  )
})

export {}
