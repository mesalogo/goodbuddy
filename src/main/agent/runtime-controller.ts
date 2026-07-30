import type {
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type { AgentRuntime } from './runtime'

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

  async *run(
    request: AgentRequest,
    signal: AbortSignal,
    authorize?: (requiresToolApproval: boolean) => Promise<void>
  ): AsyncGenerator<AgentEvent, void, void> {
    const slot = this.current
    slot.activeRequests += 1
    try {
      await authorize?.(slot.runtime.requiresToolApproval)
      for await (const event of slot.runtime.run(request, signal)) {
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
