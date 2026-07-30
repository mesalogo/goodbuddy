import type {
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'

export interface AgentRuntime {
  readonly requiresToolApproval: boolean
  getStatus(): Promise<AgentRuntimeStatus>
  run(
    request: AgentRequest,
    signal: AbortSignal,
    authorize?: (requiresToolApproval: boolean) => Promise<void>
  ): AsyncGenerator<AgentEvent, void, void>
  dispose(): Promise<void>
}
