import { z } from 'zod'
import {
  MODEL_DOWNLOAD_SOURCES,
  modelArtifactIdentitySchema,
  modelDownloadAvailabilitySchema,
  modelDownloadSourceSchema
} from './model-download-contracts'
import { settingsWarningsSchema } from './settings-warning-contracts'

export const maximumDocumentExtractedCharacters = 5_000_000
export const maximumDocumentOcrSectionCharacters = 1_000_000
export const maximumDocumentParsingWarnings = 20
export const maximumPdfPageCount = 10_000

export const documentParsingPurposeSchema = z.enum([
  'chat-attachment',
  'knowledge-index',
  'artifact-import',
  'diagnostic'
])

export const documentParsingTestPurposeSchema = z.enum([
  'chat-attachment',
  'knowledge-index'
])

export const chatDocumentWorkflowSchema = z.enum([
  'auto',
  'fast-text',
  'high-fidelity'
])

export const knowledgeDocumentWorkflowSchema = z.enum([
  'complete-index',
  'fast-index',
  'high-fidelity'
])

export const localOcrModelIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)

const documentOcrSha256Schema =
  modelArtifactIdentitySchema.shape.sha256

export const documentOcrModelFileRoleSchema = z.enum([
  'detection',
  'recognition',
  'dictionary'
])

export const documentOcrModelArtifactSchema =
  modelArtifactIdentitySchema

export const documentOcrModelFileSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^/\\\0]+$/u),
    role: documentOcrModelFileRoleSchema,
    size: documentOcrModelArtifactSchema.shape.size,
    sha256: documentOcrModelArtifactSchema.shape.sha256,
    targets: documentOcrModelArtifactSchema.shape.targets
  })
  .strict()

export const documentOcrModelCatalogEntrySchema = z
  .object({
    id: localOcrModelIdSchema,
    displayName: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    languages: z.array(z.string().trim().min(1).max(32)).min(1).max(32),
    runtime: z.literal('onnxruntime-web-wasm'),
    quality: z.enum(['basic', 'balanced', 'high']),
    speed: z.enum(['fast', 'balanced', 'slow']),
    recommended: z.boolean(),
    repositoryUrls: z
      .object({
        modelscope: z.url().max(2_048).optional(),
        'hugging-face': z.url().max(2_048).optional()
      })
      .strict(),
    license: z
      .object({
        name: z.string().trim().min(1).max(120),
        notice: z.string().trim().min(1).max(1_000),
        url: z.url().max(2_048)
      })
      .strict(),
    files: z.array(documentOcrModelFileSchema).length(3)
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      new Set(entry.files.map((file) => file.name)).size !==
      entry.files.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'OCR 模型文件名不能重复'
      })
    }
    if (
      new Set(entry.files.map((file) => file.role)).size !==
      entry.files.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'OCR 模型文件角色不能重复'
      })
    }
    for (const source of MODEL_DOWNLOAD_SOURCES) {
      const targets = entry.files
        .map((file) => file.targets[source])
        .filter((target) => target !== undefined)
      if (
        targets.length > 0 &&
        (!entry.repositoryUrls[source] ||
          !targets.some(
            (target) =>
              target.repositoryUrl === entry.repositoryUrls[source]
          ))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['repositoryUrls', source],
          message:
            'OCR 模型仓库地址必须对应到该下载源的一个文件目标'
        })
      }
    }
    if (
      !MODEL_DOWNLOAD_SOURCES.some((source) =>
        entry.files.every((file) => file.targets[source])
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'OCR 模型必须至少由一个下载源提供完整文件'
      })
    }
  })

export const documentOcrModelCatalogViewEntrySchema =
  z
    .object({
      id: localOcrModelIdSchema,
      displayName: z.string().trim().min(1).max(120),
      description: z.string().trim().min(1).max(500),
      languages: z.array(z.string().trim().min(1).max(32)).min(1).max(32),
      runtime: z.literal('onnxruntime-web-wasm'),
      quality: z.enum(['basic', 'balanced', 'high']),
      speed: z.enum(['fast', 'balanced', 'slow']),
      recommended: z.boolean(),
      license: documentOcrModelCatalogEntrySchema.shape.license,
      files: z
        .array(
          documentOcrModelFileSchema.omit({
            targets: true
          })
        )
        .length(3),
      downloadAvailability: z
        .array(modelDownloadAvailabilitySchema)
        .length(MODEL_DOWNLOAD_SOURCES.length)
    })
    .strict()

