import { describe, expect, it, vi } from 'vitest'
import {
  defaultDocumentParsingSettings
} from './document-parsing-settings-store'
import { DocumentParsingService } from './document-parsing-service'

function createPdfFixture(text: string): Buffer {
  const stream = `BT /F1 18 Tf 50 100 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
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
}) {
  const settings = {
    ...defaultDocumentParsingSettings,
    ...overrides?.settings
  }
  const recognize = vi.fn(async () => ({
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
  const service = new DocumentParsingService(
    {
      get: vi.fn(async () => settings),
      update: vi.fn(async () => settings)
    } as never,
    {
      getStatus: vi.fn(async () => ({
        id: 'pp-ocrv6-tiny',
        displayName: 'PP-OCRv6 Tiny',
        available: true,
        verified: true,
        runtime: 'onnxruntime-web-wasm',
        detail: '可用'
      }))
    } as never,
    { recognize } as never
  )
  return { recognize, service }
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
})
