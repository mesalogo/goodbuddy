import type {
  AgentQuestionAnswer,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type {
  AgentExecutionRequest,
  AgentRuntime,
  RuntimeAuthorizer,
  RuntimeEvent
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

  constructor(
    runtime: AgentRuntime,
    private readonly shutdownGraceMs = 2_000
  ) {
    this.current = {
      runtime,
      activeRequests: 0,
      retiring: false
    }
  }

  get requiresToolApproval(): boolean {
    return this.current.runtime.requiresToolApproval
  }

  get runtimeId(): AgentRuntimeStatus['id'] | undefined {
    return this.current.runtime.runtimeId
  }

  get supportsToolExecution(): boolean {
    return this.current.runtime.supportsToolExecution
  }

  get capability(): AgentRuntime['capability'] {
    return this.current.runtime.capability
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

  async getStatus(): Promise<AgentRuntimeStatus> {
    return this.probe((runtime) => runtime.getStatus())
  }

  async testConnection(): Promise<AgentRuntimeStatus> {
    return this.probe(
      (runtime) =>
        runtime.testConnection?.() ?? runtime.getStatus()
    )
  }

  private async probe(
    operation: (runtime: AgentRuntime) => Promise<AgentRuntimeStatus>
  ): Promise<AgentRuntimeStatus> {
    if (this.closing) {
      throw new Error('Agent Runtime 正在关闭')
    }
    const slot = this.current
    slot.activeRequests += 1
    try {
      const status = await operation(slot.runtime)
      if (slot !== this.current) {
        throw new Error('Runtime 已切换，请重试')
      }
      return {
        ...status,
        supportsToolExecution: slot.runtime.supportsToolExecution
      }
    } finally {
      slot.activeRequests -= 1
      if (slot.retiring && slot.activeRequests === 0) {
        await this.disposeSlot(slot)
      }
    }
  }

  async *run(
    request: AgentExecutionRequest,
    signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<RuntimeEvent, void, void> {
    if (this.closing) {
      throw new Error('Agent Runtime 正在关闭')
    }
    const slot = this.current
    const toolsAllowed = request.workMode === 'execute'
    const effectiveAuthorize: RuntimeAuthorizer | undefined = toolsAllowed
      ? authorize
      : async () => 'deny'
    slot.activeRequests += 1
    try {
      if (toolsAllowed && !slot.runtime.supportsToolExecution) {
        throw new Error('当前 Runtime 不支持工具执行，请切换到 OpenCode 或 Continue')
      }
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
          throw new Error('Runtime 已切换，当前请求已中断')
        }
        yield event
      }
      if (slot !== this.current) {
        throw new Error('Runtime 已切换，当前请求已中断')
      }
    } finally {
      slot.activeRequests -= 1
      if (slot.retiring && slot.activeRequests === 0) {
        await this.disposeSlot(slot)
      }
    }
  }

  async releaseConversation(conversationId: string): Promise<void> {
    await this.current.runtime.releaseConversation?.(conversationId)
  }

  async respondToQuestion(
    questionId: string,
    answers?: AgentQuestionAnswer[]
  ): Promise<void> {
    if (this.closing) {
      throw new Error('Agent Runtime 正在关闭')
    }
    const runtime = this.current.runtime
    if (!runtime.respondToQuestion) {
      throw new Error('当前 Runtime 不支持回答交互式问题')
    }
    await runtime.respondToQuestion(questionId, answers)
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
    const operation = this.replacementQueue.then(async () => {
      const slot = this.current
      const disposal = this.retire(slot)
      if (slot.activeRequests === 0) {
        return disposal
      }
      await Promise.race([
        disposal,
        new Promise<void>((resolve) =>
          setTimeout(resolve, this.shutdownGraceMs)
        )
      ])
      await this.disposeSlot(slot)
      return disposal
    })
    this.replacementQueue = operation.catch(() => undefined)
    await operation
  }
}
