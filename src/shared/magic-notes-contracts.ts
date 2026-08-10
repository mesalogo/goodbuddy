import { z } from 'zod'

export const MAGIC_NOTE_MAX_IMAGES = 12
export const MAGIC_NOTE_MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAGIC_NOTE_MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024
export const MAGIC_NOTE_MAX_TEXT_BYTES = 500 * 1024

export function magicNoteImageDataBytes(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const padding = payload.endsWith('==')
    ? 2
    : payload.endsWith('=')
      ? 1
      : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

const magicNoteIdSchema = z.string().uuid()
const imageDataUrlSchema = z
  .string()
  .max(Math.ceil((MAGIC_NOTE_MAX_IMAGE_BYTES * 4) / 3) + 128)
  .regex(
    /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
    '只支持本地 JPEG、PNG、GIF 或 WebP 图片'
  )

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
    indent: z.number().int().min(1).max(8).optional()
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
              z.object({ image: imageDataUrlSchema }).strict()
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
    for (const operation of content.ops) {
      if (typeof operation.insert === 'string') {
        textBytes += encoder.encode(operation.insert).byteLength
      } else {
        imageData.push(operation.insert.image)
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
  entryId: string
  content: string
  updatedAt: string
}
