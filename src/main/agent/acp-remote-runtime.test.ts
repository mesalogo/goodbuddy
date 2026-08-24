import { createHash } from 'node:crypto'
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type AgentCapabilities,
  type PromptRequest,
  type PromptResponse
} from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../../shared/agent-protocol/canonical'
import type {
  RemotePromptOperationAcceptance,
  RemotePromptOperationPreparation
} from '../../shared/remote-agent-contracts'
import {
  REMOTE_RUNTIME_LAUNCH_LIMITS
} from '../../shared/remote-runtime-launch-contracts'
import type { RuntimeEvent } from './runtime'
import {
  AcpRemoteRuntime,
  type AcpRemoteRuntimeOptions
} from './acp-remote-runtime'
import type {
  RemoteModelBridgeOpenRequest,
  RemoteModelBridgeSession,
  RemoteCancellationEscalation,
  RemotePromptOperationCompletion,
  RemotePromptOperationCompletionResult,
  RemotePromptOperationReconciliation,
  RemotePromptOperationReconciliationResult,
  RemoteRuntimeChannel
} from './remote-runtime-channel'
import { MemoryRuntimeSessionBindingStore } from './runtime-session-binding-store'

type FakeServer = {
  channel: RemoteRuntimeChannel
  client: AgentSideConnection
  generation: { current: boolean }
  close: ReturnType<typeof vi.fn>
  setInboundPaused: ReturnType<typeof vi.fn>
  prepare: ReturnType<
    typeof vi.fn<
      (
        value: RemotePromptOperationPreparation
      ) => Promise<RemotePromptOperationAcceptance>
    >
  >
  complete: ReturnType<
    typeof vi.fn<
      (
        value: RemotePromptOperationCompletion
      ) => Promise<RemotePromptOperationCompletionResult>
    >
  >
  reconcile: ReturnType<
    typeof vi.fn<
      (
        value: RemotePromptOperationReconciliation
      ) => Promise<RemotePromptOperationReconciliationResult>
    >
  >
  escalate: ReturnType<
    typeof vi.fn<(value: RemoteCancellationEscalation) => Promise<void>>
  >
}

function capabilityDigest(capabilities: AgentCapabilities): string {
  return `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        protocolVersion: PROTOCOL_VERSION,
        capabilities
      })
    )
    .digest('hex')}`
}

const identity = {
  controllerId: 'controller-1',
  controllerGeneration: 1,
  hostId: 'host-1',
  hostRevision: 1,
  hostKeyGeneration: 1,
  workspaceIdentity: 'workspace-1',
  agentInstallationId: 'installation-1',
  daemonBootIdAtOpen: 'boot-1',
  runtimeBundleDigest: `sha256:${'a'.repeat(64)}`,
  runtimeAdapterDigest: `sha256:${'b'.repeat(64)}`
}

function acceptPrompt(
  value: RemotePromptOperationPreparation
): RemotePromptOperationAcceptance {
  return {
    bindingId: value.bindingId,
    operationId: value.operationId,
    requestId: value.requestId,
    workMode: value.workMode,
    deadlineAt: value.deadlineAt,
    acceptedAt: new Date().toISOString()
  }
}

function fakeServer(
  handlers: {
    capabilities?: AgentCapabilities
    advertisedAcpCapabilitiesDigest?: string
    channelEpoch?: string
    generation?: number
    initialize?: Agent['initialize']
    newSession?: Agent['newSession']
    prompt?: (request: PromptRequest) => Promise<PromptResponse>
    loadSession?: Agent['loadSession']
    resumeSession?: Agent['resumeSession']
    closeSession?: Agent['closeSession']
    cancel?: Agent['cancel']
    preparePrompt?: (
      value: RemotePromptOperationPreparation
    ) => Promise<RemotePromptOperationAcceptance>
    completePromptOperation?: (
      value: RemotePromptOperationCompletion
    ) => Promise<RemotePromptOperationCompletionResult>
    reconcilePromptOperation?: (
      value: RemotePromptOperationReconciliation
    ) => Promise<RemotePromptOperationReconciliationResult>
    openModelBridge?: (
      value: RemoteModelBridgeOpenRequest
    ) => Promise<RemoteModelBridgeSession>
  } = {}
): FakeServer {
  const mainToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToMain = new TransformStream<Uint8Array, Uint8Array>()
  const generation = { current: true }
  const close = vi.fn(async () => {})
  const setInboundPaused = vi.fn(async () => {})
  const prepare = vi.fn<
    (
      value: RemotePromptOperationPreparation
    ) => Promise<RemotePromptOperationAcceptance>
  >(
    handlers.preparePrompt ??
      (async (value) => acceptPrompt(value))
  )
  const reconcile = vi.fn<
    (
      value: RemotePromptOperationReconciliation
    ) => Promise<RemotePromptOperationReconciliationResult>
  >(
    handlers.reconcilePromptOperation ??
      (async () => ({
        status: 'terminal',
        terminalState: 'completed',
        processTree: 'empty'
      }))
  )
  const complete = vi.fn<
    (
      value: RemotePromptOperationCompletion
    ) => Promise<RemotePromptOperationCompletionResult>
  >(
    handlers.completePromptOperation ??
      (async (value) => ({
        ...value,
        status: 'completed',
        processTree: 'running'
      }))
  )
  const escalate = vi.fn<
    (value: RemoteCancellationEscalation) => Promise<void>
  >(async () => {})
  const agentCapabilities = handlers.capabilities ?? {
    loadSession: true,
    sessionCapabilities: {
      close: {},
      resume: {}
    }
  }
  const connection = new AgentSideConnection(
    () =>
      ({
        initialize:
          handlers.initialize ??
          (async () => ({
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities
          })),
        newSession:
          handlers.newSession ??
          (async () => ({ sessionId: 'session-1' })),
        loadSession: handlers.loadSession ?? (async () => ({})),
        resumeSession: handlers.resumeSession ?? (async () => ({})),
        closeSession: handlers.closeSession ?? (async () => ({})),
        prompt:
          handlers.prompt ??
          (async () => ({ stopReason: 'end_turn' })),
        cancel: handlers.cancel ?? (async () => {})
      }) as unknown as Agent,
    ndJsonStream(agentToMain.writable, mainToAgent.readable)
  )
  const channel: RemoteRuntimeChannel = {
    input: agentToMain.readable,
    output: mainToAgent.writable,
    generation: handlers.generation ?? 1,
    channelEpoch: handlers.channelEpoch ?? '1',
    advertisedAcpCapabilitiesDigest:
      handlers.advertisedAcpCapabilitiesDigest ??
      capabilityDigest(agentCapabilities),
    capabilities: {
      cancellationEscalation: true,
      promptOperationReconciliation: true,
      modelBridge: handlers.openModelBridge !== undefined
    },
    closed: new Promise(() => {}),
    isCurrentGeneration: () => generation.current,
    getBindingCursors: async () => ({
      lastOutboundJournaledSequence: '0',
      lastOutboundDeliveredSequence: '0',
      lastInboundJournaledSequence: '0',
      lastMainAckSequence: '0'
    }),
    preparePrompt: prepare,
    ...(handlers.openModelBridge === undefined
      ? {}
      : { openModelBridge: handlers.openModelBridge }),
    completePromptOperation: complete,
    setInboundPaused,
    escalateCancellation: escalate,
    reconcilePromptOperation: reconcile,
    close
  }
  return {
    channel,
    client: connection,
    generation,
    close,
    setInboundPaused,
    prepare,
    complete,
    reconcile,
    escalate
  }
}

