import { convert } from 'html-to-text'
import { unzipSync } from 'fflate'
import { extname } from 'node:path'
import type {
  KnowledgeChunkingSettings,
  KnowledgeChunkRole
} from '../../shared/knowledge-contracts'

export type ParsedSection = {
  locator: string
  content: string
  method?: 'native' | 'ocr' | 'converted' | 'vision'
  confidence?: number
  pageNumber?: number
  headingPath?: string[]
  blockKind?: DocumentBlockKind
}

export type ParsedDocument = {
  title: string
  sourceFormat: string
  content: string
  sections: ParsedSection[]
  warnings: string[]
  pageCount?: number
}

export type DocumentChunk = {
  position: number
  locator: string
  content: string
  heading?: string
  pageNumber?: number
  headingPath?: string[]
  blockKind?: DocumentBlockKind
  role?: KnowledgeChunkRole
  parentPosition?: number
}

export type DocumentBlockKind = 'text' | 'table' | 'slide'

const maximumDocumentBytes = 20 * 1024 * 1024
const maximumExtractedCharacters = 5_000_000
const maximumHeadingCharacters = 512
const maximumHeadingDepth = 6
export const maximumChunkContextPrefixCharacters = 512
const textExtensions = new Set([
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.log',
  '.md',
  '.mjs',
  '.php',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
])

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([\da-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
}

function extractXmlText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/(?:w:p|a:p|row)>/g, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeText(buffer: Buffer): string {
  const content = buffer.toString('utf8')
  const nullCount = [...content.slice(0, 8_192)].filter(
    (character) => character.charCodeAt(0) === 0
  ).length
  if (nullCount > 2) {
    throw new Error('文件不是受支持的 UTF-8 文本')
  }
  return content
}

function extractDocxSections(xml: string): ParsedSection[] {
  const blocks =
    xml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g) ??
    []
  if (blocks.length === 0) {
    const content = extractXmlText(xml)
    return content
      ? [{ locator: '正文', content, blockKind: 'text' }]
      : []
  }

  const sections: ParsedSection[] = []
  let paragraphs: string[] = []
  let paragraphStart = 1
  let paragraphNumber = 0
  let tableNumber = 0
  const flushParagraphs = (): void => {
    if (paragraphs.length === 0) {
      return
    }
    const paragraphEnd = paragraphStart + paragraphs.length - 1
    sections.push({
      locator:
        paragraphStart === paragraphEnd
          ? `正文 · 段落 ${paragraphStart}`
          : `正文 · 段落 ${paragraphStart}-${paragraphEnd}`,
      content: paragraphs.join('\n'),
      blockKind: 'text'
    })
    paragraphs = []
  }

  for (const block of blocks) {
    if (/^<w:tbl\b/u.test(block)) {
      flushParagraphs()
      tableNumber += 1
      const content = extractXmlText(block)
      if (content) {
        sections.push({
          locator: `正文 · 表格 ${tableNumber}`,
          content,
          blockKind: 'table'
        })
      }
      paragraphStart = paragraphNumber + 1
      continue
    }
    paragraphNumber += 1
    const content = extractXmlText(block)
    if (content) {
      if (paragraphs.length === 0) {
        paragraphStart = paragraphNumber
      }
      paragraphs.push(content)
    }
  }
  flushParagraphs()
  return sections
}

function extractSharedStrings(xml: string | undefined): string[] {
  if (!xml) {
    return []
  }
  return (xml.match(/<si\b[\s\S]*?<\/si>/g) ?? []).map((item) =>
    extractXmlText(item)
  )
}

