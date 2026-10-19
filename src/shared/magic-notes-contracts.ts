import { z } from 'zod'

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

function embeddedDataUrlSchema(): z.ZodString {
  return z
    .string()
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
    dataUrl: embeddedDataUrlSchema()
  })
  .strict()

const attachmentSchema = z
  .object({
    ...embeddedFileFields,
    dataUrl: embeddedDataUrlSchema()
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
    color: z.enum(MAGIC_NOTE_TEXT_COLORS).optional(),
    table: z.string().min(1).max(64).optional()
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
              z.string(),
              z.object({ image: imageDataUrlSchema }).strict(),
              z.object({ localVideo: localVideoSchema }).strict(),
              z.object({ attachment: attachmentSchema }).strict()
            ]),
            attributes: magicNoteAttributesSchema.optional()
          })
          .strict()
      )
      .min(1)
  })
  .strict()

export type MagicNoteRichContent = z.infer<
  typeof magicNoteRichContentSchema
>

const canvasDataUrlSchema = embeddedDataUrlSchema()
export const magicNoteCanvasContentSchema = z.object({
  version: z.literal(2),
  kind: z.literal('paged-canvas'),
  pages: z.array(z.object({
    id: z.string().min(1),
    width: z.number().finite().positive().max(3000),
    height: z.number().finite().positive().max(3000),
    background: z.union([
      z.object({ type: z.literal('template'), template: z.enum(['blank', 'ruled', 'grid', 'dot']) }).strict(),
      z.object({ type: z.literal('pdf'), assetId: z.string().min(1), pageNumber: z.number().int().positive(), text: z.string().optional() }).strict()
    ]),
    objects: z.array(z.record(z.string(), z.unknown())),
    flowAuto: z.boolean().optional()
  }).strict()).min(1),
  flow: z.object({ version: z.literal(1).optional(), ops: z.array(z.object({
    insert: z.union([z.string(), z.record(z.string(), z.unknown())]),
    attributes: z.record(z.string(), z.unknown()).optional()
  }).strict()) }).strict().optional(),
  assets: z.array(z.object({
    id: z.string().min(1), name: embeddedFileNameSchema,
    mimeType: embeddedMimeTypeSchema, dataUrl: canvasDataUrlSchema
  }).strict()),
  preview: z.string().optional()
}).strict()

export type MagicNoteCanvasContent = z.infer<typeof magicNoteCanvasContentSchema>
export const magicNoteContentSchema = z.union([magicNoteRichContentSchema, magicNoteCanvasContentSchema])
export type MagicNoteContent = z.infer<typeof magicNoteContentSchema>
export type MagicNoteAnalysisInputMode = 'text' | 'images' | 'canvas-images' | 'text-fallback'

export const magicNoteSourceSchema = z.object({
  kind: z.enum(['message', 'conversation']),
  conversationId: magicNoteIdSchema,
  messageIds: z.array(magicNoteIdSchema).min(1),
  capturedAt: z.string().datetime(),
  conversationTitle: z.string(),
  projectId: magicNoteIdSchema.optional(),
  projectName: z.string().optional()
}).strict().superRefine((source, context) => {
  if (source.kind === 'message' && source.messageIds.length !== 1) {
    context.addIssue({ code: 'custom', path: ['messageIds'], message: 'Message sources require exactly one message' })
  }
  if (new Set(source.messageIds).size !== source.messageIds.length) {
    context.addIssue({ code: 'custom', path: ['messageIds'], message: 'Source message IDs must be unique' })
  }
})
export type MagicNoteSource = z.infer<typeof magicNoteSourceSchema>

export const magicNoteSearchSchema = z.object({
  query: z.string().trim().max(1000),
  limit: z.number().int().min(1).max(200).optional()
}).strict()
export type MagicNoteSearchInput = z.infer<typeof magicNoteSearchSchema>

export const MAGIC_NOTE_TAG_MAX_LENGTH = 24
export const MAGIC_NOTE_MAX_TAGS = 10

/** Tags compare case-insensitively after trimming and NFC normalization. */
export function magicNoteTagKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase()
}

