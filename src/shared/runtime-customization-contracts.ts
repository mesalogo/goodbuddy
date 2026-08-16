import { z } from 'zod'
import {
  assistantIdSchema,
  conversationContextCompressionStateSchema,
  conversationHistoryMessageSchema,
  maximumConversationHistoryCharacters,
  maximumConversationHistoryMessages
} from './assistant-contracts'
import { agentRuntimeSelectionSchema } from './runtime-selection-contracts'

export const customizableRuntimeProviderSchema = z.enum([
  'opencode',
  'continue',
  'deepseek-harness'
])

export type CustomizableRuntimeProvider = z.infer<
  typeof customizableRuntimeProviderSchema
>

export const runtimeCustomizationLimits = {
  presets: 12,
  rulesPerPreset: 32,
  promptsPerPreset: 32,
  nameCharacters: 120,
  descriptionCharacters: 500,
  contentCharacters: 20_000
} as const

export const runtimeNativeInventoryLimits = {
  agents: 100,
  tools: 200,
  commands: 200,
  lsp: 100,
  formatters: 100,
  mcpServers: 100,
  skills: 200,
  rules: 200,
  prompts: 200,
  resources: 200
} as const

export const boundedRuntimeIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code > 31 && code !== 127
      }),
    'Runtime 标识包含控制字符'
  )

const boundedRuntimeLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)

const boundedRuntimeDescriptionSchema = z
  .string()
  .trim()
  .max(2_000)
  .optional()

export const continueRuleSchema = z
  .object({
    id: assistantIdSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(runtimeCustomizationLimits.nameCharacters),
    content: z
      .string()
      .trim()
      .min(1)
      .max(runtimeCustomizationLimits.contentCharacters),
    enabled: z.boolean()
  })
  .strict()

export type ContinueRule = z.infer<typeof continueRuleSchema>

export const runtimePromptTemplateSchema = z
  .object({
    id: assistantIdSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(runtimeCustomizationLimits.nameCharacters),
    description: z
      .string()
      .trim()
      .max(runtimeCustomizationLimits.descriptionCharacters)
      .optional(),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(runtimeCustomizationLimits.contentCharacters)
  })
  .strict()

export type RuntimePromptTemplate = z.infer<
  typeof runtimePromptTemplateSchema
>

export const continueConfigurationPresetSchema = z
  .object({
    id: assistantIdSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(runtimeCustomizationLimits.nameCharacters),
    description: z
      .string()
      .trim()
      .max(runtimeCustomizationLimits.descriptionCharacters)
      .optional(),
    rules: z
      .array(continueRuleSchema)
      .max(runtimeCustomizationLimits.rulesPerPreset),
    prompts: z
      .array(runtimePromptTemplateSchema)
      .max(runtimeCustomizationLimits.promptsPerPreset)
  })
  .strict()
  .superRefine((preset, context) => {
    const ids = [
      ...preset.rules.map((rule) => rule.id),
      ...preset.prompts.map((prompt) => prompt.id)
    ]
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        message: 'Continue 预设中的规则与 Prompt ID 不得重复'
      })
    }
  })

export type ContinueConfigurationPreset = z.infer<
  typeof continueConfigurationPresetSchema
>

export const runtimeCustomizationSettingsSchema = z
  .object({
    opencode: z
      .object({
        defaultAgent: boundedRuntimeIdentifierSchema.optional()
      })
      .strict(),
    continue: z
      .object({
        defaultPresetId: assistantIdSchema.optional(),
        presets: z
          .array(continueConfigurationPresetSchema)
          .max(runtimeCustomizationLimits.presets)
      })
      .strict()
  })
  .strict()
  .superRefine((settings, context) => {
    const presetIds = settings.continue.presets.map(
      (preset) => preset.id
    )
    if (new Set(presetIds).size !== presetIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['continue', 'presets'],
        message: 'Continue 预设 ID 不得重复'
      })
    }
    if (
      settings.continue.defaultPresetId &&
      !presetIds.includes(settings.continue.defaultPresetId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['continue', 'defaultPresetId'],
        message: '默认 Continue 预设不存在'
      })
    }
  })

export type RuntimeCustomizationSettings = z.infer<
  typeof runtimeCustomizationSettingsSchema
>

export const defaultRuntimeCustomizationSettings: RuntimeCustomizationSettings =
  {
    opencode: {},
    continue: {
      presets: []
    }
  }

