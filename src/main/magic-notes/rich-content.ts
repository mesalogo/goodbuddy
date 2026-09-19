import {
  MAGIC_NOTE_MAX_ATTACHMENT_BYTES,
  MAGIC_NOTE_MAX_IMAGE_BYTES,
  MAGIC_NOTE_MAX_VIDEO_BYTES,
  MAGIC_NOTE_VIDEO_TYPES,
  magicNoteDataBytes,
  magicNoteRichContentSchema,
  magicNoteContentSchema,
  type MagicNoteContent,
  type MagicNoteRichContent
} from '../../shared/magic-notes-contracts'

const signatures = {
  jpeg: (bytes: Buffer): boolean =>
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff,
  png: (bytes: Buffer): boolean =>
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ),
  gif: (bytes: Buffer): boolean => {
    const header = bytes.subarray(0, 6).toString('ascii')
    return header === 'GIF87a' || header === 'GIF89a'
  },
  webp: (bytes: Buffer): boolean =>
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
} as const

type SupportedImageType = keyof typeof signatures

function validateImage(dataUrl: string, maxBytes = MAGIC_NOTE_MAX_IMAGE_BYTES): void {
  const match = /^data:image\/(jpeg|png|gif|webp);base64,(.+)$/.exec(
    dataUrl
  )
  if (!match) {
    throw new Error('只支持本地 JPEG、PNG、GIF 或 WebP 图片')
  }
  const type = match[1]! as SupportedImageType
  const payload = match[2]!
  const bytes = Buffer.from(payload, 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > maxBytes
  ) {
    throw new Error('每张图片必须小于 2 MB')
  }
  if (bytes.toString('base64') !== payload) {
    throw new Error('图片数据格式无效')
  }
  if (!signatures[type](bytes)) {
    throw new Error('图片内容与声明的格式不一致')
  }
}

type EmbeddedFile = {
  name: string
  mimeType: string
  size: number
  dataUrl: string
}

function decodeEmbeddedFile(
  file: EmbeddedFile,
  maxBytes: number
): Buffer {
  const separatorIndex = file.dataUrl.indexOf(',')
  const prefix = file.dataUrl.slice(0, separatorIndex)
  const payload = file.dataUrl.slice(separatorIndex + 1)
  if (prefix !== `data:${file.mimeType};base64`) {
    throw new Error('附件内容与声明的类型不一致')
  }
  const bytes = Buffer.from(payload, 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > maxBytes ||
    bytes.length !== file.size
  ) {
    throw new Error('附件内容与声明的大小不一致')
  }
  if (bytes.toString('base64') !== payload) {
    throw new Error('附件数据格式无效')
  }
  return bytes
}

function validateVideo(file: EmbeddedFile): void {
  const bytes = decodeEmbeddedFile(file, MAGIC_NOTE_MAX_VIDEO_BYTES)
  const hasIsoBaseMediaSignature =
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString('ascii') === 'ftyp'
  const signatureMatches =
    (file.mimeType === 'video/mp4' && hasIsoBaseMediaSignature) ||
    (file.mimeType === 'video/quicktime' && hasIsoBaseMediaSignature) ||
    (file.mimeType === 'video/webm' &&
      bytes.length >= 4 &&
      bytes.subarray(0, 4).equals(
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
      )) ||
    (file.mimeType === 'video/ogg' &&
      bytes.length >= 4 &&
      bytes.subarray(0, 4).toString('ascii') === 'OggS')
  if (
    !MAGIC_NOTE_VIDEO_TYPES.includes(
      file.mimeType as (typeof MAGIC_NOTE_VIDEO_TYPES)[number]
    ) ||
    !signatureMatches
  ) {
    throw new Error('视频内容与声明的格式不一致')
  }
}

function validateAttachment(file: EmbeddedFile): void {
  decodeEmbeddedFile(file, MAGIC_NOTE_MAX_ATTACHMENT_BYTES)
}

