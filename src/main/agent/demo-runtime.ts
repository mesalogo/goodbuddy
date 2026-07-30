import type {
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type { AgentRuntime } from './runtime'

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    function onAbort(): void {
      clearTimeout(timeout)
      reject(signal.reason)
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class DemoAgentRuntime implements AgentRuntime {
  readonly requiresToolApproval = false

  async getStatus(): Promise<AgentRuntimeStatus> {
    return {
      id: 'demo',
      label: '演示模式',
      available: true,
      detail: '配置 OpenCode 后将启用文件、搜索和受控工具能力'
    }
  }

  async *run(
    request: AgentRequest,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, void, void> {
    yield {
      requestId: request.requestId,
      type: 'status',
      message: '正在准备回答'
    }

    const response = [
      'GoodBuddy 的桌面外壳已经运行。',
      '',
      `你刚才输入了：“${request.prompt.slice(0, 160)}${request.prompt.length > 160 ? '…' : ''}”`,
      '',
      '当前使用演示运行时。设置 `GOODBUDDY_OPENCODE_URL` 连接已有 OpenCode Server，',
      '或设置 `GOODBUDDY_OPENCODE_EMBEDDED=true` 由 GoodBuddy 启动本机 OpenCode。'
    ].join('\n')

    for (const chunk of response.match(/.{1,12}/gs) ?? []) {
      await wait(16, signal)
      yield {
        requestId: request.requestId,
        type: 'text',
        delta: chunk
      }
    }

    yield {
      requestId: request.requestId,
      type: 'done'
    }
  }

  async dispose(): Promise<void> {}
}
