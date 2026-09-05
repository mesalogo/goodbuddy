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
import type { ExecutionSpaceDescriptor } from '../execution-space'
import type {
  DesktopDiagnosticFailureObserver
} from '../desktop-diagnostics'

export type SelectedRuntimeResolver = {
  getRuntime(
    selection: AgentRuntimeSelection,
    executionSpace?: ExecutionSpaceDescriptor
  ): Promise<AgentRuntime>
  getStatus(
    selection: AgentRuntimeSelection
  ): Promise<AgentRuntimeStatus>
  testStatus(
    selection: AgentRuntimeSelection
  ): Promise<AgentRuntimeStatus>
  getNativeSnapshot(
    selection: AgentRuntimeSelection,
    executionSpace?: ExecutionSpaceDescriptor
  ): Promise<RuntimeNativeSnapshot>
  compactConversation(
    request: RuntimeConversationCompactInput,
    executionSpace: ExecutionSpaceDescriptor | undefined,
    signal: AbortSignal
  ): Promise<RuntimeConversationCompactOutcome>
  releaseConversation(conversationId: string): Promise<void>
  reset?(): Promise<void>
}

type RuntimeEntry = {
  operation: Promise<AgentRuntimeController>
  controller?: AgentRuntimeController
  hostId?: string
  lastUsed: number
}

const DEFAULT_MAXIMUM_CACHED_RUNTIMES = 8
const DEFAULT_MAXIMUM_RETAINED_RUNTIMES = 16

export class SelectedRuntimeManager implements SelectedRuntimeResolver {
  private readonly entries = new Map<string, RuntimeEntry>()
  private disposed = false
  private readonly retiring = new Set<Promise<void>>()
  private readonly retiringControllers =
    new Set<AgentRuntimeController>()
  private pendingRetirementControllers = 0
  private readonly tests = new Set<Promise<AgentRuntimeStatus>>()
  private readonly snapshots = new Set<
    Promise<RuntimeNativeSnapshot>
  >()
  private useSequence = 0
  private applicationExitDetachment?: Promise<void>

  constructor(
    private readonly createRuntime: (
      selection: AgentRuntimeSelection,
      executionSpace?: ExecutionSpaceDescriptor
    ) => Promise<AgentRuntime>,
    private readonly maximumCachedRuntimes =
      DEFAULT_MAXIMUM_CACHED_RUNTIMES,
    private readonly maximumRetainedRuntimes =
      DEFAULT_MAXIMUM_RETAINED_RUNTIMES,
    private readonly observeFailure?:
      DesktopDiagnosticFailureObserver,
    private readonly createStatusRuntime = createRuntime
  ) {
    if (
      !Number.isSafeInteger(maximumCachedRuntimes) ||
      maximumCachedRuntimes < 1 ||
      maximumCachedRuntimes > 64
    ) {
      throw new RangeError('Invalid selected Runtime cache limit')
    }
    if (
      !Number.isSafeInteger(maximumRetainedRuntimes) ||
      maximumRetainedRuntimes < maximumCachedRuntimes ||
      maximumRetainedRuntimes > 64
    ) {
      throw new RangeError('Invalid retained Runtime limit')
    }
  }

