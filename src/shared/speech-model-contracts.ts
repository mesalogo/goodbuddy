import { z } from 'zod'

const safeIdentifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const safeFileNamePattern =
  /^(?!\.{1,2}$)(?!.*(?:^|[\\/])\.{1,2}(?:[\\/]|$))[^/\\\0]+$/u
const sha256Pattern = /^[a-f0-9]{64}$/u
export const SPEECH_TRANSCRIPTION_SAMPLE_RATE = 16_000
export const SPEECH_TRANSCRIPTION_MAX_SECONDS = 20
export const SPEECH_TRANSCRIPTION_MAX_SAMPLES =
  SPEECH_TRANSCRIPTION_SAMPLE_RATE * SPEECH_TRANSCRIPTION_MAX_SECONDS

export const speechModelIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(safeIdentifierPattern)

export const speechModelFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(safeFileNamePattern)

export const speechModelFileRoleSchema = z.enum([
  'model',
  'encoder',
  'decoder',
  'tokens',
  'configuration'
])

export const speechModelDownloadSchema = z
  .object({
    url: z.url().max(2_048),
    size: z.number().int().positive().safe(),
    sha256: z.string().regex(sha256Pattern)
  })
  .strict()

export const speechModelFileSpecSchema = z
  .object({
    name: speechModelFileNameSchema,
    role: speechModelFileRoleSchema,
    download: speechModelDownloadSchema.optional()
  })
  .strict()

export const speechModelLicenseSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    notice: z.string().trim().min(1).max(1_000),
    url: z.url().max(2_048)
  })
  .strict()

export const speechModelCatalogEntrySchema = z
  .object({
    id: speechModelIdSchema,
    displayName: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    languages: z.array(z.string().trim().min(1).max(32)).min(1).max(32),
    family: z.enum(['sensevoice', 'whisper']),
    quantization: z.enum(['int8', 'fp16', 'fp32']),
    repositoryUrl: z.url().max(2_048),
    license: speechModelLicenseSchema,
    manualOnly: z.boolean(),
    manualReason: z.string().trim().min(1).max(500).optional(),
    files: z.array(speechModelFileSpecSchema).min(1).max(32)
  })
  .strict()
  .superRefine((entry, context) => {
    if (new Set(entry.files.map((file) => file.name)).size !== entry.files.length) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: '模型文件名不能重复'
      })
    }
    if (entry.manualOnly && !entry.manualReason) {
      context.addIssue({
        code: 'custom',
        path: ['manualReason'],
        message: '仅手动导入的模型必须说明原因'
      })
    }
    if (
      !entry.manualOnly &&
      entry.files.some((file) => file.download === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: '可下载模型的每个文件都必须提供已验证的大小和 SHA-256'
      })
    }
  })

export const speechModelInstalledFileSchema = z
  .object({
    name: speechModelFileNameSchema,
    role: speechModelFileRoleSchema,
    size: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(sha256Pattern)
  })
  .strict()

export const installedSpeechModelSchema = z
  .object({
    id: speechModelIdSchema,
    displayName: z.string().trim().min(1).max(120),
    source: z.enum(['download', 'local']),
    installedAt: z.string().datetime(),
    files: z.array(speechModelInstalledFileSchema).min(1).max(32)
  })
  .strict()

export const speechModelOperationSchema = z
  .object({
    modelId: speechModelIdSchema,
    kind: z.enum(['download', 'import']),
    phase: z.enum(['preparing', 'transferring', 'installing']),
    currentFile: speechModelFileNameSchema.nullable(),
    completedBytes: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().nonnegative().safe().nullable()
  })
  .strict()

export const speechModelSnapshotSchema = z
  .object({
    rootDirectory: z.string().min(1).max(32_768),
    catalog: z.array(speechModelCatalogEntrySchema).max(64),
    installed: z.array(installedSpeechModelSchema).max(64),
    operations: z.array(speechModelOperationSchema).max(16),
    selectedModelId: speechModelIdSchema.nullable()
  })
  .strict()

export const speechModelActionInputSchema = z
  .object({
    modelId: speechModelIdSchema
  })
  .strict()

export const speechModelSelectionInputSchema = z
  .object({
    modelId: speechModelIdSchema.nullable()
  })
  .strict()

export const speechModelLocalDirectoryInputSchema = z
  .object({
    modelId: speechModelIdSchema,
    directory: z.string().trim().min(1).max(32_768)
  })
  .strict()

export const speechTranscriptionInputSchema = z
  .object({
    requestId: z.string().uuid(),
    sampleRate: z.literal(SPEECH_TRANSCRIPTION_SAMPLE_RATE),
    audio: z.custom<ArrayBuffer>(
      (value) =>
        value instanceof ArrayBuffer &&
        value.byteLength > 0 &&
        value.byteLength <= SPEECH_TRANSCRIPTION_MAX_SAMPLES * 4 &&
        value.byteLength % 4 === 0,
      '录音数据无效或超过长度限制'
    )
  })
  .strict()

export const speechTranscriptionResultSchema = z
  .object({
    text: z.string().trim().max(20_000)
  })
  .strict()

export type SpeechModelId = z.infer<typeof speechModelIdSchema>
export type SpeechModelFileSpec = z.infer<
  typeof speechModelFileSpecSchema
>
export type SpeechModelCatalogEntry = z.infer<
  typeof speechModelCatalogEntrySchema
>
export type InstalledSpeechModel = z.infer<
  typeof installedSpeechModelSchema
>
export type SpeechModelOperation = z.infer<
  typeof speechModelOperationSchema
>
export type SpeechModelSnapshot = z.infer<typeof speechModelSnapshotSchema>
export type SpeechModelLocalDirectoryInput = z.infer<
  typeof speechModelLocalDirectoryInputSchema
>
export type SpeechTranscriptionInput = z.infer<
  typeof speechTranscriptionInputSchema
>
export type SpeechTranscriptionResult = z.infer<
  typeof speechTranscriptionResultSchema
>
