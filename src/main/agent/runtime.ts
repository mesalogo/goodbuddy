import type {
  ApprovalDecision,
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'

export type RuntimeApprovalRequest = {
  scopeKey: string
  title: string
  description: string
  toolName?: string
  argumentSummary?: string
  allowPermanent?: boolean
}

export type RuntimeAuthorizer = (
  request: RuntimeApprovalRequest
) => Promise<ApprovalDecision>

export type RuntimeGeneratedImageEvent = {
  requestId: string
  type: 'generated-image'
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  data: string
  title: string
}

export type RuntimeModelUsageEvent = {
  requestId: string
  type: 'model-usage'
  callId: string
  runtime: 'model' | 'continue' | 'opencode'
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reportedTotalTokens?: number
}

export type RuntimeEvent =
  | AgentEvent
  | RuntimeGeneratedImageEvent
  | RuntimeModelUsageEvent

export interface AgentRuntime {
  readonly requiresToolApproval: boolean
  readonly supportsToolExecution: boolean
  readonly capability?: 'chat' | 'image-generation'
  getStatus(): Promise<AgentRuntimeStatus>
  testConnection?(): Promise<AgentRuntimeStatus>
  run(
    request: AgentExecutionRequest,
    signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<RuntimeEvent, void, void>
  releaseConversation?(conversationId: string): Promise<void>
  dispose(): Promise<void>
}

export type AgentImage = {
  name: string
  mediaType: 'image/png' | 'image/jpeg'
  data: string
}

export type AgentExecutionRequest = AgentRequest & {
  images?: AgentImage[]
}