function extractWorksheetText(
  xml: string,
  sharedStrings: string[]
): string {
  const rows = xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []
  if (rows.length === 0) {
    return extractXmlText(xml)
  }
  return rows
    .map((row) =>
      (row.match(/<c\b[\s\S]*?<\/c>/g) ?? [])
        .map((cell) => {
          const type = /\bt="([^"]+)"/u.exec(cell)?.[1]
          if (type === 'inlineStr') {
            const inline = /<is\b[\s\S]*?<\/is>/u.exec(cell)?.[0]
            return inline ? extractXmlText(inline) : ''
          }
          const rawValue = /<v\b[^>]*>([\s\S]*?)<\/v>/u.exec(cell)?.[1]
          if (rawValue === undefined) {
            return ''
          }
          const value = decodeXmlEntities(rawValue).trim()
          if (type === 's') {
            const index = Number.parseInt(value, 10)
            return Number.isSafeInteger(index)
              ? (sharedStrings[index] ?? '')
              : ''
          }
          return value
        })
        .join('\t')
        .trimEnd()
    )
    .filter((row) => row.length > 0)
    .join('\n')
    .trim()
}

function parseOfficeArchive(
  buffer: Buffer,
  extension: string
): ParsedSection[] {
  const patterns =
    extension === '.docx'
      ? [/^word\/document\.xml$/]
      : extension === '.xlsx'
        ? [
            /^xl\/sharedStrings\.xml$/,
            /^xl\/worksheets\/sheet\d+\.xml$/
          ]
        : [/^ppt\/slides\/slide\d+\.xml$/]
  let archive: Record<string, Uint8Array>
  let entryCount = 0
  let selectedBytes = 0
  try {
    archive = unzipSync(new Uint8Array(buffer), {
      filter: (file) => {
        entryCount += 1
        if (entryCount > 10_000) {
          throw new Error('Office 文档包含过多压缩条目')
        }
        const selected = patterns.some((pattern) =>
          pattern.test(file.name)
        )
        if (!selected) {
          return false
        }
        if (file.originalSize > 10 * 1024 * 1024) {
          throw new Error('Office 文档单个内容条目过大')
        }
        selectedBytes += file.originalSize
        if (selectedBytes > 50 * 1024 * 1024) {
          throw new Error('Office 文档解压后内容超过安全限制')
        }
        return true
      }
    })
  } catch {
    throw new Error('Office 文档已损坏或不是有效的 Open XML 文件')
  }

  if (extension === '.docx') {
    const documentXml = archive['word/document.xml']
    return documentXml
      ? extractDocxSections(Buffer.from(documentXml).toString('utf8'))
      : []
  }

  if (extension === '.xlsx') {
    const sharedStrings = extractSharedStrings(
      archive['xl/sharedStrings.xml']
        ? Buffer.from(archive['xl/sharedStrings.xml']).toString('utf8')
        : undefined
    )
    const worksheets = Object.entries(archive)
      .filter(([path]) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(path))
      .sort(([left], [right]) =>
        left.localeCompare(right, undefined, { numeric: true })
      )
      .map(([path, data]) => {
        const sheetNumber =
          Number.parseInt(/sheet(\d+)\.xml$/u.exec(path)?.[1] ?? '', 10) || 1
        return {
          locator: `工作表 ${sheetNumber}`,
          content: extractWorksheetText(
            Buffer.from(data).toString('utf8'),
            sharedStrings
          ),
          blockKind: 'table' as const
        }
      })
      .filter((section) => section.content.length > 0)
    if (worksheets.length > 0) {
      return worksheets
    }
    const content = sharedStrings.filter(Boolean).join('\n')
    return content
      ? [{ locator: '共享字符串', content, blockKind: 'table' }]
      : []
  }

  return Object.entries(archive)
    .filter(([path]) => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
    .sort(([left], [right]) =>
      left.localeCompare(right, undefined, { numeric: true })
    )
    .map(([path, data]) => ({
      locator: `幻灯片 ${
        Number.parseInt(/slide(\d+)\.xml$/u.exec(path)?.[1] ?? '', 10) || 1
      }`,
      content: extractXmlText(Buffer.from(data).toString('utf8')),
      blockKind: 'slide' as const
    }))
    .filter((section) => section.content.length > 0)
}

async function parsePdf(
  buffer: Buffer
): Promise<{ sections: ParsedSection[]; pageCount: number }> {
  const pages = await extractPdfTextPages(buffer)
  return {
    pageCount: pages.length,
    sections: pages
      .filter((page) => page.content.length > 0)
      .map((page) => ({
        locator: `第 ${page.pageNumber} 页`,
        content: page.content,
        pageNumber: page.pageNumber,
        blockKind: 'text'
      }))
  }
}

export type PdfTextPage = {
  pageNumber: number
  content: string
}

export class DocumentTextUnavailableError extends Error {
  constructor(message = '文档中没有可索引的文本内容') {
    super(message)
    this.name = 'DocumentTextUnavailableError'
  }
}

function reconstructPdfText(
  items: readonly unknown[]
): string {
  const lines: string[] = []
  let line: string[] = []
  let previousY: number | undefined
  let previousHeight = 0
  const flush = (): void => {
    const value = line.join(' ').replace(/[ \t]+/gu, ' ').trim()
    if (value) {
      lines.push(value)
    }
    line = []
  }

  for (const candidate of items) {
    if (typeof candidate !== 'object' || candidate === null) {
      continue
    }
    const item = candidate as {
      str?: string
      hasEOL?: boolean
      transform?: ArrayLike<number>
      height?: number
    }
    const value = typeof item.str === 'string' ? item.str.trim() : ''
    const y =
      item.transform && Number.isFinite(item.transform[5])
        ? Number(item.transform[5])
        : undefined
    const height =
      typeof item.height === 'number' && Number.isFinite(item.height)
        ? Math.abs(item.height)
        : 0
    const coordinateLineBreak =
      line.length > 0 &&
      y !== undefined &&
      previousY !== undefined &&
      Math.abs(y - previousY) >
        Math.max(3, previousHeight * 0.8, height * 0.8)
    if (coordinateLineBreak) {
      flush()
    }
    if (value) {
      line.push(value)
    }
    if (item.hasEOL) {
      flush()
      previousY = undefined
      previousHeight = 0
    } else if (y !== undefined) {
      previousY = y
      previousHeight = height
    }
  }
  flush()
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

export async function extractPdfTextPages(
  buffer: Buffer
): Promise<PdfTextPage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // Electron's main process identifies itself as process.type ===
    // "browser", so PDF.js otherwise selects DOM font factories even
    // though no document exists there.
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false
  })
  const document = await loadingTask.promise
  const pages: PdfTextPage[] = []
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const text = await page.getTextContent()
      const content = reconstructPdfText(text.items)
      pages.push({ pageNumber, content })
      page.cleanup()
    }
  } finally {
    await loadingTask.destroy()
  }
  return pages
}

