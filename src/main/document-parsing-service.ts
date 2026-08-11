import { extname } from 'node:path'
import {
  documentParsingDiagnosticSchema,
  documentParsingSnapshotSchema,
  type DocumentParsingDiagnostic,
  type DocumentParsingPurpose,
  type DocumentParsingSettings,
  type DocumentParsingSnapshot
} from '../shared/document-parsing-contracts'
import type { DocumentOcrBroker } from './document-ocr-broker'
import type { DocumentOcrModelManager } from './document-ocr-model-manager'
import type { DocumentParsingSettingsStore } from './document-parsing-settings-store'
import {
  DocumentTextUnavailableError,
  extractPdfTextPages,
  parseDocument,
  type ParsedDocument,
  type ParsedSection,
  type PdfTextPage
} from './knowledge/document-parser'

const minimumUsefulPdfCharacters = 12
const maximumReplacementCharacterRatio = 0.08

export type ParseDocumentForPurpose = (
  name: string,
  buffer: Buffer,
  purpose: DocumentParsingPurpose,
  signal?: AbortSignal
) => Promise<ParsedDocument>

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('文档解析已取消')
  }
}

function hasUsefulText(content: string): boolean {
  const compact = content.replace(/\s+/gu, '')
  if (compact.length < minimumUsefulPdfCharacters) {
    return false
  }
  const replacementCount = [...compact].filter(
    (character) => character === '\uFFFD'
  ).length
  return replacementCount / compact.length <=
    maximumReplacementCharacterRatio
}

function effectiveOcrMode(
  settings: DocumentParsingSettings,
  purpose: DocumentParsingPurpose
): DocumentParsingSettings['pdfOcrMode'] {
  if (
    (purpose === 'chat-attachment' &&
      settings.chatWorkflow === 'fast-text') ||
    (purpose === 'knowledge-index' &&
      settings.knowledgeWorkflow === 'fast-index')
  ) {
    return 'disabled'
  }
  if (
    (purpose === 'chat-attachment' &&
      settings.chatWorkflow === 'high-fidelity') ||
    (purpose === 'knowledge-index' &&
      settings.knowledgeWorkflow === 'high-fidelity')
  ) {
    return 'always'
  }
  return settings.pdfOcrMode
}

function buildPdfDocument(
  name: string,
  sections: ParsedSection[],
  pageCount: number,
  warnings: string[] = []
): ParsedDocument {
  const content = sections
    .map((section) => section.content)
    .join('\n\n')
    .slice(0, 5_000_000)
  if (!content) {
    throw new DocumentTextUnavailableError()
  }
  return {
    title: name.replace(/\.[^.]+$/u, ''),
    sourceFormat: '.pdf',
    content,
    sections,
    pageCount,
    warnings
  }
}

function nativePdfSections(pages: PdfTextPage[]): ParsedSection[] {
  return pages
    .filter((page) => page.content.length > 0)
    .map((page) => ({
      locator: `第 ${page.pageNumber} 页`,
      content: page.content,
      method: 'native' as const
    }))
}

export class DocumentParsingService {
  constructor(
    private readonly settingsStore: DocumentParsingSettingsStore,
    private readonly modelManager: DocumentOcrModelManager,
    private readonly ocrBroker: DocumentOcrBroker
  ) {}

  async snapshot(): Promise<DocumentParsingSnapshot> {
    const settings = await this.settingsStore.get()
    const [localOcr, ocrModels] = await Promise.all([
      this.modelManager.getStatus(settings.localOcrModelId),
      this.modelManager.getSnapshot()
    ])
    return documentParsingSnapshotSchema.parse({
      settings,
      status: {
        nativeParsingAvailable: true,
        conversionAvailable: false,
        localOcr
      },
      ocrModels
    })
  }

  async update(input: unknown): Promise<DocumentParsingSnapshot> {
    await this.settingsStore.update(input)
    return this.snapshot()
  }

