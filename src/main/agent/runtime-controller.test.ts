import { describe, expect, it, vi } from 'vitest'
import type {
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type { AgentRuntime, RuntimeAuthorizer } from './runtime'
import {
  AgentRuntimeController,
  MAX_DRAINING_RUNTIME_GENERATIONS,
  RuntimeReplacementCapacityError
} from './runtime-controller'

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

  releaseConversation(): Promise<void> {
    return Promise.resolve()
  }
}

class DrainableTestRuntime extends TestRuntime {
  readonly beginDrain = vi.fn(async () => {})
  readonly forceShutdown = vi.fn(async () => {})
  private readonly drained: Promise<void>
  private resolveDrained!: () => void

  constructor() {
    super(true)
    this.drained = new Promise((resolve) => {
      this.resolveDrained = resolve
    })
  }

  waitForDrain(): Promise<void> {
    return this.drained
  }

  releaseConversation(): Promise<void> {
    this.resolveDrained()
    return Promise.resolve()
  }
}

class DetachableTestRuntime extends DrainableTestRuntime {
  readonly detachForApplicationExit = vi.fn(() => undefined)
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

  it('drains remote sessions without interrupting their active prompt', async () => {
    const previous = new DrainableTestRuntime()
    const next = new TestRuntime()
    const controller = new AgentRuntimeController(previous)
    const stream = controller.run(
      {
        requestId: '1c608898-ecb7-4081-8174-2b6a52f53b13',
        conversationId: 'conversation-drain',
        prompt: 'test',
        workMode: 'ask'
      },
      new AbortController().signal
    )
    const pending = stream.next()
    await previous.started

    await controller.replace(next)
    expect(previous.beginDrain).toHaveBeenCalledOnce()
    expect(previous.dispose).not.toHaveBeenCalled()

    previous.finish()
    await expect(pending).resolves.toMatchObject({
      value: { type: 'text' }
    })
    await stream.return()
    expect(previous.dispose).not.toHaveBeenCalled()

    await controller.releaseConversation('conversation-drain')
    await vi.waitFor(() =>
      expect(previous.dispose).toHaveBeenCalledOnce()
    )
    await controller.dispose()
  })

  it('clears conversation ownership when a Runtime release fails', async () => {
    const runtime = new TestRuntime()
    runtime.releaseConversation = vi.fn(async () => {
      throw new Error('release failed')
    })
    const controller = new AgentRuntimeController(runtime)
    const stream = controller.run(
      {
        requestId: '1c608898-ecb7-4081-8174-2b6a52f53b16',
        conversationId: 'conversation-release-failure',
        prompt: 'test',
        workMode: 'ask'
      },
      new AbortController().signal
    )
    await stream.next()
    await stream.return()

    expect(controller.ownedConversationCount).toBe(1)
    await expect(
      controller.releaseConversation(
        'conversation-release-failure'
      )
    ).rejects.toBeInstanceOf(AggregateError)
    expect(controller.ownedConversationCount).toBe(0)
    expect(controller.canRetire).toBe(true)
    await controller.dispose()
  })

