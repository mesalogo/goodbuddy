import { z } from 'zod'
import type {
  BrowserProfileCreateInput,
  BrowserProfileRenameInput,
  CapabilityDiagnosticReport,
  CapabilityAssignments,
  CapabilitySnapshot,
  ComputerCapabilityId,
  McpServerInput,
  McpServerTestResult,
  SkillImportKind
} from './capability-contracts'
import {
  assistantIdSchema,
  workModeSchema,
  type AssistantProject,
  type AssistantArtifact,
  type AssistantMemory,
  type AssistantSchedule,
  type AssistantHeartbeatConfig,
  type AssistantHeartbeatEntry,
  type AssistantHeartbeatRun,
  type AssistantExpert,
  type AssistantTask,
  type TokenUsageSummary,
  type ConversationSnapshot,
  type ConversationAttachment,
  type WorkspaceChanges,
  type WorkspaceDirectoryListing,
  type WorkspaceFilePreview,
  type ProjectCreateInput,
  type MemoryCreateInput,
  type ScheduleCreateInput,
  type HeartbeatCreateInput,
  type HeartbeatUpdateInput,
  type ExpertCreateInput,
  type ExpertUpdateInput
} from './assistant-contracts'
import type {
  MagicNoteDetail,
  MagicNoteCreateInput,
  MagicNoteEntryCreateInput,
  MagicNoteEntryUpdateInput,
  MagicNotesSnapshot,
  MagicNoteUpdateInput,
  MagicTodoCreateInput,
  MagicTodoItem,
  MagicTodosSnapshot,
  MagicTodoUpdateInput
} from './magic-notes-contracts'
import type {
  ChannelConnectionTestResult,
  ChannelSettingsApply,
  ChannelSettingsSnapshot,
  CredentialChannel,
  DingTalkChannelSettingsInput,
  WeComChannelSettingsInput
} from './channel-settings-contracts'
import type {
  ApplicationSettings,
  VersionCheckResult
} from './application-settings-contracts'
import type {
  SpeechModelSnapshot,
  SpeechTranscriptionInput,
  SpeechTranscriptionResult
} from './speech-model-contracts'
import type {
  EmbeddingDiagnosticResult,
  EmbeddingIndexStatus,
  EmbeddingSettingsSnapshot
} from './embedding-contracts'
import type { WeixinBindingSnapshot } from './weixin-channel-contracts'
import type { RemoteChannelActivity } from './remote-channel-contracts'
import {
  agentRuntimeSelectionSchema,
  type AgentRuntimeSelection
} from './runtime-selection-contracts'

export const workspaceRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => {
    if (
      value.includes('\0') ||
      /^[\\/]/u.test(value) ||
      /^[a-zA-Z]:[\\/]/u.test(value)
    ) {
      return false
    }
    return value
      .split(/[\\/]/u)
      .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  }, '路径必须是工作区内的相对路径')

export const workspaceDirectoryRequestSchema = z
  .object({
    projectId: assistantIdSchema,
    path: z.union([workspaceRelativePathSchema, z.literal('')])
  })
  .strict()

export const workspaceFileRequestSchema = z
  .object({
    projectId: assistantIdSchema,
    path: workspaceRelativePathSchema
  })
  .strict()

export const workspaceOpenPathRequestSchema = z
  .object({
    projectId: assistantIdSchema,
    path: workspaceRelativePathSchema,
    type: z.enum(['file', 'directory'])
  })
  .strict()

export const agentQuestionAnswerSchema = z
  .array(z.string().trim().min(1).max(2_000))
  .max(20)

export const agentQuestionResponseSchema = z
  .object({
    questionId: z.string().trim().min(1).max(128),
    answers: z.array(agentQuestionAnswerSchema).max(4)
  })
  .strict()

export type AgentQuestionAnswer = z.infer<
  typeof agentQuestionAnswerSchema
>

export const conversationIdSchema = z.string().min(1).max(128)

export const agentRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    conversationId: conversationIdSchema,
    projectId: z.string().uuid().optional(),
    expertId: z.string().uuid().optional(),
    teamMode: z.boolean().optional(),
    smartRouting: z.boolean().optional(),
    runtimeSelection: agentRuntimeSelectionSchema.optional(),
    workMode: workModeSchema.optional(),
    prompt: z.string().trim().min(1).max(100_000),
    knowledgeLibraryIds: z
      .array(z.string().uuid())
      .max(20)
      .default([]),
    contextIds: z.array(z.string().uuid()).max(8).optional(),
    history: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(100_000)
          })
          .strict()
      )
      .max(40)
      .optional()
  })
  .strict()
  .superRefine((request, context) => {
    const historyLength =
      request.history?.reduce(
        (total, message) => total + message.content.length,
        0
      ) ?? 0
    if (historyLength > 500_000) {
      context.addIssue({
        code: 'custom',
        path: ['history'],
        message: '会话历史总长度不能超过 500,000 个字符'
      })
    }
  })

