import { extname } from 'node:path'
import {
  documentParsingDiagnosticSchema,
  documentParsingSettingsUpdateSchema,
  documentParsingSnapshotSchema,
  maximumDocumentExtractedCharacters,
  maximumDocumentParsingWarnings,
  type DocumentParsingDiagnostic,
  type DocumentParsingPurpose,
  type DocumentParsingSettings,
  type DocumentParsingSnapshot
} from '../shared/document-parsing-contracts'
import type { DocumentOcrBroker } from './document-ocr-broker'
import type { DocumentOcrModelManager } from './document-ocr-model-manager'
import type { DocumentParsingSettingsStore } from './document-parsing-settings-store'
import { extractPptxPages } from './knowledge/pptx-parser'
import {
  assertDocumentBuffer,
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
): 'auto' | 'always' | 'disabled' {
  if (
    ((purpose === 'chat-attachment' ||
      purpose === 'artifact-import') &&
      settings.chatWorkflow === 'fast-text') ||
    (purpose === 'knowledge-index' &&
      settings.knowledgeWorkflow === 'fast-index')
  ) {
    return 'disabled'
  }
  if (
    ((purpose === 'chat-attachment' ||
      purpose === 'artifact-import') &&
      settings.chatWorkflow === 'high-fidelity') ||
    (purpose === 'knowledge-index' &&
      settings.knowledgeWorkflow === 'high-fidelity')
  ) {
    return 'always'
  }
  return 'auto'
}

function buildPagedDocument(
  name: string,
  sections: ParsedSection[],
  pageCount: number,
  warnings: string[] = [],
  sourceFormat: '.pdf' | '.pptx' = '.pdf'
): ParsedDocument {
  const truncationWarning =
    '文档提取文本超过 5,000,000 字符，已截断'
  const boundedWarnings = [
    ...new Set(
      warnings.filter((warning) => warning !== truncationWarning)
    )
  ]
  const limitedSections: ParsedSection[] = []
  let remaining = maximumDocumentExtractedCharacters
  let truncated = false
  for (const section of sections) {
    const separatorLength = limitedSections.length > 0 ? 2 : 0
    if (remaining <= separatorLength) {
      truncated = true
      break
    }
    const content = section.content.slice(0, remaining - separatorLength)
    if (content) {
      limitedSections.push(
        content === section.content ? section : { ...section, content }
      )
      remaining -= separatorLength + content.length
    }
    if (content.length < section.content.length) {
      truncated = true
      break
    }
  }
  if (limitedSections.length < sections.length) {
    truncated = true
  }
  const content = limitedSections
    .map((section) => section.content)
    .join('\n\n')
  if (!content) {
    throw new DocumentTextUnavailableError()
  }
  const documentWarnings =
    truncated || warnings.includes(truncationWarning)
    ? [
        ...boundedWarnings.slice(0, maximumDocumentParsingWarnings - 1),
        truncationWarning
      ]
    : boundedWarnings.slice(0, maximumDocumentParsingWarnings)
  return {
    title: name.replace(/\.[^.]+$/u, ''),
    sourceFormat,
    content,
    sections: limitedSections,
    pageCount,
    warnings: documentWarnings
  }
}

