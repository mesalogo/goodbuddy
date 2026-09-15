import { isDeepStrictEqual } from 'node:util'
import type {
  AgentExecutionRequest,
  AgentRuntime,
  RuntimeAuthorizer,
  RuntimeEvent
} from './runtime'
import type {
  AgentQuestionAnswer,
  RuntimeConversationCompactInput
} from '../../shared/contracts'

const IDLE_RUNTIME_MS = 60_000

type LocalProcessRuntime = AgentRuntime & {
  readonly hasRetainedSessions: boolean
}

class LocalRuntimeEntry {
  private instance?: LocalProcessRuntime
  private closing?: Promise<void>
  private active = 0
  private retired = false
  private idle?: ReturnType<typeof setTimeout>
  readonly description: Pick<AgentRuntime,
    'runtimeId' | 'requiresToolApproval' | 'supportsToolExecution' |
    'supportsScopedDataTools' | 'capability'>

  constructor(
    readonly configuration: unknown,
    private readonly create: () => LocalProcessRuntime,
    private readonly idleMs: number,
    private readonly onClosed: () => void
  ) {
    const runtime = this.instance = create()
    this.description = {
      runtimeId: runtime.runtimeId,
      requiresToolApproval: runtime.requiresToolApproval,
      supportsToolExecution: runtime.supportsToolExecution,
      supportsScopedDataTools: runtime.supportsScopedDataTools,
      capability: runtime.capability
    }
    this.scheduleIdle()
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
  }

  private scheduleIdle(): void {
    this.clearIdle()
    if (this.active > 0) return
    if (this.retired) {
      void this.close().finally(this.onClosed).catch(() => undefined)
    } else if (!this.instance?.hasRetainedSessions) {
      this.idle = setTimeout(() => {
        this.idle = undefined
        void this.close().catch(() => undefined)
      }, this.idleMs)
      this.idle.unref?.()
    }
  }

  private close(): Promise<void> {
    this.clearIdle()
    if (this.closing) return this.closing
    const runtime = this.instance
    this.instance = undefined
    const closing = Promise.resolve().then(() => runtime?.dispose()).finally(() => {
      if (this.closing === closing) this.closing = undefined
    })
    this.closing = closing
    return closing
  }

  async enter(): Promise<AgentRuntime> {
    if (this.retired) throw new Error('Runtime 配置已退役，请重新选择')
    this.clearIdle()
    this.active += 1
    try {
      await this.closing
      if (this.retired) throw new Error('Runtime 配置已退役，请重新选择')
      return this.instance ??= this.create()
    } catch (error) {
      this.leave()
      throw error
    }
  }

  leave(): void {
    this.active -= 1
    this.scheduleIdle()
  }

  async invoke<T>(operation: (runtime: AgentRuntime) => Promise<T>): Promise<T> {
    const runtime = await this.enter()
    try {
      return await operation(runtime)
    } finally {
      this.leave()
    }
  }

  async getStatus() {
    if (this.retired) throw new Error('Runtime 配置已退役，请重新选择')
    if (this.instance) return this.instance.getStatus()
    // Status inspection must not acquire or extend the execution owner's
    // lifetime. Both local runtimes can inspect configuration without starting.
    const inspection = this.create()
    try {
      return await inspection.getStatus()
    } finally {
      await inspection.dispose()
    }
  }

  async respondToQuestion(questionId: string, answers?: AgentQuestionAnswer[]): Promise<void> {
    const runtime = this.instance
    if (!runtime?.respondToQuestion) throw new Error('当前 Runtime 不支持回答交互式问题')
    // An active request may finish on a retired configuration, including its
    // outstanding native question. This does not admit a new request.
    this.clearIdle()
    this.active += 1
    try {
      await runtime.respondToQuestion(questionId, answers)
    } finally {
      this.leave()
    }
  }

  async releaseConversation(conversationId: string): Promise<void> {
    const runtime = this.instance
    if (!runtime) return
    this.clearIdle()
    this.active += 1
    try {
      await runtime.releaseConversation?.(conversationId)
    } finally {
      this.leave()
    }
  }

