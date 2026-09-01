import type {
  ApprovalDecision,
  AgentEvent,
  AgentQuestionAnswer,
  AgentRequest,
  AgentRuntimeStatus,
  RuntimeConversationCompactInput,
  RuntimeConversationCompactResult,
  RuntimeNativeSnapshot
} from '../../shared/contracts'
import type {
  ConversationSubagentActivity,
  ConversationToolActivity,
  WorkMode
} from '../../shared/assistant-contracts'

export type RuntimeApprovalRequest = {
  scopeKey: string
  title: string
  description: string
  toolName?: string
  argumentSummary?: string
  allowPermanent?: boolean
}

export type RuntimeAuthorizer = (
  request: RuntimeApprovalRequest,
  signal?: AbortSignal
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

export type RuntimePublicEvent =
  | AgentEvent
  | RuntimeGeneratedImageEvent
  | RuntimeModelUsageEvent

export type RemoteSemanticEventProvenance = {
  source: 'remote-semantic-transcript'
  bindingId: string
  operationId: string
  semanticSequence: string
  eventIndex: number
}

export type RemoteSemanticRuntimeEvent = RuntimePublicEvent & {
  remoteProvenance: RemoteSemanticEventProvenance
}

export type RemoteSemanticCheckpointEvent = {
  requestId: string
  type: 'remote-semantic-checkpoint'
  remoteProvenance: RemoteSemanticEventProvenance
}

export type RuntimeEvent =
  | RuntimePublicEvent
  | RemoteSemanticCheckpointEvent

export type RuntimeConversationCompactOutcome = {
  result: RuntimeConversationCompactResult
  usageEvents?: RuntimeModelUsageEvent[]
}

export interface AgentRuntime {
  readonly runtimeId?: AgentRuntimeStatus['id']
  readonly requiresToolApproval: boolean
  readonly supportsToolExecution: boolean
  /** Whether request-scoped GoodBuddy data tools can reach this runtime. */
  readonly supportsScopedDataTools?: boolean
  readonly capability?: 'chat' | 'image-generation'
  getStatus(): Promise<AgentRuntimeStatus>
  testConnection?(): Promise<AgentRuntimeStatus>
  getNativeSnapshot?(): Promise<RuntimeNativeSnapshot>
  compactConversation?(
    request: RuntimeConversationCompactInput,
    signal: AbortSignal
  ): Promise<RuntimeConversationCompactOutcome>
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
  /**
   * Stop Main-process admission during a normal application exit. Runtimes
   * that implement this hook may intentionally leave remote work owned by
   * another process running after Desktop disconnects.
   */
  detachForApplicationExit?(): void | Promise<void>
  dispose(): Promise<void>
}

export type AgentImage = {
  name: string
  mediaType: 'image/png' | 'image/jpeg'
  data: string
}

export type RemoteRecoveredTool = ConversationToolActivity & {
  callId: string
}

export type RemoteRecoveredSubagent =
  ConversationSubagentActivity

export type AgentExecutionRequest = Omit<AgentRequest, 'workMode'> & {
  workMode?: WorkMode
  images?: AgentImage[]
  /** Main-process-only recursion guard for direct-model programming delegation. */
  directModelDelegationDepth?: 0 | 1
  /** Main-process-only instructions placed in the model system layer. */
  trustedInstructions?: string
  /** Main-process-only request-scoped authorization for built-in data tools. */
  knowledgeCapabilityToken?: string
  /**
   * Main-process recovery cursor for an Agent-owned semantic prompt.
   * It is never sent as prompt content and is ignored by local runtimes.
   */
  remoteSemanticAfterSequence?: string
  /** Recovery may attach an accepted Agent prompt but must never replay it. */
  remoteRecoveryOnly?: boolean
  /** Main-only durable tool state used to merge partial recovery updates. */
  remoteRecoveredTools?: readonly RemoteRecoveredTool[]
  /** Main-only durable native subagent state for partial recovery updates. */
  remoteRecoveredSubagents?: readonly RemoteRecoveredSubagent[]
}
