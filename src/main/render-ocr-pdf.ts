import { createCanvas } from '@napi-rs/canvas'

export async function* renderOcrPdf(
  buffer: Buffer,
  pageNumbers: number[],
  signal?: AbortSignal
): AsyncGenerator<{ pageNumber: number; data: Buffer; width: number; height: number }> {
  signal?.throwIfAborted()
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({
    data: Uint8Array.from(buffer), disableFontFace: true,
    isOffscreenCanvasSupported: false, useSystemFonts: false, useWorkerFetch: false
  })
  const abort = (): void => { void task.destroy() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const pdf = await task.promise
    for (const pageNumber of pageNumbers) {
      signal?.throwIfAborted()
      const page = await pdf.getPage(pageNumber)
      try {
        const original = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: Math.min(2, 2400 / Math.max(original.width, original.height)) })
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        const render = page.render({ canvas: canvas as unknown as Parameters<typeof page.render>[0]['canvas'], viewport })
        const cancel = (): void => render.cancel()
        signal?.addEventListener('abort', cancel, { once: true })
        try { await render.promise } finally { signal?.removeEventListener('abort', cancel) }
        signal?.throwIfAborted()
        yield { pageNumber, data: await canvas.encode('png'), width: canvas.width, height: canvas.height }
      } finally { page.cleanup() }
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    await task.destroy()
  }
}

export async function renderSelectedOcrPdf(buffer: Buffer, pageNumbers: number[], signal?: AbortSignal): Promise<Buffer> {
  const { jsPDF } = await import('jspdf')
  let document: InstanceType<typeof jsPDF> | undefined
  let bytes = 0
  for await (const page of renderOcrPdf(buffer, pageNumbers, signal)) {
    bytes += page.data.length
    if (bytes > 20 * 1024 * 1024) throw new Error('选中页面渲染结果超过 20 MiB，请减少单次解析页数')
    const format = [page.width / 2, page.height / 2]
    const orientation = page.width > page.height ? 'landscape' : 'portrait'
    if (!document) document = new jsPDF({ unit: 'pt', format, orientation, compress: true })
    else document.addPage(format, orientation)
    document.addImage(page.data, 'PNG', 0, 0, format[0]!, format[1]!, undefined, 'FAST')
  }
  signal?.throwIfAborted()
  if (!document) throw new Error('没有需要 OCR 的页面')
  const result = Buffer.from(document.output('arraybuffer'))
  if (result.length > 20 * 1024 * 1024) throw new Error('选中页面 PDF 超过 20 MiB')
  return result
}
