import { z } from 'zod'

const controlCharacterFreeString = (maximumLength: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximumLength)
    .refine(
      (value) =>
        [...value].every((character) => {
          const code = character.charCodeAt(0)
          return code > 31 && code !== 127
        }),
      '值包含控制字符'
    )

export const runtimeTargetSchema = z.enum([
  'model',
  'opencode',
  'continue'
])
export type RuntimeTarget = z.infer<typeof runtimeTargetSchema>

export const capabilityAssignmentsSchema = z
  .array(runtimeTargetSchema)
  .max(3)
  .refine(
    (assignments) => new Set(assignments).size === assignments.length,
    'Runtime 分配不能重复'
  )
export type CapabilityAssignments = z.infer<
  typeof capabilityAssignmentsSchema
>

export const secretActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z
    .object({
      action: z.literal('replace'),
      value: controlCharacterFreeString(8_192)
    })
    .strict(),
  z.object({ action: z.literal('clear') }).strict()
])
export type SecretAction = z.infer<typeof secretActionSchema>

export const skillIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

export const skillImportKindSchema = z.enum(['directory', 'zip'])
export type SkillImportKind = z.infer<typeof skillImportKindSchema>

export const skillToggleInputSchema = z
  .object({
    skillId: skillIdSchema,
    enabled: z.boolean()
  })
  .strict()

export const skillAssignmentsInputSchema = z
  .object({
    skillId: skillIdSchema,
    assignments: capabilityAssignmentsSchema
  })
  .strict()

export const skillSummarySchema = z
  .object({
    id: skillIdSchema,
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    version: z.string().max(32).optional(),
    tags: z.array(z.string().min(1).max(32)).max(12),
    source: z.enum(['builtin', 'imported']),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    enabled: z.boolean(),
    assignments: capabilityAssignmentsSchema
  })
  .strict()
export type SkillSummary = z.infer<typeof skillSummarySchema>

export const computerCapabilityIdSchema = z.enum([
  'host-browser-control',
  'linux-desktop-control'
])
export type ComputerCapabilityId = z.infer<
  typeof computerCapabilityIdSchema
>

export const browserProfileIdSchema = z.string().uuid()
export const browserProfileNameSchema = controlCharacterFreeString(80)

export const browserProfileCreateInputSchema = z
  .object({
    name: browserProfileNameSchema
  })
  .strict()
export type BrowserProfileCreateInput = z.infer<
  typeof browserProfileCreateInputSchema
>

export const browserProfileRenameInputSchema = z
  .object({
    profileId: browserProfileIdSchema,
    name: browserProfileNameSchema
  })
  .strict()
export type BrowserProfileRenameInput = z.infer<
  typeof browserProfileRenameInputSchema
>

export const browserProfileSelectionInputSchema = z
  .object({
    profileId: browserProfileIdSchema
  })
  .strict()

export const browserProfileSummarySchema = z
  .object({
    id: browserProfileIdSchema,
    name: browserProfileNameSchema,
    mode: z.literal('managed-isolated')
  })
  .strict()
export type BrowserProfileSummary = z.infer<
  typeof browserProfileSummarySchema
>

export const browserProfilesSummarySchema = z
  .object({
    profiles: z.array(browserProfileSummarySchema).max(32),
    defaultProfileId: browserProfileIdSchema.nullable()
  })
  .strict()
export type BrowserProfilesSummary = z.infer<
  typeof browserProfilesSummarySchema
>

export const computerCapabilityToggleInputSchema = z
  .object({
    capabilityId: computerCapabilityIdSchema,
    enabled: z.boolean()
  })
  .strict()

export const computerCapabilityConfigInputSchema = z
  .object({
    capabilityId: computerCapabilityIdSchema,
    browserProfileId: browserProfileIdSchema.nullable()
  })
  .strict()

export const computerCapabilityConfigSummarySchema = z
  .object({
    id: computerCapabilityIdSchema,
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    enabled: z.boolean(),
    supported: z.boolean(),
    browserProfileId: browserProfileIdSchema.nullable(),
    riskSummary: z.string().min(1).max(500)
  })
  .strict()
export type ComputerCapabilityConfigSummary = z.infer<
  typeof computerCapabilityConfigSummarySchema
>

export const capabilityDiagnosticStatusSchema = z.enum([
  'available',
  'degraded',
  'unavailable',
  'disabled'
])
export type CapabilityDiagnosticStatus = z.infer<
  typeof capabilityDiagnosticStatusSchema
>

export const capabilityDiagnosticCheckStatusSchema =
  capabilityDiagnosticStatusSchema.exclude(['disabled'])

export const capabilityDiagnosticCheckSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9-]*$/u),
    status: capabilityDiagnosticCheckStatusSchema,
    summary: z.string().min(1).max(240),
    remedy: z.string().min(1).max(400).optional()
  })
  .strict()

export const capabilityDiagnosticReportSchema = z
  .object({
    capabilityId: computerCapabilityIdSchema,
    status: capabilityDiagnosticStatusSchema,
    checkedAt: z.string().datetime(),
    checks: z.array(capabilityDiagnosticCheckSchema).max(16)
  })
  .strict()
