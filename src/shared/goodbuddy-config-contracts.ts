import { z } from 'zod'
import {
  applicationSettingsSchema,
  applicationSettingsUpdateSchema
} from './application-settings-contracts'
import {
  capabilityAssignmentsSchema,
  mcpServerIdSchema,
  mcpTransportSchema,
  skillIdSchema,
  skillSummarySchema
} from './capability-contracts'

export const GOODBUDDY_CONFIG_MAX_OPERATIONS = 32

const boundedPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code > 31 && code !== 127
      }),
    'Path contains control characters'
  )

const mcpNameSchema = z.string().trim().min(1).max(80)
const mcpDescriptionSchema = z.string().trim().max(500)
const mcpCommandSchema = z.string().trim().min(1).max(4_096)
const mcpArgumentSchema = z.string().trim().min(1).max(4_096)

const publicMcpUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) {
      context.addIssue({
        code: 'custom',
        message: 'MCP URL must use HTTP or HTTPS'
      })
    }
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: 'custom',
        message:
          'MCP URL must not contain credentials, query parameters, or fragments'
      })
    }
  })

const mcpConnectionShape = {
  name: mcpNameSchema,
  description: mcpDescriptionSchema,
  allowDynamicTools: z.boolean()
}

const directModelAssignmentsSchema = z
  .array(z.literal('model'))
  .max(1)

/**
 * Secret-free MCP connection settings accepted from a model. Authentication
 * material is intentionally absent and must be managed through the trusted UI.
 */
export const goodbuddyConfigMcpConnectionSchema = z.discriminatedUnion(
  'transport',
  [
    z
      .object({
        ...mcpConnectionShape,
        transport: z.literal('stdio'),
        command: mcpCommandSchema,
        args: z.array(mcpArgumentSchema).max(64)
      })
      .strict(),
    z
      .object({
        ...mcpConnectionShape,
        transport: z.literal('http'),
        url: publicMcpUrlSchema
      })
      .strict(),
    z
      .object({
        ...mcpConnectionShape,
        transport: z.literal('sse'),
        url: publicMcpUrlSchema
      })
      .strict()
  ]
)
export type GoodBuddyConfigMcpConnection = z.infer<
  typeof goodbuddyConfigMcpConnectionSchema
>

const applicationUpdateOperationSchema = z
  .object({
    operation: z.literal('application.update'),
    updates: applicationSettingsUpdateSchema
  })
  .strict()

const skillImportOperationSchema = z
  .object({
    operation: z.literal('skill.import'),
    sourcePath: boundedPathSchema,
    enabled: z.boolean(),
    assignments: capabilityAssignmentsSchema
  })
  .strict()

const skillSetEnabledOperationSchema = z
  .object({
    operation: z.literal('skill.setEnabled'),
    skillId: skillIdSchema,
    enabled: z.boolean()
  })
  .strict()

const skillSetAssignmentsOperationSchema = z
  .object({
    operation: z.literal('skill.setAssignments'),
    skillId: skillIdSchema,
    assignments: capabilityAssignmentsSchema
  })
  .strict()

const skillRemoveOperationSchema = z
  .object({
    operation: z.literal('skill.remove'),
    skillId: skillIdSchema
  })
  .strict()

const mcpAddOperationSchema = z
  .object({
    operation: z.literal('mcp.add'),
    connection: goodbuddyConfigMcpConnectionSchema,
    enabled: z.boolean(),
    assignments: directModelAssignmentsSchema
  })
  .strict()

const mcpUpdateOperationSchema = z
  .object({
    operation: z.literal('mcp.update'),
    serverId: mcpServerIdSchema,
    connection: goodbuddyConfigMcpConnectionSchema
  })
  .strict()

const mcpSetEnabledOperationSchema = z
  .object({
    operation: z.literal('mcp.setEnabled'),
    serverId: mcpServerIdSchema,
    enabled: z.boolean()
  })
  .strict()

const mcpSetAssignmentsOperationSchema = z
  .object({
    operation: z.literal('mcp.setAssignments'),
    serverId: mcpServerIdSchema,
    assignments: directModelAssignmentsSchema
  })
  .strict()

