import { z } from 'zod'
import type {
  CapabilityAssignments,
  CapabilitySnapshot,
  McpServerInput,
  McpServerTestResult
} from './capability-contracts'
import {
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
  type WorkspaceChanges,
  type ProjectCreateInput,
  type MemoryCreateInput,
  type ScheduleCreateInput,
  type HeartbeatCreateInput,
  type HeartbeatUpdateInput,
  type ExpertCreateInput
} from './assistant-contracts'

export const agentRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    conversationId: z.string().min(1).max(128),
    projectId: z.string().uuid().optional(),
    expertId: z.string().uuid().optional(),
    teamMode: z.boolean().optional(),
    workMode: workModeSchema.optional(),
    prompt: z.string().trim().min(1).max(100_000),
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

export type AgentRequest = z.infer<typeof agentRequestSchema>

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
  'openai-chat-completions',
  'openai-images-generations'
])
export const modelAuthenticationSchema = z.enum(['api-key', 'none'])
export type ModelProtocol = z.infer<typeof modelProtocolSchema>
export type ModelAuthentication = z.infer<
  typeof modelAuthenticationSchema
>
export const defaultModelProfileId =
  '00000000-0000-4000-8000-000000000001'

export const defaultRuntimeSettings = {
  provider: 'auto',
  modelBaseUrl: 'https://bigtoken.ai',
  modelName: 'sonnet-5',
  modelProtocol: 'anthropic-messages',
  modelAuthentication: 'api-key',
  opencodeBaseUrl: '',
  opencodeEmbedded: false,
  opencodeBinaryPath: '',
  opencodeConfigPath: '',
  continueBinaryPath: '',
  continueConfigPath: '',
  continueMode: 'chat',
  runtimeSandboxMode: 'auto',
  knowledgeEmbeddingEnabled: false,
  knowledgeEmbeddingBaseUrl: 'http://127.0.0.1:11434',
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
    id: z.string().uuid(),
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
    knowledgeEmbeddingEnabled: z.boolean(),
    knowledgeEmbeddingBaseUrl: z.string().url().max(2_048),
    knowledgeEmbeddingModel: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[\w./:-]+$/, '向量模型名称包含不支持的字符'),
    workspacePath: z.string().trim().min(1).max(4_096),
    apiKey: modelApiKeyUpdateSchema,
    modelProfiles: z.array(modelProfileInputSchema).min(1).max(20).optional(),
    defaultModelProfileId: z.string().uuid().optional(),
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
      const url = new URL(endpoint.value)
      const hostname = url.hostname.toLowerCase()
      const loopback =
        hostname === 'localhost' ||
        hostname === '::1' ||
        hostname === '[::1]' ||
        /^127(?:\.\d{1,3}){3}$/u.test(hostname)
      if (
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && loopback)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        context.addIssue({
          code: 'custom',
          path: endpoint.path,
          message:
            '模型服务地址必须使用 HTTPS；仅本机回环地址可使用 HTTP，且不得包含凭据、查询参数或片段'
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
        (opencodeProfile.protocol !== 'anthropic-messages' ||
          opencodeProfile.authentication !== 'api-key')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['opencodeModelSource'],
          message:
            'OpenCode 独立模型连接仅支持需要 API Key 的 Anthropic Messages 协议'
        })
      }
      const continueSource = settings.continueModelSource
      const continueProfile =
        continueSource?.kind === 'profile'
          ? settings.modelProfiles.find(
              (profile) => profile.id === continueSource.profileId
            )
          : undefined
      if (continueProfile?.protocol === 'openai-images-generations') {
        context.addIssue({
          code: 'custom',
          path: ['continueModelSource'],
          message: 'Continue 不支持图像生成模型连接'
        })
      }
    }
    if (settings.opencodeBaseUrl) {
      const opencodeUrl = new URL(settings.opencodeBaseUrl)
      if (
        !['http:', 'https:'].includes(opencodeUrl.protocol) ||
        opencodeUrl.username ||
        opencodeUrl.password ||
        opencodeUrl.search ||
        opencodeUrl.hash ||
        (opencodeUrl.pathname !== '/' && opencodeUrl.pathname !== '')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['opencodeBaseUrl'],
          message: 'OpenCode 地址必须是无凭据和路径的 HTTP(S) origin'
        })
      }
    }
    const embeddingUrl = new URL(settings.knowledgeEmbeddingBaseUrl)
    const embeddingHost = embeddingUrl.hostname.toLowerCase()
    const privateIpv4 =
      /^10(?:\.\d{1,3}){3}$/u.test(embeddingHost) ||
      /^192\.168(?:\.\d{1,3}){2}$/u.test(embeddingHost) ||
      /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/u.test(
        embeddingHost
      )
    const loopback =
      embeddingHost === 'localhost' ||
      embeddingHost === '::1' ||
      embeddingHost === '[::1]' ||
      /^127(?:\.\d{1,3}){3}$/u.test(embeddingHost)
    if (
      (embeddingUrl.protocol !== 'https:' &&
        !(
          embeddingUrl.protocol === 'http:' &&
          (loopback || privateIpv4)
        )) ||
      embeddingUrl.username ||
      embeddingUrl.password ||
      embeddingUrl.search ||
      embeddingUrl.hash ||
      (embeddingUrl.pathname !== '/' && embeddingUrl.pathname !== '')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['knowledgeEmbeddingBaseUrl'],
        message:
          'Ollama 向量地址必须使用 HTTPS，或使用本机/私有网络 HTTP origin，且不得包含凭据、路径、查询参数或片段'
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
  apiKeyConfigured: boolean
  credentialSource: 'none' | 'encrypted' | 'environment'
}

