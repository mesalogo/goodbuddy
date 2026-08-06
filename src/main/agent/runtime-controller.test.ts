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
    private readonly invokeToolAuthorization = false,
    readonly supportsToolExecution = true
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
      supportsToolExecution: this.supportsToolExecution,
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
  it('fails retired runtime requests and disposes them after exit', async () => {
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

    await expect(pendingEvent).rejects.toThrow(
      'Runtime 已切换，当前请求已中断'
    )
    await replacement
    expect(previous.dispose).toHaveBeenCalledOnce()
    await expect(controller.getStatus()).resolves.toMatchObject({
      label: 'Test'
    })
  })

  it('keeps a retiring runtime alive until its status probe finishes', async () => {
    let finishProbe!: () => void
    const probe = new Promise<void>((resolve) => {
      finishProbe = resolve
    })
    const previous = new TestRuntime()
    previous.getStatus = vi.fn(async () => {
      await probe
      return {
        id: 'opencode' as const,
        label: 'OpenCode',
        available: true,
        supportsToolExecution: true,
        detail: 'Ready'
      }
    })
    const next = new TestRuntime()
    const controller = new AgentRuntimeController(previous)

    const status = controller.getStatus()
    const replacement = controller.replace(next)
    await Promise.resolve()
    expect(previous.dispose).not.toHaveBeenCalled()

    finishProbe()
    await expect(status).rejects.toThrow('Runtime 已切换')
    await replacement
    expect(previous.dispose).toHaveBeenCalledOnce()
    await controller.dispose()
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

  it('forwards per-tool authorization without adding a whole-run gate', async () => {
    const runtime = new TestRuntime(false, false, true)
    const controller = new AgentRuntimeController(runtime)
    const authorize = vi.fn(async () => 'session' as const)
    const stream = controller.run(
      {
        requestId: '1c608898-ecb7-4081-8174-2b6a52f53b10',
        conversationId: 'conversation-4',
        prompt: 'test',
        workMode: 'execute'
      },
      new AbortController().signal,
      authorize
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'text' }
    })
    expect(authorize).toHaveBeenCalledOnce()
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: 'test:tool' })
    )
  })

  it('rejects Execute mode when the runtime cannot execute tools', async () => {
    const runtime = new TestRuntime(false, false, false, false)
    const controller = new AgentRuntimeController(runtime)
    const stream = controller.run(
      {
        requestId: '1c608898-ecb7-4081-8174-2b6a52f53b11',
        conversationId: 'conversation-5',
        prompt: 'test',
        workMode: 'execute'
      },
      new AbortController().signal
    )

    await expect(stream.next()).rejects.toThrow(
      '当前 Runtime 不支持工具执行'
    )
  })
})
