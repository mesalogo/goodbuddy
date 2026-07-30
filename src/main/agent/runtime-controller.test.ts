import { describe, expect, it, vi } from 'vitest'
import type {
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type { AgentRuntime } from './runtime'
import { AgentRuntimeController } from './runtime-controller'

class TestRuntime implements AgentRuntime {
  readonly dispose = vi.fn(async () => {})
  readonly started: Promise<void>
  private release?: () => void
  private markStarted!: () => void

  constructor(
    private readonly delayed = false,
    readonly requiresToolApproval = false
  ) {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve
    })
  }

  getStatus(): Promise<AgentRuntimeStatus> {
    return Promise.resolve({
      id: 'demo',
      label: 'Test',
      available: true,
      detail: 'Test runtime'
    })
  }

  async *run(
    request: AgentRequest
  ): AsyncGenerator<AgentEvent, void, void> {
    this.markStarted()
    if (this.delayed) {
      await new Promise<void>((resolve) => {
        this.release = resolve
      })
    }
    yield {
      requestId: request.requestId,
      type: 'text',
      delta: 'old runtime event'
    }
  }

  finish(): void {
    this.release?.()
  }
}

describe('AgentRuntimeController', () => {
  it('suppresses retired runtime events and disposes it after requests exit', async () => {
    const previous = new TestRuntime(true, true)
    const next = new TestRuntime()
    const controller = new AgentRuntimeController(previous)
    const authorize = vi.fn(async () => {})
    const approvedStream = controller.run(
      {
        requestId: '1c608898-ecb7-4081-8174-2b6a52f53b08',
        conversationId: 'conversation-2',
        prompt: 'test'
      },
      new AbortController().signal,
      authorize
    )
    const pendingEvent = approvedStream.next()
    await previous.started
    expect(authorize).toHaveBeenCalledWith(true)

    const replacement = controller.replace(next)
    previous.finish()

    await expect(pendingEvent).resolves.toMatchObject({ done: true })
    await replacement
    expect(previous.dispose).toHaveBeenCalledOnce()
    await expect(controller.getStatus()).resolves.toMatchObject({
      label: 'Test'
    })
  })
})