export type AgentRequest = z.input<typeof agentRequestSchema>

export const runtimeProviderSchema = z.enum([
  'auto',
  'model',
  'opencode',
  'continue'
])

export const toolApprovalPolicySchema = z.enum([
  'always',
  'session',
  'workspace',
  'policy'
])

export const continueModeSchema = z.enum(['chat', 'agent'])
export const runtimeSandboxModeSchema = z.enum(['off', 'auto', 'strict'])
export const modelProtocolSchema = z.enum([
  'anthropic-messages',
  'openai-responses',
  'openai-chat-completions',
  'openai-images-generations'
])
export const modelAuthenticationSchema = z.enum(['api-key', 'none'])
export const imageGenerationQualitySchema = z.enum([
  'auto',
  'low',
  'medium',
  'high'
])
export type ModelProtocol = z.infer<typeof modelProtocolSchema>
export function isAgentRuntimeModelProtocol(
  protocol: ModelProtocol
): boolean {
  return protocol !== 'openai-images-generations'
}
export type ModelAuthentication = z.infer<
  typeof modelAuthenticationSchema
>
export type ImageGenerationQuality = z.infer<
  typeof imageGenerationQualitySchema
>
export const defaultModelProfileId =
  '00000000-0000-4000-8000-000000000001'
export const modelProfileIdSchema = z.string().uuid()

export const defaultRuntimeSettings = {
  provider: 'model',
  modelBaseUrl: 'https://bigtoken.ai',
  modelName: 'sonnet-5',
  modelProtocol: 'anthropic-messages',
  modelAuthentication: 'api-key',
  imageGenerationQuality: 'auto',
  opencodeBaseUrl: '',
  opencodeEmbedded: true,
  opencodeBinaryPath: '',
  opencodeConfigPath: '',
  continueBinaryPath: '',
  continueConfigPath: '',
  continueMode: 'chat',
  runtimeSandboxMode: 'auto',
  subagentSmartRoutingEnabled: false,
  knowledgeEmbeddingEnabled: false,
  knowledgeEmbeddingBaseUrl:
    'http://127.0.0.1:11434/v1/embeddings',
  knowledgeEmbeddingModel: 'nomic-embed-text',
  workspacePath: '',
  toolApproval: 'always'
} as const

export const runtimePathSchema = z
  .string()
  .max(4_096)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code > 31 && code !== 127
      }),
    'Runtime 路径包含控制字符'
  )

export const runtimeFileSelectionKindSchema = z.enum([
  'opencodeBinary',
  'opencodeConfig',
  'continueBinary',
  'continueConfig'
])

export type RuntimeFileSelectionKind = z.infer<
  typeof runtimeFileSelectionKindSchema
>

export const runtimeConfigActionInputSchema = z
  .object({
    runtime: z.enum(['opencode', 'continue']),
    action: z.enum(['open-file', 'show-file', 'open-directory'])
  })
  .strict()

export type RuntimeConfigActionInput = z.infer<
  typeof runtimeConfigActionInputSchema
>

const modelApiKeyUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z
    .object({
      action: z.literal('replace'),
      value: z
        .string()
        .trim()
        .min(1)
        .max(8_192)
        .refine(
          (value) =>
            [...value].every((character) => {
              const code = character.charCodeAt(0)
              return code > 31 && code !== 127
            }),
          {
            message: 'API Key 包含控制字符'
          }
        )
    })
    .strict(),
  z.object({ action: z.literal('clear') }).strict()
])

const modelProfileInputSchema = z
  .object({
    id: modelProfileIdSchema,
    name: z.string().trim().min(1).max(64),
    baseUrl: z.string().url().max(2_048),
    modelName: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[\w./:-]+$/, '模型名称包含不支持的字符'),
    protocol: modelProtocolSchema,
    authentication: modelAuthenticationSchema,
    imageGenerationQuality: imageGenerationQualitySchema,
    apiKey: modelApiKeyUpdateSchema
  })
  .strict()

export const runtimeModelSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('platform') }).strict(),
  z
    .object({
      kind: z.literal('profile'),
      profileId: z.string().uuid()
    })
    .strict()
])

