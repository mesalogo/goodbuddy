import { extname } from 'node:path'
import { convert } from 'html-to-text'
import {
  documentParsingDiagnosticSchema,
  documentParsingSettingsUpdateSchema,
  documentParsingSnapshotSchema,
  defaultHttpOcrSettings,
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
import { HttpDocumentOcr } from './http-document-ocr'
import { renderOcrPdf, renderSelectedOcrPdf } from './render-ocr-pdf'
import type { DocumentResultStorage } from './document-result-storage'
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
  private readonly diagnosticOperations = new Map<string, AbortController>()
  constructor(
    private readonly settingsStore: DocumentParsingSettingsStore,
    private readonly modelManager: DocumentOcrModelManager,
    private readonly ocrBroker: DocumentOcrBroker,
    readonly results?: DocumentResultStorage
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
      httpCredentialConfigured: await this.settingsStore.credentialConfigured(),
      ...(this.settingsStore.getWarnings().length > 0
        ? { warnings: [...this.settingsStore.getWarnings()] }
        : {})
    })
  }

  async update(input: unknown): Promise<DocumentParsingSnapshot> {
    const nextSettings =
      documentParsingSettingsUpdateSchema.parse(input)
    const currentSettings = await this.settingsStore.get()
    if (nextSettings.ocrProvider === 'paddleocr-vl') {
      if (!nextSettings.httpOcr?.baseUrl) throw new Error('请输入 HTTP OCR 服务地址')
      if (nextSettings.httpOcr.authentication === 'bearer' && !nextSettings.apiKey && (nextSettings.clearApiKey || !await this.settingsStore.credentialConfigured())) throw new Error('请输入 Bearer API Key，或选择无需认证')
    }
    if (
      nextSettings.ocrProvider !== 'paddleocr-vl' &&
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

  async checkHttp(): Promise<{ checkedAt: string; declaredOptions: string[] }> {
    return this.httpProvider(await this.settingsStore.forOperation()).check()
  }

  async extractImage(name: string, buffer: Buffer, signal?: AbortSignal): Promise<ParsedDocument> {
    const startedAt = Date.now()
    ensureNotAborted(signal)
    assertDocumentBuffer(buffer)
    const operation = await this.settingsStore.forOperation()
    const { settings } = operation
    let sections: ParsedSection[]
    let images: ParsedDocument['images']
    let missingImages: ParsedDocument['missingImages']
    let warnings: string[]
    if (settings.ocrProvider === 'paddleocr-vl') {
      const result = await this.httpProvider(operation).recognize(buffer, 1, [1], signal)
      sections = result.sections
      images = result.images
      missingImages = result.missingImages
      warnings = result.warnings
    } else {
      const status = await this.modelManager.getStatus(settings.localOcrModelId)
      if (!status.available || !status.verified) throw new Error(status.detail)
      const mimeType = extname(name).toLowerCase() === '.png' ? 'image/png' as const
        : extname(name).toLowerCase() === '.webp' ? 'image/webp' as const : 'image/jpeg' as const
      const result = await this.ocrBroker.recognize({ modelId: settings.localOcrModelId, fileName: name, mimeType,
        data: Uint8Array.from(buffer).buffer, maximumPages: 1, pageTimeoutSeconds: settings.pageTimeoutSeconds }, signal)
      sections = result.sections.map((section) => ({ ...section, method: 'ocr' }))
      warnings = result.warnings
    }
    const content = sections.map((section) => section.content).join('\n\n')
    if (!convert(content.replace(/!\[[^\]]*\]\([^)]*\)/gu, ''), { wordwrap: false }).trim()) throw new Error('未提取到文字，原图片发送方式保持不变')
    ensureNotAborted(signal)
    return { title: name, sourceFormat: extname(name).toLowerCase(), content, sections, warnings, pageCount: 1, images, missingImages, parsingSettings: settings, parsingDurationMs: Date.now() - startedAt }
  }

  private httpProvider(operation: Awaited<ReturnType<DocumentParsingSettingsStore['forOperation']>>): HttpDocumentOcr {
    const { settings } = operation
    const http = settings.httpOcr ?? defaultHttpOcrSettings
    return new HttpDocumentOcr(http, http.authentication === 'bearer' ? operation.apiKey() : undefined)
  }

  parse: ParseDocumentForPurpose = async (
    name,
    buffer,
    purpose,
    signal
  ) => {
    const started = Date.now()
    const operation = await this.settingsStore.forOperation()
    const parsed = await this.parseInput(name, buffer, purpose, operation, signal)
    return { ...parsed, parsingSettings: operation.settings, parsingDurationMs: Date.now() - started }
  }

  private async parseInput(
    name: string,
    buffer: Buffer,
    purpose: DocumentParsingPurpose,
    operation: Awaited<ReturnType<DocumentParsingSettingsStore['forOperation']>>,
    signal?: AbortSignal
  ): Promise<ParsedDocument> {
    const { settings } = operation
    ensureNotAborted(signal)
    assertDocumentBuffer(buffer)
    if (extname(name).toLowerCase() === '.pptx') {
      return this.parsePptx(name, buffer, purpose, operation, signal)
    }
    if (extname(name).toLowerCase() !== '.pdf') {
      return parseDocument(name, buffer, signal)
    }

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
    if (settings.ocrProvider === 'paddleocr-vl') {
      const provider = this.httpProvider(operation)
      const recognized: ParsedSection[] = []
      const images: NonNullable<ParsedDocument['images']> = []
      const missingImages: NonNullable<ParsedDocument['missingImages']> = []
      const warnings: string[] = []
      let restructure: ParsedDocument['restructure']
      try {
        if (ocrPageNumbers.length === extracted.pageCount && (mode === 'always' || settings.httpOcr?.mergeTables || settings.httpOcr?.relevelTitles)) {
          const result = await provider.recognize(buffer, 0, ocrPageNumbers, signal)
          recognized.push(...result.sections)
          images.push(...(result.images ?? []))
          missingImages.push(...(result.missingImages ?? []))
          warnings.push(...result.warnings)
          restructure = result.restructure
        } else if (settings.httpOcr?.mergeTables || settings.httpOcr?.relevelTitles) {
          const groups: number[][] = []
          for (const page of ocrPageNumbers) {
            const current = groups.at(-1)
            if (current && current.at(-1) === page - 1) current.push(page)
            else groups.push([page])
          }
          for (const group of groups) {
            const selected = await renderSelectedOcrPdf(buffer, group, signal)
            const result = await provider.recognize(selected, 0, group, signal)
            recognized.push(...result.sections)
            images.push(...(result.images ?? []))
            missingImages.push(...(result.missingImages ?? []))
            warnings.push(...result.warnings)
            if (result.restructure) restructure = { changed: Boolean(restructure?.changed || result.restructure.changed), sourcePages: [...(restructure?.sourcePages ?? []), ...group] }
          }
        } else {
          for await (const page of renderOcrPdf(buffer, ocrPageNumbers, signal)) {
            const result = await provider.recognize(page.data, 1, [page.pageNumber], signal)
            recognized.push(...result.sections)
            images.push(...(result.images ?? []))
            missingImages.push(...(result.missingImages ?? []))
            warnings.push(...result.warnings)
          }
        }
        if (warnings.length && (mode === 'always' || purpose === 'knowledge-index')) {
          throw new Error(warnings.join('；'))
        }
      } catch (error) {
        ensureNotAborted(signal)
        if (mode !== 'auto' || purpose === 'knowledge-index' || !native.some((section) => hasUsefulText(section.content))) throw error
        return buildPagedDocument(name, native, extracted.pageCount, [`HTTP OCR 未完成，已保留原生文本：${error instanceof Error ? error.message : '请求失败'}`])
      }
      const merged = [...native.filter((section) => !ocrPageNumbers.includes(section.pageNumber!)), ...recognized]
        .sort((left, right) => (left.pageNumber ?? left.sourcePages?.[0] ?? 0) - (right.pageNumber ?? right.sourcePages?.[0] ?? 0))
      return { ...buildPagedDocument(name, merged, extracted.pageCount, warnings), images, missingImages, restructure }
    }
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
      (purpose === 'knowledge-index' || mode === 'always')
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
        ...(missingOcrPage === undefined ? [] : [`第 ${missingOcrPage} 页未完成 OCR，当前为部分解析结果`]),
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
    operation: Awaited<ReturnType<DocumentParsingSettingsStore['forOperation']>>,
    signal?: AbortSignal
  ): Promise<ParsedDocument> {
    const { settings } = operation
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
    const images: NonNullable<ParsedDocument['images']> = []
    const missingImages: NonNullable<ParsedDocument['missingImages']> = []
    const warnings: string[] = []
    let extractedCharacters = native.reduce(
      (total, section) => total + section.content.length, 0
    )
    if (imagePages.length > 0) {
      try {
        const http = settings.ocrProvider === 'paddleocr-vl' ? this.httpProvider(operation) : undefined
        if (!http) {
          const status = await this.modelManager.getStatus(settings.localOcrModelId)
          if (!status.available || !status.verified) throw new Error(status.detail)
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
            const result = http ? await http.recognize(Buffer.from(image.data), 1, [page.pageNumber], signal) : await (signal
              ? this.ocrBroker.recognize(request, signal)
              : this.ocrBroker.recognize(request))
            if ('images' in result) images.push(...(result.images ?? []).map((image) => ({ ...image, locator })))
            if ('missingImages' in result) missingImages.push(...(result.missingImages ?? []))
            if (http && result.warnings.length && (mode === 'always' || purpose === 'knowledge-index')) throw new Error(result.warnings.join('；'))
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
    return { ...buildPagedDocument(name, sections, pages.length, warnings, '.pptx'), ...(images.length ? { images } : {}), ...(missingImages.length ? { missingImages } : {}) }
  }

  async diagnose(
    name: string,
    buffer: Buffer,
    purpose: DocumentParsingPurpose = 'diagnostic',
    operationId?: string
  ): Promise<DocumentParsingDiagnostic> {
    const startedAt = Date.now()
    const controller = new AbortController()
    if (operationId) {
      if (this.diagnosticOperations.has(operationId)) throw new Error('解析任务已在运行')
      this.diagnosticOperations.set(operationId, controller)
    }
    try {
    const parsed = await this.parse(name, buffer, purpose, controller.signal)
    controller.signal.throwIfAborted()
    const saved = parsed.parsingSettings ? await this.results?.save(name, buffer, parsed, parsed.parsingSettings, Date.now() - startedAt, undefined, controller.signal) : undefined
    const ocrPageCount = new Set(parsed.sections.filter(
      (section) => section.method === 'ocr'
    ).flatMap((section) => (section.sourcePages ?? [section.pageNumber ?? section.locator]).map(String))).size
    const nativePageCount = parsed.sections.filter(
      (section) => section.method !== 'ocr'
    ).length
    return documentParsingDiagnosticSchema.parse({
      provider: ocrPageCount ? parsed.parsingSettings?.ocrProvider ?? 'local' : 'native',
      ...(saved ? { resultId: saved.id } : {}),
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
    } finally {
      if (operationId) this.diagnosticOperations.delete(operationId)
    }
  }

  cancelDiagnostic(operationId: string): void {
    this.diagnosticOperations.get(operationId)?.abort(new Error('文档解析已取消'))
  }

  async dispose(): Promise<void> {
    for (const controller of this.diagnosticOperations.values()) controller.abort(new Error('应用正在退出'))
    await this.results?.close()
  }
}