export const runtimeControlSchema = z.discriminatedUnion(
  'provider',
  [
    z
      .object({
        provider: z.literal('opencode'),
        agent: boundedRuntimeIdentifierSchema.optional(),
        command: z
          .object({
            name: boundedRuntimeIdentifierSchema,
            arguments: z.string().max(100_000)
          })
          .strict()
          .optional()
      })
      .strict(),
    z
      .object({
        provider: z.literal('continue'),
        presetId: assistantIdSchema.optional()
      })
      .strict()
  ]
)

export type RuntimeControl = z.infer<typeof runtimeControlSchema>

export const runtimeNativeSnapshotInputSchema = z
  .object({
    provider: customizableRuntimeProviderSchema,
    profileId: assistantIdSchema.optional(),
    projectId: assistantIdSchema.optional()
  })
  .strict()

export type RuntimeNativeSnapshotInput = z.infer<
  typeof runtimeNativeSnapshotInputSchema
>

export const runtimeNativeSkillSchema = z
  .object({
    id: boundedRuntimeIdentifierSchema,
    name: boundedRuntimeLabelSchema,
    description: boundedRuntimeDescriptionSchema,
    source: z
      .enum(['global', 'workspace', 'plugin', 'runtime', 'unknown'])
      .default('unknown')
  })
  .strict()

const runtimeNativeMcpServerSchema = z
  .object({
    id: boundedRuntimeIdentifierSchema,
    name: boundedRuntimeLabelSchema,
    status: z.enum([
      'connected',
      'disabled',
      'failed',
      'needs-auth',
      'unsupported',
      'unknown'
    ]),
    detail: z.string().trim().max(500).optional()
  })
  .strict()

export const runtimeNativePromptSchema = z
  .object({
    id: boundedRuntimeIdentifierSchema,
    name: boundedRuntimeLabelSchema,
    description: boundedRuntimeDescriptionSchema,
    prompt: z.string().trim().min(1).max(20_000),
    source: z.enum([
      'runtime',
      'mcp',
      'configuration',
      'preset'
    ])
  })
  .strict()

export type RuntimeNativePrompt = z.infer<
  typeof runtimeNativePromptSchema
>

export const runtimeNativeRuleSchema = z
  .object({
    id: boundedRuntimeIdentifierSchema,
    name: boundedRuntimeLabelSchema,
    description: boundedRuntimeDescriptionSchema,
    content: z.string().trim().min(1).max(20_000),
    source: z.enum([
      'global',
      'workspace',
      'configuration',
      'runtime'
    ])
  })
  .strict()

export type RuntimeNativeRule = z.infer<
  typeof runtimeNativeRuleSchema
>

const runtimeNativeResourceSchema = z
  .object({
    id: boundedRuntimeIdentifierSchema,
    name: boundedRuntimeLabelSchema,
    uri: z.string().trim().min(1).max(2_048),
    description: boundedRuntimeDescriptionSchema,
    mimeType: z.string().trim().min(1).max(200).optional(),
    server: boundedRuntimeLabelSchema.optional()
  })
  .strict()

const runtimeNativeAgentSchema = z
  .object({
    id: boundedRuntimeIdentifierSchema,
    name: boundedRuntimeLabelSchema,
    description: boundedRuntimeDescriptionSchema,
    mode: z.enum(['primary', 'subagent', 'all']),
    native: z.boolean(),
    hidden: z.boolean()
  })
  .strict()

const runtimeNativeCommandSchema = z
  .object({
    id: boundedRuntimeIdentifierSchema,
    name: boundedRuntimeLabelSchema,
    description: boundedRuntimeDescriptionSchema,
    source: z.enum(['command', 'mcp', 'skill', 'runtime']),
    agent: boundedRuntimeIdentifierSchema.optional()
  })
  .strict()

const runtimeNativeLspSchema = z
  .object({
    id: boundedRuntimeIdentifierSchema,
    name: boundedRuntimeLabelSchema,
    status: z.enum(['connected', 'error', 'not-loaded']),
    detail: z.string().trim().max(500).optional()
  })
  .strict()

const runtimeNativeFormatterSchema = z
  .object({
    id: boundedRuntimeIdentifierSchema,
    name: boundedRuntimeLabelSchema,
    enabled: z.boolean(),
    extensions: z
      .array(z.string().trim().min(1).max(32))
      .max(100)
  })
  .strict()

export const runtimeNativeToolSchema = z
  .object({
    id: boundedRuntimeIdentifierSchema,
    name: boundedRuntimeLabelSchema,
    description: boundedRuntimeDescriptionSchema,
    kind: z.enum([
      'read',
      'write',
      'shell',
      'network',
      'agent',
      'interaction',
      'other'
    ]),
    source: z.enum([
      'runtime',
      'plugin',
      'mcp',
      'skill',
      'unknown'
    ]),
    ask: z.enum(['allowed', 'blocked', 'conditional']),
    execute: z.enum(['allowed', 'blocked', 'conditional'])
  })
  .strict()

