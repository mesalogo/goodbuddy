import type {
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'

export interface AgentRuntime {
  getStatus(): Promise<AgentRuntimeStatus>
  run(
    request: AgentRequest,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, void, void>
  dispose(): Promise<void>
}
