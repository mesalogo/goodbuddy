import { randomUUID } from 'node:crypto'
import { loadImage } from '@napi-rs/canvas'
import { convert } from 'html-to-text'
import { z } from 'zod'
import {
  maximumDocumentExtractedCharacters,
  type httpOcrSettingsSchema
} from '../shared/document-parsing-contracts'
import type { ParsedDocument, ParsedSection } from './knowledge/document-parser'

type Settings = z.infer<typeof httpOcrSettingsSchema>
export type ParsedDocumentImage = {
  id: string
  pageNumber: number
  key: string
  locator?: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  width: number
  height: number
  data: Buffer
}

const maximumResponseBytes = 32 * 1024 * 1024
const pageSchema = z.object({
  prunedResult: z.record(z.string(), z.unknown()),
  markdown: z.object({
    text: z.string().max(maximumDocumentExtractedCharacters),
    images: z.record(z.string(), z.string()).nullish()
  })
})
const responseSchema = z.object({
  errorCode: z.number().optional(),
  result: z.object({ layoutParsingResults: z.array(pageSchema).min(1).max(500) })
})

export class HttpDocumentOcr {
  constructor(private readonly settings: Settings, private readonly apiKey?: string) {}

  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    if (!this.settings.baseUrl) throw new Error('请在文档解析设置中保存 HTTP OCR 服务地址')
    if (this.settings.authentication === 'bearer' && !this.apiKey) {
      throw new Error('HTTP OCR Bearer 凭据未配置')
    }
    const timeout = AbortSignal.timeout(this.settings.timeoutSeconds * 1000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(`${this.settings.baseUrl.replace(/\/+$/u, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.settings.authentication === 'bearer' ? { Authorization: `Bearer ${this.apiKey}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: combined,
      redirect: 'error'
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`HTTP OCR ${path}：HTTP ${response.status}`)
    }
    if (!response.body) throw new Error('HTTP OCR 返回空响应')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > maximumResponseBytes) throw new Error('HTTP OCR 响应超过 32 MiB 限制')
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    combined.throwIfAborted()
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const envelope = z.object({ errorCode: z.number().optional() }).passthrough().parse(value)
    if (envelope.errorCode && envelope.errorCode !== 0) {
      throw new Error(`HTTP OCR ${path}：服务错误 ${envelope.errorCode}；请检查部署模型和所选高级选项`)
    }
    return value
  }

  async check(): Promise<{ checkedAt: string; declaredOptions: string[] }> {
    await this.request('/health')
    const schema = z.object({ components: z.object({ schemas: z.record(z.string(), z.object({ properties: z.record(z.string(), z.unknown()).optional() }).passthrough()) }).optional() })
      .parse(await this.request('/openapi.json'))
    return { checkedAt: new Date().toISOString(), declaredOptions: Object.keys(schema.components?.schemas.InferRequest?.properties ?? {}) }
  }

  async recognize(
    data: Buffer,
    fileType: 0 | 1,
    sourcePages: number[],
    signal?: AbortSignal
  ): Promise<Pick<ParsedDocument, 'sections' | 'images' | 'missingImages' | 'warnings' | 'restructure'>> {
    const labels = this.settings.filterMode === 'default' ? undefined
      : this.settings.filterMode === 'all' ? [] : this.settings.ignoredLabels
    const response = responseSchema.parse(await this.request('/layout-parsing', {
      file: data.toString('base64'), fileType,
      ...this.settings.options,
      ...(labels === undefined ? {} : { markdownIgnoreLabels: labels }),
      returnMarkdownImages: true, visualize: false
    }, signal))
    const pages = response.result.layoutParsingResults
    if (pages.length !== sourcePages.length) throw new Error('HTTP OCR 返回页数与输入不符，无法确定来源页码')
    const warnings: string[] = []
    const images: ParsedDocumentImage[] = []
    const missingImages: NonNullable<ParsedDocument['missingImages']> = []
    const sections: ParsedSection[] = []
    let imageBytes = 0
    let characters = 0
    for (const [index, page] of pages.entries()) {
      signal?.throwIfAborted()
      const pageNumber = sourcePages[index]!
      let content = page.markdown.text
      const references = [...content.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)]
      for (const key of new Set(references.map((match) => match[1] ?? match[2]!))) {
        signal?.throwIfAborted()
        const encoded = page.markdown.images?.[key]
        let replacement: string
        try {
          if (!encoded || /^https?:/iu.test(encoded)) throw new Error('未返回内联图片字节')
          const raw = encoded.replace(/^data:image\/(?:jpeg|png|webp);base64,/iu, '')
          if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(raw)) throw new Error('Base64 无效')
          const bytes = Buffer.from(raw, 'base64')
          if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error('图片超过 12 MiB 或为空')
          const mimeType = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg'
            : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
              : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined
          if (!mimeType) throw new Error('图片格式不支持')
          const image = await loadImage(bytes)
          if (!image.width || !image.height || image.width * image.height > 40_000_000) throw new Error('图片尺寸无效或超过 4000 万像素')
          imageBytes += bytes.length
          if (imageBytes > maximumResponseBytes) throw new Error('解码图片总量超过 32 MiB')
          const id = randomUUID()
          images.push({ id, pageNumber, key, mimeType, width: image.width, height: image.height, data: bytes })
          replacement = `![第 ${pageNumber} 页图片](asset:${id})`
        } catch (error) {
          signal?.throwIfAborted()
          missingImages.push({ pageNumber, key, reason: error instanceof Error ? error.message : '解码失败' })
          const warning = `第 ${pageNumber} 页图片未保存：${error instanceof Error ? error.message : '解码失败'}`
          warnings.push(warning)
          replacement = `[${warning}]`
        }
        for (const reference of references.filter((match) => (match[1] ?? match[2]) === key)) {
          content = content.replace(reference[0], replacement)
        }
      }
      characters += content.length
      if (characters > maximumDocumentExtractedCharacters) throw new Error('HTTP OCR 文字超过 5,000,000 字符')
      sections.push({ locator: `第 ${pageNumber} 页`, pageNumber, sourcePages: [pageNumber], content, method: 'ocr' })
      if (!content.trim()) warnings.push(`第 ${pageNumber} 页未返回文字或有效插图`)
    }
    // Restructuring is only meaningful for contiguous original pages.
    let restructure: ParsedDocument['restructure']
    if (this.settings.mergeTables || this.settings.relevelTitles) {
      if (sourcePages.some((page, index) => index > 0 && page !== sourcePages[index - 1]! + 1)) {
        throw new Error('不连续来源页不能进行跨页整理')
      }
      signal?.throwIfAborted()
      try {
      const result = responseSchema.parse(await this.request('/restructure-pages', {
        pages: pages.map((page) => ({ prunedResult: page.prunedResult, markdownImages: page.markdown.images ?? {} })),
        mergeTables: this.settings.mergeTables, relevelTitles: this.settings.relevelTitles,
        ...(this.settings.options.prettifyMarkdown === undefined ? {} : { prettifyMarkdown: this.settings.options.prettifyMarkdown }),
        ...(this.settings.options.showFormulaNumber === undefined ? {} : { showFormulaNumber: this.settings.options.showFormulaNumber }),
        returnMarkdownImages: true,
        concatenatePages: false
      }, signal))
      const changed = JSON.stringify(result.result.layoutParsingResults.map((page) => page.markdown.text)) !== JSON.stringify(pages.map((page) => page.markdown.text))
      restructure = { changed, sourcePages }
      if (changed) {
        try {
          const merged: string[] = []
          for (const page of result.result.layoutParsingResults) {
            let content = page.markdown.text
            const references = [...content.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)]
            for (const reference of references) {
              const key = reference[1] ?? reference[2]!
              const encoded = page.markdown.images?.[key]
              if (!encoded || /^https?:/iu.test(encoded)) throw new Error('重组图片缺少内联数据')
              const bytes = Buffer.from(encoded.replace(/^data:image\/(?:jpeg|png|webp);base64,/iu, ''), 'base64')
              const matches = images.filter((image) => image.data.equals(bytes))
              if (matches.length !== 1) throw new Error('重组图片不能唯一对应原始页面')
              content = content.replace(reference[0], `![第 ${matches[0]!.pageNumber} 页图片](asset:${matches[0]!.id})`)
            }
            merged.push(content)
          }
          const content = merged.join('\n\n')
          if (!content.trim() || content.length > maximumDocumentExtractedCharacters) throw new Error('重组正文为空或超过容量限制')
          // The grouped section represents all input pages, never a guessed single page.
          sections.splice(0, sections.length, { locator: `跨页整理 · 来源页 ${sourcePages.join('、')}`, sourcePages, content, method: 'ocr' })
        } catch (error) {
          warnings.push(`跨页整理未完成，保留逐页结果：${error instanceof Error ? error.message : '来源映射失败'}`)
        }
      }
      } catch (error) {
        signal?.throwIfAborted()
        warnings.push(`跨页整理请求失败，保留逐页结果：${error instanceof Error ? error.message : '请求失败'}`)
      }
    }
    signal?.throwIfAborted()
    const text = sections.map((section) => convert(section.content.replace(/!\[[^\]]*\]\([^)]*\)/gu, '').replace(/\[第 \d+ 页图片未保存：[^\]]*\]/gu, ''), { wordwrap: false })).join('').trim()
    if (!text && images.length === 0) throw new Error('HTTP OCR 未返回文字或有效图片')
    return { sections, images, missingImages, warnings, ...(restructure ? { restructure } : {}) }
  }
}