export const runtimeSettingsInputSchema = z
  .object({
    provider: runtimeProviderSchema,
    modelBaseUrl: z.string().url().max(2_048),
    modelName: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[\w./:-]+$/, '模型名称包含不支持的字符'),
    modelProtocol: modelProtocolSchema,
    modelAuthentication: modelAuthenticationSchema,
    imageGenerationQuality: imageGenerationQualitySchema,
    opencodeBaseUrl: z.union([
      z.literal(''),
      z.string().url().max(2_048)
    ]),
    opencodeEmbedded: z.boolean(),
    opencodeBinaryPath: runtimePathSchema,
    opencodeConfigPath: runtimePathSchema,
    continueBinaryPath: runtimePathSchema,
    continueConfigPath: runtimePathSchema,
    continueMode: continueModeSchema,
    runtimeSandboxMode: runtimeSandboxModeSchema,
    subagentSmartRoutingEnabled: z.boolean().optional(),
    knowledgeEmbeddingEnabled: z.boolean(),
    knowledgeEmbeddingBaseUrl: z.string().url().max(2_048),
    knowledgeEmbeddingModel: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[\w./:-]+$/, '向量模型名称包含不支持的字符'),
    knowledgeEmbeddingApiKey: modelApiKeyUpdateSchema.optional(),
    workspacePath: z.string().trim().min(1).max(4_096),
    apiKey: modelApiKeyUpdateSchema,
    modelProfiles: z.array(modelProfileInputSchema).min(1).max(20).optional(),
    defaultModelProfileId: modelProfileIdSchema.optional(),
    opencodeModelSource: runtimeModelSourceSchema.optional(),
    continueModelSource: runtimeModelSourceSchema.optional(),
    toolApproval: toolApprovalPolicySchema
  }).strict()
  .superRefine((settings, context) => {
    if (
      !settings.modelProfiles &&
      settings.modelAuthentication === 'none' &&
      settings.apiKey.action === 'replace'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['apiKey'],
        message: '无认证模型连接不得配置 API Key'
      })
    }
    const endpoints = settings.modelProfiles?.map((profile, index) => ({
      path: ['modelProfiles', index, 'baseUrl'] as (string | number)[],
      value: profile.baseUrl
    })) ?? [{ path: ['modelBaseUrl'], value: settings.modelBaseUrl }]
    for (const endpoint of endpoints) {
      if (!['http:', 'https:'].includes(new URL(endpoint.value).protocol)) {
        context.addIssue({
          code: 'custom',
          path: endpoint.path,
          message: '模型服务地址必须使用 HTTP 或 HTTPS'
        })
      }
    }
    if (settings.modelProfiles) {
      for (const [index, profile] of settings.modelProfiles.entries()) {
        if (
          profile.authentication === 'none' &&
          profile.apiKey.action === 'replace'
        ) {
          context.addIssue({
            code: 'custom',
            path: ['modelProfiles', index, 'apiKey'],
            message: '无认证模型连接不得配置 API Key'
          })
        }
      }
      const ids = new Set(settings.modelProfiles.map((profile) => profile.id))
      const names = new Set(
        settings.modelProfiles.map((profile) => profile.name.toLowerCase())
      )
      if (
        ids.size !== settings.modelProfiles.length ||
        names.size !== settings.modelProfiles.length
      ) {
        context.addIssue({
          code: 'custom',
          path: ['modelProfiles'],
          message: '模型连接的 ID 和名称必须唯一'
        })
      }
      const defaultId =
        settings.defaultModelProfileId ?? settings.modelProfiles[0]?.id
      if (!defaultId || !ids.has(defaultId)) {
        context.addIssue({
          code: 'custom',
          path: ['defaultModelProfileId'],
          message: '默认模型连接不存在'
        })
      }
      for (const [key, source] of [
        ['opencodeModelSource', settings.opencodeModelSource],
        ['continueModelSource', settings.continueModelSource]
      ] as const) {
        if (source?.kind === 'profile' && !ids.has(source.profileId)) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'Runtime 引用的模型连接不存在'
          })
        }
      }
      const opencodeSource = settings.opencodeModelSource
      const opencodeProfile =
        opencodeSource?.kind === 'profile'
          ? settings.modelProfiles.find(
              (profile) => profile.id === opencodeSource.profileId
            )
          : undefined
      if (
        opencodeProfile &&
        !isAgentRuntimeModelProtocol(opencodeProfile.protocol)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['opencodeModelSource'],
          message:
            'OpenCode 独立模型连接仅支持文本对话协议，不支持图像生成协议'
        })
      }
      const continueSource = settings.continueModelSource
      const continueProfile =
        continueSource?.kind === 'profile'
          ? settings.modelProfiles.find(
              (profile) => profile.id === continueSource.profileId
            )
          : undefined
      if (
        continueProfile &&
        !isAgentRuntimeModelProtocol(continueProfile.protocol)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['continueModelSource'],
          message:
            'Continue 独立模型连接仅支持文本对话协议，不支持图像生成协议'
        })
      }
    }
    if (
      settings.opencodeBaseUrl &&
      !['http:', 'https:'].includes(
        new URL(settings.opencodeBaseUrl).protocol
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['opencodeBaseUrl'],
        message: 'OpenCode 地址必须使用 HTTP 或 HTTPS'
      })
    }
    if (
      !['http:', 'https:'].includes(
        new URL(settings.knowledgeEmbeddingBaseUrl).protocol
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['knowledgeEmbeddingBaseUrl'],
        message: '向量接口 URL 必须使用 HTTP 或 HTTPS'
      })
    }
  })