export const installedDocumentOcrModelSchema = z
  .object({
    id: localOcrModelIdSchema,
    displayName: z.string().trim().min(1).max(120),
    source: z.enum(['download', 'local']),
    installedAt: z.string().datetime(),
    files: z
      .array(
        z
          .object({
            name: z.string().min(1).max(255).regex(/^[^/\\\0]+$/u),
            role: documentOcrModelFileRoleSchema,
            size: z.number().int().positive().safe(),
            sha256: documentOcrSha256Schema
          })
          .strict()
      )
      .length(3)
  })
  .strict()

export const documentOcrModelOperationSchema = z
  .object({
    modelId: localOcrModelIdSchema,
    kind: z.enum(['download', 'import']),
    phase: z.enum(['preparing', 'transferring', 'installing']),
    currentFile: z.string().min(1).max(255).nullable(),
    completedBytes: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().nonnegative().safe().nullable(),
    downloadSource: modelDownloadSourceSchema.optional()
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      (operation.kind === 'download') !==
      (operation.downloadSource !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['downloadSource'],
        message: 'OCR 下载操作必须且仅能包含下载源'
      })
    }
  })

export const documentOcrModelSnapshotSchema = z
  .object({
    rootDirectory: z.string().min(1).max(32_768),
    selectedDownloadSource: modelDownloadSourceSchema,
    catalog: z.array(documentOcrModelCatalogViewEntrySchema).max(16),
    installed: z.array(installedDocumentOcrModelSchema).max(16),
    operations: z.array(documentOcrModelOperationSchema).max(8)
  })
  .strict()

export const documentOcrModelActionInputSchema = z
  .object({
    modelId: localOcrModelIdSchema
  })
  .strict()

export const documentOcrModelInstallInputSchema = z
  .object({
    modelId: localOcrModelIdSchema,
    expectedDownloadSource: modelDownloadSourceSchema
  })
  .strict()

export const documentParsingSettingsSchema = z
  .object({
    chatWorkflow: chatDocumentWorkflowSchema,
    knowledgeWorkflow: knowledgeDocumentWorkflowSchema,
    localOcrModelId: localOcrModelIdSchema,
    maximumPages: z.number().int().min(1).max(500),
    pageTimeoutSeconds: z.number().int().min(10).max(300)
  })
  .strict()

export const documentParsingSettingsUpdateSchema =
  documentParsingSettingsSchema

export const documentParsingModelStatusSchema = z
  .object({
    id: localOcrModelIdSchema,
    displayName: z.string().trim().min(1).max(120),
    available: z.boolean(),
    verified: z.boolean(),
    runtime: z.literal('onnxruntime-web-wasm'),
    detail: z.string().trim().min(1).max(500)
  })
  .strict()

export const documentParsingStatusSchema = z
  .object({
    nativeParsingAvailable: z.literal(true),
    conversionAvailable: z.boolean(),
    localOcr: documentParsingModelStatusSchema
  })
  .strict()

export const documentParsingSnapshotSchema = z
  .object({
    settings: documentParsingSettingsSchema,
    status: documentParsingStatusSchema,
    ocrModels: documentOcrModelSnapshotSchema,
    warnings: settingsWarningsSchema.optional()
  })
  .strict()

export const documentParsingTestInputSchema = z
  .object({
    purpose: documentParsingTestPurposeSchema
  })
  .strict()

export const documentParsingDiagnosticSchema = z
  .object({
    fileName: z.string().trim().min(1).max(500),
    sourceFormat: z.string().trim().min(1).max(32),
    pageCount: z.number().int().nonnegative().max(maximumPdfPageCount),
    ocrPageCount: z.number().int().nonnegative().max(maximumPdfPageCount),
    characterCount: z.number().int().nonnegative().safe(),
    method: z.enum(['native', 'ocr', 'mixed']),
    durationMs: z.number().int().nonnegative().safe(),
    preview: z.string().max(2_000),
    warnings: z
      .array(z.string().trim().min(1).max(500))
      .max(maximumDocumentParsingWarnings)
  })
  .strict()

