import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { documentResultSchema, type DocumentResult } from '../shared/document-result-contracts'
import type { DocumentParsingSettings } from '../shared/document-parsing-contracts'
import type { ParsedDocument } from './knowledge/document-parser'
import { hasExtractedDocumentText } from './document-extracted-text'

export function parsedCompleteness(parsed: ParsedDocument): DocumentResult['completeness'] {
  return !hasExtractedDocumentText(parsed.content) && parsed.images?.length
    ? 'images-only' : parsed.warnings.length ? 'partial' : 'complete'
}

export function originalImageMime(data: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg'
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

export class DocumentResultStorage {
  private readonly results = new Map<string, { directory: string; original: string }>()
  private readonly persistentLookups: Array<(id: string) => { directory: string; original: string } | undefined> = []
  constructor(private readonly root: string) {}

  setPersistentLookup(lookup: (id: string) => { directory: string; original: string } | undefined): void {
    this.persistentLookups.unshift(lookup)
  }

  detach(id: string): { directory: string; original: string } {
    const location = this.require(id)
    this.results.delete(id)
    return location
  }

  isTemporaryResult(id: string): boolean { return this.results.has(id) }

  async move(id: string, directory: string): Promise<void> {
    const current = this.require(id)
    await mkdir(dirname(directory), { recursive: true })
    await rename(current.directory, directory)
    this.results.set(id, { directory, original: dirname(current.original) === current.directory ? join(directory, basename(current.original)) : current.original })
  }

  async save(name: string, original: Buffer | undefined, parsed: ParsedDocument, settings: DocumentParsingSettings, durationMs: number, originalPathOverride?: string, signal?: AbortSignal): Promise<DocumentResult> {
    signal?.throwIfAborted()
    const id = randomUUID()
    const directory = join(this.root, id)
    const mime = original ? originalImageMime(original) : undefined
    const originalPath = originalPathOverride ?? join(directory, `original${mime ? `.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}` : extname(name).toLowerCase()}`)
    this.results.set(id, { directory, original: originalPath })
    try {
      await mkdir(join(directory, 'images'), { recursive: true })
      if (original) await writeFile(originalPath, original)
      const images = await Promise.all((parsed.images ?? []).map(async ({ data, ...image }) => {
        await writeFile(join(directory, 'images', image.id), data)
        return { ...image, size: data.byteLength }
      }))
      const result = documentResultSchema.parse({
        id, fileName: name, sourceFormat: parsed.sourceFormat, content: parsed.content,
        sections: parsed.sections, images, pageCount: parsed.pageCount,
        missingImages: parsed.missingImages ?? [],
        warnings: parsed.warnings,
        completeness: parsedCompleteness(parsed),
        parsedAt: new Date().toISOString(), durationMs, settings, restructure: parsed.restructure
      })
      await writeFile(join(directory, 'parsed.md'), parsed.content)
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(result))
      signal?.throwIfAborted()
      return result
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      this.results.delete(id)
      throw error
    }
  }

  private require(id: string): { directory: string; original: string } {
    const temporary = this.results.get(id)
    if (temporary) return temporary
    for (const lookup of this.persistentLookups) {
      const result = lookup(id)
      if (result) return result
    }
    throw new Error('解析结果已关闭或不可用')
  }

  async get(id: string): Promise<DocumentResult> {
    return documentResultSchema.parse(JSON.parse(await readFile(join(this.require(id).directory, 'manifest.json'), 'utf8')))
  }

  async image(id: string, imageId: string, thumbnail = false): Promise<string> {
    const result = await this.get(id)
    const image = result.images.find((candidate) => candidate.id === imageId)
    if (!image) throw new Error('解析图片不存在')
    const data = await readFile(join(this.require(id).directory, 'images', imageId))
    if (thumbnail) {
      const source = await loadImage(data)
      const scale = Math.min(1, 640 / Math.max(source.width, source.height))
      const canvas = createCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)))
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(source, 0, 0, canvas.width, canvas.height)
      return `data:image/jpeg;base64,${(await canvas.encode('jpeg', 80)).toString('base64')}`
    }
    return `data:${image.mimeType};base64,${data.toString('base64')}`
  }

  original(id: string): string { return this.require(id).original }

  async release(id: string): Promise<void> {
    const result = this.results.get(id)
    if (!result) return
    await rm(result.directory, { recursive: true, force: true })
    this.results.delete(id)
  }

  async close(): Promise<void> {
    await Promise.all([...this.results.keys()].map((id) => this.release(id)))
  }
}
