import { z } from 'zod'

export const MAGIC_NOTE_MAX_IMAGES = 12
export const MAGIC_NOTE_MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAGIC_NOTE_MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024
export const MAGIC_NOTE_MAX_VIDEOS = 4
export const MAGIC_NOTE_MAX_VIDEO_BYTES = 16 * 1024 * 1024
export const MAGIC_NOTE_MAX_ATTACHMENTS = 8
export const MAGIC_NOTE_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const MAGIC_NOTE_MAX_TOTAL_EMBED_BYTES = 32 * 1024 * 1024
export const MAGIC_NOTE_MAX_NOTE_EMBED_BYTES = 64 * 1024 * 1024
export const MAGIC_NOTE_MAX_TEXT_BYTES = 500 * 1024

export const MAGIC_NOTE_VIDEO_TYPES = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime'
] as const

export const MAGIC_NOTE_TEXT_COLORS = [
  '#000000',
  '#e60000',
  '#ff9900',
  '#ffff00',
  '#008a00',
  '#0066cc',
  '#9933ff',
  '#ffffff',
  '#facccc',
  '#ffebcc',
  '#ffffcc',
  '#cce8cc',
  '#cce0f5',
  '#ebd6ff',
  '#bbbbbb',
  '#f06666',
  '#ffc266',
  '#ffff66',
  '#66b966',
  '#66a3e0',
  '#c285ff',
  '#888888',
  '#a10000',
  '#b26b00',
  '#b2b200',
  '#006100',
  '#0047b2',
  '#6b24b2',
  '#444444',
  '#5c0000',
  '#663d00',
  '#666600',
  '#003700',
  '#002966',
  '#3d1466'
] as const

export function magicNoteDataBytes(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const padding = payload.endsWith('==')
    ? 2
    : payload.endsWith('=')
      ? 1
      : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

export const magicNoteImageDataBytes = magicNoteDataBytes

const magicNoteIdSchema = z.string().uuid()
const imageDataUrlSchema = z
  .string()
  .max(Math.ceil((MAGIC_NOTE_MAX_IMAGE_BYTES * 4) / 3) + 128)
  .regex(
    /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
    '只支持本地 JPEG、PNG、GIF 或 WebP 图片'
  )

const embeddedFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^<>:"/\\|?*]+$/u, '附件名称包含不支持的字符')
  .refine(
    (name) =>
      [...name].every((character) => {
        const code = character.charCodeAt(0)
        return code >= 32 && code !== 127
      }),
    { message: '附件名称包含不支持的字符' }
  )
  .refine((name) => name !== '.' && name !== '..', {
    message: '附件名称无效'
  })

const embeddedMimeTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(127)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u,
    '附件类型无效'
  )