  parse: ParseDocumentForPurpose = async (
    name,
    buffer,
    purpose,
    signal
  ) => {
    ensureNotAborted(signal)
    if (extname(name).toLowerCase() !== '.pdf') {
      return parseDocument(name, buffer)
    }

    const settings = await this.settingsStore.get()
    const pages = await extractPdfTextPages(buffer)
    ensureNotAborted(signal)
    const mode = effectiveOcrMode(settings, purpose)
    const pagesWithoutUsefulText = pages
      .filter((page) => !hasUsefulText(page.content))
      .map((page) => page.pageNumber)
    const ocrPageNumbers =
      mode === 'always'
        ? pages.map((page) => page.pageNumber)
        : mode === 'auto'
          ? pagesWithoutUsefulText
          : []

    if (mode === 'disabled' || !settings.localOcrEnabled) {
      const native = nativePdfSections(pages)
      if (native.length > 0) {
        return buildPdfDocument(
          name,
          native,
          pages.length,
          pagesWithoutUsefulText.length > 0
            ? ['部分页面没有有效文本，当前工作流未启用 OCR']
            : []
        )
      }
      throw new DocumentTextUnavailableError(
        'PDF 没有可用文本层，当前工作流未启用 OCR'
      )
    }
    if (ocrPageNumbers.length === 0) {
      return buildPdfDocument(
        name,
        nativePdfSections(pages),
        pages.length
      )
    }
    if (pages.length > settings.maximumPages) {
      throw new Error(
        `PDF 共 ${pages.length} 页，超过本地 OCR 的 ${settings.maximumPages} 页限制`
      )
    }
    const modelStatus = await this.modelManager.getStatus(
      settings.localOcrModelId
    )
    if (!modelStatus.available || !modelStatus.verified) {
      throw new Error(modelStatus.detail)
    }

    const ocrRequest = {
      modelId: settings.localOcrModelId,
      fileName: name,
      mimeType: 'application/pdf' as const,
      data: Uint8Array.from(buffer).buffer,
      maximumPages: settings.maximumPages,
      pageNumbers: ocrPageNumbers,
      pageTimeoutSeconds: settings.pageTimeoutSeconds
    }
    const ocr = await (signal
      ? this.ocrBroker.recognize(ocrRequest, signal)
      : this.ocrBroker.recognize(ocrRequest))
    ensureNotAborted(signal)
    const ocrByLocator = new Map(
      ocr.sections.map((section) => [section.locator, section])
    )
    const merged = pages.flatMap((page): ParsedSection[] => {
      const locator = `第 ${page.pageNumber} 页`
      const recognized = ocrByLocator.get(locator)
      if (
        recognized &&
        (mode === 'always' || !hasUsefulText(page.content))
      ) {
        return [
          {
            locator,
            content: recognized.content,
            method: 'ocr',
            confidence: recognized.confidence
          }
        ]
      }
      return page.content
        ? [{ locator, content: page.content, method: 'native' }]
        : []
    })
    return buildPdfDocument(name, merged, pages.length, ocr.warnings)
  }

  async diagnose(
    name: string,
    buffer: Buffer,
    purpose: DocumentParsingPurpose = 'diagnostic'
  ): Promise<DocumentParsingDiagnostic> {
    const startedAt = Date.now()
    const parsed = await this.parse(name, buffer, purpose)
    const ocrPageCount = parsed.sections.filter(
      (section) => section.method === 'ocr'
    ).length
    const nativePageCount = parsed.sections.filter(
      (section) => section.method !== 'ocr'
    ).length
    return documentParsingDiagnosticSchema.parse({
      fileName: name,
      sourceFormat:
        parsed.sourceFormat.replace(/^\./u, '').toUpperCase() || 'UNKNOWN',
      pageCount:
        parsed.sourceFormat === '.pdf'
          ? (parsed.pageCount ?? parsed.sections.length)
          : 0,
      ocrPageCount,
      characterCount: parsed.content.length,
      method:
        ocrPageCount > 0 && nativePageCount > 0
          ? 'mixed'
          : ocrPageCount > 0
            ? 'ocr'
            : 'native',
      durationMs: Date.now() - startedAt,
      preview: parsed.content.slice(0, 2_000),
      warnings: parsed.warnings
    })
  }
}
