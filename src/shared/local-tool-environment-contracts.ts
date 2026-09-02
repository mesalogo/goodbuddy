import { z } from 'zod'

const absoluteExecutablePathPattern =
  /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/u

export const localToolExecutablePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.trim() === value, {
    message: 'Executable path must not have surrounding whitespace'
  })
  .refine((value) => !value.includes('\0'), {
    message: 'Executable path must not contain null characters'
  })
  .regex(absoluteExecutablePathPattern, 'Executable path must be absolute')

export const localToolRuntimeSelectionSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('managed') }).strict(),
  z
    .object({
      source: z.literal('custom'),
      executablePath: localToolExecutablePathSchema
    })
    .strict()
])

export const artifactDownloadSourceSchema = z.enum(['native', 'oss'])

export const localToolEnvironmentSettingsSchema = z
  .object({
    node: localToolRuntimeSelectionSchema,
    python: localToolRuntimeSelectionSchema,
    artifactDownloadSource: artifactDownloadSourceSchema
  })
  .strict()

export const defaultLocalToolEnvironmentSettings: LocalToolEnvironmentSettings =
  {
    node: { source: 'managed' },
    python: { source: 'managed' },
    artifactDownloadSource: 'native'
  }

export type LocalToolRuntimeSelection = z.infer<
  typeof localToolRuntimeSelectionSchema
>
export type ArtifactDownloadSource = z.infer<
  typeof artifactDownloadSourceSchema
>
export type LocalToolEnvironmentSettings = z.infer<
  typeof localToolEnvironmentSettingsSchema
>

export const localToolKindSchema = z.enum(['node', 'python'])
export type LocalToolKind = z.infer<typeof localToolKindSchema>

export const localToolDiagnoseTargetSchema = z.enum([
  'node',
  'python',
  'all'
])
export type LocalToolDiagnoseTarget = z.infer<
  typeof localToolDiagnoseTargetSchema
>

export const localToolKindInputSchema = z
  .object({ kind: localToolKindSchema })
  .strict()
export const localToolDiagnoseInputSchema = z
  .object({ kind: localToolDiagnoseTargetSchema })
  .strict()

export const localToolCandidateSchema = z
  .object({
    kind: localToolKindSchema,
    executablePath: localToolExecutablePathSchema,
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
    architecture: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9A-Za-z][0-9A-Za-z._-]*$/u)
  })
  .strict()
export type LocalToolCandidate = z.infer<typeof localToolCandidateSchema>

export const localToolDiagnosticSchema = z
  .object({
    available: z.boolean(),
    source: z.enum(['managed', 'custom']),
    version: z.string().max(160).optional(),
    executablePath: localToolExecutablePathSchema.optional(),
    detail: z.string().max(512)
  })
  .strict()
export type LocalToolDiagnosticSnapshot = z.infer<
  typeof localToolDiagnosticSchema
>

export const localToolPythonOperationSchema = z
  .object({
    source: artifactDownloadSourceSchema,
    phase: z.enum([
      'downloading',
      'extracting',
      'validating',
      'publishing'
    ]),
    receivedBytes: z.number().int().nonnegative().safe().optional(),
    totalBytes: z.number().int().positive().safe().optional()
  })
  .strict()
export type LocalToolPythonOperation = z.infer<
  typeof localToolPythonOperationSchema
>

export const localToolEnvironmentSnapshotSchema = z
  .object({
    settings: localToolEnvironmentSettingsSchema,
    candidates: z.array(localToolCandidateSchema).max(40),
    diagnostics: z
      .object({
        node: localToolDiagnosticSchema.optional(),
        npm: localToolDiagnosticSchema.optional(),
        npx: localToolDiagnosticSchema.optional(),
        python: localToolDiagnosticSchema.optional(),
        python3: localToolDiagnosticSchema.optional(),
        pip: localToolDiagnosticSchema.optional()
      })
      .strict(),
    managedPython: z
      .object({
        version: z.string().regex(/^\d+\.\d+\.\d+$/u),
        installed: z.boolean(),
        executablePath: localToolExecutablePathSchema.optional(),
        operation: localToolPythonOperationSchema.optional()
      })
      .strict()
  })
  .strict()
export type LocalToolEnvironmentSnapshot = z.infer<
  typeof localToolEnvironmentSnapshotSchema
>

export const localToolEnvironmentProgressSchema = z
  .object({
    snapshot: localToolEnvironmentSnapshotSchema
  })
  .strict()
export type LocalToolEnvironmentProgress = z.infer<
  typeof localToolEnvironmentProgressSchema
>