  it('counts a draining generation until disposal actually settles', async () => {
    const previous = new DrainableTestRuntime()
    let finishDisposal!: () => void
    previous.dispose.mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finishDisposal = resolve
        })
    )
    const controller = new AgentRuntimeController(previous)

    await controller.replace(new TestRuntime())
    await controller.releaseConversation('conversation-disposal')
    await vi.waitFor(() =>
      expect(previous.dispose).toHaveBeenCalledOnce()
    )
    expect(controller.replacementStatus.drainingGenerations).toBe(1)

    finishDisposal()
    await vi.waitFor(() =>
      expect(
        controller.replacementStatus.drainingGenerations
      ).toBe(0)
    )
    await controller.dispose()
  })

  it('bounds retained draining generations and rejects further replacements', async () => {
    const first = new DrainableTestRuntime()
    const second = new DrainableTestRuntime()
    const third = new DrainableTestRuntime()
    const rejected = new TestRuntime()
    const controller = new AgentRuntimeController(first)

    await controller.replace(second)
    await controller.replace(third)

    expect(controller.replacementStatus).toEqual({
      drainingGenerations: MAX_DRAINING_RUNTIME_GENERATIONS,
      failedDrainingGenerations: 0,
      pendingReplacements: 0,
      maximumDrainingGenerations: MAX_DRAINING_RUNTIME_GENERATIONS,
      saturated: true
    })
    const replacement = controller.replace(rejected)
    await expect(replacement).rejects.toBeInstanceOf(
      RuntimeReplacementCapacityError
    )
    await expect(replacement).rejects.toMatchObject({
      code: 'runtime-drain-capacity',
      occupiedGenerations: MAX_DRAINING_RUNTIME_GENERATIONS,
      maximumGenerations: MAX_DRAINING_RUNTIME_GENERATIONS
    })
    expect(rejected.dispose).toHaveBeenCalledOnce()
    expect(first.forceShutdown).not.toHaveBeenCalled()
    expect(second.forceShutdown).not.toHaveBeenCalled()

    await controller.releaseConversation('conversation-drain')
    await vi.waitFor(() => {
      expect(first.dispose).toHaveBeenCalledOnce()
      expect(second.dispose).toHaveBeenCalledOnce()
    })
    await controller.dispose()
  })

  it('retains a recoverable generation when drain observation fails', async () => {
    const previous = new DrainableTestRuntime()
    previous.waitForDrain = vi.fn(async () => {
      throw new Error('temporary drain status failure')
    })
    const controller = new AgentRuntimeController(previous, 1)

    await controller.replace(new TestRuntime())
    await vi.waitFor(() =>
      expect(controller.replacementStatus).toMatchObject({
        drainingGenerations: 1,
        failedDrainingGenerations: 1
      })
    )
    expect(previous.dispose).not.toHaveBeenCalled()
    expect(previous.forceShutdown).not.toHaveBeenCalled()

    await controller.dispose()
    expect(previous.forceShutdown).toHaveBeenCalledOnce()
    expect(previous.dispose).toHaveBeenCalledOnce()
  })

  it('uses the configured shutdown grace while replacing a busy runtime', async () => {
    vi.useFakeTimers()
    try {
      const previous = new TestRuntime(true)
      const controller = new AgentRuntimeController(previous, 25)
      const stream = controller.run(
        {
          requestId: '1c608898-ecb7-4081-8174-2b6a52f53b14',
          conversationId: 'conversation-replacement-grace',
          prompt: 'test',
          workMode: 'ask'
        },
        new AbortController().signal
      )
      const pending = stream.next()
      await previous.started

      const replacement = controller.replace(new TestRuntime())
      await vi.advanceTimersByTimeAsync(24)
      let replaced = false
      void replacement.then(() => {
        replaced = true
      })
      await Promise.resolve()
      expect(replaced).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await replacement
      expect(replaced).toBe(true)

      previous.finish()
      await expect(pending).rejects.toThrow('Runtime 已切换')
      await stream.return()
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears bounded-wait timers after fast lifecycle operations', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AgentRuntimeController(
        new TestRuntime(),
        25
      )
      await controller.replace(new TestRuntime())
      expect(vi.getTimerCount()).toBe(0)

      await controller.dispose()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forces runtime disposal when active work does not stop during shutdown', async () => {
    const runtime = new TestRuntime(true)
    const controller = new AgentRuntimeController(runtime, 1)
    const stream = controller.run(
      {
        requestId: '1c608898-ecb7-4081-8174-2b6a52f53b12',
        conversationId: 'conversation-shutdown',
        prompt: 'test',
        workMode: 'ask'
      },
      new AbortController().signal
    )
    const pendingEvent = stream.next()
    await runtime.started

    await controller.dispose()
    expect(runtime.dispose).toHaveBeenCalledOnce()

    runtime.finish()
    await expect(pendingEvent).resolves.toMatchObject({
      value: { type: 'text' }
    })
    await stream.return()
  })

  it('detaches a remote runtime on application exit without draining or disposing it', async () => {
    const runtime = new DetachableTestRuntime()
    const controller = new AgentRuntimeController(runtime, 1)
    const stream = controller.run(
      {
        requestId: '1c608898-ecb7-4081-8174-2b6a52f53b17',
        conversationId: 'conversation-application-exit',
        prompt: 'keep running remotely',
        workMode: 'execute'
      },
      new AbortController().signal
    )
    const pendingEvent = stream.next()
    await runtime.started

    await controller.detachForApplicationExit()

    expect(runtime.detachForApplicationExit).toHaveBeenCalledOnce()
    expect(runtime.beginDrain).not.toHaveBeenCalled()
    expect(runtime.forceShutdown).not.toHaveBeenCalled()
    expect(runtime.dispose).not.toHaveBeenCalled()

    runtime.finish()
    await expect(pendingEvent).resolves.toMatchObject({
      value: { type: 'text' }
    })
    await stream.return()
  })

  it('denies tool authorization in Ask mode without prompting the user', async () => {
      const runtime = new TestRuntime(false, false, true)
      const controller = new AgentRuntimeController(runtime)
      const authorize = vi.fn(async () => 'once' as const)
      const stream = controller.run(
        {
          requestId: '1c608898-ecb7-4081-8174-2b6a52f53b09',
          conversationId: 'conversation-3',
          prompt: 'test',
          workMode: 'ask'
        },
        new AbortController().signal,
        authorize
      )

      await expect(stream.next()).rejects.toThrow('tool denied')
      expect(authorize).not.toHaveBeenCalled()
  })

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