export type RuntimeSettings = {
  provider: RuntimeSettingsInput['provider']
  modelBaseUrl: string
  modelName: string
  modelProtocol: ModelProtocol
  modelAuthentication: ModelAuthentication
  opencodeBaseUrl: string
  opencodeEmbedded: boolean
  opencodeBinaryPath: string
  opencodeConfigPath: string
  continueBinaryPath: string
  continueConfigPath: string
  continueMode: RuntimeSettingsInput['continueMode']
  runtimeSandboxMode: RuntimeSettingsInput['runtimeSandboxMode']
  knowledgeEmbeddingEnabled: boolean
  knowledgeEmbeddingBaseUrl: string
  knowledgeEmbeddingModel: string
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

export type ContextAttachment = {
  id: string
  name: string
  size: number
  preview: string
  kind: 'text' | 'image'
  thumbnailUrl?: string
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
      type: 'tool'
      callId: string
      name: string
      state: 'pending' | 'running' | 'completed' | 'failed'
      summary: string
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
      type: 'artifact'
      artifactId: string
      kind: 'image'
      title: string
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

export type AppInfo = {
  name: string
  version: string
  platform: string
  arch: string
  shortcut: string
}

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
    clearLocalData: () => Promise<void>
    onNewConversation: (listener: () => void) => () => void
    onOpenSettings: (listener: () => void) => () => void
  }
  agent: {
    getStatus: () => Promise<AgentRuntimeStatus>
    run: (request: AgentRequest) => Promise<void>
    cancel: (requestId: string) => Promise<void>
    respondApproval: (
      approvalId: string,
      decision: ApprovalDecision
    ) => Promise<void>
    onEvent: (listener: (event: AgentEvent) => void) => () => void
  }
  settings: {
    getRuntime: () => Promise<RuntimeSettings>
    updateRuntime: (input: RuntimeSettingsInput) => Promise<RuntimeSettings>
    selectWorkspace: () => Promise<string | undefined>
    detectAgentRuntimes: () => Promise<AgentRuntimeDetection>
    selectRuntimeFile: (
      kind: RuntimeFileSelectionKind
    ) => Promise<string | undefined>
    testRuntime: () => Promise<AgentRuntimeStatus>
  }
  projects: {
    list: (includeArchived?: boolean) => Promise<AssistantProject[]>
    create: (input: ProjectCreateInput) => Promise<AssistantProject>
    update: (
      projectId: string,
      input: ProjectCreateInput
    ) => Promise<AssistantProject>
    setArchived: (projectId: string, archived: boolean) => Promise<void>
  }
  conversations: {
    list: () => Promise<ConversationSnapshot[]>
    replace: (conversations: ConversationSnapshot[]) => Promise<void>
  }
  workspace: {
    getChanges: (projectId: string) => Promise<WorkspaceChanges>
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
  }
  capabilities: {
    getSnapshot: () => Promise<CapabilitySnapshot>
    importSkill: () => Promise<CapabilitySnapshot>
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
  }
  context: {
    selectFiles: () => Promise<ContextAttachment[]>
    captureScreen: () => Promise<ContextAttachment>
    captureWindow: () => Promise<ContextAttachment>
    readClipboard: () => Promise<ContextAttachment>
    remove: (contextId: string) => Promise<void>
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
