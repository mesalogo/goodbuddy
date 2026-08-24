import type {
  AgentQuestionAnswer,
  AgentRuntimeStatus,
  RuntimeConversationCompactInput,
  RuntimeNativeSnapshot
} from '../../shared/contracts'
import type {
  AgentExecutionRequest,
  AgentRuntime,
  RuntimeAuthorizer,
  RuntimeConversationCompactOutcome,
  RuntimeEvent
} from './runtime'

type RuntimeSlot = {
  runtime: AgentRuntime
  activeRequests: number
  retiring: boolean
  drainable: boolean
  drainStarted?: Promise<void>
  drainError?: Error
  disposal?: Promise<void>
  disposeStarted?: Promise<void>
  resolveDisposal?: () => void
}

export const MAX_DRAINING_RUNTIME_GENERATIONS = 2

export type RuntimeReplacementStatus = {
  drainingGenerations: number
  failedDrainingGenerations: number
  pendingReplacements: number
  maximumDrainingGenerations: number
  saturated: boolean
}

export class RuntimeReplacementCapacityError extends Error {
  readonly code = 'runtime-drain-capacity'

  constructor(
    readonly occupiedGenerations: number,
    readonly maximumGenerations: number
  ) {
    super(
      `Runtime replacement is unavailable while previous generations are draining (${occupiedGenerations}/${maximumGenerations})`
    )
    this.name = 'RuntimeReplacementCapacityError'
  }
}

export interface DrainableAgentRuntime extends AgentRuntime {
  /** Stop accepting new sessions while existing session ownership remains. */
  beginDrain(): Promise<void>
  /** Resolve only after all owned sessions are released or interrupted. */
  waitForDrain(): Promise<void>
  /** Explicit bounded-shutdown escalation; never used by replacement. */
  forceShutdown(): Promise<void>
}

function isDrainableRuntime(
  runtime: AgentRuntime
): runtime is DrainableAgentRuntime {
  const candidate = runtime as Partial<DrainableAgentRuntime>
  return (
    typeof candidate.beginDrain === 'function' &&
    typeof candidate.waitForDrain === 'function' &&
    typeof candidate.forceShutdown === 'function'
  )
}

export class AgentRuntimeController implements AgentRuntime {
  private current: RuntimeSlot
  private readonly retired = new Set<RuntimeSlot>()
  private replacementQueue: Promise<void> = Promise.resolve()
  private pendingReplacements = 0
  private closing = false
  private retirement?: Promise<void>
  private disposal?: Promise<void>
  private readonly ownedConversationIds = new Set<string>()

  constructor(
    runtime: AgentRuntime,
    private readonly shutdownGraceMs = 2_000
  ) {
    this.current = {
      runtime,
      activeRequests: 0,
      retiring: false,
      drainable: isDrainableRuntime(runtime)
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

  get supportsScopedDataTools(): boolean {
    return this.current.runtime.supportsScopedDataTools !== false
  }

  get capability(): AgentRuntime['capability'] {
    return this.current.runtime.capability
  }

  get replacementStatus(): RuntimeReplacementStatus {
    const drainingGenerations = [...this.retired].filter(
      (slot) => slot.drainable
    ).length
    const failedDrainingGenerations = [...this.retired].filter(
      (slot) =>
        slot.drainable &&
        slot.drainError !== undefined
    ).length
    const occupiedGenerations =
      drainingGenerations + this.pendingReplacements
    return {
      drainingGenerations,
      failedDrainingGenerations,
      pendingReplacements: this.pendingReplacements,
      maximumDrainingGenerations: MAX_DRAINING_RUNTIME_GENERATIONS,
      saturated:
        occupiedGenerations >= MAX_DRAINING_RUNTIME_GENERATIONS
    }
  }

  get activeRequestCount(): number {
    return [...new Set([this.current, ...this.retired])].reduce(
      (total, slot) => total + slot.activeRequests,
      0
    )
  }

  get ownedConversationCount(): number {
    return this.ownedConversationIds.size
  }

  get canRetire(): boolean {
    return (
      !this.closing &&
      this.activeRequestCount === 0 &&
      this.ownedConversationIds.size === 0
    )
  }

  replace(next: AgentRuntime): Promise<void> {
    if (this.closing) {
      return this.disposeRejectedRuntime(next).then(() => {
        throw new Error('Agent Runtime 正在关闭')
      })
    }
    const status = this.replacementStatus
    const occupiedGenerations =
      status.drainingGenerations + status.pendingReplacements
    if (occupiedGenerations >= MAX_DRAINING_RUNTIME_GENERATIONS) {
      return this.disposeRejectedRuntime(next).then(() => {
        throw new RuntimeReplacementCapacityError(
          occupiedGenerations,
          MAX_DRAINING_RUNTIME_GENERATIONS
        )
      })
    }
    this.pendingReplacements += 1
    const operation = this.replacementQueue
      .then(() => this.performReplace(next))
      .finally(() => {
        this.pendingReplacements -= 1
      })
    this.replacementQueue = operation.catch(() => undefined)
    return operation
  }

  private async performReplace(next: AgentRuntime): Promise<void> {
    const previous = this.current
    this.current = {
      runtime: next,
      activeRequests: 0,
      retiring: false,
      drainable: isDrainableRuntime(next)
    }
    const disposal = this.retireSlot(previous)
    if (previous.drainable) {
      await previous.drainStarted
      return
    }
    await waitWithin(disposal, this.shutdownGraceMs)
  }

  private async disposeRejectedRuntime(runtime: AgentRuntime): Promise<void> {
    await waitWithin(
      runtime.dispose().catch(() => undefined),
      this.shutdownGraceMs
    )
  }

  async getStatus(): Promise<AgentRuntimeStatus> {
    return this.probeStatus((runtime) => runtime.getStatus())
  }

  async testConnection(): Promise<AgentRuntimeStatus> {
    return this.probeStatus(
      (runtime) =>
        runtime.testConnection?.() ?? runtime.getStatus()
    )
  }

  async getNativeSnapshot(): Promise<RuntimeNativeSnapshot> {
    return this.invoke((runtime) => {
      if (!runtime.getNativeSnapshot) {
        throw new Error('当前 Runtime 不支持原生能力清单')
      }
      return runtime.getNativeSnapshot()
    })
  }

  async compactConversation(
    request: RuntimeConversationCompactInput,
    signal: AbortSignal
  ): Promise<RuntimeConversationCompactOutcome> {
    this.ownedConversationIds.add(request.conversationId)
    return this.invoke((runtime) => {
      if (!runtime.compactConversation) {
        throw new Error('当前 Runtime 不支持手动压缩')
      }
      return runtime.compactConversation(request, signal)
    })
  }

  private async probeStatus(
    operation: (runtime: AgentRuntime) => Promise<AgentRuntimeStatus>
  ): Promise<AgentRuntimeStatus> {
    const status = await this.invoke(operation)
    return {
      ...status,
      supportsToolExecution: this.current.runtime.supportsToolExecution
    }
  }

  private async invoke<T>(
    operation: (runtime: AgentRuntime) => Promise<T>
  ): Promise<T> {
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
      return status
    } finally {
      slot.activeRequests -= 1
      if (
        slot.retiring &&
        !slot.drainable &&
        slot.activeRequests === 0
      ) {
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
    this.ownedConversationIds.add(request.conversationId)
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
        if (slot !== this.current && !slot.drainable) {
          throw new Error('Runtime 已切换，当前请求已中断')
        }
        yield event
      }
      if (slot !== this.current && !slot.drainable) {
        throw new Error('Runtime 已切换，当前请求已中断')
      }
    } finally {
      slot.activeRequests -= 1
      if (
        slot.retiring &&
        !slot.drainable &&
        slot.activeRequests === 0
      ) {
        await this.disposeSlot(slot)
      }
    }
  }

  async releaseConversation(conversationId: string): Promise<void> {
    const results = await Promise.allSettled([
      this.current.runtime.releaseConversation?.(conversationId),
      ...[...this.retired].map((slot) =>
        slot.runtime.releaseConversation?.(conversationId)
      )
    ])
    this.ownedConversationIds.delete(conversationId)
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'One or more Agent Runtimes failed to release the conversation'
      )
    }
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