export type RuntimeNativeTool = z.infer<
  typeof runtimeNativeToolSchema
>

export const runtimeNativeInventoryStatusSchema = z.enum([
  'available',
  'partial',
  'unavailable',
  'connection-only',
  'unsupported'
])

export type RuntimeNativeInventoryStatus = z.infer<
  typeof runtimeNativeInventoryStatusSchema
>

export const runtimeContextCapabilitySchema = z
  .object({
    strategy: z.enum([
      'native',
      'goodbuddy-summary',
      'unsupported'
    ]),
    manualCompact: z.boolean(),
    detail: z.string().trim().min(1).max(500)
  })
  .strict()

export type RuntimeContextCapability = z.infer<
  typeof runtimeContextCapabilitySchema
>

export const runtimeNativeSnapshotSchema = z
  .object({
    provider: customizableRuntimeProviderSchema,
    available: z.boolean(),
    inventoryStatus: runtimeNativeInventoryStatusSchema,
    detail: z.string().trim().min(1).max(1_000),
    agents: z
      .array(runtimeNativeAgentSchema)
      .max(runtimeNativeInventoryLimits.agents),
    tools: z
      .array(runtimeNativeToolSchema)
      .max(runtimeNativeInventoryLimits.tools),
    toolsSupported: z.boolean(),
    commands: z
      .array(runtimeNativeCommandSchema)
      .max(runtimeNativeInventoryLimits.commands),
    lsp: z
      .array(runtimeNativeLspSchema)
      .max(runtimeNativeInventoryLimits.lsp),
    formatters: z
      .array(runtimeNativeFormatterSchema)
      .max(runtimeNativeInventoryLimits.formatters),
    mcpServers: z
      .array(runtimeNativeMcpServerSchema)
      .max(runtimeNativeInventoryLimits.mcpServers),
    skills: z
      .array(runtimeNativeSkillSchema)
      .max(runtimeNativeInventoryLimits.skills),
    rules: z
      .array(runtimeNativeRuleSchema)
      .max(runtimeNativeInventoryLimits.rules),
    prompts: z
      .array(runtimeNativePromptSchema)
      .max(runtimeNativeInventoryLimits.prompts),
    resources: z
      .array(runtimeNativeResourceSchema)
      .max(runtimeNativeInventoryLimits.resources),
    resourcesSupported: z.boolean(),
    context: runtimeContextCapabilitySchema
  })
  .strict()

export type RuntimeNativeSnapshot = z.infer<
  typeof runtimeNativeSnapshotSchema
>

export const runtimeConversationCompactInputSchema = z
  .object({
    requestId: assistantIdSchema,
    conversationId: assistantIdSchema,
    projectId: assistantIdSchema.optional(),
    runtimeSelection: agentRuntimeSelectionSchema,
    history: z
      .array(conversationHistoryMessageSchema)
      .max(maximumConversationHistoryMessages),
    historyMessageIds: z
      .array(assistantIdSchema)
      .max(maximumConversationHistoryMessages),
    contextCompressionState:
      conversationContextCompressionStateSchema.optional()
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.history.length !== request.historyMessageIds.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['historyMessageIds'],
        message: '会话历史消息 ID 必须与历史消息一一对应'
      })
    }
    if (
      new Set(request.historyMessageIds).size !==
      request.historyMessageIds.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['historyMessageIds'],
        message: '会话历史消息 ID 不得重复'
      })
    }
    if (
      request.history.reduce(
        (total, message) => total + message.content.length,
        0
    ) > maximumConversationHistoryCharacters
    ) {
      context.addIssue({
        code: 'custom',
        path: ['history'],
        message: `会话历史总长度不能超过 ${maximumConversationHistoryCharacters.toLocaleString()} 个字符`
      })
    }
  })

export type RuntimeConversationCompactInput = z.infer<
  typeof runtimeConversationCompactInputSchema
>

export const runtimeConversationCompactResultSchema = z
  .object({
    provider: z.enum(['opencode', 'continue']),
    strategy: z.enum(['native', 'goodbuddy-summary']),
    compacted: z.boolean(),
    detail: z.string().trim().min(1).max(500),
    contextCompressionState:
      conversationContextCompressionStateSchema.optional()
  })
  .strict()

export type RuntimeConversationCompactResult = z.infer<
  typeof runtimeConversationCompactResultSchema
>
