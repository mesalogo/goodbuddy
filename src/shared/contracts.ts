import { z } from 'zod'

export const agentRequestSchema = z.object({
  requestId: z.string().uuid(),
  conversationId: z.string().min(1).max(128),
  prompt: z.string().trim().min(1).max(100_000),
  workspace: z.string().max(2_048).optional()
})

export type AgentRequest = z.infer<typeof agentRequestSchema>

export type AgentRuntimeStatus = {
  id: 'demo' | 'bigtoken' | 'opencode'
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
    onEvent: (listener: (event: AgentEvent) => void) => () => void
  }
}