function runtime(
  server: FakeServer,
  store = new MemoryRuntimeSessionBindingStore(),
  cancellationGraceMs = 5,
  overrides: Partial<AcpRemoteRuntimeOptions> = {}
): AcpRemoteRuntime {
  return new AcpRemoteRuntime({
    runtimeId: 'opencode',
    label: 'Remote ACP',
    workspacePath: '/workspace',
    identity,
    channel: server.channel,
    bindingStore: store,
    assertHostCurrent: () => {},
    cancellationGraceMs,
    operationTimeoutMs: overrides.operationTimeoutMs ?? 100,
    promptTimeoutMs:
      overrides.promptTimeoutMs ??
      overrides.operationTimeoutMs ??
      100,
    usage: {
      runtime: 'opencode',
      provider: 'test',
      model: 'fake'
    },
    ...overrides
  })
}

function factoryRuntime(
  factory: (bindingId: string) => Promise<RemoteRuntimeChannel>,
  store = new MemoryRuntimeSessionBindingStore(),
  overrides: Partial<AcpRemoteRuntimeOptions> = {}
): AcpRemoteRuntime {
  return new AcpRemoteRuntime({
    runtimeId: 'opencode',
    label: 'Remote ACP',
    workspacePath: '/workspace',
    identity,
    channelFactory: factory,
    bindingStore: store,
    assertHostCurrent: () => {},
    cancellationGraceMs: 5,
    operationTimeoutMs: overrides.operationTimeoutMs ?? 100,
    promptTimeoutMs:
      overrides.promptTimeoutMs ??
      overrides.operationTimeoutMs ??
      100,
    usage: {
      runtime: 'opencode',
      provider: 'test',
      model: 'fake'
    },
    ...overrides,
    channel: undefined
  })
}

