import { describe, expect, it, vi } from 'vitest'
import {
  defaultDocumentParsingSettings
} from './document-parsing-settings-store'
import { DocumentParsingService } from './document-parsing-service'

function createPdfFixture(...pageTexts: string[]): Buffer {
  const texts = pageTexts.length > 0 ? pageTexts : ['']
  const fontObjectId = texts.length + 3
  const firstContentObjectId = fontObjectId + 1
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${texts
      .map((_, index) => `${index + 3} 0 R`)
      .join(' ')}] /Count ${texts.length} >>`,
    ...texts.map(
      (_, index) =>
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] ' +
        `/Resources << /Font << /F1 ${fontObjectId} 0 R >> >> ` +
        `/Contents ${firstContentObjectId + index} 0 R >>`
    ),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...texts.map((text) => {
      const stream = `BT /F1 18 Tf 50 100 Td (${text}) Tj ET`
      return (
        `<< /Length ${Buffer.byteLength(stream)} >>\n` +
        `stream\n${stream}\nendstream`
      )
    })
  ]
  let content = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content))
    content += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(content)
  content += `xref\n0 ${objects.length + 1}\n`
  content += '0000000000 65535 f \n'
  content += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  content += `startxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(content)
}

function createService(overrides?: {
  settings?: Partial<typeof defaultDocumentParsingSettings>
  modelStatus?: {
    available: boolean
    verified: boolean
    detail: string
  }
  recognize?: () => Promise<{
    requestId: string
    sections: Array<{
      locator: string
      content: string
      confidence: number
    }>
    pageCount: number
    warnings: string[]
  }>
}) {
  const settings = {
    ...defaultDocumentParsingSettings,
    ...overrides?.settings
  }
  const recognize = vi.fn(
    overrides?.recognize ??
      (async () => ({
        requestId: crypto.randomUUID(),
        sections: [
          {
            locator: '第 1 页',
            content: '扫描件识别正文',
            confidence: 0.93
          }
        ],
        pageCount: 1,
        warnings: []
      }))
  )
  const settingsStore = {
    get: vi.fn(async () => settings),
    update: vi.fn(async () => settings)
  }
  const modelManager = {
    getStatus: vi.fn(async () => ({
        id: 'pp-ocrv6-tiny',
        displayName: 'PP-OCRv6 Tiny',
        available: overrides?.modelStatus?.available ?? true,
        verified: overrides?.modelStatus?.verified ?? true,
        runtime: 'onnxruntime-web-wasm',
        detail: overrides?.modelStatus?.detail ?? '可用'
      })),
    getSnapshot: vi.fn()
  }
  const service = new DocumentParsingService(
    settingsStore as never,
    modelManager as never,
    { recognize } as never
  )
  return { modelManager, recognize, service, settingsStore }
}

describe('DocumentParsingService', () => {
  it('keeps useful PDF text local without invoking OCR', async () => {
    const { recognize, service } = createService()

    const parsed = await service.parse(
      'native.pdf',
      createPdfFixture('Native PDF body text'),
      'knowledge-index'
    )

    expect(parsed.content).toContain('Native PDF body text')
    expect(parsed.sections[0]?.method).toBe('native')
    expect(recognize).not.toHaveBeenCalled()
  })

  it('uses OCR for a PDF without useful text', async () => {
    const { recognize, service } = createService()

    const parsed = await service.parse(
      'scan.pdf',
      createPdfFixture(''),
      'chat-attachment'
    )

    expect(parsed.content).toBe('扫描件识别正文')
    expect(parsed.sections).toEqual([
      {
        locator: '第 1 页',
        content: '扫描件识别正文',
        method: 'ocr',
        confidence: 0.93
      }
    ])
    expect(recognize).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'scan.pdf',
        modelId: 'pp-ocrv6-tiny',
        mimeType: 'application/pdf',
        pageNumbers: [1]
      })
    )
  })

  it('does not use OCR in a fast-text workflow', async () => {
    const { recognize, service } = createService({
      settings: { chatWorkflow: 'fast-text' }
    })

    await expect(
      service.parse(
        'scan.pdf',
        createPdfFixture(''),
        'chat-attachment'
      )
    ).rejects.toThrow('未启用 OCR')
    expect(recognize).not.toHaveBeenCalled()
  })

  it('falls back to useful native text when automatic OCR is unavailable', async () => {
    const { recognize, service } = createService({
      modelStatus: {
        available: false,
        verified: false,
        detail: '模型尚未安装'
      }
    })
    const pdf = createPdfFixture('Native PDF body text', '')
    const originalExtract = await service.parse(
      'native.pdf',
      pdf,
      'chat-attachment'
    )
    expect(originalExtract.content).toContain('Native PDF body text')
    expect(originalExtract.warnings).toEqual([
      expect.stringContaining('模型尚未安装')
    ])
    expect(recognize).not.toHaveBeenCalled()
  })

  it('falls back to native text when automatic OCR fails', async () => {
    const { service } = createService({
      recognize: async () => {
        throw new Error('OCR runtime failed')
      }
    })
    const parsed = await service.parse(
      'native.pdf',
      createPdfFixture('Native PDF body text', ''),
      'chat-attachment'
    )

    expect(parsed.content).toContain('Native PDF body text')
    expect(parsed.warnings).toEqual([
      expect.stringContaining('OCR runtime failed')
    ])
  })

  it('limits the number of pages sent to OCR rather than total PDF pages', async () => {
    const { recognize, service } = createService({
      settings: { maximumPages: 1 }
    })

    await service.parse(
      'mixed.pdf',
      createPdfFixture('Native PDF body text', ''),
      'chat-attachment'
    )

    expect(recognize).toHaveBeenCalledWith(
      expect.objectContaining({
        maximumPages: 1,
        pageNumbers: [2]
      })
    )
  })

  it('rejects high-fidelity parsing when OCR pages exceed the limit', async () => {
    const { recognize, service } = createService({
      settings: {
        chatWorkflow: 'high-fidelity',
        maximumPages: 1
      }
    })

    await expect(
      service.parse(
        'two-pages.pdf',
        createPdfFixture('First page text', 'Second page text'),
        'chat-attachment'
      )
    ).rejects.toThrow('有 2 页需要 OCR')
    expect(recognize).not.toHaveBeenCalled()
  })

  it('rejects selecting an OCR model that is not installed', async () => {
    const { modelManager, service, settingsStore } = createService()
    modelManager.getStatus.mockResolvedValueOnce({
      id: 'pp-ocrv6-medium',
      displayName: 'PP-OCRv6 Medium',
      available: false,
      verified: false,
      runtime: 'onnxruntime-web-wasm',
      detail: '模型尚未安装'
    })

    await expect(
      service.update({
        ...defaultDocumentParsingSettings,
        localOcrModelId: 'pp-ocrv6-medium'
      })
    ).rejects.toThrow('请先安装并校验')
    expect(settingsStore.update).not.toHaveBeenCalled()
  })
})