  private retireSlot(slot: RuntimeSlot): Promise<void> {
    slot.retiring = true
    this.retired.add(slot)
    if (!slot.disposal) {
      slot.disposal = new Promise((resolve) => {
        slot.resolveDisposal = resolve
      })
    }
    if (slot.drainable && !slot.drainStarted) {
      const runtime = slot.runtime as DrainableAgentRuntime
      slot.drainStarted = runtime.beginDrain()
      void slot.drainStarted
        .then(() => runtime.waitForDrain())
        .then(() => this.disposeSlot(slot))
        .catch((error: unknown) => {
          slot.drainError =
            error instanceof Error ? error : new Error(String(error))
        })
    }
    if (!slot.drainable && slot.activeRequests === 0) {
      void this.disposeSlot(slot)
    }
    return slot.disposal
  }

  private async disposeSlot(
    slot: RuntimeSlot,
    timeoutMs?: number,
    abandonOnTimeout = false
  ): Promise<void> {
    if (!slot.resolveDisposal) {
      return
    }
    slot.disposeStarted ??= Promise.resolve().then(() =>
      slot.runtime.dispose()
    )
    let completed = true
    try {
      if (timeoutMs === undefined) {
        await slot.disposeStarted
      } else {
        completed = await waitWithin(
          slot.disposeStarted,
          timeoutMs
        )
      }
    } catch {
      completed = true
    }
    if (!completed && !abandonOnTimeout) {
      return
    }
    const resolve = slot.resolveDisposal
    if (resolve === undefined) {
      return
    }
    slot.resolveDisposal = undefined
    this.retired.delete(slot)
    resolve()
  }

  retire(): Promise<void> {
    if (this.retirement !== undefined) {
      return this.retirement
    }
    this.closing = true
    const operation = this.replacementQueue.then(async () => {
      this.retireSlot(this.current)
      await Promise.all(
        [...this.retired].map(
          (slot) => slot.disposal ?? Promise.resolve()
        )
      )
    })
    this.retirement = operation
    return operation
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) {
      return this.disposal
    }
    this.closing = true
    const operation = this.replacementQueue.then(async () => {
      const slot = this.current
      this.retireSlot(slot)
      const slots = [...this.retired]
      const disposals = slots.map(
        (candidate) => candidate.disposal ?? Promise.resolve()
      )
      await waitWithin(
        Promise.all(disposals).then(() => undefined),
        this.shutdownGraceMs
      )
      await Promise.all(
        slots.map(async (candidate) => {
          if (!candidate.resolveDisposal) {
            return
          }
          if (candidate.drainable) {
            await waitWithin(
              (
                candidate.runtime as DrainableAgentRuntime
              ).forceShutdown().catch(() => undefined),
              this.shutdownGraceMs
            )
          }
          await this.disposeSlot(
            candidate,
            this.shutdownGraceMs,
            true
          )
        })
      )
      await Promise.all(disposals)
    })
    this.disposal = operation
    return operation
  }
}

async function waitWithin(
  promise: Promise<void>,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}