export type CapabilityDiagnosticReport = z.infer<
  typeof capabilityDiagnosticReportSchema
>

export const mcpTransportSchema = z.enum(['stdio', 'http', 'sse'])
export type McpTransport = z.infer<typeof mcpTransportSchema>

export const mcpServerIdSchema = z.string().uuid()
const mcpServerNameSchema = controlCharacterFreeString(80)
const mcpServerDescriptionSchema = z.string().trim().max(500)
const mcpCommandSchema = controlCharacterFreeString(4_096)
const mcpArgumentSchema = controlCharacterFreeString(4_096)
const mcpRemoteUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    if (!['http:', 'https:'].includes(new URL(value).protocol)) {
      context.addIssue({
        code: 'custom',
        message: 'MCP URL 必须使用 HTTP 或 HTTPS'
      })
    }
  })

const mcpCommonInputShape = {
  name: mcpServerNameSchema,
  description: mcpServerDescriptionSchema,
  enabled: z.boolean(),
  allowDynamicTools: z.boolean(),
  assignments: capabilityAssignmentsSchema,
  secret: secretActionSchema
}

export const mcpServerInputSchema = z.discriminatedUnion('transport', [
  z
    .object({
      ...mcpCommonInputShape,
      transport: z.literal('stdio'),
      command: mcpCommandSchema,
      args: z.array(mcpArgumentSchema).max(64)
    })
    .strict(),
  z
    .object({
      ...mcpCommonInputShape,
      transport: z.literal('http'),
      url: mcpRemoteUrlSchema
    })
    .strict(),
  z
    .object({
      ...mcpCommonInputShape,
      transport: z.literal('sse'),
      url: mcpRemoteUrlSchema
    })
    .strict()
])
export type McpServerInput = z.infer<typeof mcpServerInputSchema>

export const mcpServerSummarySchema = z.discriminatedUnion('transport', [
  z
    .object({
      id: mcpServerIdSchema,
      name: mcpServerNameSchema,
      description: mcpServerDescriptionSchema,
      enabled: z.boolean(),
      allowDynamicTools: z.boolean(),
      assignments: capabilityAssignmentsSchema,
      secretConfigured: z.boolean(),
      transport: z.literal('stdio'),
      command: mcpCommandSchema,
      args: z.array(mcpArgumentSchema).max(64)
    })
    .strict(),
  z
    .object({
      id: mcpServerIdSchema,
      name: mcpServerNameSchema,
      description: mcpServerDescriptionSchema,
      enabled: z.boolean(),
      allowDynamicTools: z.boolean(),
      assignments: capabilityAssignmentsSchema,
      secretConfigured: z.boolean(),
      transport: z.literal('http'),
      url: mcpRemoteUrlSchema
    })
    .strict(),
  z
    .object({
      id: mcpServerIdSchema,
      name: mcpServerNameSchema,
      description: mcpServerDescriptionSchema,
      enabled: z.boolean(),
      allowDynamicTools: z.boolean(),
      assignments: capabilityAssignmentsSchema,
      secretConfigured: z.boolean(),
      transport: z.literal('sse'),
      url: mcpRemoteUrlSchema
    })
    .strict()
])
export type McpServerSummary = z.infer<typeof mcpServerSummarySchema>

export const webSearchCapabilitySchema = z
  .object({
    provider: z.literal('exa'),
    enabled: z.boolean(),
    availableIn: z.tuple([z.literal('ask'), z.literal('execute')]),
    tools: z.tuple([
      z.literal('web_search'),
      z.literal('web_fetch')
    ])
  })
  .strict()
export type WebSearchCapability = z.infer<
  typeof webSearchCapabilitySchema
>

export const capabilitySnapshotSchema = z
  .object({
    skills: z.array(skillSummarySchema).max(256),
    mcpServers: z.array(mcpServerSummarySchema).max(64),
    webSearch: webSearchCapabilitySchema.optional(),
    computerCapabilities: z
      .array(computerCapabilityConfigSummarySchema)
      .max(2)
      .optional(),
    browserProfiles: browserProfilesSummarySchema.optional()
  })
  .strict()
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>

export const mcpServerTestResultSchema = z
  .object({
    serverName: z.string().min(1).max(120).optional(),
    serverVersion: z.string().min(1).max(64).optional(),
    dynamicToolsSupported: z.boolean(),
    toolCount: z.number().int().min(0).max(10_000),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            description: z.string().max(500).optional()
          })
          .strict()
      )
      .max(100)
  })
  .strict()
export type McpServerTestResult = z.infer<
  typeof mcpServerTestResultSchema
>

export const webSearchTestResultSchema = z
  .object({
    provider: z.literal('exa'),
    query: z.string().min(1).max(120),
    durationMs: z.number().int().min(0),
    preview: z.string().min(1).max(500)
  })
  .strict()
export type WebSearchTestResult = z.infer<
  typeof webSearchTestResultSchema
>
