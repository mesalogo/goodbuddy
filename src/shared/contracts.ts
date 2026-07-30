import { z } from 'zod'

export const agentRequestSchema = z.object({
  requestId: z.string().uuid(),
  conversationId: z.string().min(1).max(128),
  prompt: z.string().trim().min(1).max(100_000),
  contextIds: z.array(z.string().uuid()).max(8).optional()
})

export type AgentRequest = z.infer<typeof agentRequestSchema>

export const runtimeProviderSchema = z.enum([
  'auto',
  'bigtoken',
  'opencode',
  'continue'
])

export const toolApprovalPolicySchema = z.enum([
  'always',
  'session',
  'workspace',
  'policy'
])

export const defaultRuntimeSettings = {
  provider: 'auto',
  bigtokenBaseUrl: 'https://bigtoken.ai',
  bigtokenModel: 'sonnet-5',
  toolApproval: 'always'
} as const

export const runtimeSettingsInputSchema = z
  .object({
    provider: runtimeProviderSchema,
    bigtokenBaseUrl: z.string().url().max(2_048),
    bigtokenModel: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[\w./:-]+$/, '模型名称包含不支持的字符'),
    apiKey: z.discriminatedUnion('action', [
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
    ]),
    toolApproval: toolApprovalPolicySchema
  }).strict()
  .superRefine((settings, context) => {
    const url = new URL(settings.bigtokenBaseUrl)
    if (url.protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['bigtokenBaseUrl'],
        message: 'Bigtoken 服务必须使用 HTTPS'
      })
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['bigtokenBaseUrl'],
        message: '服务地址只能包含 HTTPS origin'
      })
    }
  })

export type RuntimeSettingsInput = z.infer<typeof runtimeSettingsInputSchema>

export type RuntimeSettings = {
  provider: RuntimeSettingsInput['provider']
  bigtokenBaseUrl: string
  bigtokenModel: string
  apiKeyConfigured: boolean
  credentialSource: 'none' | 'encrypted' | 'environment'
  secureStorageAvailable: boolean
  toolApproval: RuntimeSettingsInput['toolApproval']
}

export type ContextAttachment = {
  id: string
  name: string
  size: number
  preview: string
}

export type AgentRuntimeStatus = {
  id: 'demo' | 'bigtoken' | 'opencode' | 'continue'
  label: string
  available: boolean
  detail: string
}

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
    }
  | {
      requestId: string
      type: 'done'
      sessionId?: string
    }
  | {
      requestId: string
      type: 'error'
      message: string
    }

export type AppInfo = {
  name: string
  version: string
  platform: string
  arch: string
  shortcut: string
}

export type DesktopApi = {
  app: {
    getInfo: () => Promise<AppInfo>
    show: () => Promise<void>
    hide: () => Promise<void>
    onNewConversation: (listener: () => void) => () => void
  }
  agent: {
    getStatus: () => Promise<AgentRuntimeStatus>
    run: (request: AgentRequest) => Promise<void>
    cancel: (requestId: string) => Promise<void>
    respondApproval: (approvalId: string, approved: boolean) => Promise<void>
    onEvent: (listener: (event: AgentEvent) => void) => () => void
  }
  settings: {
    getRuntime: () => Promise<RuntimeSettings>
    updateRuntime: (input: RuntimeSettingsInput) => Promise<RuntimeSettings>
  }
  context: {
    selectFiles: () => Promise<ContextAttachment[]>
    remove: (contextId: string) => Promise<void>
  }
}