export const documentOcrAssetsSchema = z
  .object({
    modelId: localOcrModelIdSchema,
    detection: z.instanceof(ArrayBuffer),
    recognition: z.instanceof(ArrayBuffer),
    dictionary: z.instanceof(ArrayBuffer)
  })
  .strict()

export const documentOcrRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    modelId: localOcrModelIdSchema,
    fileName: z.string().trim().min(1).max(500),
    mimeType: z.enum([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp'
    ]),
    data: z
      .instanceof(ArrayBuffer)
      .refine(
        (value) => value.byteLength > 0 && value.byteLength <= 20 * 1024 * 1024,
        'OCR 输入必须介于 1 字节和 20MB 之间'
      ),
    maximumPages: z.number().int().min(1).max(500),
    pageNumbers: z
      .array(z.number().int().min(1).max(maximumPdfPageCount))
      .min(1)
      .max(500)
      .optional(),
    pageTimeoutSeconds: z.number().int().min(10).max(300)
  })
  .strict()
  .superRefine((request, context) => {
    if (!request.pageNumbers) {
      return
    }
    if (
      new Set(request.pageNumbers).size !== request.pageNumbers.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['pageNumbers'],
        message: 'OCR 页码不能重复'
      })
    }
    if (request.pageNumbers.length > request.maximumPages) {
      context.addIssue({
        code: 'custom',
        path: ['pageNumbers'],
        message: 'OCR 页数超过当前文档限制'
      })
    }
  })

export const documentOcrSectionSchema = z
  .object({
    locator: z.string().trim().min(1).max(500),
    pageNumber: z
      .number()
      .int()
      .min(1)
      .max(maximumPdfPageCount)
      .optional(),
    content: z
      .string()
      .trim()
      .min(1)
      .max(maximumDocumentOcrSectionCharacters),
    confidence: z.number().min(0).max(1)
  })
  .strict()

export const documentOcrResultSchema = z
  .object({
    requestId: z.string().uuid(),
    sections: z.array(documentOcrSectionSchema).max(500),
    pageCount: z
      .number()
      .int()
      .nonnegative()
      .max(maximumPdfPageCount),
    warnings: z
      .array(z.string().trim().min(1).max(500))
      .max(maximumDocumentParsingWarnings)
  })
  .strict()
  .superRefine((result, context) => {
    let characters = 0
    for (const section of result.sections) {
      characters += section.content.length
      if (characters > maximumDocumentExtractedCharacters) {
        context.addIssue({
          code: 'custom',
          path: ['sections'],
          message: 'OCR 输出超过文档字符限制'
        })
        return
      }
    }
  })

export const documentOcrFailureSchema = z
  .object({
    requestId: z.string().uuid(),
    error: z.string().trim().min(1).max(1_000)
  })
  .strict()

export type DocumentParsingPurpose = z.infer<
  typeof documentParsingPurposeSchema
>
export type DocumentParsingTestPurpose = z.infer<
  typeof documentParsingTestPurposeSchema
>
export type DocumentParsingSettings = z.infer<
  typeof documentParsingSettingsSchema
>
export type DocumentParsingSnapshot = z.infer<
  typeof documentParsingSnapshotSchema
>
export type DocumentOcrModelFile = z.infer<
  typeof documentOcrModelFileSchema
>
export type DocumentOcrModelCatalogEntry = z.infer<
  typeof documentOcrModelCatalogEntrySchema
>
export type DocumentOcrModelCatalogViewEntry = z.infer<
  typeof documentOcrModelCatalogViewEntrySchema
>
export type InstalledDocumentOcrModel = z.infer<
  typeof installedDocumentOcrModelSchema
>
export type DocumentOcrModelOperation = z.infer<
  typeof documentOcrModelOperationSchema
>
export type DocumentOcrModelSnapshot = z.infer<
  typeof documentOcrModelSnapshotSchema
>
export type DocumentParsingDiagnostic = z.infer<
  typeof documentParsingDiagnosticSchema
>
export type DocumentOcrAssets = z.infer<typeof documentOcrAssetsSchema>
export type DocumentOcrRequest = z.infer<typeof documentOcrRequestSchema>
export type DocumentOcrResult = z.infer<typeof documentOcrResultSchema>
export type DocumentOcrFailure = z.infer<typeof documentOcrFailureSchema>