const mcpRemoveOperationSchema = z
  .object({
    operation: z.literal('mcp.remove'),
    serverId: mcpServerIdSchema
  })
  .strict()

export const goodbuddyConfigOperationSchema = z.discriminatedUnion(
  'operation',
  [
    applicationUpdateOperationSchema,
    skillImportOperationSchema,
    skillSetEnabledOperationSchema,
    skillSetAssignmentsOperationSchema,
    skillRemoveOperationSchema,
    mcpAddOperationSchema,
    mcpUpdateOperationSchema,
    mcpSetEnabledOperationSchema,
    mcpSetAssignmentsOperationSchema,
    mcpRemoveOperationSchema
  ]
)
export type GoodBuddyConfigOperation = z.infer<
  typeof goodbuddyConfigOperationSchema
>

export const goodbuddyConfigOperationNameSchema = z.enum([
  'application.update',
  'skill.import',
  'skill.setEnabled',
  'skill.setAssignments',
  'skill.remove',
  'mcp.add',
  'mcp.update',
  'mcp.setEnabled',
  'mcp.setAssignments',
  'mcp.remove'
])
export type GoodBuddyConfigOperationName = z.infer<
  typeof goodbuddyConfigOperationNameSchema
>

export const goodbuddyConfigRiskSchema = z.enum([
  'low',
  'medium',
  'high'
])
export type GoodBuddyConfigRisk = z.infer<
  typeof goodbuddyConfigRiskSchema
>

export const goodbuddyConfigReloadSchema = z.enum([
  'none',
  'after-current-request'
])
export type GoodBuddyConfigReload = z.infer<
  typeof goodbuddyConfigReloadSchema
>

type OperationRegistry = {
  [Name in GoodBuddyConfigOperationName]: {
    summary: string
    risk: GoodBuddyConfigRisk
    reload: GoodBuddyConfigReload
    destructive: boolean
    exampleRequest: string
    example: Extract<GoodBuddyConfigOperation, { operation: Name }>
  }
}

