import { describe, expect, it, vi } from 'vitest'
import type {
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type { AgentRuntime, RuntimeAuthorizer } from './runtime'
import { AgentRuntimeController } from './runtime-controller'

class TestRuntime implements AgentRuntime {
  readonly dispose = vi.fn(async () => {})
  readonly started: Promise<void>
  private release?: () => void
  private markStarted!: () => void

  constructor(
    private readonly delayed = false,
    readonly requiresToolApproval = false,
    private readonly invokeToolAuthorization = false
  ) {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve
    })
  }

  getStatus(): Promise<AgentRuntimeStatus> {
    return Promise.resolve({
      id: 'model',
      label: 'Test',
      available: true,
      detail: 'Test runtime'
    })
  }

  async *run(
    request: AgentRequest,
    _signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<AgentEvent, void, void> {
    this.markStarted()
    if (this.invokeToolAuthorization && authorize) {
      const decision = await authorize({
        scopeKey: 'test:tool',
        title: 'Test tool',
        description: 'Test tool request'
      })
      if (decision === 'deny') {
        throw new Error('tool denied')
      }
    }
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
    const authorize = vi.fn(async () => 'once' as const)
    const approvedStream = controller.run(
      {
        requestId: '1c608898-ecb7-4081-8174-2b6a52f53b08',
        conversationId: 'conversation-2',
        prompt: 'test',
        workMode: 'execute'
      },
      new AbortController().signal,
      authorize
    )
    const pendingEvent = approvedStream.next()
    await previous.started
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'runtime:whole-run'
      })
    )

    const replacement = controller.replace(next)
    previous.finish()

    await expect(pendingEvent).resolves.toMatchObject({ done: true })
    await replacement
    expect(previous.dispose).toHaveBeenCalledOnce()
    await expect(controller.getStatus()).resolves.toMatchObject({
      label: 'Test'
    })
  })

  it.each(['ask', 'plan'] as const)(
    'denies tool authorization in %s mode without prompting the user',
    async (workMode) => {
      const runtime = new TestRuntime(false, false, true)
      const controller = new AgentRuntimeController(runtime)
      const authorize = vi.fn(async () => 'once' as const)
      const stream = controller.run(
        {
          requestId: '1c608898-ecb7-4081-8174-2b6a52f53b09',
          conversationId: 'conversation-3',
          prompt: 'test',
          workMode
        },
        new AbortController().signal,
        authorize
      )

      await expect(stream.next()).rejects.toThrow('tool denied')
      expect(authorize).not.toHaveBeenCalled()
    }
  )
})
