import {
  agentRuntimeSelectionKey,
  type AgentRuntimeSelection
} from '../../shared/runtime-selection-contracts'
import type { AgentRuntimeStatus } from '../../shared/contracts'
import type { AgentRuntime } from './runtime'
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

  constructor(
    private readonly createRuntime: (
      selection: AgentRuntimeSelection,
      workspacePath?: string
    ) => Promise<AgentRuntime>
  ) {}

  async getRuntime(
    selection: AgentRuntimeSelection,
    workspacePath?: string
  ): Promise<AgentRuntime> {
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