  retire(): void {
    this.retired = true
    this.scheduleIdle()
  }

  async dispose(): Promise<void> {
    this.retired = true
    await this.close()
    this.onClosed()
  }
}

/** Main-owned local processes; workspace facades never own their lifetime. */
export class LocalRuntimeRegistry {
  private readonly current = new Map<string, LocalRuntimeEntry>()
  private readonly entries = new Set<LocalRuntimeEntry>()
  private disposed = false

  constructor(private readonly idleMs = IDLE_RUNTIME_MS) {}

  acquire(
    key: string,
    configuration: unknown,
    workspace: string,
    create: () => LocalProcessRuntime
  ): AgentRuntime {
    if (this.disposed) throw new Error('Runtime 正在关闭')
    let entry = this.current.get(key)
    if (entry && !isDeepStrictEqual(entry.configuration, configuration)) {
      this.current.delete(key)
      entry.retire()
      entry = undefined
    }
    if (!entry) {
      const created = new LocalRuntimeEntry(configuration, create, this.idleMs, () => {
        this.entries.delete(created)
        if (this.current.get(key) === created) this.current.delete(key)
      })
      this.current.set(key, created)
      this.entries.add(created)
      entry = created
    }
    return new WorkspaceRuntime(entry, workspace)
  }

  async releaseConversation(conversationId: string): Promise<void> {
    await Promise.all([...this.entries].map((entry) => entry.releaseConversation(conversationId)))
  }

  reset(keep?: AgentRuntime): void {
    const retained = keep instanceof WorkspaceRuntime ? keep.owner : undefined
    for (const [key, entry] of this.current) {
      if (entry === retained) continue
      this.current.delete(key)
      entry.retire()
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.current.clear()
    await Promise.all([...this.entries].map((entry) => entry.dispose()))
  }
}

class WorkspaceRuntime implements AgentRuntime {
  readonly sharedProcess = true
  private disposed = false

  constructor(
    private readonly entry: LocalRuntimeEntry,
    private readonly workspace: string
  ) {}

  get owner(): LocalRuntimeEntry { return this.entry }
  get runtimeId() { return this.entry.description.runtimeId }
  get requiresToolApproval() { return this.entry.description.requiresToolApproval }
  get supportsToolExecution() { return this.entry.description.supportsToolExecution }
  get supportsScopedDataTools() { return this.entry.description.supportsScopedDataTools }
  get capability() { return this.entry.description.capability }

  private check(): void {
    if (this.disposed) throw new Error('Runtime 工作区已释放')
  }

  getStatus() {
    this.check()
    return this.entry.getStatus()
  }

  testConnection() {
    this.check()
    return this.entry.invoke((runtime) => runtime.testConnection?.() ?? runtime.getStatus())
  }

  getNativeSnapshot() {
    this.check()
    return this.entry.invoke((runtime) => {
      if (!runtime.getNativeSnapshot) throw new Error('当前 Runtime 不支持原生能力清单')
      return runtime.getNativeSnapshot(this.workspace)
    })
  }

  async *run(
    request: AgentExecutionRequest,
    signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<RuntimeEvent, void, void> {
    this.check()
    signal.throwIfAborted()
    const runtime = await this.entry.enter()
    try {
      yield* runtime.run({ ...request, executionWorkspace: this.workspace }, signal, authorize)
    } finally {
      this.entry.leave()
    }
  }

  compactConversation(request: RuntimeConversationCompactInput, signal: AbortSignal) {
    this.check()
    return this.entry.invoke((runtime) => {
      if (!runtime.compactConversation) throw new Error('当前 Runtime 不支持手动压缩')
      return runtime.compactConversation(request, signal)
    })
  }

  respondToQuestion(questionId: string, answers?: AgentQuestionAnswer[]) {
    this.check()
    return this.entry.respondToQuestion(questionId, answers)
  }

  releaseConversation(conversationId: string) {
    return this.entry.releaseConversation(conversationId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}
