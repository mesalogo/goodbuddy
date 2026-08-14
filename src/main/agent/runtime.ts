import type {
  ApprovalDecision,
  AgentEvent,
  AgentQuestionAnswer,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type { WorkMode } from '../../shared/assistant-contracts'

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
  runtime: 'model' | 'continue' | 'opencode' | 'deepseek-harness'
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
  readonly runtimeId?: AgentRuntimeStatus['id']
  readonly requiresToolApproval: boolean
  readonly supportsToolExecution: boolean
  /** Whether request-scoped GoodBuddy data tools can reach this runtime. */
  readonly supportsScopedDataTools?: boolean
  readonly capability?: 'chat' | 'image-generation'
  getStatus(): Promise<AgentRuntimeStatus>
  testConnection?(): Promise<AgentRuntimeStatus>
  run(
    request: AgentExecutionRequest,
    signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<RuntimeEvent, void, void>
  respondToQuestion?(
    questionId: string,
    answers?: AgentQuestionAnswer[]
  ): Promise<void>
  releaseConversation?(conversationId: string): Promise<void>
  dispose(): Promise<void>
}

export type AgentImage = {
  name: string
  mediaType: 'image/png' | 'image/jpeg'
  data: string
}

export type AgentExecutionRequest = Omit<AgentRequest, 'workMode'> & {
  workMode?: WorkMode
  images?: AgentImage[]
  /** Main-process-only instructions placed in the model system layer. */
  trustedInstructions?: string
  /** Main-process-only request-scoped authorization for built-in data tools. */
  knowledgeCapabilityToken?: string
}