export const magicNoteTagNameSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1, '标签不能为空')
      .max(MAGIC_NOTE_TAG_MAX_LENGTH, `标签最长 ${MAGIC_NOTE_TAG_MAX_LENGTH} 个字`)
      .refine((value) => !/[\p{Cc},，#]/u.test(value), '标签不能包含逗号、# 或控制字符')
  )

/** Deduplicates case-insensitively and keeps the first spelling and order. */
export const magicNoteTagListSchema = z
  .array(magicNoteTagNameSchema)
  .transform((tags) => {
    const seen = new Set<string>()
    return tags.filter((tag) => {
      const key = magicNoteTagKey(tag)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })
  .pipe(z.array(z.string()).max(MAGIC_NOTE_MAX_TAGS, `每篇笔记最多 ${MAGIC_NOTE_MAX_TAGS} 个标签`))

export const magicNoteCreateSchema = z
  .object({
    title: z.string().trim().min(1),
    content: magicNoteContentSchema.optional(),
    source: magicNoteSourceSchema.optional(),
    tags: magicNoteTagListSchema.optional()
  })
  .strict()
  .refine((input) => !input.source || !!input.content, {
    path: ['content'], message: 'Source requires initial content'
  })
export type MagicNoteCreateInput = z.infer<typeof magicNoteCreateSchema>

export const magicNoteUpdateSchema = z
  .object({
    noteId: magicNoteIdSchema,
    title: z.string().trim().min(1).optional(),
    pinned: z.boolean().optional(),
    tags: magicNoteTagListSchema.optional(),
    expectedRevision: z.number().int().nonnegative()
  })
  .strict()
  .refine(
    (input) => input.title !== undefined || input.pinned !== undefined || input.tags !== undefined,
    { message: '没有可更新的笔记字段' }
  )
export type MagicNoteUpdateInput = z.infer<typeof magicNoteUpdateSchema>

export const magicNoteTagIdSchema = magicNoteIdSchema

export const magicNoteTagCreateSchema = z
  .object({ name: magicNoteTagNameSchema })
  .strict()
export type MagicNoteTagCreateInput = z.infer<typeof magicNoteTagCreateSchema>

export const magicNoteTagRenameSchema = z
  .object({
    tagId: magicNoteTagIdSchema,
    name: magicNoteTagNameSchema
  })
  .strict()
export type MagicNoteTagRenameInput = z.infer<typeof magicNoteTagRenameSchema>

export const magicNoteTagDeleteSchema = z
  .object({ tagId: magicNoteTagIdSchema })
  .strict()

export const magicNoteDeleteSchema = z
  .object({
    noteId: magicNoteIdSchema
  })
  .strict()

export const magicNoteEntryCreateSchema = z
  .object({
    noteId: magicNoteIdSchema,
    content: magicNoteContentSchema,
    source: magicNoteSourceSchema.optional()
  })
  .strict()
export type MagicNoteEntryCreateInput = z.infer<
  typeof magicNoteEntryCreateSchema
>

export const magicNoteEntryUpdateSchema = z
  .object({
    entryId: magicNoteIdSchema,
    content: magicNoteContentSchema,
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
    format: magicNoteCommentFormatSchema,
    canvasPageText: z.array(z.object({ pageId: z.string().min(1), text: z.string().max(20_001) }).strict()).max(8).optional(),
    canvasImages: z.array(z.object({ pageId: z.string().min(1), dataUrl: z.string().regex(/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/) }).strict()).max(50).optional()
  })
  .strict()
export type MagicNoteAnalysisOptions = z.infer<
  typeof magicNoteAnalysisOptionsSchema
>

export const magicNoteAnalyzeSchema = z
  .object({
    entryId: magicNoteIdSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
    ...magicNoteAnalysisOptionsSchema.shape
  })
  .strict()
  .refine((input) => !(input.canvasImages?.length || input.canvasPageText?.length) || input.expectedRevision !== undefined, {
    message: '画布截图或分页文字必须提供记录版本', path: ['expectedRevision']
  })

export type MagicNoteEntryAnalysisOptions = MagicNoteAnalysisOptions & { expectedRevision?: number }

export const magicNoteDraftAnalyzeSchema = z
  .object({
    content: magicNoteContentSchema,
    ...magicNoteAnalysisOptionsSchema.shape
  })
  .strict()

export const magicTodoIdSchema = z
  .object({
    todoId: magicNoteIdSchema,
    sourceEntryRevision: z.number().int().nonnegative().optional(),
    ...magicNoteAnalysisOptionsSchema.shape
  })
  .strict()
  .refine((input) => !(input.canvasImages?.length || input.canvasPageText?.length) || input.sourceEntryRevision !== undefined, {
    message: '画布截图或分页文字必须提供来源记录版本', path: ['sourceEntryRevision']
  })

export type MagicTodoAnalysisOptions = MagicNoteAnalysisOptions & { sourceEntryRevision?: number }

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
  inputMode?: MagicNoteAnalysisInputMode
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
  content: MagicNoteContent
  source?: MagicNoteSource
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
  /** Display names in the order the user added them. */
  tags: string[]
  revision: number
  createdAt: string
  updatedAt: string
}

export type MagicNoteTag = {
  id: string
  name: string
  noteCount: number
}

export type MagicNoteTagRenameResult = {
  tag: MagicNoteTag
  /** True when the new name matched another tag and the two were merged. */
  merged: boolean
}

export type MagicNoteDetail = MagicNoteSummary & {
  entries: MagicNoteEntry[]
}

export type MagicNoteEntryCreateResult = MagicNoteDetail & {
  createdEntryId: string
}

export type MagicNoteCreateResult = MagicNoteDetail & {
  createdEntryId?: string
}

export type MagicNotesSnapshot = {
  notes: MagicNoteSummary[]
  tags: MagicNoteTag[]
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

export type MagicTodoStatus = {
  incompleteCount: number
}

export type MagicTodosSnapshot = {
  todos: MagicTodoItem[]
}

export type MagicNoteDraftAnalysis = {
  id: string
  comments: MagicNoteComment[]
  analyzedAt: string
  inputMode?: MagicNoteAnalysisInputMode
}

// Model request budgets only: never applied to note imports or storage.
export const magicNoteQuestionLimits = { images: 50, imageBytes: 24 * 1024 * 1024, textCharacters: 200_000 } as const
export const magicNoteQuestionScopeSchema = z.enum(['page', 'pages', 'document', 'region'])
export type MagicNoteQuestionScope = z.infer<typeof magicNoteQuestionScopeSchema>

export const magicNoteQuestionSchema = z.object({
  noteId: magicNoteIdSchema,
  question: z.string().trim().min(1).max(4_000),
  scope: magicNoteQuestionScopeSchema,
  entryId: magicNoteIdSchema.optional(),
  pageStart: z.number().int().positive().optional(),
  pageEnd: z.number().int().positive().optional(),
  contexts: z.array(z.object({
    entryId: magicNoteIdSchema,
    revision: z.number().int().nonnegative(),
    pages: z.array(z.object({
      pageId: z.string().min(1), text: z.string(),
      dataUrl: z.string().regex(/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/).optional()
    }).strict())
  }).strict()),
  history: z.array(z.object({ question: z.string(), answer: z.string(), context: z.string() }).strict()).default([])
}).strict().refine((input) => input.scope === 'document' || (input.entryId !== undefined && input.pageStart !== undefined && input.pageEnd !== undefined && input.pageStart <= input.pageEnd
  && (input.scope === 'pages' || input.pageStart === input.pageEnd)), {
  message: '分页范围无效', path: ['pageStart']
})
export type MagicNoteQuestionInput = z.infer<typeof magicNoteQuestionSchema>

export type MagicNoteQuestionResult = {
  requestId: string
  answer: string
  inputMode?: 'text' | 'vision'
}

export type MagicNoteSearchResult = {
  noteId: string
  noteTitle: string
  entryId?: string
  content: string
  updatedAt: string
}
