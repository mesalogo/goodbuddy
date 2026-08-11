import {
  createCanvas,
  DOMMatrix,
  Path2D,
  type Canvas
} from '@napi-rs/canvas'
import type {
  PDFDocumentLoadingTask,
  PDFPageProxy
} from 'pdfjs-dist/types/src/display/api'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWorkerPdfLoadingParameters,
  WorkerPdfCanvasFactory
} from './document-ocr-pdf'

const encoder = new TextEncoder()

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0
  )
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function createScannedPdfFixture(): Uint8Array {
  const chunks: Uint8Array[] = []
  const offsets = [0]
  let byteLength = 0
  const append = (chunk: string | Uint8Array): void => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    chunks.push(bytes)
    byteLength += bytes.byteLength
  }
  const image = Uint8Array.from([
    0b10101010,
    0b01010101,
    0b10101010,
    0b01010101,
    0b10101010,
    0b01010101,
    0b10101010,
    0b01010101
  ])
  const content = 'q\n100 0 0 100 0 0 cm\n/Im0 Do\nQ'
  const objects: Array<string | Uint8Array[]> = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
    [
      encoder.encode(
        `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1 /Decode [0 1] /Length ${image.byteLength} >>\nstream\n`
      ),
      image,
      encoder.encode('\nendstream')
    ],
    `<< /Length ${encoder.encode(content).byteLength} >>\nstream\n${content}\nendstream`
  ]

  append('%PDF-1.4\n')
  for (const [index, object] of objects.entries()) {
    offsets.push(byteLength)
    append(`${index + 1} 0 obj\n`)
    if (typeof object === 'string') {
      append(object)
    } else {
      for (const part of object) {
        append(part)
      }
    }
    append('\nendobj\n')
  }
  const xrefOffset = byteLength
  append(`xref\n0 ${objects.length + 1}\n`)
  append('0000000000 65535 f \n')
  for (const offset of offsets.slice(1)) {
    append(`${String(offset).padStart(10, '0')} 00000 n \n`)
  }
  append(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  )
  return concatBytes(chunks)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OCR PDF rendering', () => {
  it('renders an image-only PDF without a DOM document', async () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'document'
    )
    const toHexDescriptor = Object.getOwnPropertyDescriptor(
      Uint8Array.prototype,
      'toHex'
    )
    const mapInsertionDescriptor = Object.getOwnPropertyDescriptor(
      Map.prototype,
      'getOrInsertComputed'
    )
    const weakMapInsertionDescriptor = Object.getOwnPropertyDescriptor(
      WeakMap.prototype,
      'getOrInsertComputed'
    )
    let canvasCount = 0
    vi.stubGlobal('DOMMatrix', DOMMatrix)
    vi.stubGlobal('Path2D', Path2D)
    vi.stubGlobal(
      'OffscreenCanvas',
      function TestOffscreenCanvas(width: number, height: number) {
        canvasCount += 1
        return createCanvas(width, height)
      } as unknown as typeof OffscreenCanvas
    )
    if (!toHexDescriptor) {
      Object.defineProperty(Uint8Array.prototype, 'toHex', {
        configurable: true,
        value(this: Uint8Array) {
          return Array.from(this, (byte) =>
            byte.toString(16).padStart(2, '0')
          ).join('')
        }
      })
    }
    if (!mapInsertionDescriptor) {
      Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
        configurable: true,
        value(
          this: Map<unknown, unknown>,
          key: unknown,
          callback: (key: unknown) => unknown
        ) {
          if (this.has(key)) {
            return this.get(key)
          }
          const value = callback(key)
          this.set(key, value)
          return value
        }
      })
    }
    if (!weakMapInsertionDescriptor) {
      Object.defineProperty(WeakMap.prototype, 'getOrInsertComputed', {
        configurable: true,
        value(
          this: WeakMap<object, unknown>,
          key: object,
          callback: (key: object) => unknown
        ) {
          if (this.has(key)) {
            return this.get(key)
          }
          const value = callback(key)
          this.set(key, value)
          return value
        }
      })
    }
    Reflect.deleteProperty(globalThis, 'document')

    let loadingTask: PDFDocumentLoadingTask | undefined
    let page: PDFPageProxy | undefined
    let output: ReturnType<WorkerPdfCanvasFactory['create']> | undefined
    try {
      const pdfjs = await import('pdfjs-dist')
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
        join(
          process.cwd(),
          'node_modules',
          'pdfjs-dist',
          'build',
          'pdf.worker.mjs'
        )
      ).href
      const fixture = createScannedPdfFixture()
      loadingTask = pdfjs.getDocument(
        createWorkerPdfLoadingParameters(
          fixture.buffer.slice(
            fixture.byteOffset,
            fixture.byteOffset + fixture.byteLength
          ) as ArrayBuffer
        )
      )
      const pdf = await loadingTask.promise
      page = await pdf.getPage(1)
      const viewport = page.getViewport({ scale: 2 })
      const factory = new WorkerPdfCanvasFactory()
      output = factory.create(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height)
      )
      const canvasCountBeforeRender = canvasCount

      await page.render({
        canvas: output.canvas as unknown as HTMLCanvasElement,
        canvasContext:
          output.context as unknown as CanvasRenderingContext2D,
        viewport
      }).promise

      expect(canvasCount).toBeGreaterThan(canvasCountBeforeRender)
      expect(
        await (output.canvas as unknown as Canvas).encode('png')
      ).not.toHaveLength(0)
    } finally {
      page?.cleanup()
      if (output) {
        new WorkerPdfCanvasFactory().destroy(output)
      }
      await loadingTask?.destroy()
      if (documentDescriptor) {
        Object.defineProperty(
          globalThis,
          'document',
          documentDescriptor
        )
      }
      if (toHexDescriptor) {
        Object.defineProperty(
          Uint8Array.prototype,
          'toHex',
          toHexDescriptor
        )
      } else {
        Reflect.deleteProperty(Uint8Array.prototype, 'toHex')
      }
      if (mapInsertionDescriptor) {
        Object.defineProperty(
          Map.prototype,
          'getOrInsertComputed',
          mapInsertionDescriptor
        )
      } else {
        Reflect.deleteProperty(Map.prototype, 'getOrInsertComputed')
      }
      if (weakMapInsertionDescriptor) {
        Object.defineProperty(
          WeakMap.prototype,
          'getOrInsertComputed',
          weakMapInsertionDescriptor
        )
      } else {
        Reflect.deleteProperty(
          WeakMap.prototype,
          'getOrInsertComputed'
        )
      }
    }
  })
})