  async getRuntime(
    selection: AgentRuntimeSelection,
    executionSpace?: ExecutionSpaceDescriptor
  ): Promise<AgentRuntimeController> {
    if (this.disposed) {
      throw new Error('Agent Runtime 正在关闭')
    }
    const key = JSON.stringify([
      agentRuntimeSelectionKey(selection),
      executionSpace?.cacheIdentity ?? null
    ])
    const existing = this.entries.get(key)
    if (existing) {
      existing.lastUsed = ++this.useSequence
      return existing.operation
    }
    this.evictIdleEntries(this.maximumCachedRuntimes - 1)
    if (this.entries.size >= this.maximumCachedRuntimes) {
      throw new Error(
        'Agent Runtime 缓存已被活动会话占满，请先关闭不再使用的会话'
      )
    }
    if (
      this.entries.size +
        this.retiringControllers.size +
        this.pendingRetirementControllers >=
      this.maximumRetainedRuntimes
    ) {
      throw new Error(
        'Agent Runtime 退役容量已满，请先关闭仍由旧设置持有的会话'
      )
    }
    const operation = this.createRuntime(selection, executionSpace).then(
      async (runtime) => {
        if (
          this.disposed ||
          this.entries.get(key)?.operation !== operation
        ) {
          await runtime.dispose()
          throw new Error('Runtime 设置已更改，请重新选择')
        }
        const controller = new AgentRuntimeController(
          runtime,
          undefined,
          this.observeFailure
        )
        entry.controller = controller
        return controller
      }
    )
    const entry: RuntimeEntry = {
      operation,
      ...(executionSpace?.kind === 'ssh'
        ? { hostId: executionSpace.hostId }
        : {}),
      lastUsed: ++this.useSequence
    }
    this.entries.set(key, entry)
    try {
      return await operation
    } catch (error) {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key)
      }
      this.reportFailure('create', error)
      throw error
    }
  }

  async getStatus(
    selection: AgentRuntimeSelection
  ): Promise<AgentRuntimeStatus> {
    if (this.disposed) {
      throw new Error('Agent Runtime 正在关闭')
    }
    const operation = this.runStatusProbe(selection)
    this.tests.add(operation)
    try {
      return await operation
    } catch (error) {
      this.reportFailure('status', error)
      throw error
    } finally {
      this.tests.delete(operation)
    }
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
    } catch (error) {
      this.reportFailure('connection-test', error)
      throw error
    } finally {
      this.tests.delete(operation)
    }
  }

  async getNativeSnapshot(
    selection: AgentRuntimeSelection,
    executionSpace?: ExecutionSpaceDescriptor
  ): Promise<RuntimeNativeSnapshot> {
    if (this.disposed) {
      throw new Error('Agent Runtime 正在关闭')
    }
    const operation = this.runNativeSnapshot(
      selection,
      executionSpace
    )
    this.snapshots.add(operation)
    try {
      return await operation
    } catch (error) {
      this.reportFailure('native-snapshot', error)
      throw error
    } finally {
      this.snapshots.delete(operation)
    }
  }

  async compactConversation(
    request: RuntimeConversationCompactInput,
    executionSpace: ExecutionSpaceDescriptor | undefined,
    signal: AbortSignal
  ): Promise<RuntimeConversationCompactOutcome> {
    const runtime = await this.getRuntime(
      request.runtimeSelection,
      executionSpace
    )
    return runtime.compactConversation(request, signal)
  }

  async releaseConversation(conversationId: string): Promise<void> {
    const controllers = await Promise.allSettled([
      ...[...this.entries.values()].map(({ operation }) => operation)
    ])
    const current = controllers.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    await Promise.allSettled(
      [...new Set([...current, ...this.retiringControllers])].map(
        async (controller) => {
          await controller.releaseConversation(conversationId)
        }
      )
    )
    this.evictIdleEntries(this.maximumCachedRuntimes)
  }

  async reset(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(
      entries.map((entry) => this.startRetiring(entry, false))
    )
  }

  async invalidateHost(hostId: string): Promise<void> {
    const entries: RuntimeEntry[] = []
    for (const [key, entry] of this.entries) {
      if (entry.hostId !== hostId) {
        continue
      }
      this.entries.delete(key)
      entries.push(entry)
    }
    await Promise.allSettled(
      entries.map((entry) => this.startRetiring(entry, false))
    )
  }

  async dispose(): Promise<void> {
    if (this.applicationExitDetachment) {
      await this.applicationExitDetachment
      return
    }
    this.disposed = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(
      entries.map((entry) => this.startRetiring(entry, true))
    )
    await Promise.allSettled(
      [...this.retiringControllers].map(
        async (controller) => await controller.dispose()
      )
    )
    await Promise.allSettled([...this.tests])
    await Promise.allSettled([...this.snapshots])
    await Promise.allSettled([...this.retiring])
  }

  detachForApplicationExit(): Promise<void> {
    if (this.applicationExitDetachment) {
      return this.applicationExitDetachment
    }
    this.disposed = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    const operation = (async () => {
      const controllers = await Promise.allSettled(
        entries.map(({ operation }) => operation)
      )
      const current = controllers.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      )
      await Promise.allSettled(
        [...new Set([...current, ...this.retiringControllers])].map(
          (controller) =>
            controller.detachForApplicationExit()
        )
      )
      await Promise.allSettled([...this.tests])
      await Promise.allSettled([...this.snapshots])
    })()
    this.applicationExitDetachment = operation
    return operation
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

  private async runStatusProbe(
    selection: AgentRuntimeSelection
  ): Promise<AgentRuntimeStatus> {
    const runtime = await this.createStatusRuntime(selection)
    try {
      if (this.disposed) {
        throw new Error('Agent Runtime 正在关闭')
      }
      return await runtime.getStatus()
    } finally {
      await runtime.dispose()
    }
  }

  private async runNativeSnapshot(
    selection: AgentRuntimeSelection,
    executionSpace?: ExecutionSpaceDescriptor
  ): Promise<RuntimeNativeSnapshot> {
    // The inventory runs on the same cached Runtime that later serves the
    // conversation, so a slow cold start (embedded OpenCode on Linux ARM)
    // is paid once instead of once per inventory and again per request.
    const controller = await this.getRuntime(selection, executionSpace)
    return controller.getNativeSnapshot()
  }

  private async startRetiring(
    entry: RuntimeEntry,
    waitForDisposal: boolean
  ): Promise<void> {
    this.pendingRetirementControllers += 1
    let controllerPending = true
    try {
      const controller =
        entry.controller ?? await entry.operation
      this.pendingRetirementControllers -= 1
      controllerPending = false
      const disposal = this.trackRetiringController(
        controller,
        waitForDisposal
      )
      if (waitForDisposal) {
        await disposal
      }
    } catch {
      return
    } finally {
      if (controllerPending) {
        this.pendingRetirementControllers -= 1
      }
    }
  }

  private trackRetiringController(
    controller: AgentRuntimeController,
    force: boolean
  ): Promise<void> {
    this.retiringControllers.add(controller)
    const disposal = force
      ? controller.dispose()
      : controller.retire()
    this.retiring.add(disposal)
    void disposal.then(
      () => {
        this.retiring.delete(disposal)
        this.retiringControllers.delete(controller)
      },
      () => {
        this.retiring.delete(disposal)
        this.retiringControllers.delete(controller)
      }
    )
    return disposal
  }

  private evictIdleEntries(targetSize: number): void {
    if (this.entries.size <= targetSize) {
      return
    }
    const candidates = [...this.entries.entries()]
      .filter((entry): entry is [string, RuntimeEntry] => {
        const controller = entry[1].controller
        return controller !== undefined && controller.canRetire
      })
      .sort(
        (left, right) => left[1].lastUsed - right[1].lastUsed
      )
    for (const [key, entry] of candidates) {
      if (this.entries.size <= targetSize) {
        break
      }
      if (this.entries.get(key) !== entry) {
        continue
      }
      this.entries.delete(key)
      void this.startRetiring(entry, false)
    }
  }

  private reportFailure(stage: string, error: unknown): void {
    try {
      this.observeFailure?.({
        component: 'runtime',
        stage,
        code: 'runtime.operation.failed',
        error
      })
    } catch {
      // Diagnostics must not alter Runtime behavior.
    }
  }
}