function embeddedDataUrlSchema(maxBytes: number): z.ZodString {
  return z
    .string()
    .max(Math.ceil((maxBytes * 4) / 3) + 256)
    .regex(
      /^data:[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*;base64,[A-Za-z0-9+/]+={0,2}$/u,
      '只支持本地附件数据'
    )
}

const embeddedFileFields = {
  name: embeddedFileNameSchema,
  mimeType: embeddedMimeTypeSchema,
  size: z.number().int().positive()
}

const localVideoSchema = z
  .object({
    ...embeddedFileFields,
    mimeType: z.enum(MAGIC_NOTE_VIDEO_TYPES),
    size: z.number().int().positive().max(MAGIC_NOTE_MAX_VIDEO_BYTES),
    dataUrl: embeddedDataUrlSchema(MAGIC_NOTE_MAX_VIDEO_BYTES)
  })
  .strict()

const attachmentSchema = z
  .object({
    ...embeddedFileFields,
    size: z.number().int().positive().max(MAGIC_NOTE_MAX_ATTACHMENT_BYTES),
    dataUrl: embeddedDataUrlSchema(MAGIC_NOTE_MAX_ATTACHMENT_BYTES)
  })
  .strict()

const magicNoteAttributesSchema = z
  .object({
    bold: z.literal(true).optional(),
    italic: z.literal(true).optional(),
    underline: z.literal(true).optional(),
    strike: z.literal(true).optional(),
    code: z.literal(true).optional(),
    header: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    blockquote: z.literal(true).optional(),
    'code-block': z.literal(true).optional(),
    list: z
      .enum(['ordered', 'bullet', 'checked', 'unchecked'])
      .optional(),
    align: z.enum(['center', 'right', 'justify']).optional(),
    indent: z.number().int().min(1).max(8).optional(),
    size: z.enum(['small', 'large', 'huge']).optional(),
    color: z.enum(MAGIC_NOTE_TEXT_COLORS).optional()
  })
  .strict()

export const magicNoteRichContentSchema = z
  .object({
    version: z.literal(1),
    ops: z
      .array(
        z
          .object({
            insert: z.union([
              z.string().max(200_000),
              z.object({ image: imageDataUrlSchema }).strict(),
              z.object({ localVideo: localVideoSchema }).strict(),
              z.object({ attachment: attachmentSchema }).strict()
            ]),
            attributes: magicNoteAttributesSchema.optional()
          })
          .strict()
      )
      .min(1)
      .max(10_000)
  })
  .strict()
  .superRefine((content, context) => {
    const encoder = new TextEncoder()
    let textBytes = 0
    const imageData: string[] = []
    const videoData: string[] = []
    const attachmentData: string[] = []
    for (const operation of content.ops) {
      if (typeof operation.insert === 'string') {
        textBytes += encoder.encode(operation.insert).byteLength
      } else if ('image' in operation.insert) {
        imageData.push(operation.insert.image)
      } else if ('localVideo' in operation.insert) {
        videoData.push(operation.insert.localVideo.dataUrl)
      } else {
        attachmentData.push(operation.insert.attachment.dataUrl)
      }
    }
    if (textBytes > MAGIC_NOTE_MAX_TEXT_BYTES) {
      context.addIssue({
        code: 'custom',
        message: '每条记录的文字内容不能超过 500 KB'
      })
    }
    if (imageData.length > MAGIC_NOTE_MAX_IMAGES) {
      context.addIssue({
        code: 'custom',
        message: `每条记录最多包含 ${MAGIC_NOTE_MAX_IMAGES} 张图片`
      })
    }
    const estimatedBytes = imageData.reduce(
      (total, dataUrl) => total + magicNoteImageDataBytes(dataUrl),
      0
    )
    if (estimatedBytes > MAGIC_NOTE_MAX_TOTAL_IMAGE_BYTES) {
      context.addIssue({
        code: 'custom',
        message: '一篇笔记中的图片总大小不能超过 8 MB'
      })
    }
    if (videoData.length > MAGIC_NOTE_MAX_VIDEOS) {
      context.addIssue({
        code: 'custom',
        message: `每条记录最多包含 ${MAGIC_NOTE_MAX_VIDEOS} 个视频`
      })
    }
    if (attachmentData.length > MAGIC_NOTE_MAX_ATTACHMENTS) {
      context.addIssue({
        code: 'custom',
        message: `每条记录最多包含 ${MAGIC_NOTE_MAX_ATTACHMENTS} 个附件`
      })
    }
    const embeddedBytes = [...imageData, ...videoData, ...attachmentData].reduce(
      (total, dataUrl) => total + magicNoteDataBytes(dataUrl),
      0
    )
    if (embeddedBytes > MAGIC_NOTE_MAX_TOTAL_EMBED_BYTES) {
      context.addIssue({
        code: 'custom',
        message: '每条记录中的图片、视频和附件总大小不能超过 32 MB'
      })
    }
  })

export type MagicNoteRichContent = z.infer<
  typeof magicNoteRichContentSchema
>

export const magicNoteCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(100)
  })
  .strict()
export type MagicNoteCreateInput = z.infer<typeof magicNoteCreateSchema>

export const magicNoteUpdateSchema = z
  .object({
    noteId: magicNoteIdSchema,
    title: z.string().trim().min(1).max(100).optional(),
    pinned: z.boolean().optional(),
    expectedRevision: z.number().int().nonnegative()
  })
  .strict()
  .refine((input) => input.title !== undefined || input.pinned !== undefined, {
    message: '没有可更新的笔记字段'
  })
export type MagicNoteUpdateInput = z.infer<typeof magicNoteUpdateSchema>

export const magicNoteDeleteSchema = z
  .object({
    noteId: magicNoteIdSchema
  })
  .strict()

export const magicNoteEntryCreateSchema = z
  .object({
    noteId: magicNoteIdSchema,
    content: magicNoteRichContentSchema
  })
  .strict()
