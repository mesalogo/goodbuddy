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
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    ) {
      context.addIssue({
        code: 'custom',
        message: 'MCP URL 必须是无凭据和片段的 HTTP(S) 地址'
      })
    }
  })

const mcpCommonInputShape = {
  name: mcpServerNameSchema,
  description: mcpServerDescriptionSchema,
  enabled: z.boolean(),
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
      assignments: capabilityAssignmentsSchema,
      secretConfigured: z.boolean(),
      transport: z.literal('sse'),
      url: mcpRemoteUrlSchema
    })
    .strict()
])
export type McpServerSummary = z.infer<typeof mcpServerSummarySchema>

export const capabilitySnapshotSchema = z
  .object({
    skills: z.array(skillSummarySchema).max(256),
    mcpServers: z.array(mcpServerSummarySchema).max(64)
  })
  .strict()
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>

export const mcpServerTestResultSchema = z
  .object({
    serverName: z.string().min(1).max(120).optional(),
    serverVersion: z.string().min(1).max(64).optional(),
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