export function validateMagicNoteRichContent(
  input: unknown
): MagicNoteRichContent {
  const content = magicNoteRichContentSchema.parse(input)
  for (const operation of content.ops) {
    if (typeof operation.insert === 'string') {
      continue
    }
    if (operation.attributes !== undefined) {
      throw new Error('嵌入内容不支持行内格式')
    }
    if ('image' in operation.insert) {
      validateImage(operation.insert.image)
    } else if ('localVideo' in operation.insert) {
      validateVideo(operation.insert.localVideo)
    } else {
      validateAttachment(operation.insert.attachment)
    }
  }
  return content
}

export function magicNotePlainText(
  content: MagicNoteContent
): string {
  if (content.version === 2) {
    const text: string[] = [magicNotePlainText(flowContent(content))]
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { value.forEach(visit); return }
      for (const [key, child] of Object.entries(value)) {
        if ((key === 'text' || key === 'insert') && typeof child === 'string') text.push(child)
        else if (typeof child === 'object') visit(child)
      }
    }
    for (const page of content.pages) {
      if (page.background.type === 'pdf' && page.background.text) text.push(page.background.text)
      visit(page.objects)
    }
    return text.filter(Boolean).join('\n').trim()
  }
  return content.ops
    .map((operation) => insertText(operation.insert))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function magicNoteImageBytes(
  content: MagicNoteContent
): number {
  if (content.version === 2) return canvasResourceBytes(content, true)
  return content.ops.reduce((total, operation) => {
    if (typeof operation.insert === 'string') {
      return total
    }
    return (
      total +
      ('image' in operation.insert
        ? magicNoteDataBytes(operation.insert.image)
        : 0)
    )
  }, 0)
}

export function magicNoteEmbeddedBytes(
  content: MagicNoteContent
): number {
  if (content.version === 2) return canvasResourceBytes(content, false)
  return content.ops.reduce((total, operation) => {
    if (typeof operation.insert === 'string') {
      return total
    }
    if ('image' in operation.insert) {
      return total + magicNoteDataBytes(operation.insert.image)
    }
    if ('localVideo' in operation.insert) {
      return total + magicNoteDataBytes(operation.insert.localVideo.dataUrl)
    }
    return total + magicNoteDataBytes(operation.insert.attachment.dataUrl)
  }, 0)
}