export async function parseDocument(
  name: string,
  buffer: Buffer
): Promise<ParsedDocument> {
  if (buffer.byteLength === 0) {
    throw new Error('文档内容为空')
  }
  if (buffer.byteLength > maximumDocumentBytes) {
    throw new Error('单个文档不能超过 20MB')
  }

  const extension = extname(name).toLowerCase()
  let sections: ParsedSection[]
  let pageCount: number | undefined
  if (extension === '.pdf') {
    const parsedPdf = await parsePdf(buffer)
    sections = parsedPdf.sections
    pageCount = parsedPdf.pageCount
  } else if (['.docx', '.xlsx', '.pptx'].includes(extension)) {
    sections = parseOfficeArchive(buffer, extension)
  } else if (['.html', '.htm'].includes(extension)) {
    const content = convert(decodeText(buffer), {
      wordwrap: false,
      selectors: [
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' }
      ]
    }).trim()
    sections = content ? [{ locator: '网页正文', content }] : []
  } else if (textExtensions.has(extension)) {
    const content = decodeText(buffer).trim()
    sections = content ? [{ locator: '全文', content }] : []
  } else {
    throw new Error(`不支持的文档类型：${extension || '未知'}`)
  }

  const content = sections
    .map((section) => section.content)
    .join('\n\n')
    .slice(0, maximumExtractedCharacters)
  if (!content) {
    throw new DocumentTextUnavailableError()
  }
  return {
    title: name.replace(/\.[^.]+$/, ''),
    sourceFormat: extension || 'unknown',
    content,
    sections,
    warnings: [],
    ...(pageCount === undefined ? {} : { pageCount })
  }
}

