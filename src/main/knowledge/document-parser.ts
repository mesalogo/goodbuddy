import { convert } from 'html-to-text'
import { unzipSync } from 'fflate'
import { extname } from 'node:path'

export type ParsedSection = {
  locator: string
  content: string
}

export type ParsedDocument = {
  title: string
  content: string
  sections: ParsedSection[]
}

export type DocumentChunk = {
  position: number
  locator: string
  content: string
}

const maximumDocumentBytes = 20 * 1024 * 1024
const maximumExtractedCharacters = 5_000_000
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

  return Object.entries(archive)
    .filter(([path]) => patterns.some((pattern) => pattern.test(path)))
    .sort(([left], [right]) =>
      left.localeCompare(right, undefined, { numeric: true })
    )
    .map(([, data], index) => ({
      locator:
        extension === '.docx'
          ? '正文'
          : extension === '.xlsx'
            ? `工作表内容 ${index + 1}`
            : `幻灯片 ${index + 1}`,
      content: extractXmlText(Buffer.from(data).toString('utf8'))
    }))
    .filter((section) => section.content.length > 0)
}

async function parsePdf(buffer: Buffer): Promise<ParsedSection[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer)
  })
  const document = await loadingTask.promise
  const sections: ParsedSection[] = []
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const text = await page.getTextContent()
      const content = text.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (content) {
        sections.push({
          locator: `第 ${pageNumber} 页`,
          content
        })
      }
      page.cleanup()
    }
  } finally {
    await loadingTask.destroy()
  }
  return sections
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
  if (extension === '.pdf') {
    sections = await parsePdf(buffer)
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
    throw new Error('文档中没有可索引的文本内容')
  }
  return {
    title: name.replace(/\.[^.]+$/, ''),
    content,
    sections
  }
}

export function chunkDocument(
  document: ParsedDocument,
  maximumLength = 1_600,
  overlap = 160
): DocumentChunk[] {
  if (
    maximumLength < 400 ||
    maximumLength > 8_000 ||
    overlap < 0 ||
    overlap >= maximumLength / 2
  ) {
    throw new Error('分块参数无效')
  }

  const chunks: DocumentChunk[] = []
  for (const section of document.sections) {
    let offset = 0
    while (offset < section.content.length) {
      let end = Math.min(offset + maximumLength, section.content.length)
      if (end < section.content.length) {
        const boundary = Math.max(
          section.content.lastIndexOf('\n', end),
          section.content.lastIndexOf('。', end),
          section.content.lastIndexOf('. ', end)
        )
        if (boundary > offset + maximumLength / 2) {
          end = boundary + 1
        }
      }
      const content = section.content.slice(offset, end).trim()
      if (content) {
        chunks.push({
          position: chunks.length,
          locator: section.locator,
          content
        })
      }
      if (end >= section.content.length) {
        break
      }
      offset = Math.max(offset + 1, end - overlap)
    }
  }
  return chunks
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