export const goodbuddyConfigOperationRegistry = {
  'application.update': {
    summary: 'Update one or more public application preferences.',
    risk: 'low',
    reload: 'none',
    destructive: false,
    exampleRequest: '关闭启动时自动检查更新。',
    example: {
      operation: 'application.update',
      updates: { checkUpdatesOnStartup: false }
    }
  },
  'skill.import': {
    summary: 'Import one Skill directory or ZIP from a local path.',
    risk: 'high',
    reload: 'after-current-request',
    destructive: false,
    exampleRequest: '导入当前工作区的 meeting-helper Skill。',
    example: {
      operation: 'skill.import',
      sourcePath: './meeting-helper',
      enabled: true,
      assignments: ['model']
    }
  },
  'skill.setEnabled': {
    summary: 'Enable or disable an installed Skill.',
    risk: 'medium',
    reload: 'after-current-request',
    destructive: false,
    exampleRequest: '启用 meeting-helper Skill。',
    example: {
      operation: 'skill.setEnabled',
      skillId: 'meeting-helper',
      enabled: true
    }
  },
  'skill.setAssignments': {
    summary: 'Choose the runtimes that can use an installed Skill.',
    risk: 'medium',
    reload: 'after-current-request',
    destructive: false,
    exampleRequest: '让 meeting-helper 可用于直连模型和 OpenCode。',
    example: {
      operation: 'skill.setAssignments',
      skillId: 'meeting-helper',
      assignments: ['model', 'opencode']
    }
  },
  'skill.remove': {
    summary: 'Permanently remove an imported Skill.',
    risk: 'high',
    reload: 'after-current-request',
    destructive: true,
    exampleRequest: '删除已导入的 meeting-helper Skill。',
    example: {
      operation: 'skill.remove',
      skillId: 'meeting-helper'
    }
  },
  'mcp.add': {
    summary: 'Add a secret-free MCP server configuration.',
    risk: 'high',
    reload: 'after-current-request',
    destructive: false,
    exampleRequest:
      '添加一个使用 npx 启动的本地 MCP，先保持禁用，只分配给直连模型。',
    example: {
      operation: 'mcp.add',
      connection: {
        name: 'Local tools',
        description: 'Local project tools',
        allowDynamicTools: false,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/mcp-server']
      },
      enabled: false,
      assignments: ['model']
    }
  },
  'mcp.update': {
    summary: 'Replace the public connection settings for an MCP server.',
    risk: 'high',
    reload: 'after-current-request',
    destructive: false,
    exampleRequest: '把 Project tools MCP 的地址改为新的 HTTPS 地址。',
    example: {
      operation: 'mcp.update',
      serverId: '00000000-0000-4000-8000-000000000001',
      connection: {
        name: 'Project tools',
        description: 'Tools served on the local network',
        allowDynamicTools: true,
        transport: 'http',
        url: 'https://mcp.example.com/tools'
      }
    }
  },
  'mcp.setEnabled': {
    summary: 'Enable or disable a configured MCP server.',
    risk: 'high',
    reload: 'after-current-request',
    destructive: false,
    exampleRequest: '启用指定的 MCP Server。',
    example: {
      operation: 'mcp.setEnabled',
      serverId: '00000000-0000-4000-8000-000000000001',
      enabled: true
    }
  },
  'mcp.setAssignments': {
    summary: 'Choose the runtimes that can use an MCP server.',
    risk: 'high',
    reload: 'after-current-request',
    destructive: false,
    exampleRequest: '只把指定 MCP Server 分配给直连模型。',
    example: {
      operation: 'mcp.setAssignments',
      serverId: '00000000-0000-4000-8000-000000000001',
      assignments: ['model']
    }
  },
  'mcp.remove': {
    summary: 'Permanently remove an MCP server configuration.',
    risk: 'high',
    reload: 'after-current-request',
    destructive: true,
    exampleRequest: '删除指定的 MCP Server 配置。',
    example: {
      operation: 'mcp.remove',
      serverId: '00000000-0000-4000-8000-000000000001'
    }
  }
} as const satisfies OperationRegistry

export const goodbuddyConfigCommonExamples =
  goodbuddyConfigOperationNameSchema.options.map(
    (operation) => goodbuddyConfigOperationRegistry[operation].example
  )

export const goodbuddyConfigOperationDescriptorSchema = z
  .object({
    operation: goodbuddyConfigOperationNameSchema,
    summary: z.string().min(1).max(240),
    risk: goodbuddyConfigRiskSchema,
    reload: goodbuddyConfigReloadSchema,
    destructive: z.boolean(),
    exampleRequest: z.string().min(1).max(240),
    example: goodbuddyConfigOperationSchema
  })
  .strict()
export type GoodBuddyConfigOperationDescriptor = z.infer<
  typeof goodbuddyConfigOperationDescriptorSchema
>

export const goodbuddyConfigOperationDescriptors =
  goodbuddyConfigOperationNameSchema.options.map((operation) => ({
    operation,
    ...goodbuddyConfigOperationRegistry[operation]
  }))

export const goodbuddyConfigCapabilitiesInputSchema = z
  .object({})
  .strict()
export type GoodBuddyConfigCapabilitiesInput = z.infer<
  typeof goodbuddyConfigCapabilitiesInputSchema
>

export const goodbuddyConfigCapabilitiesOutputSchema = z
  .object({
    server: z.literal('goodbuddy_config'),
    version: z.literal(1),
    authorization: z.literal('request-scoped'),
    secretPolicy: z.literal('never-exposed-or-accepted'),
    applyRequiresApproval: z.literal(true),
    operations: z.array(goodbuddyConfigOperationDescriptorSchema).length(10)
  })
  .strict()
export type GoodBuddyConfigCapabilitiesOutput = z.infer<
  typeof goodbuddyConfigCapabilitiesOutputSchema
>

export const goodbuddyConfigCapabilities = {
  server: 'goodbuddy_config',
  version: 1,
  authorization: 'request-scoped',
  secretPolicy: 'never-exposed-or-accepted',
  applyRequiresApproval: true,
  operations: goodbuddyConfigOperationDescriptors
} as const satisfies GoodBuddyConfigCapabilitiesOutput

