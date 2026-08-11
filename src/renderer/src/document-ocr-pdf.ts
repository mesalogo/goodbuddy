type PdfCanvasEntry = {
  canvas: OffscreenCanvas | null
  context: OffscreenCanvasRenderingContext2D | null
}

function assertCanvasSize(width: number, height: number): void {
  if (width <= 0 || height <= 0) {
    throw new Error('PDF 画布尺寸无效')
  }
}

export class WorkerPdfCanvasFactory {
  create(width: number, height: number): PdfCanvasEntry {
    assertCanvasSize(width, height)
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', {
      willReadFrequently: true
    })
    if (!context) {
      canvas.width = 0
      canvas.height = 0
      throw new Error('无法创建 PDF 页面渲染画布')
    }
    return {
      canvas,
      context
    }
  }

  reset(
    entry: PdfCanvasEntry,
    width: number,
    height: number
  ): void {
    assertCanvasSize(width, height)
    if (!entry.canvas) {
      throw new Error('PDF 画布已释放')
    }
    entry.canvas.width = width
    entry.canvas.height = height
  }

  destroy(entry: PdfCanvasEntry): void {
    if (!entry.canvas) {
      return
    }
    entry.canvas.width = 0
    entry.canvas.height = 0
    entry.canvas = null
    entry.context = null
  }
}

export class WorkerPdfFilterFactory {
  addFilter(): string {
    return 'none'
  }

  addHCMFilter(): string {
    return 'none'
  }

  addAlphaFilter(): string {
    return 'none'
  }

  addLuminosityFilter(): string {
    return 'none'
  }

  addKnockoutFilter(): string {
    return 'none'
  }

  addHighlightHCMFilter(): string {
    return 'none'
  }

  addSelectionHCMFilter(): string {
    return 'none'
  }

  addSelectionFilter(): string {
    return 'none'
  }

  createSelectionStyle(): null {
    return null
  }

  destroy(): void {}
}

export function createWorkerPdfLoadingParameters(
  data: ArrayBuffer
) {
  return {
    data: new Uint8Array(data),
    CanvasFactory: WorkerPdfCanvasFactory,
    FilterFactory: WorkerPdfFilterFactory,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false
  }
}
