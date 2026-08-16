import {
  agentRuntimeSelectionKey,
  type AgentRuntimeSelection
} from '../../shared/runtime-selection-contracts'
import type {
  AgentRuntimeStatus,
  RuntimeConversationCompactInput,
  RuntimeNativeSnapshot
} from '../../shared/contracts'
import type {
  AgentRuntime,
  RuntimeConversationCompactOutcome
} from './runtime'
import { AgentRuntimeController } from './runtime-controller'

export type SelectedRuntimeResolver = {
  getRuntime(
    selection: AgentRuntimeSelection,
    workspacePath?: string
  ): Promise<AgentRuntime>
  getStatus(
    selection: AgentRuntimeSelection
  ): Promise<AgentRuntimeStatus>
  testStatus(
    selection: AgentRuntimeSelection
  ): Promise<AgentRuntimeStatus>
  getNativeSnapshot(
    selection: AgentRuntimeSelection,
    workspacePath?: string
  ): Promise<RuntimeNativeSnapshot>
  compactConversation(
    request: RuntimeConversationCompactInput,
    workspacePath: string | undefined,
    signal: AbortSignal
  ): Promise<RuntimeConversationCompactOutcome>
  releaseConversation(conversationId: string): Promise<void>
  reset?(): Promise<void>
}

export class SelectedRuntimeManager implements SelectedRuntimeResolver {
  private readonly entries = new Map<
    string,
    Promise<AgentRuntimeController>
  >()
  private disposed = false
  private readonly retiring = new Set<Promise<void>>()
  private readonly tests = new Set<Promise<AgentRuntimeStatus>>()
  private readonly snapshots = new Set<
    Promise<RuntimeNativeSnapshot>
  >()

  constructor(
    private readonly createRuntime: (
      selection: AgentRuntimeSelection,
      workspacePath?: string
    ) => Promise<AgentRuntime>
  ) {}

  async getRuntime(
    selection: AgentRuntimeSelection,
    workspacePath?: string
  ): Promise<AgentRuntimeController> {
    if (this.disposed) {
      throw new Error('Agent Runtime 正在关闭')
    }
    const key = JSON.stringify([
      agentRuntimeSelectionKey(selection),
      workspacePath ?? ''
    ])
    const existing = this.entries.get(key)
    if (existing) {
      return existing
    }
    const operation = this.createRuntime(selection, workspacePath).then(
      async (runtime) => {
        if (this.disposed || this.entries.get(key) !== operation) {
          await runtime.dispose()
          throw new Error('Runtime 设置已更改，请重新选择')
        }
        return new AgentRuntimeController(runtime)
      }
    )
    this.entries.set(key, operation)
    try {
      return await operation
    } catch (error) {
      if (this.entries.get(key) === operation) {
        this.entries.delete(key)
      }
      throw error
    }
  }

  async getStatus(
    selection: AgentRuntimeSelection
  ): Promise<AgentRuntimeStatus> {
    return (await this.getRuntime(selection)).getStatus()
  }

  async testStatus(
    selection: AgentRuntimeSelection
  ): Promise<AgentRuntimeStatus> {
    if (this.disposed) {
      throw new Error('Agent Runtime 正在关闭')
    }
    const operation = this.runConnectionTest(selection)
    this.tests.add(operation)
    try {
      return await operation
    } finally {
      this.tests.delete(operation)
    }
  }

  async getNativeSnapshot(
    selection: AgentRuntimeSelection,
    workspacePath?: string
  ): Promise<RuntimeNativeSnapshot> {
    if (this.disposed) {
      throw new Error('Agent Runtime 正在关闭')
    }
    const operation = this.runNativeSnapshot(
      selection,
      workspacePath
    )
    this.snapshots.add(operation)
    try {
      return await operation
    } finally {
      this.snapshots.delete(operation)
    }
  }

  async compactConversation(
    request: RuntimeConversationCompactInput,
    workspacePath: string | undefined,
    signal: AbortSignal
  ): Promise<RuntimeConversationCompactOutcome> {
    const runtime = await this.getRuntime(
      request.runtimeSelection,
      workspacePath
    )
    return runtime.compactConversation(request, signal)
  }

  async releaseConversation(conversationId: string): Promise<void> {
    const controllers = await Promise.allSettled([
      ...this.entries.values()
    ])
    await Promise.allSettled(
      controllers.flatMap((result) =>
        result.status === 'fulfilled'
          ? [result.value.releaseConversation(conversationId)]
          : []
      )
    )
  }

  async reset(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(
      entries.map((entry) => this.startRetiring(entry, false))
    )
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(
      entries.map((entry) => this.startRetiring(entry, true))
    )
    await Promise.allSettled([...this.tests])
    await Promise.allSettled([...this.snapshots])
    await Promise.allSettled([...this.retiring])
  }

  private async runConnectionTest(
    selection: AgentRuntimeSelection
  ): Promise<AgentRuntimeStatus> {
    const runtime = await this.createRuntime(selection)
    try {
      if (this.disposed) {
        throw new Error('Agent Runtime 正在关闭')
      }
      return (
        (await runtime.testConnection?.()) ??
        (await runtime.getStatus())
      )
    } finally {
      await runtime.dispose()
    }
  }

  private async runNativeSnapshot(
    selection: AgentRuntimeSelection,
    workspacePath?: string
  ): Promise<RuntimeNativeSnapshot> {
    const runtime = await this.createRuntime(selection, workspacePath)
    try {
      if (this.disposed) {
        throw new Error('Agent Runtime 正在关闭')
      }
      if (!runtime.getNativeSnapshot) {
        throw new Error('当前 Runtime 不支持原生能力清单')
      }
      return await runtime.getNativeSnapshot()
    } finally {
      await runtime.dispose()
    }
  }

  private async startRetiring(
    entry: Promise<AgentRuntimeController>,
    waitForDisposal: boolean
  ): Promise<void> {
    try {
      const controller = await entry
      const disposal = controller.dispose()
      this.retiring.add(disposal)
      void disposal.then(
        () => this.retiring.delete(disposal),
        () => this.retiring.delete(disposal)
      )
      if (waitForDisposal) {
        await disposal
      }
    } catch {
      return
    }
  }
}