export type RuntimeSettingsInput = z.infer<typeof runtimeSettingsInputSchema>

export type RuntimeModelSource = z.infer<typeof runtimeModelSourceSchema>

export type ModelConnectionSettings = {
  id: string
  name: string
  baseUrl: string
  modelName: string
  protocol: ModelProtocol
  authentication: ModelAuthentication
  imageGenerationQuality: ImageGenerationQuality
  apiKeyConfigured: boolean
  credentialSource: 'none' | 'encrypted' | 'environment'
}

export type RuntimeSettings = {
  provider: RuntimeSettingsInput['provider']
  modelBaseUrl: string
  modelName: string
  modelProtocol: ModelProtocol
  modelAuthentication: ModelAuthentication
  imageGenerationQuality: ImageGenerationQuality
  opencodeBaseUrl: string
  opencodeEmbedded: boolean
  opencodeBinaryPath: string
  opencodeConfigPath: string
  continueBinaryPath: string
  continueConfigPath: string
  continueMode: RuntimeSettingsInput['continueMode']
  runtimeSandboxMode: RuntimeSettingsInput['runtimeSandboxMode']
  subagentSmartRoutingEnabled: boolean
  knowledgeEmbeddingEnabled: boolean
  knowledgeEmbeddingBaseUrl: string
  knowledgeEmbeddingModel: string
  knowledgeEmbeddingApiKeyConfigured: boolean
  knowledgeEmbeddingCredentialSource: 'none' | 'encrypted' | 'environment'
  workspacePath: string
  apiKeyConfigured: boolean
  credentialSource: 'none' | 'encrypted' | 'environment'
  modelProfiles: ModelConnectionSettings[]
  defaultModelProfileId: string
  opencodeModelSource: RuntimeModelSource
  continueModelSource: RuntimeModelSource
  secureStorageAvailable: boolean
  toolApproval: RuntimeSettingsInput['toolApproval']
  warning?: string
}

export type ContextAttachment = ConversationAttachment

export const windowCaptureSourceIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code > 31 && code !== 127
      }),
    '窗口来源 ID 无效'
  )

export const windowCaptureRequestSchema = z
  .object({
    sourceId: windowCaptureSourceIdSchema
  })
  .strict()

export type WindowCaptureOption = {
  id: string
  name: string
}

export type AgentRuntimeStatus = {
  id: 'setup' | 'model' | 'opencode' | 'continue'
  label: string
  available: boolean
  detail: string
  capability?: 'chat' | 'image-generation'
  supportsToolExecution: boolean
}

export type RuntimeBinaryDetection =
  | {
      available: true
      path: string
      version?: string
      detail: string
    }
  | {
      available: false
      path?: never
      version?: never
      detail: string
    }

export type AgentRuntimeDetection = {
  opencode: RuntimeBinaryDetection
  continue: RuntimeBinaryDetection
}

export const approvalDecisionSchema = z.enum([
  'deny',
  'once',
  'session',
  'permanent'
])

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>

export const subagentEventSchema = z
  .object({
    requestId: z.string().uuid(),
    type: z.literal('subagent'),
    childTaskId: z.string().uuid(),
    expertId: z.string().uuid(),
    expertName: z.string().trim().min(1).max(80),
    routingMode: z.enum(['manual', 'smart']),
    state: z.enum([
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled'
    ]),
    reason: z.string().trim().min(1).max(240).optional(),
    error: z.string().trim().min(1).max(1_000).optional()
  })
  .strict()

export type SubagentEvent = z.infer<typeof subagentEventSchema>

