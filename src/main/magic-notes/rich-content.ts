import {
  MAGIC_NOTE_MAX_IMAGE_BYTES,
  magicNoteImageDataBytes,
  magicNoteRichContentSchema,
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

function validateImage(dataUrl: string): void {
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
    bytes.length > MAGIC_NOTE_MAX_IMAGE_BYTES
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

export function validateMagicNoteRichContent(
  input: unknown
): MagicNoteRichContent {
  const content = magicNoteRichContentSchema.parse(input)
  for (const operation of content.ops) {
    if (typeof operation.insert === 'string') {
      continue
    }
    if (operation.attributes !== undefined) {
      throw new Error('图片嵌入不支持行内格式')
    }
    validateImage(operation.insert.image)
  }
  return content
}

export function magicNotePlainText(
  content: MagicNoteRichContent
): string {
  return content.ops
    .map((operation) =>
      typeof operation.insert === 'string'
        ? operation.insert
        : '[图片]'
    )
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function magicNoteImageBytes(
  content: MagicNoteRichContent
): number {
  return content.ops.reduce((total, operation) => {
    if (typeof operation.insert === 'string') {
      return total
    }
    return total + magicNoteImageDataBytes(operation.insert.image)
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
  content: MagicNoteRichContent
): MagicNoteChecklistItem[] {
  const items: MagicNoteChecklistItem[] = []
  let line = ''
  let sourceIndex = 0
  for (const operation of content.ops) {
    if (typeof operation.insert !== 'string') {
      line += '[图片]'
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
  content: MagicNoteRichContent,
  targetIndex: number,
  completed: boolean
): MagicNoteRichContent {
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
