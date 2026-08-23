import { z } from 'zod'
import {
  MODEL_DOWNLOAD_SOURCES,
  modelArtifactTargetsSchema,
  modelDownloadAvailabilitySchema,
  modelDownloadSourceSchema
} from '../../shared/model-download-contracts'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const modelFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\\:\0]+$/u)

export const embeddingModelIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)

export const embeddingModelFileRoleSchema = z.enum([
  'model',
  'tokenizer',
  'tokenizer-configuration',
  'configuration',
  'license'
])

export const embeddingModelFileSchema = z
  .object({
    name: modelFileNameSchema,
    role: embeddingModelFileRoleSchema,
    size: z.number().int().positive().safe(),
    sha256: sha256Schema,
    targets: modelArtifactTargetsSchema
  })
  .strict()

const repositoryUrlsSchema = z
  .object({
    modelscope: z.url().optional(),
    'hugging-face': z.url().optional()
  })
  .strict()

const embeddingModelLicenseSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    notice: z.string().trim().min(1).max(1_000),
    url: z.url()
  })
  .strict()

export const embeddingModelCatalogEntrySchema = z
  .object({
    id: embeddingModelIdSchema,
    displayName: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    languages: z.array(z.string().trim().min(1).max(80)).min(1).max(32),
    runtime: z.literal('onnxruntime-web/wasm'),
    dimensions: z.number().int().positive().max(65_536),
    contextTokens: z.number().int().positive().max(10_000_000),
    quantization: z.string().trim().min(1).max(40),
    recommended: z.boolean(),
    available: z.boolean(),
    unavailableReason: z.string().trim().min(1).max(1_000).optional(),
    repositoryUrls: repositoryUrlsSchema,
    license: embeddingModelLicenseSchema,
    files: z.array(embeddingModelFileSchema).min(1).max(32)
  })
  .strict()
  .superRefine((entry, context) => {
    if (!entry.available && !entry.unavailableReason) {
      context.addIssue({
        code: 'custom',
        path: ['unavailableReason'],
        message: '不可用的内置向量模型必须说明原因'
      })
    }
    if (entry.available && entry.unavailableReason) {
      context.addIssue({
        code: 'custom',
        path: ['unavailableReason'],
        message: '可用的内置向量模型不能包含不可用原因'
      })
    }
    if (entry.available) {
      for (const role of [
        'model',
        'tokenizer',
        'tokenizer-configuration',
        'configuration'
      ] as const) {
        if (!entry.files.some((file) => file.role === role)) {
          context.addIssue({
            code: 'custom',
            path: ['files'],
            message: `可安装的向量模型缺少 ${role} 工件`
          })
        }
      }
    }
    if (
      new Set(entry.files.map((file) => file.name.toLowerCase())).size !==
      entry.files.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: '向量模型目录包含重复文件名'
      })
    }
  })

const embeddingModelCatalogViewFileSchema = embeddingModelFileSchema.omit({
  targets: true
})

export const embeddingModelCatalogViewEntrySchema = z
  .object({
    id: embeddingModelCatalogEntrySchema.shape.id,
    displayName: embeddingModelCatalogEntrySchema.shape.displayName,
    description: embeddingModelCatalogEntrySchema.shape.description,
    languages: embeddingModelCatalogEntrySchema.shape.languages,
    runtime: embeddingModelCatalogEntrySchema.shape.runtime,
    dimensions: embeddingModelCatalogEntrySchema.shape.dimensions,
    contextTokens: embeddingModelCatalogEntrySchema.shape.contextTokens,
    quantization: embeddingModelCatalogEntrySchema.shape.quantization,
    recommended: embeddingModelCatalogEntrySchema.shape.recommended,
    available: embeddingModelCatalogEntrySchema.shape.available,
    unavailableReason:
      embeddingModelCatalogEntrySchema.shape.unavailableReason,
    license: embeddingModelCatalogEntrySchema.shape.license,
    files: z.array(embeddingModelCatalogViewFileSchema).min(1).max(32),
    downloadAvailability: z
      .array(modelDownloadAvailabilitySchema)
      .length(MODEL_DOWNLOAD_SOURCES.length)
  })
  .strict()

export const installedEmbeddingModelFileSchema = z
  .object({
    name: modelFileNameSchema,
    role: embeddingModelFileRoleSchema,
    size: z.number().int().positive().safe(),
    sha256: sha256Schema
  })
  .strict()

export const installedEmbeddingModelSchema = z
  .object({
    id: embeddingModelIdSchema,
    displayName: z.string().trim().min(1).max(120),
    source: z.enum(['download', 'local']),
    installedAt: z.string().datetime(),
    files: z.array(installedEmbeddingModelFileSchema).min(1).max(32)
  })
  .strict()

export const embeddingModelOperationSchema = z
  .object({
    modelId: embeddingModelIdSchema,
    kind: z.enum(['download', 'import']),
    phase: z.enum(['preparing', 'transferring', 'installing']),
    currentFile: modelFileNameSchema.nullable(),
    completedBytes: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().positive().safe().nullable(),
    downloadSource: modelDownloadSourceSchema.optional()
  })
  .strict()

export const embeddingModelSnapshotSchema = z
  .object({
    selectedDownloadSource: modelDownloadSourceSchema,
    catalog: z.array(embeddingModelCatalogViewEntrySchema),
    installed: z.array(installedEmbeddingModelSchema),
    operations: z.array(embeddingModelOperationSchema)
  })
  .strict()

export const embeddingModelProgressSnapshotSchema = z
  .object({
    operations: z.array(embeddingModelOperationSchema)
  })
  .strict()

export const embeddingModelStatusSchema = z
  .object({
    id: embeddingModelIdSchema,
    displayName: z.string().trim().min(1).max(120),
    catalogAvailable: z.boolean(),
    installed: z.boolean(),
    verified: z.boolean(),
    detail: z.string().trim().min(1).max(1_000)
  })
  .strict()

export type EmbeddingModelCatalogEntry = z.infer<
  typeof embeddingModelCatalogEntrySchema
>
export type EmbeddingModelCatalogViewEntry = z.infer<
  typeof embeddingModelCatalogViewEntrySchema
>
export type EmbeddingModelFile = z.infer<typeof embeddingModelFileSchema>
export type InstalledEmbeddingModel = z.infer<
  typeof installedEmbeddingModelSchema
>
export type EmbeddingModelOperation = z.infer<
  typeof embeddingModelOperationSchema
>
export type EmbeddingModelSnapshot = z.infer<
  typeof embeddingModelSnapshotSchema
>
export type EmbeddingModelProgressSnapshot = z.infer<
  typeof embeddingModelProgressSnapshotSchema
>
export type EmbeddingModelStatus = z.infer<
  typeof embeddingModelStatusSchema
>