async function collect(
  stream: AsyncGenerator<RuntimeEvent, void, void>
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

const request = {
  requestId: '1c608898-ecb7-4081-8174-2b6a52f53c01',
  conversationId: 'conversation-1',
  prompt: 'hello',
  workMode: 'execute' as const
}

const modelBridgePolicy = {
  protocol: 'openai-responses' as const,
  model: 'gpt-test',
  modelProfileDigest: `sha256:${'d'.repeat(64)}`,
  supportsImageInput: false
}

function fakeModelBridge(
  value: RemoteModelBridgeOpenRequest,
  index: number,
  result = { clean: true, poisoned: false }
): RemoteModelBridgeSession & {
  close: ReturnType<typeof vi.fn>
} {
  const close = vi.fn(async () => result)
  return {
    version: 'goodbuddy-model-bridge-v1',
    channelId: `model-channel-${index}`,
    channelEpoch: String(100 + index),
    policy: value.policy,
    closed: new Promise(() => {}),
    close
  }
}

describe('AcpRemoteRuntime', () => {
  it('budgets the complete ACP input stream, not only raw prompt bytes', async () => {
    const server = fakeServer()
    const instance = runtime(
      server,
      new MemoryRuntimeSessionBindingStore()
    )

    await collect(
      instance.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )

    expect(server.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        budget: expect.objectContaining({
          maximumInputBytes:
            REMOTE_RUNTIME_LAUNCH_LIMITS.maximumPromptInputBytes
        })
      })
    )
    await instance.dispose()
  })

  it('closes a binding after a definitive prepare rejection so retry is safe', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    let rejectedBindingId = ''
    const newSession = vi.fn(async () => ({ sessionId: 'session-1' }))
    const rejected = fakeServer({
      newSession,
      preparePrompt: async (preparation) => {
        rejectedBindingId = preparation.bindingId
        throw Object.assign(
          new Error(
            'Remote Runtime runtime/preparePrompt was rejected (RPC -32000, process)'
          ),
          {
            remoteMethod: 'runtime/preparePrompt',
            remoteRequestOutcome: 'rejected'
          }
        )
      }
    })
    const first = runtime(rejected, store)

    await expect(
      collect(
        first.run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).rejects.toThrow('runtime/preparePrompt')
    expect(newSession).not.toHaveBeenCalled()
    await expect(store.getById(rejectedBindingId)).resolves.toMatchObject({
      state: 'closed',
      activePromptOperationId: undefined
    })
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toBeUndefined()

    const retry = runtime(fakeServer(), store)
    await expect(
      collect(
        retry.run(
          { ...request, requestId: 'prompt-retry' },
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'done' })
      ])
    )
    await retry.dispose()
  })

  it('allocates and cleans a fresh model bridge for each prompt on one ACP channel', async () => {
    const bridges: ReturnType<typeof fakeModelBridge>[] = []
    const openModelBridge = vi.fn(
      async (value: RemoteModelBridgeOpenRequest) => {
        const bridge = fakeModelBridge(value, bridges.length + 1)
        bridges.push(bridge)
        return bridge
      }
    )
    const server = fakeServer({
      openModelBridge,
      preparePrompt: async (preparation) => {
        expect(preparation.modelBridge).toMatchObject({
          version: 'goodbuddy-model-bridge-v1',
          policy: modelBridgePolicy
        })
        return acceptPrompt(preparation)
      }
    })
    const store = new MemoryRuntimeSessionBindingStore()
    const instance = runtime(server, store, 5, {
      modelBridgePolicy
    })

    await collect(
      instance.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    await collect(
      instance.run(
        { ...request, requestId: 'prompt-2' },
        new AbortController().signal,
        async () => 'once'
      )
    )

    expect(openModelBridge).toHaveBeenCalledTimes(2)
    expect(bridges.map((bridge) => bridge.channelId)).toEqual([
      'model-channel-1',
      'model-channel-2'
    ])
    expect(bridges.every((bridge) => bridge.close.mock.calls.length === 1))
      .toBe(true)
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      state: 'ready',
      promptSequence: 1,
      modelBridgeVersion: 'goodbuddy-model-bridge-v1',
      modelBridgePolicy
    })
    await instance.dispose()
  })

  it('closes and replaces an idle binding under a different model policy', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const firstServer = fakeServer({
      openModelBridge: async (value) => fakeModelBridge(value, 1)
    })
    const first = runtime(firstServer, store, 5, {
      modelBridgePolicy
    })
    await collect(
      first.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    const oldBinding = await store.getByConversation(
      request.conversationId
    )

    const newSession = vi.fn(async () => ({ sessionId: 'session-2' }))
    const loadSession = vi.fn(async () => ({}))
    const secondServer = fakeServer({
      openModelBridge: async (value) => fakeModelBridge(value, 2),
      newSession,
      loadSession
    })
    const second = runtime(secondServer, store, 5, {
      modelBridgePolicy: {
        ...modelBridgePolicy,
        model: 'different-model'
      }
    })
    await collect(
      second.run(
        { ...request, requestId: 'prompt-2' },
        new AbortController().signal,
        async () => 'once'
      )
    )
    expect(newSession).toHaveBeenCalledOnce()
    expect(loadSession).not.toHaveBeenCalled()
    await expect(store.getById(oldBinding!.bindingId)).resolves.toMatchObject({
      state: 'closed'
    })
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      bindingId: expect.not.stringMatching(oldBinding!.bindingId),
      acpSessionId: 'session-2',
      state: 'ready',
      modelBridgePolicy: expect.objectContaining({
        model: 'different-model'
      })
    })
    await Promise.all([first.dispose(), second.dispose()])
  })

  it('replaces an idle binding after Agent and Runtime identity changes', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const first = runtime(fakeServer(), store)
    await collect(
      first.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    const oldBinding = await store.getByConversation(
      request.conversationId
    )
    await first.dispose()

    const server = fakeServer({
      newSession: async () => ({ sessionId: 'session-2' })
    })
    const bindingIds: string[] = []
    const replacement = factoryRuntime(
      async (bindingId) => {
        bindingIds.push(bindingId)
        return server.channel
      },
      store,
      {
        identity: {
          ...identity,
          agentInstallationId: 'installation-2',
          runtimeBundleDigest: `sha256:${'c'.repeat(64)}`
        }
      }
    )

    await collect(
      replacement.run(
        { ...request, requestId: 'prompt-2' },
        new AbortController().signal
      )
    )

    expect(bindingIds).toHaveLength(1)
    expect(bindingIds[0]).not.toBe(oldBinding?.bindingId)
    await expect(store.getById(oldBinding!.bindingId)).resolves.toMatchObject({
      state: 'closed'
    })
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      bindingId: bindingIds[0],
      acpSessionId: 'session-2',
      state: 'ready',
      agentInstallationId: 'installation-2',
      runtimeBundleDigest: `sha256:${'c'.repeat(64)}`
    })
    await replacement.dispose()
  })

  it.each(['prompt-running', 'outcome-unknown'] as const)(
    'does not replace a %s binding after identity changes',
    async (state) => {
      const store = new MemoryRuntimeSessionBindingStore()
      const active = {
        bindingId: 'binding-active',
        ...identity,
        conversationId: request.conversationId,
        runtimeId: 'opencode' as const,
        acpSessionId: 'session-active',
        acpCapabilitiesDigest: capabilityDigest({
          loadSession: true,
          sessionCapabilities: {
            close: {},
            resume: {}
          }
        }),
        state,
        activePromptOperationId: request.requestId,
        promptSequence: 0,
        channelEpoch: '1',
        lastOutboundJournaledSequence: '0',
        lastOutboundDeliveredSequence: '0',
        lastInboundJournaledSequence: '0',
        lastMainAckSequence: '0'
      }
      await store.put(active)
      const factory = vi.fn(async () => fakeServer().channel)
      const instance = factoryRuntime(factory, store, {
        identity: {
          ...identity,
          agentInstallationId: 'installation-2'
        }
      })

      await expect(
        collect(
          instance.run(
            { ...request, requestId: 'prompt-2' },
            new AbortController().signal
          )
        )
      ).rejects.toThrow('不会自动重放')

      expect(factory).not.toHaveBeenCalled()
      await expect(
        store.getByConversation(request.conversationId)
      ).resolves.toMatchObject({
        bindingId: active.bindingId,
        state: 'outcome-unknown',
        activePromptOperationId: request.requestId
      })
      await instance.dispose()
    }
  )

  it('persists outcome-unknown and blocks reuse when model delivery is poisoned', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const openModelBridge = vi.fn(
      async (value: RemoteModelBridgeOpenRequest) =>
        fakeModelBridge(value, 1, {
          clean: false,
          poisoned: true
        })
    )
    const instance = runtime(
      fakeServer({ openModelBridge }),
      store,
      5,
      { modelBridgePolicy }
    )
    await expect(
      collect(
        instance.run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).rejects.toThrow('结果未知')
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      state: 'outcome-unknown',
      activePromptOperationId: request.requestId
    })
    await expect(
      collect(
        instance.run(
          { ...request, requestId: 'prompt-2' },
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).rejects.toThrow()
    expect(openModelBridge).toHaveBeenCalledOnce()
    await instance.forceShutdown()
  })

  it('persists and prepares the binding before ACP initialization', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const order: string[] = []
    const server = fakeServer({
      initialize: async () => {
        order.push('initialize')
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: {
              close: {},
              resume: {}
            }
          }
        }
      },
      preparePrompt: async (preparation) => {
        order.push('prepare')
        await expect(
          store.getByConversation(request.conversationId)
        ).resolves.toMatchObject({
          bindingId: preparation.bindingId,
          state: 'prompt-running',
          activePromptOperationId: request.requestId,
          acpCapabilitiesDigest:
            capabilityDigest({
              loadSession: true,
              sessionCapabilities: {
                close: {},
                resume: {}
              }
            })
        })
        return acceptPrompt(preparation)
      }
    })
    const instance = runtime(server, store)

    await collect(
      instance.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )

    expect(order).toEqual(['prepare', 'initialize'])
    await instance.dispose()
  })

  it('rejects actual ACP capabilities that differ from signed evidence', async () => {
    const server = fakeServer({
      advertisedAcpCapabilitiesDigest:
        `sha256:${'f'.repeat(64)}`
    })
    const instance = runtime(server)

    await expect(
      collect(
        instance.run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).rejects.toThrow('实际能力摘要')
    expect(server.close).toHaveBeenCalledOnce()
  })

  it('does not send ACP initialization during a status check', async () => {
    const initialize = vi.fn(async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          close: {},
          resume: {}
        }
      }
    }))
    const server = fakeServer({ initialize })
    const instance = runtime(server)

    await expect(instance.getStatus()).resolves.toMatchObject({
      available: true
    })
    expect(initialize).not.toHaveBeenCalled()
    await instance.dispose()
  })

  it('uses one fixed binding and channel per conversation', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const first = fakeServer()
    const second = fakeServer({
      newSession: async () => ({ sessionId: 'session-2' })
    })
    const servers = [first, second]
    const bindingIds: string[] = []
    const factory = vi.fn(async (bindingId: string) => {
      bindingIds.push(bindingId)
      return servers.shift()!.channel
    })
    const instance = factoryRuntime(factory, store)
    const secondRequest = {
      ...request,
      requestId: 'f10873fc-c528-48c1-818d-204a75588a48',
      conversationId: 'conversation-2'
    }

    await Promise.all([
      collect(
        instance.run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      ),
      collect(
        instance.run(
          secondRequest,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ])

    const firstBinding = await store.getByConversation(
      request.conversationId
    )
    const secondBinding = await store.getByConversation(
      secondRequest.conversationId
    )
    expect(new Set(bindingIds).size).toBe(2)
    expect(bindingIds).toContain(firstBinding?.bindingId)
    expect(bindingIds).toContain(secondBinding?.bindingId)
    expect(first.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: bindingIds[0] })
    )
    expect(second.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: bindingIds[1] })
    )

    await instance.releaseConversation(request.conversationId)
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
    await instance.dispose()
    expect(second.close).toHaveBeenCalledOnce()
  })

  it('bounds concurrent conversation channels until release', async () => {
    const first = fakeServer()
    const second = fakeServer()
    const servers = [first, second]
    const factory = vi.fn(async () => servers.shift()!.channel)
    const instance = factoryRuntime(factory, undefined, {
      maxConcurrentChannels: 1
    })
    await collect(
      instance.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )

    const pending = collect(
      instance.run(
        {
          ...request,
          requestId: '8c7dcf59-ce69-4900-9f50-6312a2a19ca8',
          conversationId: 'conversation-2'
        },
        new AbortController().signal,
        async () => 'once'
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(factory).toHaveBeenCalledOnce()

    await instance.releaseConversation(request.conversationId)
    await expect(pending).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'done' })
      ])
    )
    expect(factory).toHaveBeenCalledTimes(2)
    await instance.dispose()
  })

  it('passes a durable binding identity back to the channel factory', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const first = fakeServer()
    const firstIds: string[] = []
    const initial = factoryRuntime(async (bindingId) => {
      firstIds.push(bindingId)
      return first.channel
    }, store)
    await collect(
      initial.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    const durable = await store.getByConversation(request.conversationId)
    await initial.dispose()

    const loadSession = vi.fn(async () => ({}))
    const second = fakeServer({
      channelEpoch: '2',
      generation: 2,
      loadSession
    })
    const recoveredIds: string[] = []
    const recovered = factoryRuntime(async (bindingId) => {
      recoveredIds.push(bindingId)
      return second.channel
    }, store, {
      identity: {
        ...identity,
        controllerGeneration: 2,
        daemonBootIdAtOpen: 'boot-2'
      }
    })
    await collect(
      recovered.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )

    expect(firstIds).toEqual([durable?.bindingId])
    expect(recoveredIds).toEqual([durable?.bindingId])
    expect(loadSession).toHaveBeenCalledOnce()
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      bindingId: durable?.bindingId,
      controllerGeneration: 2,
      daemonBootIdAtOpen: 'boot-2',
      channelEpoch: '2'
    })
    expect(second.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        controllerGeneration: 2,
        connectionGeneration: 2,
        channelEpoch: '2'
      })
    )
    await recovered.dispose()
  })

  it('closes a channel when session opening fails and releases capacity', async () => {
    const failed = fakeServer({
      newSession: async () => {
        throw new Error('open failed')
      }
    })
    const succeeding = fakeServer()
    const servers = [failed, succeeding]
    const factory = vi.fn(async () => servers.shift()!.channel)
    const instance = factoryRuntime(factory, undefined, {
      maxConcurrentChannels: 1
    })

    await expect(
      collect(
        instance.run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).rejects.toThrow('Internal error')
    expect(failed.close).toHaveBeenCalledOnce()

    await expect(
      collect(
        instance.run(
          {
            ...request,
            requestId: '07aac893-73cd-4ddd-85d5-19ee635ebf21',
            conversationId: 'conversation-2'
          },
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'done' })
      ])
    )
    expect(factory).toHaveBeenCalledTimes(2)
    await instance.dispose()
  })

  it('starts the requested work mode before session and prompt', async () => {
    const order: string[] = []
    const server = fakeServer({
      preparePrompt: async (value) => {
        order.push(`prepare:${value.workMode}`)
        return acceptPrompt(value)
      },
      newSession: async () => {
        order.push('session')
        return { sessionId: 'session-1' }
      },
      prompt: async () => {
        order.push('prompt')
        return { stopReason: 'end_turn' }
      }
    })

    await collect(
      runtime(server).run(
        { ...request, workMode: 'ask' },
        new AbortController().signal
      )
    )

    expect(order).toEqual(['prepare:ask', 'session', 'prompt'])
    expect(server.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: request.requestId,
        requestId: request.requestId,
        workMode: 'ask',
        controllerGeneration: 1,
        connectionGeneration: 1,
        channelEpoch: '1'
      })
    )
  })

  it('passes Execute directly as the authorization contract', async () => {
    const server = fakeServer()

    await collect(
      runtime(server).run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )

    expect(server.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        workMode: 'execute'
      })
    )
    expect(server.prepare.mock.calls[0]?.[0]).not.toHaveProperty(
      'trustTier'
    )
    expect(server.prepare.mock.calls[0]?.[0]).not.toHaveProperty(
      'capabilities'
    )
  })

  it('supports Ask and Execute without trust-tier translation', async () => {
    const askServer = fakeServer()
    const executeServer = fakeServer()

    await collect(runtime(askServer).run(
      { ...request, workMode: 'ask' },
      new AbortController().signal
    ))
    await collect(runtime(executeServer).run(
      request,
      new AbortController().signal,
      async () => 'once'
    ))
    expect(askServer.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ workMode: 'ask' })
    )
    expect(executeServer.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ workMode: 'execute' })
    )
  })

  it('rejects a stale Host binding before a new prompt', async () => {
    const server = fakeServer()
    const assertion = vi.fn(() => {
      throw new Error('Host binding changed')
    })

    await expect(
      collect(
        runtime(server, undefined, undefined, {
          assertHostCurrent: assertion
        }).run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).rejects.toThrow('Host binding changed')

    expect(assertion).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'host-1' })
    )
    expect(server.prepare).not.toHaveBeenCalled()
    expect(server.close).toHaveBeenCalledOnce()
  })

  it('rechecks the Host binding before resuming a prompt', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const firstServer = fakeServer()
    const firstRuntime = runtime(firstServer, store)
    await collect(
      firstRuntime.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    await firstRuntime.dispose()

    const loadSession = vi.fn(async () => ({}))
    const secondServer = fakeServer({ loadSession })
    const assertion = vi.fn(() => {
      throw new Error('Host binding stale')
    })
    await expect(
      collect(
        runtime(secondServer, store, undefined, {
          assertHostCurrent: assertion
        }).run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).rejects.toThrow('Host binding stale')

    expect(assertion).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'host-1' })
    )
    expect(secondServer.prepare).not.toHaveBeenCalled()
    expect(loadSession).not.toHaveBeenCalled()
    expect(secondServer.close).toHaveBeenCalledOnce()
  })

  it('fails closed on a mismatched prompt acceptance before ACP session', async () => {
    const newSession = vi.fn(async () => ({ sessionId: 'session-1' }))
    const prompt = vi.fn(async () => ({ stopReason: 'end_turn' as const }))
    const server = fakeServer({
      preparePrompt: async (value) => ({
        ...acceptPrompt(value),
        bindingId: 'different-binding',
      }),
      newSession,
      prompt
    })

    await expect(
      collect(
        runtime(server).run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).rejects.toThrow('稳定操作身份不匹配')
    expect(newSession).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })

  it('maps message, thought, tool, plan and usage events', async () => {
    const client: { value?: AgentSideConnection } = {}
    const server = fakeServer({
      prompt: async ({ sessionId }) => {
        await client.value!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'answer' }
          }
        })
        await client.value!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'thinking' }
          }
        })
        await client.value!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Read',
            status: 'in_progress'
          }
        })
        await client.value!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'plan',
            entries: [
              {
                content: 'Inspect',
                priority: 'high',
                status: 'in_progress'
              }
            ]
          }
        })
        await client.value!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'usage_update',
            used: 20,
            size: 100
          }
        })
        return {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15
          }
        }
      }
    })
    client.value = server.client

    const events = await collect(
      runtime(server).run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )

    expect(events.map((event) => event.type)).toEqual([
      'status',
      'text',
      'reasoning',
      'tool',
      'status',
      'context-metrics',
      'model-usage',
      'done'
    ])
  })

  it('routes permission through the authorizer and denies Ask mode', async () => {
    const client: { value?: AgentSideConnection } = {}
    const outcomes: string[] = []
    const server = fakeServer({
      prompt: async ({ sessionId }) => {
        const response = await client.value!.requestPermission({
          sessionId,
          options: [
            {
              optionId: 'allow',
              name: 'Allow',
              kind: 'allow_once'
            },
            {
              optionId: 'reject',
              name: 'Reject',
              kind: 'reject_once'
            }
          ],
          toolCall: {
            toolCallId: 'tool-1',
            title: 'Write',
            kind: 'edit',
            rawInput: { path: 'a.txt' }
          }
        })
        outcomes.push(
          response.outcome.outcome === 'selected'
            ? response.outcome.optionId
            : 'cancelled'
        )
        return { stopReason: 'end_turn' }
      }
    })
    client.value = server.client
    const authorize = vi.fn(async () => 'once' as const)
    await collect(
      runtime(server).run(
        request,
        new AbortController().signal,
        authorize
      )
    )
    const askClient: { value?: AgentSideConnection } = {}
    const askServer = fakeServer({
        prompt: async ({ sessionId }) => {
          const response = await askClient.value!.requestPermission({
            sessionId,
            options: [
              {
                optionId: 'ask-allow',
                name: 'Allow',
                kind: 'allow_always'
              },
              {
                optionId: 'reject',
                name: 'Reject',
                kind: 'reject_once'
              }
            ],
            toolCall: { toolCallId: 'tool-2', title: 'Write' }
          })
          outcomes.push(
            response.outcome.outcome === 'selected'
              ? response.outcome.optionId
              : 'cancelled'
          )
          return { stopReason: 'end_turn' }
        }
      })
    askClient.value = askServer.client
    await collect(
      runtime(askServer).run(
        { ...request, conversationId: 'conversation-2', workMode: 'ask' },
        new AbortController().signal,
        authorize
      )
    )
    expect(authorize).toHaveBeenCalledOnce()
    expect(outcomes).toEqual(['allow', 'reject'])
  })

  it('auto-allows Execute permissions without an external authorizer', async () => {
    const client: { value?: AgentSideConnection } = {}
    const outcomes: string[] = []
    const server = fakeServer({
      prompt: async ({ sessionId }) => {
        for (const options of [
          [
            {
              optionId: 'once',
              name: 'Allow once',
              kind: 'allow_once' as const
            },
            {
              optionId: 'always',
              name: 'Allow always',
              kind: 'allow_always' as const
            },
            {
              optionId: 'reject',
              name: 'Reject',
              kind: 'reject_once' as const
            }
          ],
          [
            {
              optionId: 'once-only',
              name: 'Allow once',
              kind: 'allow_once' as const
            }
          ]
        ]) {
          const response = await client.value!.requestPermission({
            sessionId,
            options,
            toolCall: {
              toolCallId: `tool-${outcomes.length + 1}`,
              title: 'Write'
            }
          })
          outcomes.push(
            response.outcome.outcome === 'selected'
              ? response.outcome.optionId
              : 'cancelled'
          )
        }
        return { stopReason: 'end_turn' }
      }
    })
    client.value = server.client

    await collect(
      runtime(server).run(
        request,
        new AbortController().signal
      )
    )

    expect(outcomes).toEqual(['always', 'once-only'])
  })

  it('preserves an explicit Execute authorizer denial', async () => {
    const client: { value?: AgentSideConnection } = {}
    let outcome = ''
    const server = fakeServer({
      prompt: async ({ sessionId }) => {
        const response = await client.value!.requestPermission({
          sessionId,
          options: [
            {
              optionId: 'always',
              name: 'Allow always',
              kind: 'allow_always'
            },
            {
              optionId: 'reject',
              name: 'Reject',
              kind: 'reject_once'
            }
          ],
          toolCall: {
            toolCallId: 'tool-denied',
            title: 'Write'
          }
        })
        outcome =
          response.outcome.outcome === 'selected'
            ? response.outcome.optionId
            : 'cancelled'
        return { stopReason: 'end_turn' }
      }
    })
    client.value = server.client
    const authorize = vi.fn(async () => 'deny' as const)

    await collect(
      runtime(server).run(
        request,
        new AbortController().signal,
        authorize
      )
    )

    expect(authorize).toHaveBeenCalledOnce()
    expect(outcome).toBe('reject')
  })

  it('loads a durable ready binding on a new channel', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const claim = vi.spyOn(store, 'claimAcpSession')
    const first = fakeServer()
    await collect(
      runtime(first, store).run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    await runtime(first, store).dispose()
    claim.mockClear()

    const loadSession = vi.fn(async () => ({}))
    const second = fakeServer({ loadSession })
    await collect(
      runtime(second, store).run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    expect(loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' })
    )
    expect(claim).toHaveBeenCalledWith(
      expect.any(String),
      'session-1'
    )
  })

  it('reconciles an accepted completion when its response is lost without replaying it', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const server = fakeServer({
      completePromptOperation: async () => {
        throw new Error('completion response lost')
      },
      reconcilePromptOperation: async () => ({
        status: 'terminal',
        terminalState: 'completed',
        processTree: 'running'
      })
    })

    await expect(
      collect(
        runtime(server, store).run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'done' })
      ])
    )
    expect(server.complete).toHaveBeenCalledOnce()
    expect(server.reconcile).toHaveBeenCalledOnce()
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      state: 'ready',
      activePromptOperationId: undefined
    })
  })

  it('uses resume when loading history is unavailable', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const claim = vi.spyOn(store, 'claimAcpSession')
    const capabilities = {
      sessionCapabilities: { resume: {} }
    }
    const first = fakeServer({ capabilities })
    const firstRuntime = runtime(first, store)
    await collect(
      firstRuntime.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    await firstRuntime.dispose()
    claim.mockClear()

    const resumeSession = vi.fn(async () => ({}))
    const second = fakeServer({ capabilities, resumeSession })
    await collect(
      runtime(second, store).run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' })
    )
    expect(claim).toHaveBeenCalledWith(
      expect.any(String),
      'session-1'
    )
  })

  it('rejects stale generations and escalates cancellation', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const server = fakeServer({
      prompt: () => new Promise(() => {}),
      reconcilePromptOperation: async () => ({
        status: 'outcome-unknown',
        processTree: 'unknown'
      })
    })
    const instance = runtime(server, store)
    const controller = new AbortController()
    const pending = collect(
      instance.run(request, controller.signal, async () => 'once')
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('结果未知')
    expect(server.escalate).toHaveBeenCalledOnce()
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      state: 'outcome-unknown',
      activePromptOperationId: request.requestId
    })

    const stale = fakeServer()
    stale.generation.current = false
    await expect(stale.channel.isCurrentGeneration()).toBe(false)
    await expect(
      collect(
        runtime(stale).run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).rejects.toThrow('代际')
  })

  it('honors cancellation while opening a session before prompt', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const prompt = vi.fn(async () => ({ stopReason: 'end_turn' as const }))
    const server = fakeServer({
      newSession: () => new Promise(() => {}),
      prompt,
      reconcilePromptOperation: async () => ({
        status: 'outcome-unknown',
        processTree: 'unknown'
      })
    })
    const instance = runtime(server, store)
    const controller = new AbortController()
    const pending = collect(
      instance.run(request, controller.signal, async () => 'once')
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort(new Error('cancelled before prompt'))

    await expect(pending).rejects.toThrow('cancelled before prompt')
    expect(prompt).not.toHaveBeenCalled()
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      state: 'outcome-unknown',
      activePromptOperationId: request.requestId
    })
    expect(server.close).toHaveBeenCalledOnce()
  })

  it('bounds a prompt that never reaches a terminal response', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const cancel = vi.fn(async () => {})
    const server = fakeServer({
      prompt: () => new Promise(() => {}),
      cancel,
      reconcilePromptOperation: async () => ({
        status: 'outcome-unknown',
        processTree: 'unknown'
      })
    })
    const instance = runtime(server, store, 5, {
      operationTimeoutMs: 20
    })

    await expect(
      collect(
        instance.run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).rejects.toThrow('执行请求超时')
    expect(cancel).toHaveBeenCalledOnce()
    expect(server.escalate).toHaveBeenCalledOnce()
    expect(server.close).toHaveBeenCalledOnce()
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      state: 'outcome-unknown',
      activePromptOperationId: request.requestId
    })
  })

  it('allows prompts to outlive short control-operation timeouts', async () => {
    const server = fakeServer({
      prompt: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { stopReason: 'end_turn' as const }
      }
    })
    const instance = runtime(server, undefined, 5, {
      operationTimeoutMs: 10,
      promptTimeoutMs: 100
    })

    await expect(
      collect(
        instance.run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).resolves.toEqual([
      expect.objectContaining({
        type: 'status',
        message: '远端 ACP Runtime 正在处理请求'
      }),
      expect.objectContaining({
        type: 'done'
      })
    ])
  })

  it('cancels and truncates a flood when the consumer is slow', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const client: { value?: AgentSideConnection } = {}
    const cancel = vi.fn(async () => {})
    const server = fakeServer({
      prompt: async ({ sessionId }) => {
        await Promise.all(
          Array.from({ length: 20 }, (_value, index) =>
            client.value!.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `chunk-${index}` }
              }
            })
          )
        )
        return { stopReason: 'end_turn' }
      },
      cancel,
      reconcilePromptOperation: async () => ({
        status: 'outcome-unknown',
        processTree: 'unknown'
      })
    })
    client.value = server.client
    const instance = runtime(server, store, 5, {
      maxPendingUpdates: 2,
      maxPendingUpdateBytes: 1_024
    })
    const stream = instance.run(
      request,
      new AbortController().signal,
      async () => 'once'
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' },
      done: false
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(stream.next()).rejects.toThrow('输出已截断')
    expect(server.setInboundPaused).toHaveBeenCalledWith(true)
    expect(server.setInboundPaused).not.toHaveBeenCalledWith(false)
    expect(cancel).toHaveBeenCalledOnce()
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      state: 'outcome-unknown',
      activePromptOperationId: request.requestId
    })
  })

  it('keeps capability digests stable across object key order', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const first = fakeServer({
      capabilities: {
        sessionCapabilities: { resume: {}, close: {} },
        loadSession: true
      }
    })
    const firstRuntime = runtime(first, store)
    await collect(
      firstRuntime.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    await firstRuntime.dispose()

    const loadSession = vi.fn(async () => ({}))
    const second = fakeServer({
      capabilities: {
        loadSession: true,
        sessionCapabilities: { close: {}, resume: {} }
      },
      loadSession
    })
    await collect(
      runtime(second, store).run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    expect(loadSession).toHaveBeenCalledOnce()
  })

  it('rejects duplicate Runtime-provided sessions across live conversations', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const first = fakeServer({
      newSession: async () => ({ sessionId: 'shared-session' })
    })
    const second = fakeServer({
      newSession: async () => ({ sessionId: 'shared-session' })
    })

    const outcomes = await Promise.allSettled([
      collect(
        runtime(first, store).run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      ),
      collect(
        runtime(second, store).run(
          { ...request, conversationId: 'conversation-2' },
          new AbortController().signal,
          async () => 'once'
        )
      )
    ])

    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled')
    ).toHaveLength(1)
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected'
    )
    expect(String(rejected?.reason)).toContain(
      'already owned by another live binding'
    )
  })

  it('bounds release cleanup and persists interruption', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const closeSession = vi.fn(() => new Promise<Record<string, never>>(
      () => {}
    ))
    const server = fakeServer({ closeSession })
    const instance = runtime(server, store, 5, {
      operationTimeoutMs: 20
    })
    await collect(
      instance.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )

    await expect(
      instance.releaseConversation(request.conversationId)
    ).rejects.toThrow('关闭会话超时')
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({ state: 'interrupted' })
    expect(server.close).toHaveBeenCalledOnce()
  })

  it('cancels and cleans up when event consumption ends early', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    let finishPrompt:
      | ((response: PromptResponse) => void)
      | undefined
    const cancel = vi.fn(async () => {
      finishPrompt?.({ stopReason: 'cancelled' })
    })
    const server = fakeServer({
      prompt: () =>
        new Promise<PromptResponse>((resolve) => {
          finishPrompt = resolve
        }),
      cancel
    })
    const instance = runtime(server, store)
    const stream = instance.run(
      request,
      new AbortController().signal,
      async () => 'once'
    )
    await stream.next()

    await stream.return()
    expect(cancel).toHaveBeenCalledOnce()
    expect(server.escalate).not.toHaveBeenCalled()
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      state: 'ready',
      activePromptOperationId: undefined
    })
    await instance.releaseConversation(request.conversationId)
    await instance.beginDrain()
    await instance.waitForDrain()
  })

  it('drains until session release and closes session resources', async () => {
    const closeSession = vi.fn(async () => ({}))
    const server = fakeServer({ closeSession })
    const instance = runtime(server)
    await collect(
      instance.run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    await instance.beginDrain()
    let drained = false
    void instance.waitForDrain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    await instance.releaseConversation(request.conversationId)
    await instance.waitForDrain()
    expect(closeSession).toHaveBeenCalledOnce()
    await instance.dispose()
    expect(server.close).toHaveBeenCalledOnce()
  })

  it('force shutdown cancels by stable operation and preserves unknown identity', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const server = fakeServer({
      prompt: () => new Promise(() => {}),
      reconcilePromptOperation: async () => ({
        status: 'outcome-unknown',
        processTree: 'unknown'
      })
    })
    const instance = runtime(server, store, 5, {
      operationTimeoutMs: 1_000
    })
    const stream = instance.run(
      request,
      new AbortController().signal,
      async () => 'once'
    )
    await stream.next()

    await instance.forceShutdown()
    await expect(stream.next()).rejects.toThrow()
    expect(server.escalate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: request.requestId,
        requestId: request.requestId
      })
    )
    expect(server.reconcile).toHaveBeenCalledWith({
      bindingId: expect.any(String),
      operationId: request.requestId,
      requestId: request.requestId
    })
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      state: 'outcome-unknown',
      activePromptOperationId: request.requestId
    })
  })
})
