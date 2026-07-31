import type {
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type {
  AgentRuntime,
  RuntimeAuthorizer
} from './runtime'

type RuntimeSlot = {
  runtime: AgentRuntime
  activeRequests: number
  retiring: boolean
  disposal?: Promise<void>
  resolveDisposal?: () => void
}

export class AgentRuntimeController implements AgentRuntime {
  private current: RuntimeSlot
  private replacementQueue: Promise<void> = Promise.resolve()
  private closing = false

  constructor(runtime: AgentRuntime) {
    this.current = {
      runtime,
      activeRequests: 0,
      retiring: false
    }
  }

  get requiresToolApproval(): boolean {
    return this.current.runtime.requiresToolApproval
  }

  replace(next: AgentRuntime): Promise<void> {
    if (this.closing) {
      return next.dispose().then(() => {
        throw new Error('Agent Runtime 正在关闭')
      })
    }
    const operation = this.replacementQueue.then(() =>
      this.performReplace(next)
    )
    this.replacementQueue = operation.catch(() => undefined)
    return operation
  }

  private async performReplace(next: AgentRuntime): Promise<void> {
    const previous = this.current
    this.current = {
      runtime: next,
      activeRequests: 0,
      retiring: false
    }
    const disposal = this.retire(previous)
    await Promise.race([
      disposal,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000))
    ])
  }

  getStatus(): Promise<AgentRuntimeStatus> {
    return this.current.runtime.getStatus()
  }

  testConnection(): Promise<AgentRuntimeStatus> {
    return this.current.runtime.testConnection?.() ?? this.getStatus()
  }

  async *run(
    request: AgentRequest,
    signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<AgentEvent, void, void> {
    const slot = this.current
    const toolsAllowed = request.workMode === 'execute'
    const effectiveAuthorize: RuntimeAuthorizer | undefined = toolsAllowed
      ? authorize
      : async () => 'deny'
    slot.activeRequests += 1
    try {
      if (
        toolsAllowed &&
        slot.runtime.requiresToolApproval &&
        effectiveAuthorize
      ) {
        const decision = await effectiveAuthorize({
          scopeKey: 'runtime:whole-run',
          title: '允许 Agent 使用工作区工具？',
          description:
            '该 Runtime 尚不能报告单个工具调用，可能读取或修改工作区文件并执行命令。',
          allowPermanent: false
        })
        if (decision === 'deny') {
          throw new Error('用户拒绝了 Agent 工具执行')
        }
      }
      for await (const event of slot.runtime.run(
        request,
        signal,
        effectiveAuthorize
      )) {
        if (slot !== this.current) {
          return
        }
        yield event
      }
    } finally {
      slot.activeRequests -= 1
      if (slot.retiring && slot.activeRequests === 0) {
        await this.disposeSlot(slot)
      }
    }
  }

  private retire(slot: RuntimeSlot): Promise<void> {
    slot.retiring = true
    if (!slot.disposal) {
      slot.disposal = new Promise((resolve) => {
        slot.resolveDisposal = resolve
      })
    }
    if (slot.activeRequests === 0) {
      void this.disposeSlot(slot)
    }
    return slot.disposal
  }

  private async disposeSlot(slot: RuntimeSlot): Promise<void> {
    if (!slot.resolveDisposal) {
      return
    }
    const resolve = slot.resolveDisposal
    slot.resolveDisposal = undefined
    try {
      await slot.runtime.dispose()
    } catch {
      resolve()
      return
    }
    resolve()
  }

  async dispose(): Promise<void> {
    this.closing = true
    const operation = this.replacementQueue.then(() =>
      this.retire(this.current)
    )
    this.replacementQueue = operation.catch(() => undefined)
    await operation
  }
}