function nativePdfSections(pages: PdfTextPage[]): ParsedSection[] {
  return pages
    .filter((page) => page.content.length > 0)
    .map((page) => ({
      locator: `第 ${page.pageNumber} 页`,
      content: page.content,
      method: 'native' as const,
      pageNumber: page.pageNumber,
      blockKind: 'text' as const
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
      ocrModels,
      ...(this.settingsStore.getWarnings().length > 0
        ? { warnings: [...this.settingsStore.getWarnings()] }
        : {})
    })
  }

  async update(input: unknown): Promise<DocumentParsingSnapshot> {
    const nextSettings =
      documentParsingSettingsUpdateSchema.parse(input)
    const currentSettings = await this.settingsStore.get()
    if (
      nextSettings.localOcrModelId !==
      currentSettings.localOcrModelId
    ) {
      const status = await this.modelManager.getStatus(
        nextSettings.localOcrModelId
      )
      if (!status.available || !status.verified) {
        throw new Error('请先安装并校验所选 OCR 模型')
      }
    }
    await this.settingsStore.update(nextSettings)
    return this.snapshot()
  }

  parse: ParseDocumentForPurpose = async (
    name,
    buffer,
    purpose,
    signal
  ) => {
    ensureNotAborted(signal)
    assertDocumentBuffer(buffer)
    if (extname(name).toLowerCase() === '.pptx') {
      return this.parsePptx(name, buffer, purpose, signal)
    }
    if (extname(name).toLowerCase() !== '.pdf') {
      return parseDocument(name, buffer, signal)
    }

    const settings = await this.settingsStore.get()
    const extracted = await extractPdfTextPages(buffer, { signal })
    const { pages } = extracted
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

    if (mode === 'disabled') {
      const native = nativePdfSections(pages)
      if (native.length > 0) {
        const warnings = [
          ...(pagesWithoutUsefulText.length > 0
            ? ['部分页面没有有效文本，当前工作流未启用 OCR']
            : []),
          ...(extracted.truncated
            ? ['文档提取文本超过 5,000,000 字符，已截断']
            : [])
        ]
        return buildPagedDocument(
          name,
          native,
          extracted.pageCount,
          warnings
        )
      }
      throw new DocumentTextUnavailableError(
        'PDF 没有可用文本层，当前工作流未启用 OCR'
      )
    }
    if (ocrPageNumbers.length === 0) {
      return buildPagedDocument(
        name,
        nativePdfSections(pages),
        extracted.pageCount,
        extracted.truncated
          ? ['文档提取文本超过 5,000,000 字符，已截断']
          : []
      )
    }
    if (ocrPageNumbers.length > settings.maximumPages) {
      throw new Error(
        `PDF 有 ${ocrPageNumbers.length} 页需要 OCR，超过 ${settings.maximumPages} 页限制`
      )
    }
    const native = nativePdfSections(pages)
    const modelStatus = await this.modelManager.getStatus(
      settings.localOcrModelId
    )
    if (!modelStatus.available || !modelStatus.verified) {
      if (
        mode === 'auto' &&
        purpose !== 'knowledge-index' &&
        native.some((section) => hasUsefulText(section.content))
      ) {
        return buildPagedDocument(
          name,
          native,
          extracted.pageCount,
          [
            `本地 OCR 不可用，已保留 PDF 文本层内容：${modelStatus.detail}`,
            ...(extracted.truncated
              ? ['文档提取文本超过 5,000,000 字符，已截断']
              : [])
          ]
        )
      }
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
    let ocr
    try {
      ocr = await (signal
        ? this.ocrBroker.recognize(ocrRequest, signal)
        : this.ocrBroker.recognize(ocrRequest))
    } catch (error) {
      ensureNotAborted(signal)
      if (
        mode === 'auto' &&
        purpose !== 'knowledge-index' &&
        native.some((section) => hasUsefulText(section.content))
      ) {
        const detail =
          error instanceof Error ? error.message : '本地 OCR 识别失败'
        return buildPagedDocument(
          name,
          native,
          extracted.pageCount,
          [
            `本地 OCR 失败，已保留 PDF 文本层内容：${detail}`,
            ...(extracted.truncated
              ? ['文档提取文本超过 5,000,000 字符，已截断']
              : [])
          ]
        )
      }
      throw error
    }
    ensureNotAborted(signal)
    const ocrByPageNumber = new Map(
      ocr.sections.flatMap((section) =>
        section.pageNumber === undefined
          ? []
          : [[section.pageNumber, section] as const]
      )
    )
    const missingOcrPage = ocrPageNumbers.find(
      (pageNumber) => !ocrByPageNumber.has(pageNumber)
    )
    if (
      missingOcrPage !== undefined &&
      purpose === 'knowledge-index'
    ) {
      throw new Error(`第 ${missingOcrPage} 页未识别到可索引文本`)
    }
    const merged = pages.flatMap((page): ParsedSection[] => {
      const locator = `第 ${page.pageNumber} 页`
      const recognized = ocrByPageNumber.get(page.pageNumber)
      if (
        recognized &&
        (mode === 'always' || !hasUsefulText(page.content))
      ) {
        return [
          {
            locator,
            content: recognized.content,
            method: 'ocr',
            confidence: recognized.confidence,
            pageNumber: page.pageNumber,
            blockKind: 'text'
          }
        ]
      }
      return page.content
        ? [{
            locator,
            content: page.content,
            method: 'native',
            pageNumber: page.pageNumber,
            blockKind: 'text'
          }]
        : []
    })
    return buildPagedDocument(
      name,
      merged,
      extracted.pageCount,
      [
        ...ocr.warnings,
        ...(extracted.truncated
          ? ['文档提取文本超过 5,000,000 字符，已截断']
          : [])
      ]
    )
  }

  private async parsePptx(
    name: string,
    buffer: Buffer,
    purpose: DocumentParsingPurpose,
    signal?: AbortSignal
  ): Promise<ParsedDocument> {
    const settings = await this.settingsStore.get()
    const mode = effectiveOcrMode(settings, purpose)
    if (mode === 'disabled') {
      try {
        return await parseDocument(name, buffer, signal)
      } catch (error) {
        if (error instanceof DocumentTextUnavailableError) {
          throw new DocumentTextUnavailableError(
            'PPTX 没有可用文本，当前工作流未启用 OCR'
          )
        }
        throw error
      }
    }
    const pages = extractPptxPages(buffer)
    ensureNotAborted(signal)
    const native: ParsedSection[] = pages
      .filter((page) => page.content)
      .map((page) => ({
        locator: `幻灯片 ${page.pageNumber}`,
        content: page.content,
        method: 'native',
        pageNumber: page.pageNumber,
        blockKind: 'slide'
      }))
    const imagePages = pages.filter((page) => page.images.length > 0)
    if (imagePages.length > settings.maximumPages) {
      throw new Error(
        `PPTX 有 ${imagePages.length} 页需要 OCR，超过 ${settings.maximumPages} 页限制`
      )
    }
    const sections = [...native]
    const warnings: string[] = []
    let extractedCharacters = native.reduce(
      (total, section) => total + section.content.length, 0
    )
    if (imagePages.length > 0) {
      try {
        const status = await this.modelManager.getStatus(settings.localOcrModelId)
        if (!status.available || !status.verified) {
          throw new Error(status.detail)
        }
        ocrPages: for (const page of imagePages) {
          for (const [index, image] of page.images.entries()) {
            ensureNotAborted(signal)
            const locator = `幻灯片 ${page.pageNumber} · 图片 ${index + 1}`
            if (!image.mimeType) {
              throw new Error(`${locator} 的格式暂不支持 OCR：${extname(image.name)}`)
            }
            const request = {
              modelId: settings.localOcrModelId,
              fileName: image.name,
              mimeType: image.mimeType,
              data: Uint8Array.from(image.data).buffer,
              maximumPages: 1,
              pageTimeoutSeconds: settings.pageTimeoutSeconds
            }
            const result = await (signal
              ? this.ocrBroker.recognize(request, signal)
              : this.ocrBroker.recognize(request))
            ensureNotAborted(signal)
            sections.push(...result.sections.map((section): ParsedSection => ({
              locator,
              content: section.content,
              confidence: section.confidence,
              method: 'ocr',
              pageNumber: page.pageNumber,
              blockKind: 'slide'
            })))
            for (const warning of result.warnings) {
              if (warnings.length < maximumDocumentParsingWarnings) {
                warnings.push(`${locator}：${warning}`.slice(0, 500))
              }
            }
            extractedCharacters += result.sections.reduce(
              (total, section) => total + section.content.length, 0
            )
            if (extractedCharacters >= maximumDocumentExtractedCharacters) {
              warnings.push('文档提取文本超过 5,000,000 字符，已截断')
              break ocrPages
            }
          }
        }
      } catch (error) {
        ensureNotAborted(signal)
        if (
          mode !== 'auto' ||
          purpose === 'knowledge-index' ||
          !native.some((section) => hasUsefulText(section.content))
        ) {
          throw error
        }
        return buildPagedDocument(name, native, pages.length, [
          `本地 OCR 不可用，已保留 PPTX 文本内容：${
            error instanceof Error ? error.message : '本地 OCR 识别失败'
          }`.slice(0, 500)
        ], '.pptx')
      }
    }
    sections.sort((left, right) => (left.pageNumber ?? 0) - (right.pageNumber ?? 0))
    return buildPagedDocument(name, sections, pages.length, warnings, '.pptx')
  }

  async diagnose(
    name: string,
    buffer: Buffer,
    purpose: DocumentParsingPurpose = 'diagnostic'
  ): Promise<DocumentParsingDiagnostic> {
    const startedAt = Date.now()
    const parsed = await this.parse(name, buffer, purpose)
    const ocrPageCount = new Set(parsed.sections.filter(
      (section) => section.method === 'ocr'
    ).map((section) => section.pageNumber ?? section.locator)).size
    const nativePageCount = parsed.sections.filter(
      (section) => section.method !== 'ocr'
    ).length
    return documentParsingDiagnosticSchema.parse({
      fileName: name,
      sourceFormat:
        parsed.sourceFormat.replace(/^\./u, '').toUpperCase() || 'UNKNOWN',
      pageCount:
        parsed.sourceFormat === '.pdf' || parsed.sourceFormat === '.pptx'
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
