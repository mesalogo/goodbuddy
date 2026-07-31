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

export interface AgentRuntime {
  readonly requiresToolApproval: boolean
  getStatus(): Promise<AgentRuntimeStatus>
  testConnection?(): Promise<AgentRuntimeStatus>
  run(
    request: AgentExecutionRequest,
    signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<AgentEvent, void, void>
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