export type AgentEvent =
  | {
      requestId: string
      type: 'status'
      message: string
    }
  | {
      requestId: string
      type: 'text'
      delta: string
    }
  | {
      requestId: string
      type: 'reasoning'
      delta: string
    }
  | {
      requestId: string
      type: 'tool'
      callId: string
      name: string
      state:
        | 'pending'
        | 'running'
        | 'completed'
        | 'failed'
        | 'recoverable'
      summary: string
      input?: string
      output?: string
      error?: string
    }
  | {
      requestId: string
      type: 'approval'
      approvalId: string
      title: string
      description: string
      toolName?: string
      argumentSummary?: string
      allowPermanent?: boolean
    }
  | {
      requestId: string
      type: 'question'
      questionId: string
      questions: Array<{
        header: string
        question: string
        options: Array<{
          label: string
          description: string
        }>
        multiple: boolean
        custom: boolean
      }>
    }
  | {
      requestId: string
      type: 'artifact'
      artifactId: string
      kind: 'image'
      title: string
    }
  | {
      requestId: string
      type: 'source-references'
      references: KnowledgeSearchReference[]
    }
  | {
      requestId: string
      type: 'done'
      sessionId?: string
    }
  | {
      requestId: string
      type: 'error'
      status: 'failed' | 'cancelled'
      message: string
    }
  | SubagentEvent

export type AppInfo = {
  name: string
  version: string
  platform: string
  arch: string
  shortcut: string
}

export const browserLiveStateSchema = z
  .object({
    conversationId: conversationIdSchema,
    status: z.enum([
      'creating',
      'loading',
      'ready',
      'acting',
      'interactive',
      'failed',
      'stopped'
    ]),
    url: z.string().max(2_048).optional(),
    frameDataUrl: z
      .string()
      .max(400_000)
      .refine(
        (value) => value.startsWith('data:image/jpeg;base64,'),
        '浏览器画面格式无效'
      )
      .optional(),
    error: z.string().min(1).max(240).optional(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()

export type BrowserLiveState = z.infer<typeof browserLiveStateSchema>

export const browserStopRequestSchema = z
  .object({
    conversationId: conversationIdSchema
  })
  .strict()

export const browserInteractRequestSchema = browserStopRequestSchema

export const knowledgeIdSchema = z.string().uuid()
export const knowledgeCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1_000),
    storageMode: z.enum(['reference', 'managed']),
    graphEnabled: z.boolean(),
    graphStrategy: z.enum(['rules', 'model', 'hybrid', 'ask'])
  })
  .strict()
export const knowledgeImportPathsSchema = z
  .object({
    libraryId: knowledgeIdSchema,
    paths: z.array(z.string().trim().min(1).max(4_096)).min(1).max(20),
    graphStrategy: z.enum(['rules', 'model', 'hybrid']).optional()
  })
  .strict()
export const knowledgeUrlImportSchema = z
  .object({
    libraryId: knowledgeIdSchema,
    url: z.string().url().max(2_048),
    graphStrategy: z.enum(['rules', 'model', 'hybrid']).optional()
  })
  .strict()
export const knowledgeUpdateLibrarySchema = z
  .object({
    libraryId: knowledgeIdSchema,
    graphEnabled: z.boolean(),
    graphStrategy: z.enum(['rules', 'model', 'hybrid', 'ask'])
  })
  .strict()
export const knowledgeEntityUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    type: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000),
    aliases: z.array(z.string().trim().min(1).max(120)).max(50)
  })
  .strict()
export const knowledgeRelationInputSchema = z
  .object({
    sourceId: knowledgeIdSchema,
    targetId: knowledgeIdSchema,
    type: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000)
  })
  .strict()

export type KnowledgeLibrary = z.infer<typeof knowledgeCreateSchema> & {
  id: string
  sourceCount: number
  documentCount: number
  indexedDocumentCount: number
  updatedAt?: string
}

export type KnowledgeSourceItem = {
  id: string
  libraryId: string
  name: string
  kind: 'file' | 'directory' | 'url'
  location?: string
  status: 'queued' | 'syncing' | 'paused' | 'ready' | 'failed'
  progress?: number
  documentCount: number
  lastSyncedAt?: string
  error?: string
}

export type KnowledgeDocumentItem = {
  id: string
  libraryId: string
  sourceId?: string
  name: string
  path?: string
  status: 'queued' | 'parsing' | 'indexing' | 'ready' | 'failed'
  indexProgress?: number
  chunkCount?: number
  size?: number
  updatedAt?: string
  error?: string
}

export type KnowledgeGraphNode = {
  id: string
  label: string
  type: string
  description?: string
  aliases?: string[]
  x: number
  y: number
  evidenceIds?: string[]
}

export type KnowledgeGraphRelation = {
  id: string
  sourceId: string
  targetId: string
  type: string
  description?: string
  evidenceIds?: string[]
}

export type KnowledgeEvidence = {
  id: string
  documentId: string
  documentName: string
  excerpt: string
  location?: string
}