function splitNatural(
  content: string,
  maximumLength: number,
  overlap: number
): string[] {
  const chunks: string[] = []
  let offset = 0
  while (offset < content.length) {
    let end = Math.min(offset + maximumLength, content.length)
    if (end < content.length) {
      const lowerBoundary = offset + Math.floor(maximumLength / 2)
      const candidates = [
        content.lastIndexOf('\n\n', end),
        content.lastIndexOf('\n', end),
        content.lastIndexOf('。', end),
        content.lastIndexOf('！', end),
        content.lastIndexOf('？', end),
        content.lastIndexOf('. ', end)
      ]
      const boundary = Math.max(...candidates)
      if (boundary >= lowerBoundary) {
        end = boundary + (content.startsWith('\n\n', boundary) ? 2 : 1)
      }
    }
    const value = content.slice(offset, end).trim()
    if (value) {
      chunks.push(value)
    }
    if (end >= content.length) {
      break
    }
    offset = Math.max(offset + 1, end - overlap)
  }
  return chunks
}

type StructuredSection = {
  locator: string
  heading?: string
  content: string
  pageNumber?: number
  headingPath?: string[]
  blockKind?: DocumentBlockKind
}

function sectionMetadata(
  section: ParsedSection
): Pick<
  StructuredSection,
  'pageNumber' | 'headingPath' | 'blockKind'
> {
  return {
    ...(section.pageNumber === undefined
      ? {}
      : { pageNumber: section.pageNumber }),
    ...(section.headingPath
      ? { headingPath: [...section.headingPath] }
      : {}),
    ...(section.blockKind ? { blockKind: section.blockKind } : {})
  }
}

function chunkMetadata(
  section: Pick<
    StructuredSection,
    'pageNumber' | 'headingPath' | 'blockKind'
  >
): Pick<DocumentChunk, 'pageNumber' | 'headingPath' | 'blockKind'> {
  return {
    ...(section.pageNumber === undefined
      ? {}
      : { pageNumber: section.pageNumber }),
    ...(section.headingPath
      ? { headingPath: [...section.headingPath] }
      : {}),
    ...(section.blockKind ? { blockKind: section.blockKind } : {})
  }
}

function structuredSections(document: ParsedDocument): StructuredSection[] {
  return document.sections.flatMap((section) => {
    const lines = section.content.split(/\r?\n/u)
    const result: StructuredSection[] = []
    let heading: string | undefined
    let headingPath = section.headingPath
      ? [...section.headingPath].slice(0, maximumHeadingDepth)
      : undefined
    const headingHierarchy: Array<string | undefined> = []
    let body: string[] = []
    const flush = (): void => {
      const content = body.join('\n').trim()
      if (content) {
        result.push({
          locator: heading
            ? `${section.locator} · ${heading}`.slice(0, 8_192)
            : section.locator,
          heading,
          content,
          ...sectionMetadata(section),
          ...(headingPath ? { headingPath: [...headingPath] } : {})
        })
      }
      body = []
    }
    for (const line of lines) {
      const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line)
      if (match) {
        flush()
        const level = match[1]?.length ?? 1
        heading = match[2]?.trim().slice(0, maximumHeadingCharacters)
        headingHierarchy.length = level
        headingHierarchy[level - 1] = heading
        headingPath = headingHierarchy.filter(
          (value): value is string => Boolean(value)
        )
        body.push(line)
      } else {
        body.push(line)
      }
    }
    flush()
    return result.length > 0
      ? result
      : [
          {
            locator: section.locator,
            content: section.content.trim(),
            ...sectionMetadata(section)
          }
        ]
  }).filter((section) => section.content.length > 0)
}

