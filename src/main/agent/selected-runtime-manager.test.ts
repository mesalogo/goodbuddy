import type {
  AgentExecutionRequest,
  AgentRuntime,
  RuntimeEvent
} from './runtime'
import { SelectedRuntimeManager } from './selected-runtime-manager'
import { describe, expect, it, vi } from 'vitest'

function runtime() {
  const releaseConversation = vi.fn(async () => undefined)
  const dispose = vi.fn(async () => undefined)
  const testConnection = vi.fn(async () => ({
    id: 'model' as const,
    label: 'model',
    available: true,
    supportsToolExecution: true,
    detail: 'ready'
  }))
  const value: AgentRuntime = {
    runtimeId: 'model',
    requiresToolApproval: false,
    supportsToolExecution: true,
    capability: 'chat',
    getStatus: vi.fn(async () => ({
      id: 'model' as const,
      label: 'model',
      available: true,
      supportsToolExecution: true,
      detail: 'ready'
    })),
    testConnection,
    async *run(
      request: AgentExecutionRequest
    ): AsyncGenerator<RuntimeEvent, void, void> {
      yield {
        requestId: request.requestId,
        type: 'done'
      }
    },
    releaseConversation,
    dispose
  }
  return { value, releaseConversation, dispose, testConnection }
}

describe('SelectedRuntimeManager', () => {
  it('caches one controller per runtime and profile selection', async () => {
    const first = runtime()
    const second = runtime()
    const create = vi
      .fn()
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value)
    const manager = new SelectedRuntimeManager(create)

    const [left, right] = await Promise.all([
      manager.getRuntime({
        provider: 'model',
        profileId: '00000000-0000-4000-8000-000000000001'
      }),
      manager.getRuntime({
        provider: 'model',
        profileId: '00000000-0000-4000-8000-000000000001'
      })
    ])
    expect(left).toBe(right)
    expect(create).toHaveBeenCalledOnce()

    await manager.getRuntime({ provider: 'continue' })
    expect(create).toHaveBeenCalledTimes(2)
    await manager.dispose()
  })

  it('isolates cached runtimes by effective project workspace', async () => {
    const first = runtime()
    const second = runtime()
    const create = vi
      .fn()
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value)
    const manager = new SelectedRuntimeManager(create)
    const selection = { provider: 'opencode' as const }

    const projectOne = await manager.getRuntime(
      selection,
      'C:\\Projects\\One'
    )
    const projectOneAgain = await manager.getRuntime(
      selection,
      'C:\\Projects\\One'
    )
    const projectTwo = await manager.getRuntime(
      selection,
      'C:\\Projects\\Two'
    )

    expect(projectOneAgain).toBe(projectOne)
    expect(projectTwo).not.toBe(projectOne)
    expect(create).toHaveBeenNthCalledWith(
      1,
      selection,
      'C:\\Projects\\One'
    )
    expect(create).toHaveBeenNthCalledWith(
      2,
      selection,
      'C:\\Projects\\Two'
    )
    await manager.dispose()
  })

  it('retires cached runtimes when settings change', async () => {
    const first = runtime()
    const second = runtime()
    const create = vi
      .fn()
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value)
    const manager = new SelectedRuntimeManager(create)
    const selection = {
      provider: 'model' as const,
      profileId: '00000000-0000-4000-8000-000000000001'
    }

    await manager.getRuntime(selection)
    await manager.reset()
    expect(first.dispose).toHaveBeenCalledOnce()

    await manager.getRuntime(selection)
    expect(create).toHaveBeenCalledTimes(2)
    await manager.dispose()
    expect(second.dispose).toHaveBeenCalledOnce()
  })

  it('disposes a connection-test runtime without caching it', async () => {
    const tested = runtime()
    const cached = runtime()
    const create = vi
      .fn()
      .mockResolvedValueOnce(tested.value)
      .mockResolvedValueOnce(cached.value)
    const manager = new SelectedRuntimeManager(create)
    const selection = { provider: 'opencode' as const }

    await expect(manager.testStatus(selection)).resolves.toMatchObject({
      available: true
    })
    expect(tested.testConnection).toHaveBeenCalledOnce()
    expect(tested.dispose).toHaveBeenCalledOnce()

    await manager.getRuntime(selection)
    expect(create).toHaveBeenCalledTimes(2)
    await manager.dispose()
  })

  it('waits for a pending connection-test runtime during shutdown', async () => {
    let finishCreate!: (value: AgentRuntime) => void
    const pendingCreate = new Promise<AgentRuntime>((resolve) => {
      finishCreate = resolve
    })
    const tested = runtime()
    const manager = new SelectedRuntimeManager(
      vi.fn(async () => pendingCreate)
    )

    const test = manager.testStatus({ provider: 'opencode' })
    const disposal = manager.dispose()
    finishCreate(tested.value)

    await expect(test).rejects.toThrow('正在关闭')
    await disposal
    expect(tested.testConnection).not.toHaveBeenCalled()
    expect(tested.dispose).toHaveBeenCalledOnce()
  })

  it('lets active work finish while settings changes retire its runtime', async () => {
    let markStarted!: () => void
    let finishRun!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const finish = new Promise<void>((resolve) => {
      finishRun = resolve
    })
    const active = runtime()
    active.value.run = async function* (
      request: AgentExecutionRequest
    ): AsyncGenerator<RuntimeEvent, void, void> {
      markStarted()
      await finish
      yield {
        requestId: request.requestId,
        type: 'done'
      }
    }
    const manager = new SelectedRuntimeManager(
      vi.fn(async () => active.value)
    )
    const selection = {
      provider: 'model' as const,
      profileId: '00000000-0000-4000-8000-000000000001'
    }
    const controller = await manager.getRuntime(selection)
    const stream = controller.run(
      {
        requestId: '00000000-0000-4000-8000-000000000011',
        conversationId: 'conversation-one',
        prompt: 'keep working',
        workMode: 'ask'
      },
      new AbortController().signal
    )
    const firstEvent = stream.next()
    await started

    await manager.reset()
    expect(active.dispose).not.toHaveBeenCalled()
    await expect(
      controller
        .run(
          {
            requestId: '00000000-0000-4000-8000-000000000012',
            conversationId: 'conversation-two',
            prompt: 'new work',
            workMode: 'ask'
          },
          new AbortController().signal
        )
        .next()
    ).rejects.toThrow('正在关闭')

    finishRun()
    await expect(firstEvent).resolves.toEqual(
      expect.objectContaining({
        value: expect.objectContaining({ type: 'done' }),
        done: false
      })
    )
    await stream.next()
    await vi.waitFor(() =>
      expect(active.dispose).toHaveBeenCalledOnce()
    )
    await manager.dispose()
  })

  it('releases a conversation from every selected runtime', async () => {
    const first = runtime()
    const second = runtime()
    const create = vi
      .fn()
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value)
    const manager = new SelectedRuntimeManager(create)

    await manager.getRuntime({
      provider: 'model',
      profileId: '00000000-0000-4000-8000-000000000001'
    })
    await manager.getRuntime({ provider: 'opencode' })
    await manager.releaseConversation('conversation-one')

    expect(first.releaseConversation).toHaveBeenCalledWith(
      'conversation-one'
    )
    expect(second.releaseConversation).toHaveBeenCalledWith(
      'conversation-one'
    )
    await manager.dispose()
  })
})