export function magicNotePreview(plainText: string): string {
  return plainText.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export type MagicNoteChecklistItem = {
  sourceIndex: number
  title: string
  completed: boolean
}

function isChecklist(
  value: MagicNoteRichContent['ops'][number]['attributes']
): value is NonNullable<
  MagicNoteRichContent['ops'][number]['attributes']
> & { list: 'checked' | 'unchecked' } {
  return value?.list === 'checked' || value?.list === 'unchecked'
}

export function magicNoteChecklistItems(
  content: MagicNoteContent
): MagicNoteChecklistItem[] {
  if (content.version === 2) return magicNoteChecklistItems(flowContent(content))
  const items: MagicNoteChecklistItem[] = []
  let line = ''
  let sourceIndex = 0
  for (const operation of content.ops) {
    if (typeof operation.insert !== 'string') {
      if ('canvasPageBreak' in operation.insert) continue
      line += insertText(operation.insert)
      continue
    }
    const segments = operation.insert.split(/(\n)/u)
    for (const segment of segments) {
      if (segment !== '\n') {
        line += segment
        continue
      }
      if (isChecklist(operation.attributes)) {
        if (line.trim()) {
          items.push({
            sourceIndex,
            title: line.replace(/\s+/gu, ' ').trim().slice(0, 120),
            completed: operation.attributes.list === 'checked'
          })
        }
        sourceIndex += 1
      }
      line = ''
    }
  }
  return items
}

export function setMagicNoteChecklistCompletion(
  content: MagicNoteContent,
  targetIndex: number,
  completed: boolean
): MagicNoteContent {
  if (content.version === 2) {
    if (!content.flow) return content
    const updated = setMagicNoteChecklistCompletion(flowContent(content), targetIndex, completed) as MagicNoteRichContent
    return { ...content, flow: { ...content.flow, ops: updated.ops } }
  }
  let sourceIndex = 0
  return {
    ...content,
    ops: content.ops.flatMap((operation) => {
      if (
        typeof operation.insert !== 'string' ||
        !operation.insert.includes('\n')
      ) {
        return [operation]
      }
      const segments = operation.insert.match(/[^\n]*\n|[^\n]+$/gu) ?? []
      return segments.map((insert) => {
        if (!insert.endsWith('\n') || !isChecklist(operation.attributes)) {
          return { ...operation, insert }
        }
        const currentIndex = sourceIndex
        sourceIndex += 1
        return currentIndex === targetIndex
          ? {
              ...operation,
              insert,
              attributes: {
                ...operation.attributes,
                list: completed ? 'checked' : 'unchecked'
              }
            }
          : { ...operation, insert }
      })
    })
  }
}

function flowContent(content: Extract<MagicNoteContent, { version: 2 }>): MagicNoteRichContent {
  // Checklist code only interprets Quill text and list attributes; other fields survive writeback.
  return { version: 1, ops: (content.flow?.ops ?? []) as MagicNoteRichContent['ops'] }
}

function insertText(insert: string | Record<string, unknown>): string {
  if (typeof insert === 'string') return insert
  if ('canvasPageBreak' in insert) return '\n'
  if ('image' in insert) return '[图片]'
  for (const [key, label] of [['localVideo', '视频'], ['attachment', '附件']] as const) {
    const value = insert[key]
    if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') return `[${label}：${value.name}]`
  }
  return '[嵌入内容]'
}

function canvasResourceBytes(content: Extract<MagicNoteContent, { version: 2 }>, imagesOnly: boolean): number {
  let total = 0
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && /^data:[^;]+;base64,/.test(value)) {
      if (!imagesOnly || value.startsWith('data:image/')) total += magicNoteDataBytes(value)
    } else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  visit(content)
  return total
}

export function validateMagicNoteContent(input: unknown): MagicNoteContent {
  const content = magicNoteContentSchema.parse(input)
  if (content.version === 1) return validateMagicNoteRichContent(content)
  const assets = new Map(content.assets.map((asset) => [asset.id, asset]))
  if (assets.size !== content.assets.length) throw new Error('画布资源 ID 重复')
  if (new Set(content.pages.map((page) => page.id)).size !== content.pages.length) throw new Error('画布页面 ID 重复')
  for (const asset of content.assets) {
    const bytes = decodeEmbeddedFile({ ...asset, size: magicNoteDataBytes(asset.dataUrl) }, Number.MAX_SAFE_INTEGER)
    if (asset.mimeType.startsWith('image/')) validateImage(asset.dataUrl, Number.MAX_SAFE_INTEGER)
    if (asset.mimeType === 'application/pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF 内容与声明的格式不一致')
  }
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('data:image/')) validateImage(value, Number.MAX_SAFE_INTEGER)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (record.assetId !== undefined && (typeof record.assetId !== 'string' || !assets.has(record.assetId))) throw new Error('画布引用的资源不存在')
      if (record.type === 'Image' || record.type === 'image' || record.canvasKind === 'image') {
        if (record.assetId !== undefined) {
          if (!assets.get(record.assetId as string)?.mimeType.startsWith('image/')) throw new Error('图片资源类型错误')
        } else if (typeof record.src !== 'string') throw new Error('图片需要内嵌数据或资源 ID')
        if (record.src !== undefined) validateImage(String(record.src), Number.MAX_SAFE_INTEGER)
      }
      Object.values(record).forEach(visit)
    }
  }
  for (const page of content.pages) {
    if (page.background.type === 'pdf' && assets.get(page.background.assetId)?.mimeType !== 'application/pdf') throw new Error('PDF 背景资源不存在或类型错误')
    visit(page.objects)
  }
  visit(content.flow)
  return content
}
