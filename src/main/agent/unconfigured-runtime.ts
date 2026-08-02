import type {
  AgentEvent,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type {
  AgentExecutionRequest,
  AgentRuntime
} from './runtime'

export class UnconfiguredAgentRuntime implements AgentRuntime {
  readonly requiresToolApproval = false
  readonly supportsToolExecution = false

  getStatus(): Promise<AgentRuntimeStatus> {
    return Promise.resolve({
      id: 'setup',
      label: '需要配置模型',
      available: false,
      supportsToolExecution: this.supportsToolExecution,
      detail: '请在设置中选择并配置可用的模型或 Agent Runtime'
    })
  }

  async *run(
    request: AgentExecutionRequest
  ): AsyncGenerator<AgentEvent, void, void> {
    yield {
      requestId: request.requestId,
      type: 'error',
      status: 'failed',
      message: '请先完成模型与 Agent Runtime 配置'
    }
  }

  async dispose(): Promise<void> {}
}
