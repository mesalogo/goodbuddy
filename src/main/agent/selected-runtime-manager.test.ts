import type {
  AgentExecutionRequest,
  AgentRuntime,
  RuntimeEvent
} from './runtime'
import { SelectedRuntimeManager } from './selected-runtime-manager'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionSpaceDescriptor } from '../execution-space'

function executionSpace(
  cacheIdentity: string
): ExecutionSpaceDescriptor {
  return {
    kind: 'local',
    rootPath: cacheIdentity,
    cacheIdentity,
    routeIdentity: cacheIdentity,
    workspaceAccess: {} as ExecutionSpaceDescriptor['workspaceAccess']
  }
}

function remoteExecutionSpace(
  hostId: string,
  cacheIdentity: string
): ExecutionSpaceDescriptor {
  return {
    kind: 'ssh',
    hostId,
    remoteRootPath: '/srv/project',
    cacheIdentity,
    routeIdentity: cacheIdentity,
    workspaceAccess:
      {} as ExecutionSpaceDescriptor['workspaceAccess']
  }
}

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
  const getNativeSnapshot = vi.fn(async () => ({
    provider: 'opencode' as const,
    available: true,
    inventoryStatus: 'available' as const,
    detail: 'ready',
    agents: [],
    tools: [],
    toolsSupported: true,
    commands: [],
    lsp: [],
    formatters: [],
    mcpServers: [],
    skills: [],
    rules: [],
    prompts: [],
    resources: [],
    resourcesSupported: true,
    context: {
      strategy: 'native' as const,
      manualCompact: true,
      detail: 'ready'
    }
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
    getNativeSnapshot,
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
  return {
    value,
    releaseConversation,
    dispose,
    testConnection,
    getNativeSnapshot
  }
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

    const firstSpace = executionSpace('local:project-one')
    const secondSpace = executionSpace('local:project-two')
    const projectOne = await manager.getRuntime(selection, firstSpace)
    const projectOneAgain = await manager.getRuntime(
      selection,
      executionSpace('local:project-one')
    )
    const projectTwo = await manager.getRuntime(selection, secondSpace)

    expect(projectOneAgain).toBe(projectOne)
    expect(projectTwo).not.toBe(projectOne)
    expect(create).toHaveBeenNthCalledWith(
      1,
      selection,
      firstSpace
    )
    expect(create).toHaveBeenNthCalledWith(
      2,
      selection,
      secondSpace
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

  it('retires only cached runtimes for an edited SSH Host', async () => {
    const firstHost = runtime()
    const secondHost = runtime()
    const local = runtime()
    const replacement = runtime()
    const create = vi
      .fn()
      .mockResolvedValueOnce(firstHost.value)
      .mockResolvedValueOnce(secondHost.value)
      .mockResolvedValueOnce(local.value)
      .mockResolvedValueOnce(replacement.value)
    const manager = new SelectedRuntimeManager(create)
    const selection = { provider: 'opencode' as const }
    const firstSpace = remoteExecutionSpace(
      'host-one',
      'ssh:host-one:revision-one'
    )
    const secondSpace = remoteExecutionSpace(
      'host-two',
      'ssh:host-two:revision-one'
    )
    const localSpace = executionSpace('local:project')

    const firstController = await manager.getRuntime(
      selection,
      firstSpace
    )
    const secondController = await manager.getRuntime(
      selection,
      secondSpace
    )
    const localController = await manager.getRuntime(
      selection,
      localSpace
    )

    await manager.invalidateHost('host-one')

    expect(firstHost.dispose).toHaveBeenCalledOnce()
    expect(secondHost.dispose).not.toHaveBeenCalled()
    expect(local.dispose).not.toHaveBeenCalled()
    expect(
      await manager.getRuntime(selection, secondSpace)
    ).toBe(secondController)
    expect(
      await manager.getRuntime(selection, localSpace)
    ).toBe(localController)
    expect(
      await manager.getRuntime(selection, firstSpace)
    ).not.toBe(firstController)
    expect(create).toHaveBeenCalledTimes(4)

    await manager.dispose()
    expect(secondHost.dispose).toHaveBeenCalledOnce()
    expect(local.dispose).toHaveBeenCalledOnce()
    expect(replacement.dispose).toHaveBeenCalledOnce()
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

  it('disposes a native-inventory runtime without caching it', async () => {
    const inspected = runtime()
    const cached = runtime()
    const create = vi
      .fn()
      .mockResolvedValueOnce(inspected.value)
      .mockResolvedValueOnce(cached.value)
    const manager = new SelectedRuntimeManager(create)
    const selection = { provider: 'opencode' as const }

    await expect(
      manager.getNativeSnapshot(
        selection,
        executionSpace('local:project-one')
      )
    ).resolves.toMatchObject({
      provider: 'opencode',
      inventoryStatus: 'available'
    })
    expect(inspected.getNativeSnapshot).toHaveBeenCalledOnce()
    expect(inspected.dispose).toHaveBeenCalledOnce()

    await manager.getRuntime(
      selection,
      executionSpace('local:project-one')
    )
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

  it('retires a drainable Runtime without forcing it and keeps routing conversation release', async () => {
    let finishDrain!: () => void
    const drain = new Promise<void>((resolve) => {
      finishDrain = resolve
    })
    const active = runtime()
    const beginDrain = vi.fn(async () => undefined)
    const waitForDrain = vi.fn(async () => await drain)
    const forceShutdown = vi.fn(async () => undefined)
    Object.assign(active.value, {
      beginDrain,
      waitForDrain,
      forceShutdown
    })
    const manager = new SelectedRuntimeManager(
      vi.fn(async () => active.value)
    )
    const controller = await manager.getRuntime({
      provider: 'opencode'
    })
    const stream = controller.run(
      {
        requestId: '00000000-0000-4000-8000-000000000021',
        conversationId: 'conversation-draining',
        prompt: 'finish normally',
        workMode: 'ask'
      },
      new AbortController().signal
    )
    await stream.next()
    await stream.next()

    await manager.reset()
    expect(beginDrain).toHaveBeenCalledOnce()
    expect(forceShutdown).not.toHaveBeenCalled()
    expect(active.dispose).not.toHaveBeenCalled()

    await manager.releaseConversation('conversation-draining')
    expect(active.releaseConversation).toHaveBeenCalledWith(
      'conversation-draining'
    )
    finishDrain()
    await vi.waitFor(() =>
      expect(active.dispose).toHaveBeenCalledOnce()
    )
    expect(forceShutdown).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('evicts only the least-recently-used idle Runtime at the cache bound', async () => {
    const first = runtime()
    const second = runtime()
    const third = runtime()
    const create = vi
      .fn()
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value)
      .mockResolvedValueOnce(third.value)
    const manager = new SelectedRuntimeManager(create, 2)
    const selection = (suffix: string) => ({
      provider: 'model' as const,
      profileId: `00000000-0000-4000-8000-0000000000${suffix}`
    })

    const firstController = await manager.getRuntime(selection('31'))
    await manager.getRuntime(selection('32'))
    await expect(
      manager.getRuntime(selection('31'))
    ).resolves.toBe(firstController)
    await manager.getRuntime(selection('33'))

    await vi.waitFor(() =>
      expect(second.dispose).toHaveBeenCalledOnce()
    )
    expect(first.dispose).not.toHaveBeenCalled()
    expect(third.dispose).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('bounds current and drain-retained Runtime controllers across resets', async () => {
    const created = [runtime(), runtime(), runtime()]
    for (const item of created) {
      Object.assign(item.value, {
        beginDrain: vi.fn(async () => undefined),
        waitForDrain: vi.fn(async () => await new Promise(() => undefined)),
        forceShutdown: vi.fn(async () => undefined)
      })
    }
    const create = vi
      .fn()
      .mockResolvedValueOnce(created[0]!.value)
      .mockResolvedValueOnce(created[1]!.value)
      .mockResolvedValueOnce(created[2]!.value)
    const manager = new SelectedRuntimeManager(create, 1, 2)
    const selection = (suffix: string) => ({
      provider: 'model' as const,
      profileId: `00000000-0000-4000-8000-0000000000${suffix}`
    })

    await manager.getRuntime(selection('41'))
    await manager.reset()
    await manager.getRuntime(selection('42'))
    await manager.reset()
    await expect(
      manager.getRuntime(selection('43'))
    ).rejects.toThrow(/退役容量/iu)
    expect(create).toHaveBeenCalledTimes(2)
    await manager.dispose()
    expect(created[0]!.dispose).toHaveBeenCalledOnce()
    expect(created[1]!.dispose).toHaveBeenCalledOnce()
  })

  it('reserves retained capacity while an invalidated Runtime is still being created', async () => {
    let finishCreate!: (runtime: AgentRuntime) => void
    const pendingCreate = new Promise<AgentRuntime>((resolve) => {
      finishCreate = resolve
    })
    const created = runtime()
    const create = vi.fn(async () => await pendingCreate)
    const manager = new SelectedRuntimeManager(create, 1, 1)
    const selection = (suffix: string) => ({
      provider: 'model' as const,
      profileId: `00000000-0000-4000-8000-0000000000${suffix}`
    })

    const firstRuntime = manager
      .getRuntime(selection('51'))
      .catch((error: unknown) => error)
    const reset = manager.reset()

    await expect(
      manager.getRuntime(selection('52'))
    ).rejects.toThrow(/退役容量/iu)
    expect(create).toHaveBeenCalledOnce()

    finishCreate(created.value)
    await expect(firstRuntime).resolves.toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/设置已更改/iu)
      })
    )
    await reset
    expect(created.dispose).toHaveBeenCalledOnce()
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

  it('uses only the resolver-owned execution-space cache identity', async () => {
    const create = vi.fn(async () => runtime().value)
    const manager = new SelectedRuntimeManager(create)
    const selection = { provider: 'opencode' as const }
    const remote = (
      cacheIdentity: string
    ): ExecutionSpaceDescriptor => ({
      kind: 'ssh',
      hostId: 'host-one',
      remoteRootPath: '/srv/project',
      cacheIdentity,
      routeIdentity: 'remote-route',
      workspaceAccess:
        {} as ExecutionSpaceDescriptor['workspaceAccess']
    })

    const baseline = await manager.getRuntime(
      selection,
      remote('resolver-identity-one')
    )
    await expect(
      manager.getRuntime(
        selection,
        remote('resolver-identity-one')
      )
    ).resolves.toBe(baseline)
    await expect(
      manager.getRuntime(
        selection,
        remote('resolver-identity-two')
      )
    ).resolves.not.toBe(baseline)
    expect(create).toHaveBeenCalledTimes(2)
    await manager.dispose()
  })
})