export type KnowledgeSnapshot = {
  libraries: KnowledgeLibrary[]
  selectedLibraryId?: string
  sources: KnowledgeSourceItem[]
  documents: KnowledgeDocumentItem[]
  graphNodes: KnowledgeGraphNode[]
  graphRelations: KnowledgeGraphRelation[]
  evidence: KnowledgeEvidence[]
}

export type KnowledgeSearchReference = {
  libraryId: string
  libraryName: string
  documentId: string
  documentName: string
  sourceName: string
  sourceLocation?: string
  locator?: string
  snippet: string
  rank: number
  retrievalChannels?: Array<'fts' | 'vector' | 'graph'>
  evidenceIds?: string[]
}

export type DesktopApi = {
  app: {
    getInfo: () => Promise<AppInfo>
    show: () => Promise<void>
    hide: () => Promise<void>
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<void>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    onMaximizedChanged: (listener: (maximized: boolean) => void) => () => void
    clearLocalData: () => Promise<void>
    onNewConversation: (listener: () => void) => () => void
    onOpenSettings: (listener: () => void) => () => void
  }
  agent: {
    getStatus: (
      selection?: AgentRuntimeSelection
    ) => Promise<AgentRuntimeStatus>
    run: (request: AgentRequest) => Promise<void>
    cancel: (requestId: string) => Promise<void>
    respondApproval: (
      approvalId: string,
      decision: ApprovalDecision
    ) => Promise<void>
    respondQuestion: (
      questionId: string,
      answers?: AgentQuestionAnswer[]
    ) => Promise<void>
    onEvent: (listener: (event: AgentEvent) => void) => () => void
  }
  browser: {
    interact: (conversationId: string) => Promise<void>
    stop: (conversationId: string) => Promise<void>
    onState: (listener: (state: BrowserLiveState) => void) => () => void
  }
  settings: {
    getRuntime: () => Promise<RuntimeSettings>
    updateRuntime: (input: RuntimeSettingsInput) => Promise<RuntimeSettings>
    selectWorkspace: () => Promise<string | undefined>
    detectAgentRuntimes: () => Promise<AgentRuntimeDetection>
    selectRuntimeFile: (
      kind: RuntimeFileSelectionKind
    ) => Promise<string | undefined>
    openRuntimeConfig: (input: RuntimeConfigActionInput) => Promise<void>
    testModelConnection: (
      profileId: string
    ) => Promise<AgentRuntimeStatus>
    testRuntime: (
      selection: AgentRuntimeSelection
    ) => Promise<AgentRuntimeStatus>
  }
  channels?: {
    getSnapshot: () => Promise<ChannelSettingsSnapshot>
    apply: (input: ChannelSettingsApply) => Promise<ChannelSettingsSnapshot>
    testConnection: (
      channel: CredentialChannel,
      settings?: WeComChannelSettingsInput | DingTalkChannelSettingsInput
    ) => Promise<ChannelConnectionTestResult>
    getWeixinBinding: () => Promise<WeixinBindingSnapshot>
    startWeixinBinding: () => Promise<WeixinBindingSnapshot>
    submitWeixinVerification: (
      code: string
    ) => Promise<WeixinBindingSnapshot>
    disconnectWeixin: () => Promise<WeixinBindingSnapshot>
    onWeixinBindingChanged: (
      listener: (snapshot: WeixinBindingSnapshot) => void
    ) => () => void
    onRemoteActivity: (
      listener: (activity: RemoteChannelActivity) => void
    ) => () => void
  }
  updates?: {
    getSettings: () => Promise<ApplicationSettings>
    updateSettings: (
      input: ApplicationSettings
    ) => Promise<ApplicationSettings>
    check: () => Promise<VersionCheckResult>
    openReleasePage: () => Promise<void>
    onResult: (
      listener: (result: VersionCheckResult) => void
    ) => () => void
  }
  speechModels?: {
    getSnapshot: () => Promise<SpeechModelSnapshot>
    install: (modelId: string) => Promise<SpeechModelSnapshot>
    cancel: (modelId: string) => Promise<boolean>
    remove: (modelId: string) => Promise<SpeechModelSnapshot>
    select: (modelId: string | null) => Promise<SpeechModelSnapshot>
    importLocalDirectory: (
      modelId: string
    ) => Promise<SpeechModelSnapshot | undefined>
    openRepository: (modelId: string) => Promise<void>
    openModelsDirectory: () => Promise<void>
  }
  speech?: {
    transcribe: (
      input: SpeechTranscriptionInput
    ) => Promise<SpeechTranscriptionResult>
    cancel: (requestId: string) => Promise<boolean>
  }
  embeddings?: {
    getSnapshot: () => Promise<EmbeddingSettingsSnapshot>
    diagnose: () => Promise<EmbeddingDiagnosticResult>
    rebuild: () => Promise<EmbeddingIndexStatus>
    cancel: (jobId: string) => Promise<boolean>
    onStatus: (
      listener: (status: EmbeddingIndexStatus) => void
    ) => () => void
  }
  projects: {
    list: (includeArchived?: boolean) => Promise<AssistantProject[]>
    create: (input: ProjectCreateInput) => Promise<AssistantProject>
    update: (
      projectId: string,
      input: ProjectCreateInput
    ) => Promise<AssistantProject>
    setArchived: (projectId: string, archived: boolean) => Promise<void>
    delete: (projectId: string, confirmation: string) => Promise<void>
  }
  conversations: {
    list: () => Promise<ConversationSnapshot[]>
    replace: (conversations: ConversationSnapshot[]) => Promise<void>
    onChanged: (listener: () => void) => () => void
  }
  workspace: {
    getChanges: (projectId: string) => Promise<WorkspaceChanges>
    listDirectory: (
      projectId: string,
      path: string
    ) => Promise<WorkspaceDirectoryListing>
    readFile: (
      projectId: string,
      path: string
    ) => Promise<WorkspaceFilePreview>
    openPath: (
      projectId: string,
      path: string,
      type: 'file' | 'directory'
    ) => Promise<void>
  }
  tasks: {
    list: () => Promise<AssistantTask[]>
    setStatus: (
      taskId: string,
      status: Extract<AssistantTask['status'], 'completed' | 'cancelled'>
    ) => Promise<void>
  }
  usage: {
    getTokenSummary: () => Promise<TokenUsageSummary>
  }
  artifacts: {
    list: (projectId?: string) => Promise<AssistantArtifact[]>
    get: (artifactId: string) => Promise<AssistantArtifact>
    importFiles: (projectId?: string) => Promise<AssistantArtifact[]>
  }
  memory: {
    list: (scopeId?: string) => Promise<AssistantMemory[]>
    create: (input: MemoryCreateInput) => Promise<AssistantMemory>
    setStatus: (
      memoryId: string,
      status: AssistantMemory['status']
    ) => Promise<void>
    remove: (memoryId: string) => Promise<void>
  }
  schedules: {
    list: (projectId?: string) => Promise<AssistantSchedule[]>
    create: (input: ScheduleCreateInput) => Promise<AssistantSchedule>
    setEnabled: (scheduleId: string, enabled: boolean) => Promise<void>
    remove: (scheduleId: string) => Promise<void>
    runNow: (scheduleId: string) => Promise<void>
  }
  heartbeats: {
    list: (projectId?: string) => Promise<AssistantHeartbeatConfig[]>
    create: (
      input: HeartbeatCreateInput
    ) => Promise<AssistantHeartbeatConfig>
    update: (
      heartbeatId: string,
      input: HeartbeatUpdateInput
    ) => Promise<AssistantHeartbeatConfig>
    setPaused: (heartbeatId: string, paused: boolean) => Promise<void>
    remove: (heartbeatId: string) => Promise<void>
    runNow: (heartbeatId: string) => Promise<AssistantHeartbeatRun>
    history: (
      heartbeatId?: string
    ) => Promise<{
      runs: AssistantHeartbeatRun[]
      entries: AssistantHeartbeatEntry[]
    }>
  }
  experts: {
    list: () => Promise<AssistantExpert[]>
    create: (input: ExpertCreateInput) => Promise<AssistantExpert>
    update: (
      expertId: string,
      input: ExpertUpdateInput
    ) => Promise<AssistantExpert>
    remove: (expertId: string) => Promise<void>
  }
  capabilities: {
    getSnapshot: () => Promise<CapabilitySnapshot>
    importSkill: (kind: SkillImportKind) => Promise<CapabilitySnapshot>
    removeSkill: (skillId: string) => Promise<CapabilitySnapshot>
    setSkillEnabled: (
      skillId: string,
      enabled: boolean
    ) => Promise<CapabilitySnapshot>
    setSkillAssignments: (
      skillId: string,
      assignments: CapabilityAssignments
    ) => Promise<CapabilitySnapshot>
    saveMcpServer: (
      serverId: string | undefined,
      input: McpServerInput
    ) => Promise<CapabilitySnapshot>
    removeMcpServer: (serverId: string) => Promise<CapabilitySnapshot>
    testMcpServer: (serverId: string) => Promise<McpServerTestResult>
    setComputerCapabilityEnabled?: (
      capabilityId: ComputerCapabilityId,
      enabled: boolean
    ) => Promise<CapabilitySnapshot>
    setComputerCapabilityBrowserProfile?: (
      capabilityId: ComputerCapabilityId,
      browserProfileId: string | null
    ) => Promise<CapabilitySnapshot>
    diagnoseComputerCapability?: (
      capabilityId: ComputerCapabilityId
    ) => Promise<CapabilityDiagnosticReport>
    createBrowserProfile?: (
      input: BrowserProfileCreateInput
    ) => Promise<CapabilitySnapshot>
    renameBrowserProfile?: (
      input: BrowserProfileRenameInput
    ) => Promise<CapabilitySnapshot>
    setDefaultBrowserProfile?: (
      profileId: string
    ) => Promise<CapabilitySnapshot>
    removeBrowserProfile?: (
      profileId: string
    ) => Promise<CapabilitySnapshot>
  }
  context: {
    selectFiles: () => Promise<ContextAttachment[]>
    captureScreen: () => Promise<ContextAttachment>
    listWindows: () => Promise<WindowCaptureOption[]>
    captureWindow: (sourceId: string) => Promise<ContextAttachment>
    readClipboard: () => Promise<ContextAttachment>
    remove: (contextId: string) => Promise<void>
  }
  magicNotes: {
    list: (projectId?: string) => Promise<MagicNotesSnapshot>
    get: (noteId: string) => Promise<MagicNoteDetail>
    create: (input: MagicNoteCreateInput) => Promise<MagicNoteDetail>
    update: (input: MagicNoteUpdateInput) => Promise<MagicNoteDetail>
    remove: (noteId: string) => Promise<void>
    createEntry: (
      input: MagicNoteEntryCreateInput
    ) => Promise<MagicNoteDetail>
    updateEntry: (
      input: MagicNoteEntryUpdateInput
    ) => Promise<MagicNoteDetail>
    removeEntry: (entryId: string) => Promise<MagicNoteDetail>
    analyze: (entryId: string) => Promise<MagicNoteDetail>
    listTodos: (projectId?: string) => Promise<MagicTodosSnapshot>
    createTodo: (input: MagicTodoCreateInput) => Promise<MagicTodoItem>
    updateTodo: (input: MagicTodoUpdateInput) => Promise<MagicTodoItem>
    removeTodo: (todoId: string) => Promise<void>
    analyzeTodo: (todoId: string) => Promise<MagicTodoItem>
  }
  knowledge: {
    getSnapshot: (libraryId?: string) => Promise<KnowledgeSnapshot>
    createLibrary: (
      input: z.infer<typeof knowledgeCreateSchema>
    ) => Promise<KnowledgeLibrary>
    updateLibrary: (
      libraryId: string,
      update: {
        graphEnabled: boolean
        graphStrategy: 'rules' | 'model' | 'hybrid' | 'ask'
      }
    ) => Promise<void>
    deleteLibrary: (libraryId: string) => Promise<void>
    selectFiles: (
      libraryId: string,
      graphStrategy?: 'rules' | 'model' | 'hybrid'
    ) => Promise<void>
    selectDirectory: (
      libraryId: string,
      graphStrategy?: 'rules' | 'model' | 'hybrid'
    ) => Promise<void>
    importDroppedFiles: (
      libraryId: string,
      files: File[],
      graphStrategy?: 'rules' | 'model' | 'hybrid'
    ) => Promise<void>
    importUrl: (
      libraryId: string,
      url: string,
      graphStrategy?: 'rules' | 'model' | 'hybrid'
    ) => Promise<void>
    syncSource: (sourceId: string) => Promise<void>
    pauseSource: (sourceId: string) => Promise<void>
    retrySource: (sourceId: string) => Promise<void>
    removeSource: (sourceId: string) => Promise<void>
    search: (
      libraryIds: string[],
      query: string
    ) => Promise<KnowledgeSearchReference[]>
    createEntity: (
      libraryId: string,
      input: z.infer<typeof knowledgeEntityUpdateSchema>
    ) => Promise<void>
    updateEntity: (
      entityId: string,
      update: z.infer<typeof knowledgeEntityUpdateSchema>
    ) => Promise<void>
    moveEntity: (
      entityId: string,
      position: { x: number; y: number }
    ) => Promise<void>
    deleteEntity: (entityId: string) => Promise<void>
    mergeEntities: (
      sourceEntityId: string,
      targetEntityId: string
    ) => Promise<void>
    createRelation: (
      libraryId: string,
      input: z.infer<typeof knowledgeRelationInputSchema>
    ) => Promise<void>
    updateRelation: (
      relationId: string,
      input: z.infer<typeof knowledgeRelationInputSchema>
    ) => Promise<void>
    deleteRelation: (relationId: string) => Promise<void>
  }
}