function normalizeContextValue(value: string, maximumLength: number): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replaceAll('\\', '／')
    .replaceAll('"', "'")
    .slice(0, maximumLength)
}

/**
 * Builds bounded context for embedding/index input without altering the
 * source-derived chunk content used for display and citations.
 */
export function buildChunkContextPrefix(
  documentTitle: string,
  chunk: Pick<
    DocumentChunk,
    'locator' | 'headingPath' | 'pageNumber' | 'blockKind'
  >
): string {
  const fields: string[] = []
  const title = normalizeContextValue(documentTitle, 120)
  if (title) {
    fields.push(`title="${title}"`)
  }
  const headingPath = normalizeContextValue(
    (chunk.headingPath ?? [])
      .slice(0, maximumHeadingDepth)
      .map((heading) => normalizeContextValue(heading, 80))
      .filter(Boolean)
      .join(' > '),
    180
  )
  if (headingPath) {
    fields.push(`heading="${headingPath}"`)
  }
  if (
    chunk.pageNumber !== undefined &&
    Number.isSafeInteger(chunk.pageNumber) &&
    chunk.pageNumber > 0
  ) {
    fields.push(`page="${chunk.pageNumber}"`)
  }
  const locator = normalizeContextValue(chunk.locator, 120)
  if (locator) {
    fields.push(`locator="${locator}"`)
  }
  if (chunk.blockKind) {
    fields.push(`block="${chunk.blockKind}"`)
  }
  if (fields.length === 0) {
    return ''
  }
  return `${`[context ${fields.join(' ')}]`.slice(
    0,
    maximumChunkContextPrefixCharacters - 1
  )}\n`
}

export function chunkDocumentAdvanced(
  document: ParsedDocument,
  settings: KnowledgeChunkingSettings
): DocumentChunk[] {
  if (settings.mode === 'fixed') {
    return document.sections.flatMap((section) =>
      splitNatural(
        section.content,
        settings.targetCharacters,
        settings.overlapCharacters
      ).map((content) => ({
        position: 0,
        locator: section.locator,
        content,
        ...chunkMetadata(section),
        role: 'standalone' as const
      }))
    ).map((chunk, position) => ({ ...chunk, position }))
  }

  const sections = structuredSections(document)
  if (settings.mode === 'structure') {
    return sections.flatMap((section) =>
      splitNatural(
        section.content,
        settings.targetCharacters,
        settings.overlapCharacters
      ).map((content) => ({
        position: 0,
        locator: section.locator,
        heading: section.heading,
        content,
        ...chunkMetadata(section),
        role: 'standalone' as const
      }))
    ).map((chunk, position) => ({ ...chunk, position }))
  }

  const result: DocumentChunk[] = []
  for (const section of sections) {
    for (const parentContent of splitNatural(
      section.content,
      settings.parentCharacters,
      0
    )) {
      const parentPosition = result.length
      result.push({
        position: parentPosition,
        locator: section.locator,
        heading: section.heading,
        content: parentContent,
        ...chunkMetadata(section),
        role: 'parent'
      })
      const childOverlap = Math.min(
        settings.overlapCharacters,
        Math.floor(settings.childCharacters * 0.4)
      )
      for (const childContent of splitNatural(
        parentContent,
        settings.childCharacters,
        childOverlap
      )) {
        result.push({
          position: result.length,
          locator: section.locator,
          heading: section.heading,
          content: childContent,
          ...chunkMetadata(section),
          role: 'child',
          parentPosition
        })
      }
    }
  }
  return result
}

export const supportedDocumentExtensions = [
  ...textExtensions,
  '.docx',
  '.htm',
  '.html',
  '.pdf',
  '.pptx',
  '.xlsx'
] as const