export type MagicNoteEntryCreateInput = z.infer<
  typeof magicNoteEntryCreateSchema
>

export const magicNoteEntryUpdateSchema = z
  .object({
    entryId: magicNoteIdSchema,
    content: magicNoteRichContentSchema,
    expectedRevision: z.number().int().nonnegative()
  })
  .strict()
export type MagicNoteEntryUpdateInput = z.infer<
  typeof magicNoteEntryUpdateSchema
>

export const magicNoteEntryDeleteSchema = z
  .object({
    entryId: magicNoteIdSchema
  })
  .strict()

export const magicNoteCommentDirectionSchema = z.enum([
  'general',
  'expand',
  'polish',
  'challenge',
  'brainstorm'
])
export type MagicNoteCommentDirection = z.infer<
  typeof magicNoteCommentDirectionSchema
>

export const magicNoteCommentFormatSchema = z.enum([
  'combined',
  'narrative',
  'structured'
])
export type MagicNoteCommentFormat = z.infer<
  typeof magicNoteCommentFormatSchema
>

export const magicNoteAnalysisOptionsSchema = z
  .object({
    requestId: z.string().uuid(),
    direction: magicNoteCommentDirectionSchema,
    format: magicNoteCommentFormatSchema
  })
  .strict()
export type MagicNoteAnalysisOptions = z.infer<
  typeof magicNoteAnalysisOptionsSchema
>

export const magicNoteAnalyzeSchema = z
  .object({
    entryId: magicNoteIdSchema,
    ...magicNoteAnalysisOptionsSchema.shape
  })
  .strict()

export const magicNoteDraftAnalyzeSchema = z
  .object({
    content: magicNoteRichContentSchema,
    ...magicNoteAnalysisOptionsSchema.shape
  })
  .strict()

export const magicTodoIdSchema = z
  .object({
    todoId: magicNoteIdSchema,
    ...magicNoteAnalysisOptionsSchema.shape
  })
  .strict()

export const magicTodoUpdateSchema = z
  .object({
    todoId: magicNoteIdSchema,
    completed: z.boolean(),
    expectedRevision: z.number().int().nonnegative()
  })
  .strict()
export type MagicTodoUpdateInput = z.infer<
  typeof magicTodoUpdateSchema
>

export type MagicNoteCommentKind =
  | 'narrative'
  | 'summary'
  | 'suggestion'
  | 'warning'

export type MagicNoteComment = {
  id: string
  kind: MagicNoteCommentKind
  content: string
  direction?: MagicNoteCommentDirection
  format?: MagicNoteCommentFormat
  analyzedAt?: string
}

export type MagicNoteAnalysisStreamEvent = {
  requestId: string
  type: 'text'
  delta: string
  direction: MagicNoteCommentDirection
  format: 'combined' | 'narrative'
}

export type MagicNoteEntry = {
  id: string
  noteId: string
  content: MagicNoteRichContent
  plainText: string
  comments: MagicNoteComment[]
  analyzedAt?: string
  revision: number
  createdAt: string
  updatedAt: string
}

export type MagicNoteSummary = {
  id: string
  title: string
  preview: string
  entryCount: number
  pinned: boolean
  revision: number
  createdAt: string
  updatedAt: string
}

export type MagicNoteDetail = MagicNoteSummary & {
  entries: MagicNoteEntry[]
}

export type MagicNotesSnapshot = {
  notes: MagicNoteSummary[]
}

export type MagicTodoItem = {
  id: string
  noteId: string
  entryId: string
  noteTitle: string
  sourceIndex: number
  source: 'note'
  title: string
  instructions: string
  completed: boolean
  comments: MagicNoteComment[]
  analyzedAt?: string
  revision: number
  createdAt: string
  updatedAt: string
}

export type MagicTodoUpdateResult = {
  todo: MagicTodoItem
  note: MagicNoteDetail
}

export type MagicTodosSnapshot = {
  todos: MagicTodoItem[]
}

export type MagicNoteDraftAnalysis = {
  id: string
  comments: MagicNoteComment[]
  analyzedAt: string
}

export type MagicNoteSearchResult = {
  noteId: string
  noteTitle: string
  entryId?: string
  content: string
  updatedAt: string
}