/**
 * Deliberately omits commands, arguments, URLs, and credential values.
 */
export const goodbuddyConfigMcpSummarySchema = z
  .object({
    id: mcpServerIdSchema,
    name: mcpNameSchema,
    description: mcpDescriptionSchema,
    enabled: z.boolean(),
    allowDynamicTools: z.boolean(),
    assignments: capabilityAssignmentsSchema,
    secretConfigured: z.boolean(),
    transport: mcpTransportSchema
  })
  .strict()
export type GoodBuddyConfigMcpSummary = z.infer<
  typeof goodbuddyConfigMcpSummarySchema
>

export const goodbuddyConfigSnapshotSchema = z
  .object({
    application: applicationSettingsSchema,
    skills: z.array(skillSummarySchema).max(256),
    mcpServers: z.array(goodbuddyConfigMcpSummarySchema).max(64)
  })
  .strict()
export type GoodBuddyConfigSnapshot = z.infer<
  typeof goodbuddyConfigSnapshotSchema
>

export const goodbuddyConfigGetInputSchema = z.object({}).strict()
export type GoodBuddyConfigGetInput = z.infer<
  typeof goodbuddyConfigGetInputSchema
>

export const goodbuddyConfigGetOutputSchema =
  goodbuddyConfigSnapshotSchema
export type GoodBuddyConfigGetOutput = GoodBuddyConfigSnapshot

export const goodbuddyConfigPlanInputSchema = z
  .object({
    operations: z
      .array(goodbuddyConfigOperationSchema)
      .min(1)
      .max(GOODBUDDY_CONFIG_MAX_OPERATIONS)
  })
  .strict()
export type GoodBuddyConfigPlanInput = z.infer<
  typeof goodbuddyConfigPlanInputSchema
>

export const goodbuddyConfigPlanStepSchema = z
  .object({
    index: z.number().int().nonnegative(),
    operation: goodbuddyConfigOperationNameSchema,
    summary: z.string().min(1).max(12_000),
    risk: goodbuddyConfigRiskSchema,
    reload: goodbuddyConfigReloadSchema,
    destructive: z.boolean()
  })
  .strict()
export type GoodBuddyConfigPlanStep = z.infer<
  typeof goodbuddyConfigPlanStepSchema
>

export const goodbuddyConfigPlanOutputSchema = z
  .object({
    planId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    operations: z
      .array(goodbuddyConfigOperationSchema)
      .min(1)
      .max(GOODBUDDY_CONFIG_MAX_OPERATIONS),
    steps: z
      .array(goodbuddyConfigPlanStepSchema)
      .min(1)
      .max(GOODBUDDY_CONFIG_MAX_OPERATIONS),
    overallRisk: goodbuddyConfigRiskSchema,
    reload: goodbuddyConfigReloadSchema,
    requiresApproval: z.literal(true)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operations.length !== value.steps.length) {
      context.addIssue({
        code: 'custom',
        message: 'Plan operations and steps must have the same length'
      })
    }
  })
export type GoodBuddyConfigPlanOutput = z.infer<
  typeof goodbuddyConfigPlanOutputSchema
>

export const goodbuddyConfigApplyInputSchema = z
  .object({
    planId: z.string().uuid()
  })
  .strict()
export type GoodBuddyConfigApplyInput = z.infer<
  typeof goodbuddyConfigApplyInputSchema
>

export const goodbuddyConfigApplyOutputSchema = z
  .object({
    planId: z.string().uuid(),
    status: z.enum(['applied', 'partially-applied']),
    appliedOperations: z
      .number()
      .int()
      .min(1)
      .max(GOODBUDDY_CONFIG_MAX_OPERATIONS),
    reload: goodbuddyConfigReloadSchema,
    snapshot: goodbuddyConfigSnapshotSchema,
    error: z.string().min(1).max(2_000).optional()
  })
  .strict()
export type GoodBuddyConfigApplyOutput = z.infer<
  typeof goodbuddyConfigApplyOutputSchema
>
