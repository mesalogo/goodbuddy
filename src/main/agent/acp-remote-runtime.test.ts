import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type AgentCapabilities,
  type PromptRequest,
  type PromptResponse,
  type SessionUpdate
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
import type { RuntimeEvent, RemoteSemanticEventProvenance } from './runtime'
import {
  AcpRemoteRuntime,
  RemotePromptCancelledError,
  RemotePromptRecoveryUnavailableError,
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
import { MemoryRuntimeSessionBindingStore, SqliteRuntimeSessionBindingStore, type RuntimeSessionBindingStore } from './runtime-session-binding-store'
import { AssistantDatabase } from '../assistant/assistant-database'

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
    ...(overrides.promptTimeoutMs === undefined
      ? {}
      : { promptTimeoutMs: overrides.promptTimeoutMs }),
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
  store: RuntimeSessionBindingStore = new MemoryRuntimeSessionBindingStore(),
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
    ...(overrides.promptTimeoutMs === undefined
      ? {}
      : { promptTimeoutMs: overrides.promptTimeoutMs }),
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
    'retires a %s binding before starting an explicit later prompt',
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
      const replacement = fakeServer()
      const factory = vi.fn(
        async (bindingId: string) => {
          expect(bindingId).not.toBe(active.bindingId)
          return replacement.channel
        }
      )
      const instance = factoryRuntime(factory, store, {
        identity: {
          ...identity,
          agentInstallationId: 'installation-2'
        }
      })

      await collect(
        instance.run(
          { ...request, requestId: 'prompt-2' },
          new AbortController().signal
        )
      )

      expect(factory).toHaveBeenCalledOnce()
      expect(factory).not.toHaveBeenCalledWith(active.bindingId)
      await expect(
        store.getById(active.bindingId)
      ).resolves.toMatchObject({
        bindingId: active.bindingId,
        state: 'closed',
        activePromptOperationId: undefined
      })
      await expect(
        store.getByConversation(request.conversationId)
      ).resolves.toMatchObject({
        bindingId: factory.mock.calls[0]![0],
        state: 'ready',
        activePromptOperationId: undefined
      })
      await instance.dispose()
    }
  )

  it('replaces a cancelled outcome-unknown session before an immediate resend', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const first = fakeServer({
      prompt: () => new Promise(() => {}),
      reconcilePromptOperation: async () => ({
        status: 'outcome-unknown',
        processTree: 'unknown'
      })
    })
    const replacementPrompt = vi.fn(
      async () => ({ stopReason: 'end_turn' as const })
    )
    const second = fakeServer({
      newSession: async () => ({ sessionId: 'session-2' }),
      prompt: replacementPrompt
    })
    const servers = [first, second]
    const factory = vi.fn(async () => servers.shift()!.channel)
    const instance = factoryRuntime(factory, store)
    const controller = new AbortController()
    const cancelled = collect(
      instance.run(request, controller.signal, async () => 'once')
    )

    await vi.waitFor(() => {
      expect(first.prepare).toHaveBeenCalledOnce()
    })
    controller.abort(new Error('cancelled'))
    await expect(cancelled).rejects.toThrow('结果未知')

    const resentRequest = {
      ...request,
      requestId: 'f10873fc-c528-48c1-818d-204a75588a48',
      history: [
        { role: 'user' as const, content: 'remember marker' },
        { role: 'assistant' as const, content: 'GB_CANCEL_MARKER' }
      ],
      prompt: 'what was the marker?'
    }
    await expect(
      collect(
        instance.run(
          resentRequest,
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
    expect(first.close).toHaveBeenCalledOnce()
    expect(replacementPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: [
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('GB_CANCEL_MARKER')
          })
        ]
      })
    )
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      acpSessionId: 'session-2',
      state: 'ready',
      activePromptOperationId: undefined
    })
    await instance.dispose()
  })

  it('keeps another conversation running while a cancelled one is resent', async () => {
    const store = new MemoryRuntimeSessionBindingStore()
    const first = fakeServer({
      prompt: () => new Promise(() => {}),
      reconcilePromptOperation: async () => ({
        status: 'outcome-unknown',
        processTree: 'unknown'
      })
    })
    let finishOtherPrompt:
      | ((response: PromptResponse) => void)
      | undefined
    const otherPrompt = vi.fn(
      () =>
        new Promise<PromptResponse>((resolve) => {
          finishOtherPrompt = resolve
        })
    )
    const other = fakeServer({
      newSession: async () => ({ sessionId: 'session-other' }),
      prompt: otherPrompt
    })
    const replacement = fakeServer({
      newSession: async () => ({ sessionId: 'session-replacement' })
    })
    const servers = [first, other, replacement]
    const factory = vi.fn(async () => servers.shift()!.channel)
    const instance = factoryRuntime(factory, store)
    const controller = new AbortController()
    const cancelled = collect(
      instance.run(request, controller.signal, async () => 'once')
    )
    await vi.waitFor(() => {
      expect(first.prepare).toHaveBeenCalledOnce()
    })

    const otherRequest = {
      ...request,
      requestId: '8c7dcf59-ce69-4900-9f50-6312a2a19ca8',
      conversationId: 'conversation-2'
    }
    const otherRun = collect(
      instance.run(
        otherRequest,
        new AbortController().signal,
        async () => 'once'
      )
    )
    await vi.waitFor(() => {
      expect(otherPrompt).toHaveBeenCalledOnce()
    })

    controller.abort(new Error('cancelled'))
    await expect(cancelled).rejects.toThrow('结果未知')
    await expect(
      collect(
        instance.run(
          {
            ...request,
            requestId: 'f10873fc-c528-48c1-818d-204a75588a48'
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

    expect(other.close).not.toHaveBeenCalled()
    finishOtherPrompt?.({ stopReason: 'end_turn' })
    await expect(otherRun).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'done' })
      ])
    )
    await expect(
      store.getByConversation(otherRequest.conversationId)
    ).resolves.toMatchObject({
      acpSessionId: 'session-other',
      state: 'ready'
    })
    expect(factory).toHaveBeenCalledTimes(3)
    await instance.dispose()
  })

  it('injects Desktop history only when creating a new ACP session', async () => {
    const prompt = vi.fn<
      (request: PromptRequest) => Promise<PromptResponse>
    >(
      async () => ({
        stopReason: 'end_turn' as const
      })
    )
    const instance = runtime(fakeServer({ prompt }))
    const history = [
      { role: 'user' as const, content: 'remember marker' },
      { role: 'assistant' as const, content: 'GB_HISTORY_MARKER' }
    ]

    await collect(
      instance.run(
        { ...request, history },
        new AbortController().signal,
        async () => 'once'
      )
    )
    await collect(
      instance.run(
        {
          ...request,
          requestId: 'f10873fc-c528-48c1-818d-204a75588a48',
          prompt: 'continue'
        },
        new AbortController().signal,
        async () => 'once'
      )
    )

    const firstText = prompt.mock.calls[0]![0].prompt[0]
    const secondText = prompt.mock.calls[1]![0].prompt[0]
    expect(firstText).toMatchObject({
      type: 'text',
      text: expect.stringContaining('GB_HISTORY_MARKER')
    })
    expect(secondText).toEqual({ type: 'text', text: 'continue' })
    await instance.dispose()
  })

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
      'checklist',
      'context-metrics',
      'model-usage',
      'done'
    ])
  })

  it('merges incremental OpenCode Task input into native subagent events', async () => {
    const client: { value?: AgentSideConnection } = {}
    const server = fakeServer({
      prompt: async ({ sessionId }) => {
        await client.value!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'task-1',
            title: 'Review application architecture',
            kind: 'other',
            status: 'in_progress',
            rawInput: {}
          }
        })
        await client.value!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'task-1',
            status: 'in_progress',
            rawInput: {
              subagent_type: 'explorer',
              description: 'Review application architecture',
              prompt: 'Inspect the complete source tree.'
            }
          }
        })
        await client.value!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'task-1',
            status: 'in_progress',
            rawInput: {
              subagent_type: 'explorer',
              description: 'Review application architecture',
              prompt: 'Inspect the complete source tree.'
            }
          }
        })
        await client.value!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'task-1',
            status: 'completed',
            rawOutput: 'Architecture review complete.'
          }
        })
        return { stopReason: 'end_turn' }
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
      'tool',
      'subagent',
      'subagent',
      'done'
    ])
    expect(events[2]).toMatchObject({
      expertName: 'explorer',
      routingMode: 'native',
      runtimeCallId: 'task-1',
      state: 'running'
    })
    expect(events[3]).toMatchObject({
      state: 'completed',
      output: 'Architecture review complete.'
    })
  })

  it('keeps ACP content results and bridged child progress in the same card', async () => {
    const client: { value?: AgentSideConnection } = {}
    const input = { subagent_type: 'general', prompt: 'Read seed' }
    const server = fakeServer({
      prompt: async ({ sessionId }) => {
        for (const event of [
          { type: 'message.part.updated', properties: {
            sessionID: sessionId, part: {
              id: 'task', callID: 'task', type: 'tool', tool: 'task',
              state: { status: 'running', input, metadata: { sessionId: 'child' } }
            }
          } },
          { type: 'message.part.delta', properties: {
            sessionID: 'child', partID: 'text', field: 'text', delta: 'Inspecting seed'
          } },
          { type: 'message.part.updated', properties: {
            sessionID: 'child', part: {
              id: 'read', callID: 'read', type: 'tool', tool: 'read',
              state: { status: 'completed', input: { path: 'seed.txt' }, output: 'seed' }
            }
          } }
        ]) {
          await client.value!.sessionUpdate({
            sessionId, update: {
              sessionUpdate: 'tool_call_update', toolCallId: 'task',
              _meta: { goodbuddySubagentEvent: event }
            }
          })
        }
        await client.value!.sessionUpdate({
          sessionId, update: {
            sessionUpdate: 'tool_call', toolCallId: 'task', title: 'Read seed', rawInput: input,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: '**Final seed**' } }]
          }
        })
        return { stopReason: 'end_turn' }
      }
    })
    client.value = server.client
    const events = await collect(runtime(server).run(request, new AbortController().signal))
    const children = events.filter(event => event.type === 'subagent')
    expect(children.at(-1)).toMatchObject({
      state: 'completed', output: '**Final seed**',
      progress: [
        { type: 'text', content: 'Inspecting seed' },
        { type: 'tool', tool: { name: 'read', state: 'completed', output: 'seed' } }
      ]
    })
    expect(events.some(event => event.type === 'text')).toBe(false)
  })

  it('bounds native subagent output per event without a request-wide stop', async () => {
    const client: { value?: AgentSideConnection } = {}
    const server = fakeServer({
      prompt: async ({ sessionId }) => {
        await client.value!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'task-bounded',
            title: 'Bounded task',
            kind: 'other',
            status: 'completed',
            rawInput: {
              subagent_type: 'explorer',
              prompt: 'Inspect the complete source tree.'
            },
            rawOutput: 'x'.repeat(100)
          }
        })
        return { stopReason: 'end_turn' }
      }
    })
    client.value = server.client

    const events = await collect(
      runtime(server, undefined, 5, {
        maxEventCharacters: 10,
        maxRequestOutputBytes: 1_000
      }).run(
        request,
        new AbortController().signal,
        async () => 'once'
      )
    )
    expect(
      events.find((event) => event.type === 'subagent')
    ).toMatchObject({
      state: 'completed',
      output: 'xxxxx…'
    })

    const overBudgetServer = fakeServer({
      prompt: async ({ sessionId }) => {
        await client.value!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'task-over-budget',
            title: 'Over-budget task',
            kind: 'other',
            status: 'completed',
            rawInput: {
              subagent_type: 'explorer',
              prompt: 'Inspect the complete source tree.'
            },
            rawOutput: 'x'.repeat(100)
          }
        })
        return { stopReason: 'end_turn' }
      }
    })
    client.value = overBudgetServer.client
    await expect(
      collect(
        runtime(overBudgetServer, undefined, 5, {
          maxEventCharacters: 1_000,
          maxRequestOutputBytes: 80
        }).run(
          {
            ...request,
            requestId: 'b5b07fa5-f722-4bbc-ad19-33a6435817f1'
          },
          new AbortController().signal,
          async () => 'once'
        )
      )
    ).resolves.toContainEqual(
      expect.objectContaining({ type: 'done' })
    )
  })

  it('accepts more than 100 distinct remote tool calls', async () => {
    const client: { value?: AgentSideConnection } = {}
    const server = fakeServer({
      prompt: async ({ sessionId }) => {
        for (let index = 0; index <= 100; index += 1) {
          await client.value!.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: `call-${index}`,
              title: 'tool',
              status: 'completed'
            }
          })
        }
        return { stopReason: 'end_turn' }
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

    expect(
      events.filter((event) => event.type === 'tool')
    ).toHaveLength(101)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('does not impose a default wall-clock deadline on remote prompts', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const server = fakeServer({
        prompt: async () => {
          await gate
          return { stopReason: 'end_turn' }
        }
      })
      const running = collect(
        runtime(server).run(
          request,
          new AbortController().signal,
          async () => 'once'
        )
      )
      await vi.waitFor(() => expect(server.prepare).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(25 * 60 * 60_000)
      expect(server.escalate).not.toHaveBeenCalled()
      release()
      await expect(running).resolves.toEqual([
        expect.objectContaining({ type: 'status' }),
        expect.objectContaining({ type: 'done' })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes Execute permission through the authorizer and denies mutating Ask permission', async () => {
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
            toolCall: {
              toolCallId: 'tool-2',
              title: 'Write',
              kind: 'edit'
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

  it('allows only one-shot read permission in Ask mode', async () => {
    const client: { value?: AgentSideConnection } = {}
    const outcomes: string[] = []
    const server = fakeServer({
      prompt: async ({ sessionId }) => {
        for (const toolCall of [
          {
            toolCallId: 'tool-read',
            title: 'Read',
            kind: 'read' as const
          },
          {
            toolCallId: 'tool-search',
            title: 'Search',
            kind: 'search' as const
          }
        ]) {
          const response = await client.value!.requestPermission({
            sessionId,
            options: [
              {
                optionId: `${toolCall.toolCallId}-once`,
                name: 'Allow once',
                kind: 'allow_once'
              },
              {
                optionId: `${toolCall.toolCallId}-always`,
                name: 'Allow always',
                kind: 'allow_always'
              },
              {
                optionId: `${toolCall.toolCallId}-reject`,
                name: 'Reject',
                kind: 'reject_once'
              }
            ],
            toolCall
          })
          outcomes.push(
            response.outcome.outcome === 'selected'
              ? response.outcome.optionId
              : 'cancelled'
          )
        }
        const persistentRead =
          await client.value!.requestPermission({
            sessionId,
            options: [
              {
                optionId: 'read-always',
                name: 'Allow always',
                kind: 'allow_always'
              },
              {
                optionId: 'read-reject',
                name: 'Reject',
                kind: 'reject_once'
              }
            ],
            toolCall: {
              toolCallId: 'tool-persistent-read',
              title: 'Read',
              kind: 'read'
            }
          })
        outcomes.push(
          persistentRead.outcome.outcome === 'selected'
            ? persistentRead.outcome.optionId
            : 'cancelled'
        )
        return { stopReason: 'end_turn' }
      }
    })
    client.value = server.client
    const authorize = vi.fn(async () => 'once' as const)

    await collect(
      runtime(server).run(
        { ...request, workMode: 'ask' },
        new AbortController().signal,
        authorize
      )
    )

    expect(authorize).not.toHaveBeenCalled()
    expect(outcomes).toEqual([
      'tool-read-once',
      'tool-search-reject',
      'read-reject'
    ])
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
    const prompt = vi.fn<
      (request: PromptRequest) => Promise<PromptResponse>
    >(
      async () => ({
        stopReason: 'end_turn' as const
      })
    )
    const second = fakeServer({ loadSession, prompt })
    await collect(
      runtime(second, store).run(
        {
          ...request,
          requestId: 'f10873fc-c528-48c1-818d-204a75588a48',
          history: [
            {
              role: 'assistant',
              content: 'GB_RESUMED_HISTORY_MARKER'
            }
          ],
          prompt: 'continue'
        },
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
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: [{ type: 'text', text: 'continue' }]
      })
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
      operationTimeoutMs: 20,
      promptTimeoutMs: 20
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

  it('backpressures a flood without cancelling the Runtime', async () => {
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
    expect(server.setInboundPaused).toHaveBeenCalledWith(true)
    expect(server.setInboundPaused).not.toHaveBeenCalledWith(false)
    const events = []
    const firstUpdate = await stream.next()
    expect(firstUpdate).toMatchObject({
      value: { type: 'text' },
      done: false
    })
    if (firstUpdate.done) {
      throw new Error('Expected the first queued Runtime update')
    }
    events.push(firstUpdate.value)
    expect(server.setInboundPaused).not.toHaveBeenCalledWith(false)
    while (true) {
      const next = await stream.next()
      if (next.done) {
        break
      }
      events.push(next.value)
    }
    expect(
      events.filter((event) => event.type === 'text')
    ).toHaveLength(20)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(server.setInboundPaused).toHaveBeenCalledWith(true)
    expect(server.setInboundPaused).toHaveBeenCalledWith(false)
    expect(cancel).not.toHaveBeenCalled()
    await expect(
      store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      state: 'ready',
      activePromptOperationId: undefined
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

describe('AcpRemoteRuntime Agent-owned prompts', () => {
  const ownedModelProfile = {
    profileId: 'profile-owned-1',
    modelProfileDigest: `sha256:${'e'.repeat(64)}`,
    provider: 'openai' as const,
    baseUrl: 'https://provider.example/v1',
    model: 'owned-model',
    protocol: 'openai-responses' as const,
    authentication: 'api-key' as const,
    apiKey: 'agent-prompt-secret',
    capabilities: { imageInput: false },
    limits: {
      maximumOutputTokens: 4_096,
      requestTimeoutMilliseconds: 60_000
    }
  }

  function ownedChannel(options?: {
    runtimeId?: 'opencode' | 'continue'
    bindingStore?: RuntimeSessionBindingStore
    updates?: SessionUpdate[]
    state?: 'completed' | 'failed' | 'cancelled' | 'outcome-unknown'
    terminalPayload?: unknown
    includePermissionCheckpoint?: boolean
    partialRecoveredTool?: boolean
    waitForCancellation?: boolean
    escalateCancellation?: () => Promise<void>
  }) {
    const terminalState = options?.state ?? 'completed'
    const startOwnedPrompt = vi.fn(async (input: {
      bindingId: string
      operationId: string
      requestId: string
    }) => ({
      bindingId: input.bindingId,
      operationId: input.operationId,
      requestId: input.requestId,
      sessionId: 'owned-session',
      state: 'running' as const,
      latestSemanticSequence: '0'
    }))
    const attachOwnedPrompt = vi.fn(async (input: {
      bindingId: string
      operationId: string
      requestId: string
    }) => ({
      ...input,
      sessionId: 'owned-session',
      state: 'running' as const,
      latestSemanticSequence: '0'
    }))
    const defaultEvents = [
      {
        sequence: '1',
        kind: 'session-update' as const,
        payload: {
          sessionId: 'owned-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'first model round' }
          }
        },
        createdAt: 1
      },
      ...(options?.includePermissionCheckpoint
        ? [
            {
              sequence: '2',
              kind: 'permission-decision' as const,
              payload: {
                sessionId: 'owned-session',
                toolCallId: 'approval-1',
                outcome: { outcome: 'cancelled' }
              },
              createdAt: 2
            }
          ]
        : []),
      {
        sequence: options?.includePermissionCheckpoint ? '3' : '2',
        kind: 'session-update' as const,
        payload: {
          sessionId: 'owned-session',
          update: {
            sessionUpdate: options?.partialRecoveredTool
              ? 'tool_call_update'
              : 'tool_call',
            toolCallId: 'tool-1',
            ...(options?.partialRecoveredTool
              ? {}
              : { title: 'Read' }),
            status: 'completed',
            ...(options?.partialRecoveredTool
              ? {}
              : { rawOutput: { result: 'one' } })
          }
        },
        createdAt: 3
      },
      {
        sequence: options?.includePermissionCheckpoint ? '4' : '3',
        kind: 'session-update' as const,
        payload: {
          sessionId: 'owned-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-2',
            title: 'Write',
            status: 'completed',
            rawOutput: { result: 'two' }
          }
        },
        createdAt: 4
      },
      {
        sequence: options?.includePermissionCheckpoint ? '5' : '4',
        kind: 'prompt-terminal' as const,
        payload:
          options?.terminalPayload ??
          (terminalState === 'completed'
            ? {
                status: 'completed',
                response: {
                  stopReason: 'end_turn',
                  usage: {
                    inputTokens: 10,
                    outputTokens: 20,
                    totalTokens: 30
                  }
                }
              }
            : terminalState === 'failed'
              ? {
                  status: 'failed',
                  error: { name: 'Error', message: 'owned failure' }
                }
              : { status: terminalState }),
        createdAt: 5
      }
    ]
    const events = options?.updates ? [
      ...options.updates.map((update, index) => ({
        sequence: String(index + 1), kind: 'session-update' as const,
        payload: { sessionId: 'owned-session', update }, createdAt: index + 1
      })),
      { ...defaultEvents.at(-1)!, sequence: String(options.updates.length + 1) }
    ] : defaultEvents
    const pageOwnedPromptTranscript = vi.fn(async ({
      bindingId,
      operationId,
      afterSequence
    }: {
      bindingId: string
      operationId: string
      afterSequence: string
    }) => {
      if (options?.waitForCancellation === true) {
        return await new Promise<never>(() => undefined)
      }
      return {
        bindingId,
        operationId,
        events: events.filter(
          (event) => BigInt(event.sequence) > BigInt(afterSequence)
        ),
        latestSequence: events.at(-1)!.sequence,
        acknowledgedSequence: '0',
        state: terminalState,
        sessionId: 'owned-session',
        hasMore: false
      }
    })
    const ackOwnedPromptTranscript = vi.fn(async ({
      bindingId,
      operationId,
      acknowledgedSequence
    }: {
      bindingId: string
      operationId: string
      acknowledgedSequence: string
    }) => ({
      bindingId,
      operationId,
      acknowledgedSequence
    }))
    const preparePrompt = vi.fn(async (
      preparation: RemotePromptOperationPreparation
    ) => acceptPrompt(preparation))
    const channel: RemoteRuntimeChannel = {
      input: new ReadableStream<Uint8Array>(),
      output: new WritableStream<Uint8Array>(),
      generation: 1,
      channelEpoch: '1',
      advertisedAcpCapabilitiesDigest: `sha256:${'f'.repeat(64)}`,
      capabilities: {
        cancellationEscalation: true,
        promptOperationReconciliation: true,
        ownedPrompt: true,
        modelBridge: false
      },
      closed: new Promise(() => {}),
      isCurrentGeneration: () => true,
      getBindingCursors: async () => ({
        lastOutboundJournaledSequence: '0',
        lastOutboundDeliveredSequence: '0',
        lastInboundJournaledSequence: '0',
        lastMainAckSequence: '0'
      }),
      preparePrompt,
      startOwnedPrompt,
      attachOwnedPrompt,
      pageOwnedPromptTranscript:
        pageOwnedPromptTranscript as unknown as NonNullable<
          RemoteRuntimeChannel['pageOwnedPromptTranscript']
        >,
      ackOwnedPromptTranscript,
      completePromptOperation: vi.fn(async (value) => ({
        ...value,
        status: 'completed' as const,
        processTree: 'empty' as const
      })),
      setInboundPaused: vi.fn(async () => {}),
      escalateCancellation: vi.fn(
        options?.escalateCancellation ?? (async () => {})
      ),
      reconcilePromptOperation: vi.fn(async () => ({
        status: 'terminal' as const,
        terminalState: 'completed' as const,
        processTree: 'empty' as const
      })),
      close: vi.fn(async () => {})
    }
    const store = options?.bindingStore ?? new MemoryRuntimeSessionBindingStore()
    const instance = factoryRuntime(
      async () => channel,
      store,
      {
        runtimeId: options?.runtimeId ?? 'opencode',
        modelBridgePolicy,
        modelProfile: ownedModelProfile
      }
    )
    return {
      instance,
      store,
      channel,
      preparePrompt,
      startOwnedPrompt,
      attachOwnedPrompt,
      pageOwnedPromptTranscript,
      ackOwnedPromptTranscript,
      escalateCancellation: channel.escalateCancellation
    }
  }

  it.each(['continue', 'opencode'] as const)('continues %s after reopening the desktop binding database', async (runtimeId) => {
    const directory = mkdtempSync(join(tmpdir(), 'remote-runtime-restart-'))
    const databasePath = join(directory, 'bindings.sqlite')
    let store = new SqliteRuntimeSessionBindingStore(databasePath)
    const first = ownedChannel({ runtimeId, bindingStore: store })
    let replacement: AcpRemoteRuntime | undefined
    try {
      await collect(first.instance.run(request, new AbortController().signal))
      const original = (await store.getByConversation(request.conversationId))!
      await first.instance.dispose()
      store.close()
      store = new SqliteRuntimeSessionBindingStore(databasePath)
      const next = ownedChannel({ runtimeId, bindingStore: store })
      replacement = next.instance
      if (runtimeId === 'continue') {
        next.startOwnedPrompt.mockImplementationOnce(async input => {
          if ('acpSessionId' in input) throw new Error('Continue Session is unavailable')
          return { bindingId: input.bindingId, operationId: input.operationId, requestId: input.requestId,
            sessionId: 'owned-session', state: 'running', latestSemanticSequence: '0' }
        })
      }
      const history = [{ role: 'user' as const, content: 'previous question' },
        { role: 'assistant' as const, content: 'previous answer' }]
      const events = await collect(replacement.run({ ...request, requestId: 'second', history }, new AbortController().signal))
      expect(events.some(event => event.type === 'done')).toBe(true)
      const resumed = (await store.getByConversation(request.conversationId))!
      const start = next.startOwnedPrompt.mock.calls[0]![0]
      if (runtimeId === 'continue') {
        expect(resumed.bindingId).not.toBe(original.bindingId)
        expect(await store.getById(original.bindingId)).toMatchObject({ state: 'closed' })
        expect(start).not.toHaveProperty('acpSessionId')
        expect(JSON.stringify(start)).toContain('previous answer')
        expect(resumed.promptSequence).toBe(0)
      } else {
        expect(resumed.bindingId).toBe(original.bindingId)
        expect(start).toHaveProperty('acpSessionId', original.acpSessionId)
        expect(resumed.promptSequence).toBe(1)
      }
      await collect(replacement.run({ ...request, requestId: 'third', history }, new AbortController().signal))
      if (runtimeId === 'continue') {
        expect(await store.getByConversation(request.conversationId)).toMatchObject({ state: 'ready', promptSequence: 0 })
        expect(next.startOwnedPrompt.mock.calls[1]![0]).not.toHaveProperty('acpSessionId')
        expect(JSON.stringify(next.startOwnedPrompt.mock.calls[1]![0])).toContain('previous answer')
      } else {
        expect(await store.getByConversation(request.conversationId)).toMatchObject({
          bindingId: resumed.bindingId, state: 'ready', promptSequence: resumed.promptSequence + 1
        })
        expect(next.startOwnedPrompt.mock.calls[1]![0]).toHaveProperty('acpSessionId', resumed.acpSessionId)
      }
      expect(next.startOwnedPrompt).toHaveBeenCalledTimes(2)
      expect(next.attachOwnedPrompt).not.toHaveBeenCalled()
    } finally {
      await replacement?.dispose()
      await first.instance.dispose()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([true, false])('attaches a cached request after start rejection without advancing its prompt sequence (available: %s)', async available => {
    const fixture = ownedChannel({ runtimeId: 'continue' })
    fixture.startOwnedPrompt.mockRejectedValueOnce(new Error('Remote Runtime runtime/startPrompt rejected RPC -32602'))
    try {
      await expect(collect(fixture.instance.run(request, new AbortController().signal))).rejects.toThrow('runtime/startPrompt')
      const pending = (await fixture.store.getByConversation(request.conversationId))!
      fixture.attachOwnedPrompt.mockImplementationOnce(async input => {
        expect(fixture.channel.close).not.toHaveBeenCalled()
        if (!available) throw Object.assign(new Error('Remote Runtime runtime/attachPrompt rejected RPC -32602'), {
          remoteRequestOutcome: 'rejected', remoteMethod: 'runtime/attachPrompt'
        })
        return { ...input, sessionId: 'owned-session', state: 'running', latestSemanticSequence: '0' }
      })
      const recovery = collect(fixture.instance.run({ ...request, remoteRecoveryOnly: true }, new AbortController().signal))
      if (available) {
        expect((await recovery).some(event => event.type === 'done')).toBe(true)
      } else {
        await expect(recovery).rejects.toBeInstanceOf(RemotePromptRecoveryUnavailableError)
      }
      expect(await fixture.store.getByConversation(request.conversationId)).toMatchObject({
        bindingId: pending.bindingId, state: available ? 'ready' : 'prompt-running', promptSequence: pending.promptSequence
      })
      expect(fixture.preparePrompt).toHaveBeenCalledOnce()
      expect(fixture.startOwnedPrompt).toHaveBeenCalledOnce()
      expect(fixture.attachOwnedPrompt).toHaveBeenCalledOnce()
    } finally {
      await fixture.instance.dispose()
    }
  })

  it('replays complete native checklists and clears with stable provenance without starting another prompt', async () => {
    const items = [{ content: 'full content '.repeat(500).trim(), status: 'cancelled', priority: 'low' }]
    const native = (todos: unknown, sessionID = 'owned-session'): SessionUpdate => ({
      sessionUpdate: 'tool_call_update', toolCallId: 'goodbuddy-native-todos',
      _meta: { goodbuddyTodoEvent: { type: 'todo.updated', properties: { sessionID, todos } } }
    })
    const fixture = ownedChannel({ updates: [
      native(items), native([], 'child-session'), native([{ content: 'bad', status: 'failed' }]),
      { sessionUpdate: 'tool_call', toolCallId: 'todo-tool', title: 'todowrite', status: 'completed', rawInput: { todos: [] } },
      native([])
    ] })
    const first: RuntimeEvent[] = []
    for await (const event of fixture.instance.run(request, new AbortController().signal)) {
      first.push(event)
      if (event.type === 'done') break
    }
    const replacement = factoryRuntime(async () => fixture.channel, fixture.store, { modelBridgePolicy, modelProfile: ownedModelProfile })
    try {
      const replay = await collect(replacement.run({ ...request, remoteRecoveryOnly: true, remoteSemanticAfterSequence: '0' }, new AbortController().signal))
      const checklists = first.filter(event => event.type === 'checklist')
      expect(checklists).toHaveLength(2)
      expect(checklists[0]).toMatchObject({ requestId: request.requestId, checklist: { source: 'opencode', items } })
      expect(checklists[1]).toMatchObject({ checklist: { source: 'opencode', items: [] } })
      expect(replay.filter(event => event.type === 'checklist')).toEqual(checklists)
      expect(first.filter(event => event.type === 'tool')).toHaveLength(1)
      expect(fixture.startOwnedPrompt).toHaveBeenCalledTimes(1)
      expect(fixture.attachOwnedPrompt).toHaveBeenCalledTimes(1)
    } finally { await replacement.dispose(); await fixture.instance.dispose() }
  })

  it('replays complete Continue checklists and ignores wrong-source and malformed updates', async () => {
    const items = [{ content: 'complete checklist content '.repeat(300).trim(), status: 'pending' }]
    const native = (checklist: unknown): SessionUpdate => ({
      sessionUpdate: 'tool_call_update', toolCallId: 'goodbuddy-native-checklist',
      _meta: { goodbuddyChecklist: checklist as never }
    })
    const fixture = ownedChannel({ runtimeId: 'continue', updates: [
      native({ source: 'continue', items }), native({ source: 'opencode', items: [] }),
      native({ source: 'continue', items: [{ content: 'bad', status: 'failed' }] }),
      { sessionUpdate: 'tool_call', toolCallId: 'native-tool', title: 'Checklist', status: 'completed', rawInput: { checklist: '' } },
      native({ source: 'continue', items: [] })
    ] })
    const first: RuntimeEvent[] = []
    for await (const event of fixture.instance.run(request, new AbortController().signal)) {
      first.push(event)
      if (event.type === 'done') break
    }
    const replacement = factoryRuntime(async () => fixture.channel, fixture.store, {
      runtimeId: 'continue', modelBridgePolicy, modelProfile: ownedModelProfile
    })
    try {
      const replay = await collect(replacement.run({ ...request, remoteRecoveryOnly: true, remoteSemanticAfterSequence: '0' }, new AbortController().signal))
      const checklists = first.filter(event => event.type === 'checklist')
      expect(checklists).toHaveLength(2)
      expect(checklists[0]).toMatchObject({ checklist: { source: 'continue', items } })
      expect(checklists[1]).toMatchObject({ checklist: { source: 'continue', items: [] } })
      expect(replay.filter(event => event.type === 'checklist')).toEqual(checklists)
      expect(first.filter(event => event.type === 'tool')).toHaveLength(1)
      expect(fixture.startOwnedPrompt).toHaveBeenCalledOnce()
    } finally { await replacement.dispose(); await fixture.instance.dispose() }
  })

  it('keeps unconfirmed plan variants as activity, not checklist replacement', async () => {
    const fixture = ownedChannel({ updates: [
      { sessionUpdate: 'plan', entries: [] },
      { sessionUpdate: 'plan', entries: [null] } as unknown as SessionUpdate,
      { sessionUpdate: 'plan', entries: [{ content: 'bad', status: 'failed', priority: 'high' }] } as unknown as SessionUpdate,
      { sessionUpdate: 'plan_removed', id: 'plan' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '- [x] not a native checklist' } }
    ] })
    const events = await collect(fixture.instance.run(request, new AbortController().signal))
    expect(events.filter(event => event.type === 'checklist')).toEqual([
      expect.objectContaining({ checklist: { source: 'opencode', items: [] } })
    ])
    await fixture.instance.dispose()
  })

  it('starts once, maps multiple rounds, and ACKs only after consumption', async () => {
    const fixture = ownedChannel({
      includePermissionCheckpoint: true
    })
    const stream = fixture.instance.run(
      request,
      new AbortController().signal
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    const first = await stream.next()
    expect(first.value).toMatchObject({
      type: 'text',
      delta: 'first model round',
      remoteProvenance: {
        semanticSequence: '1',
        eventIndex: 0
      }
    })
    expect(fixture.ackOwnedPromptTranscript).not.toHaveBeenCalled()

    const checkpoint = await stream.next()
    expect(checkpoint.value).toMatchObject({
      type: 'remote-semantic-checkpoint',
      remoteProvenance: { semanticSequence: '1', eventIndex: 1 }
    })
    expect(fixture.ackOwnedPromptTranscript).not.toHaveBeenCalled()

    const rest = await collect(stream)
    expect(rest.filter((event) => event.type === 'tool')).toHaveLength(2)
    expect(rest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'model-usage' }),
        expect.objectContaining({
          type: 'done',
          sessionId: 'owned-session'
        })
      ])
    )
    expect(fixture.startOwnedPrompt).toHaveBeenCalledOnce()
    expect(fixture.attachOwnedPrompt).not.toHaveBeenCalled()
    expect(fixture.ackOwnedPromptTranscript.mock.calls.map(
      ([input]) => input.acknowledgedSequence
    )).toEqual(['5'])
    expect(fixture.preparePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        promptSequence: 0,
        modelProfile: expect.objectContaining({
          apiKey: 'agent-prompt-secret'
        })
      })
    )
    expect(
      fixture.preparePrompt.mock.calls[0]![0]
    ).not.toHaveProperty('modelBridge')
  })

  it('restores live questions after transcript ACK, scopes replies and ignores answered history', async () => {
    const fixture = ownedChannel()
    const reply = vi.fn<NonNullable<RemoteRuntimeChannel['respondToQuestion']>>()
      .mockRejectedValueOnce(new Error('temporary response failure'))
      .mockResolvedValue(undefined)
    fixture.channel.respondToQuestion = reply
    let answered = false
    let pages = 0
    const question = { sessionId: 'owned-session', update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'native-question', _meta: {
        goodbuddyQuestion: { question: { id: 'native-question', sessionID: 'owned-session',
          questions: [{ header: 'Input', question: 'Which?', options: [] }] } }
      }
    } }
    fixture.channel.pageOwnedPromptTranscript = async ({ bindingId, operationId }) => ({
      bindingId, operationId, state: answered ? 'completed' : 'running', sessionId: 'owned-session',
      latestSequence: answered ? '2' : '1', acknowledgedSequence: '1', hasMore: false,
      pendingQuestions: answered ? [] : [question],
      events: answered ? [
        { sequence: '1', kind: 'session-update', payload: question, createdAt: 1 },
        { sequence: '2', kind: 'prompt-terminal', payload: { status: 'completed', response: { stopReason: 'end_turn' } }, createdAt: 2 }
      ] : (++pages === 1 ? [] : [{ sequence: '1', kind: 'session-update', payload: question, createdAt: 1 }])
    })
    let id: string | undefined
    for await (const event of fixture.instance.run(request, new AbortController().signal)) {
      if (event.type !== 'question') continue
      expect(id).toBeUndefined()
      id = event.questionId
      expect(id).not.toBe('native-question')
      expect(event.questions[0]).toMatchObject({ custom: true, multiple: false })
      await expect(fixture.instance.respondToQuestion(id, [['A']])).rejects.toThrow('temporary response failure')
      await fixture.instance.respondToQuestion(id, [['A']])
      answered = true
    }
    expect(id).toBeDefined()
    expect(reply).toHaveBeenLastCalledWith({ bindingId: expect.any(String), operationId: request.requestId,
      questionId: 'native-question', answers: [['A']] })
    await expect(fixture.instance.respondToQuestion(id!, [['late']])).rejects.toThrow('no longer pending')
    expect(reply).toHaveBeenCalledTimes(2)
    await fixture.instance.dispose()
  })

  it('drops reply mappings when the Agent resolves a question while the prompt remains active', async () => {
    const fixture = ownedChannel()
    const reply = vi.fn(async () => undefined)
    fixture.channel.respondToQuestion = reply
    let pages = 0
    let answered = false
    fixture.channel.pageOwnedPromptTranscript = async ({ bindingId, operationId }) => ({
      bindingId, operationId, state: answered ? 'completed' : 'running', sessionId: 'owned-session',
      latestSequence: answered ? '1' : '0', acknowledgedSequence: '0', hasMore: false,
      pendingQuestions: answered ? [] : [{ sessionId: 'owned-session', update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'question', _meta: { goodbuddyQuestion: {
          question: { id: ++pages === 1 ? 'first' : 'second', sessionID: 'owned-session',
            questions: [{ header: 'Input', question: 'Which?', options: [] }] }
        } }
      } }],
      events: answered ? [{ sequence: '1', kind: 'prompt-terminal', createdAt: 1,
        payload: { status: 'completed', response: { stopReason: 'end_turn' } } }] : []
    })
    let previous: string | undefined
    const resolved: string[] = []
    for await (const event of fixture.instance.run(request, new AbortController().signal)) {
      if (event.type === 'question-resolved') resolved.push(event.questionId)
      if (event.type !== 'question') continue
      if (!previous) { previous = event.questionId; continue }
      await expect(fixture.instance.respondToQuestion(previous, [['stale']])).rejects.toThrow('no longer pending')
      expect(reply).not.toHaveBeenCalled()
      await fixture.instance.respondToQuestion(event.questionId)
      answered = true
    }
    expect(reply).toHaveBeenCalledOnce()
    expect(resolved).toEqual([previous])
    await fixture.instance.dispose()
  })

  it('freshly attaches an accepted prompt without resending it', async () => {
    const fixture = ownedChannel()
    const first = fixture.instance.run(
      request,
      new AbortController().signal
    )
    await first.next()
    await first.return()

    const attached = factoryRuntime(
      async () => fixture.channel,
      fixture.store,
      {
        modelBridgePolicy,
        modelProfile: ownedModelProfile
      }
    )
    const events = await collect(
      attached.run(request, new AbortController().signal)
    )

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'done' })
      ])
    )
    expect(fixture.startOwnedPrompt).toHaveBeenCalledOnce()
    expect(fixture.attachOwnedPrompt).toHaveBeenCalledOnce()
    expect(fixture.preparePrompt).toHaveBeenCalledOnce()
  })

  it('uses the recovered generation for retained and new Sessions and mode changes', async () => {
    const fixture = ownedChannel()
    const fresh = ownedChannel()
    try {
      await collect(fixture.instance.run(
        { ...request, workMode: 'ask' }, new AbortController().signal
      ))
      Object.defineProperty(fixture.channel, 'generation', { value: 2 })
      await collect(fixture.instance.run(
        { ...request, requestId: 'after-reconnect', workMode: 'execute' },
        new AbortController().signal
      ))
      Object.defineProperty(fresh.channel, 'generation', { value: 2 })
      await collect(fresh.instance.run(
        { ...request, requestId: 'new-after-reconnect', conversationId: 'another-conversation' },
        new AbortController().signal
      ))
      expect([
        ...fixture.preparePrompt.mock.calls.slice(1),
        ...fresh.preparePrompt.mock.calls
      ].map(([prepared]) => ({
        controllerGeneration: prepared.controllerGeneration,
        connectionGeneration: prepared.connectionGeneration
      }))).toEqual([
        { controllerGeneration: 2, connectionGeneration: 2 },
        { controllerGeneration: 2, connectionGeneration: 2 }
      ])
      expect(fixture.startOwnedPrompt).toHaveBeenNthCalledWith(
        2, expect.objectContaining({ acpSessionId: 'owned-session' })
      )
      expect(fixture.attachOwnedPrompt).not.toHaveBeenCalled()
    } finally {
      await Promise.all([fixture.instance.dispose(), fresh.instance.dispose()])
    }
  })

  it('does not abandon an accepted Agent prompt for a later request', async () => {
    const fixture = ownedChannel({ waitForCancellation: true })
    const first = fixture.instance.run(
      request,
      new AbortController().signal
    )
    await first.next()
    await first.return()

    const restarted = factoryRuntime(
      async () => fixture.channel,
      fixture.store,
      {
        modelBridgePolicy,
        modelProfile: ownedModelProfile
      }
    )
    await expect(
      collect(
        restarted.run(
          {
            ...request,
            requestId:
              '1c608898-ecb7-4081-8174-2b6a52f53c02'
          },
          new AbortController().signal
        )
      )
    ).rejects.toThrow(/必须先恢复或取消原请求/u)
    expect(fixture.startOwnedPrompt).toHaveBeenCalledOnce()
    expect(fixture.preparePrompt).toHaveBeenCalledOnce()
    await restarted.dispose()
  })

  it('replaces an unrecoverable prompt binding after Agent identity changes', async () => {
    const fixture = ownedChannel({ waitForCancellation: true })
    const first = fixture.instance.run(
      request,
      new AbortController().signal
    )
    await first.next()
    await first.return()
    const stale = await fixture.store.getByConversation(
      request.conversationId
    )
    const fresh = ownedChannel()
    const replacement = factoryRuntime(
      async () => fresh.channel,
      fixture.store,
      {
        identity: {
          ...identity,
          agentInstallationId: 'installation-2'
        },
        modelBridgePolicy,
        modelProfile: ownedModelProfile
      }
    )

    await expect(
      collect(
        replacement.run(
          {
            ...request,
            requestId:
              '1c608898-ecb7-4081-8174-2b6a52f53c03'
          },
          new AbortController().signal
        )
      )
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'done' })
      ])
    )
    await expect(
      fixture.store.getById(stale!.bindingId)
    ).resolves.toMatchObject({ state: 'closed' })
    await Promise.all([
      replacement.dispose(),
      fresh.instance.dispose()
    ])
  })

  it('merges partial recovery tool updates with durable tool identity', async () => {
    const fixture = ownedChannel({ partialRecoveredTool: true })
    const events = await collect(
      fixture.instance.run(
        {
          ...request,
          remoteRecoveredTools: [
            {
              callId: 'tool-1',
              name: 'Original Read',
              state: 'running',
              summary: 'Read the original file',
              input: '{"path":"/workspace/file.txt"}'
            }
          ]
        },
        new AbortController().signal
      )
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        callId: 'tool-1',
        name: 'Original Read',
        state: 'completed',
        input: '{"path":"/workspace/file.txt"}'
      })
    )
  })

  const failedRead: SessionUpdate = {
    sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read',
    status: 'failed', rawInput: { filePath: '/missing' },
    content: [{ type: 'content', content: { type: 'text', text: 'File not found' } }]
  }
  const responseText: SessionUpdate = {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Handled the missing file.' }
  }

  describe.each(['owned', 'direct'] as const)('%s tool failure recovery', (path) => {
    it.each([
      { name: 'response after failure', updates: [failedRead, responseText], recovered: true },
      { name: 'no response', updates: [failedRead], recovered: false },
      { name: 'response before failure', updates: [responseText, failedRead], recovered: false },
      { name: 'reasoning only', updates: [failedRead, { ...responseText, sessionUpdate: 'agent_thought_chunk' }], recovered: false },
      { name: 'whitespace only', updates: [failedRead, { ...responseText, content: { type: 'text', text: ' \n\t' } }], recovered: false },
      { name: 'another failure after response', updates: [failedRead, responseText, { ...failedRead, toolCallId: 'read-2' }], recovered: false },
      { name: 'unfinished tool', updates: [failedRead, responseText, { ...failedRead, toolCallId: 'read-2', status: 'in_progress' }], recovered: false },
      { name: 'native subagent failure', updates: [{ ...failedRead, rawInput: { subagent_type: 'explorer', prompt: 'Read a file' } }, responseText], recovered: false }
    ] satisfies Array<{ name: string; updates: SessionUpdate[]; recovered: boolean }>)('$name', async ({ updates, recovered }) => {
      const fixture = path === 'owned' ? ownedChannel({ updates }) : undefined
      const server = fixture ? undefined : fakeServer({
        prompt: async ({ sessionId }) => {
          for (const update of updates) await server!.client.sessionUpdate({ sessionId, update })
          return { stopReason: 'end_turn' }
        }
      })
      const instance = fixture?.instance ?? runtime(server!)
      try {
        const events = await collect(instance.run(request, new AbortController().signal))
        const recovery = events.filter(event => event.type === 'tool' && event.state === 'recoverable')
        expect(recovery).toHaveLength(recovered ? 1 : 0)
        if (recovered) expect(recovery[0]).toMatchObject({
          callId: 'read-1', name: 'Read', input: '{"filePath":"/missing"}', output: '"File not found"'
        })
        expect(events.some(event => event.type === 'done')).toBe(true)
      } finally {
        await instance.dispose()
      }
    })

    it.each(['failed', 'cancelled', 'outcome-unknown'] as const)('does not recover a %s prompt', async (state) => {
      const updates = [failedRead, responseText]
      const fixture = path === 'owned' ? ownedChannel({ updates, state }) : undefined
      const server = fixture ? undefined : fakeServer({
        prompt: async ({ sessionId }) => {
          for (const update of updates) await server!.client.sessionUpdate({ sessionId, update })
          if (state === 'cancelled') return { stopReason: 'cancelled' }
          throw new Error(state)
        }
      })
      const instance = fixture?.instance ?? runtime(server!)
      const events: RuntimeEvent[] = []
      try {
        await expect((async () => {
          for await (const event of instance.run(request, new AbortController().signal)) events.push(event)
        })()).rejects.toThrow()
        expect(events.some(event => event.type === 'tool' && event.state === 'recoverable')).toBe(false)
        expect(events.some(event => event.type === 'done')).toBe(false)
      } finally {
        await instance.dispose()
      }
    })
  })

  it.each(['failed', 'cancelled', 'interrupted', 'running'] as const)('does not promote an ineligible recovered %s tool', async (state) => {
    const fixture = ownedChannel({ updates: [] })
    try {
      const events = await collect(fixture.instance.run({
        ...request, remoteRecoveredTools: [{ callId: 'read', name: 'Read', state, summary: 'Read' }],
        remoteHasResponseTextAfterToolFailure: state !== 'failed'
      }, new AbortController().signal))
      expect(events.some(event => event.type === 'tool')).toBe(false)
    } finally {
      await fixture.instance.dispose()
    }
  })

  it.each(['recoverable', 'done', 'unfinished-tool', 'unfinished-subagent'] as const)(
    'replays a partial %s terminal after real message reduction without provenance conflicts', async (cut) => {
    const failedTerminal = cut.startsWith('unfinished-')
    const fixture = ownedChannel({
      terminalPayload: { status: 'completed', response: { stopReason: 'end_turn' } },
      updates: failedTerminal ? [failedRead, responseText, {
        ...failedRead, toolCallId: 'running-call', status: 'in_progress',
        ...(cut === 'unfinished-subagent'
          ? { rawInput: { subagent_type: 'explorer', prompt: 'Read a file' } } : {})
      }] : [
        { ...failedRead, toolCallId: 'z-read' },
        { ...failedRead, toolCallId: 'a-read' }, responseText
      ]
    })
    const database = new AssistantDatabase(':memory:')
    database.initialize('C:\\Workspace')
    const project = database.createSshProject({
      project: { name: 'Recovery', description: '', rootPath: '/srv/project', defaultWorkMode: 'execute', runtimeSelection: { provider: 'opencode' } },
      executionSpace: { kind: 'ssh', hostId: '00000000-0000-4000-8000-000000000850', remoteRootPath: '/srv/project' },
      assertCurrent: () => {}
    })
    const assistantMessageId = '00000000-0000-4000-8000-000000000851'
    const conversationId = '00000000-0000-4000-8000-000000000853'
    database.saveLocalConversations([{
      header: { id: conversationId, projectId: project.id, title: 'Recovery', updatedAt: 0 }, messages: []
    }])
    database.createTask({
      id: request.requestId, projectId: project.id, conversationId,
      title: 'Recovery', instructions: 'Read', workMode: 'execute',
      remoteRecovery: { recoverable: true, currentUserMessageId: '00000000-0000-4000-8000-000000000852', currentAssistantMessageId: assistantMessageId }
    })
    const persist = (event: RuntimeEvent & { remoteProvenance?: RemoteSemanticEventProvenance }) => {
      if (!event.remoteProvenance) return undefined
      if (event.type === 'model-usage' || event.type === 'generated-image') throw new Error('Unexpected fixture event')
      const { remoteProvenance, ...publicEvent } = event
      // IPC rejects done while the original failed Read is still unsuccessful.
      const payload = failedTerminal && publicEvent.type === 'done' ? {
        requestId: request.requestId, type: 'error' as const, status: 'failed' as const,
        message: 'Read 工具执行失败'
      } : publicEvent
      return database.appendRemoteConversationTaskEventOnce({
        taskId: request.requestId, conversationId, assistantMessageId,
        ...remoteProvenance, event: payload
      })
    }
    const stream = fixture.instance.run({ ...request, conversationId }, new AbortController().signal)
    let partial: RuntimeEvent | undefined
    for (;;) {
      const next = await stream.next()
      if (next.done) throw new Error('Expected partial terminal')
      persist(next.value)
      if (cut === 'recoverable'
        ? next.value.type === 'tool' && next.value.state === 'recoverable'
        : next.value.type === 'done') {
        partial = next.value
        break
      }
    }
    await stream.return()
    const replacement = factoryRuntime(async () => fixture.channel, fixture.store, {
      modelBridgePolicy, modelProfile: ownedModelProfile
    })
    try {
      const cursor = database.getHighestCommittedRemoteTaskEventSequenceForTask(request.requestId)
      expect(cursor).toBe('3')
      expect(database.getTask(request.requestId).status).toBe('running')
      expect(database.hasRemoteResponseTextAfterToolFailure(request.requestId)).toBe(true)
      const message = database.getConversation(conversationId).messages[1]!
      const states = database.getRemoteTaskActivityStates(request.requestId)
      if (cut === 'unfinished-tool') {
        expect(message.tools?.map(tool => tool.state)).toEqual(['failed', 'failed'])
        expect(states.tools.get('running-call')).toBe('running')
      } else if (cut === 'unfinished-subagent') {
        expect(message.subagents?.[0]).toMatchObject({ state: 'failed', error: 'Read 工具执行失败' })
        expect(states.subagents.get(message.subagents![0]!.childTaskId)).toEqual({ state: 'running', error: undefined })
      }
      const recovered = await collect(replacement.run({
        ...request, conversationId, remoteRecoveryOnly: true, remoteSemanticAfterSequence: cursor,
        remoteHasResponseTextAfterToolFailure: database.hasRemoteResponseTextAfterToolFailure(request.requestId),
        remoteRecoveredTools: [...(message.tools ?? [])].reverse().map(tool => ({
          ...tool, callId: tool.callId!, state: states.tools.get(tool.callId!) ?? tool.state
        })),
        remoteRecoveredSubagents: message.subagents?.map(subagent => ({
          ...subagent, ...states.subagents.get(subagent.childTaskId)
        }))
      }, new AbortController().signal))
      expect(recovered).toContainEqual(partial)
      const replayed = recovered.filter(event => event.type === 'tool')
      expect(replayed.map(event => event.callId)).toEqual(failedTerminal ? [] : ['a-read', 'z-read'])
      expect(persist(partial!)).toBe(false)
      for (const event of recovered) persist(event)
      expect(database.getHighestCommittedRemoteTaskEventSequenceForTask(request.requestId)).toBe('4')
      expect(recovered.some(event => event.type === 'done')).toBe(true)
      expect(database.getTask(request.requestId).status).toBe(failedTerminal ? 'failed' : 'completed')
      expect(fixture.startOwnedPrompt).toHaveBeenCalledOnce()
      expect(fixture.attachOwnedPrompt).toHaveBeenCalledOnce()
    } finally {
      database.close()
      await Promise.all([replacement.dispose(), fixture.instance.dispose()])
    }
  })

  it.each(['opencode', 'continue'] as const)('starts a fresh %s binding after a cached unknown terminal', async runtimeId => {
    const fixture = ownedChannel({ runtimeId, state: 'outcome-unknown' })
    const next = ownedChannel({ runtimeId })
    try {
      await expect(collect(fixture.instance.run(request, new AbortController().signal)))
        .rejects.toThrow(/终态未知/iu)
      const original = (await fixture.store.getByConversation(request.conversationId))!
      expect(original).toMatchObject({ state: 'outcome-unknown', activePromptOperationId: request.requestId })
      await expect(collect(fixture.instance.run(
        { ...request, remoteRecoveryOnly: true }, new AbortController().signal
      ))).rejects.toBeInstanceOf(RemotePromptRecoveryUnavailableError)
      expect(fixture.channel.close).not.toHaveBeenCalled()
      fixture.pageOwnedPromptTranscript.mockImplementation(next.pageOwnedPromptTranscript)
      const events = await collect(fixture.instance.run({
        ...request, requestId: 'after-unknown', prompt: 'new explicit request',
        history: [{ role: 'user', content: 'previous question' }, { role: 'assistant', content: 'previous answer' }]
      }, new AbortController().signal))
      expect(events.some(event => event.type === 'done')).toBe(true)
      expect(await fixture.store.getById(original.bindingId)).toMatchObject({ state: 'closed', activePromptOperationId: undefined })
      const binding = (await fixture.store.getByConversation(request.conversationId))!
      expect(binding.bindingId).not.toBe(original.bindingId)
      expect(binding).toMatchObject({ state: 'ready', promptSequence: 0 })
      expect(fixture.channel.close).toHaveBeenCalledOnce()
      expect(fixture.preparePrompt).toHaveBeenCalledTimes(2)
      expect(fixture.startOwnedPrompt).toHaveBeenCalledTimes(2)
      expect(fixture.startOwnedPrompt.mock.calls[1]![0]).toMatchObject({
        bindingId: binding.bindingId, operationId: 'after-unknown', requestId: 'after-unknown'
      })
      expect(fixture.startOwnedPrompt.mock.calls[1]![0]).not.toHaveProperty('acpSessionId')
      expect(JSON.stringify(fixture.startOwnedPrompt.mock.calls[1]![0])).toContain('previous answer')
      expect(JSON.stringify(fixture.startOwnedPrompt.mock.calls[1]![0])).toContain('new explicit request')
      expect(fixture.attachOwnedPrompt).not.toHaveBeenCalled()
    } finally { await fixture.instance.dispose(); await next.instance.dispose() }
  })

  it.each(['opencode', 'continue'] as const)('does not prepare or start attach-only recovery from a cached ready %s session', async runtimeId => {
    const fixture = ownedChannel({ runtimeId })
    try {
      await collect(fixture.instance.run(request, new AbortController().signal))
      const binding = await fixture.store.getByConversation(request.conversationId)
      await expect(collect(fixture.instance.run(
        { ...request, remoteRecoveryOnly: true }, new AbortController().signal
      ))).rejects.toBeInstanceOf(RemotePromptRecoveryUnavailableError)
      expect(await fixture.store.getByConversation(request.conversationId)).toEqual(binding)
      expect(fixture.preparePrompt).toHaveBeenCalledOnce()
      expect(fixture.startOwnedPrompt).toHaveBeenCalledOnce()
      expect(fixture.attachOwnedPrompt).not.toHaveBeenCalled()
      expect(fixture.channel.close).not.toHaveBeenCalled()
    } finally { await fixture.instance.dispose() }
  })

  it('preserves a cached running operation when another explicit request arrives', async () => {
    const fixture = ownedChannel()
    try {
      const stream = fixture.instance.run(request, new AbortController().signal)
      await stream.next()
      await stream.return()
      const binding = await fixture.store.getByConversation(request.conversationId)
      await expect(collect(fixture.instance.run(
        { ...request, requestId: 'different-request' }, new AbortController().signal
      ))).rejects.toThrow(/必须先恢复或取消原请求/iu)
      expect(await fixture.store.getByConversation(request.conversationId)).toEqual(binding)
      expect(fixture.preparePrompt).toHaveBeenCalledOnce()
      expect(fixture.startOwnedPrompt).toHaveBeenCalledOnce()
      expect(fixture.channel.close).not.toHaveBeenCalled()
      const recovered = await collect(fixture.instance.run(
        { ...request, remoteRecoveryOnly: true }, new AbortController().signal
      ))
      expect(recovered.some(event => event.type === 'done')).toBe(true)
      expect(fixture.preparePrompt).toHaveBeenCalledOnce()
      expect(fixture.startOwnedPrompt).toHaveBeenCalledOnce()
    } finally { await fixture.instance.dispose() }
  })

  it('continues a cached ready session after a failed terminal', async () => {
    const fixture = ownedChannel({ state: 'failed' })
    const next = ownedChannel()
    try {
      await expect(collect(fixture.instance.run(request, new AbortController().signal)))
        .rejects.toThrow('owned failure')
      const binding = (await fixture.store.getByConversation(request.conversationId))!
      expect(binding).toMatchObject({ state: 'ready', activePromptOperationId: undefined })
      fixture.pageOwnedPromptTranscript.mockImplementation(next.pageOwnedPromptTranscript)
      const events = await collect(fixture.instance.run(
        { ...request, requestId: 'after-failure' }, new AbortController().signal
      ))
      expect(events.some(event => event.type === 'done')).toBe(true)
      expect(await fixture.store.getByConversation(request.conversationId)).toMatchObject({
        bindingId: binding.bindingId, state: 'ready', promptSequence: binding.promptSequence + 1
      })
      expect(fixture.startOwnedPrompt.mock.calls[1]![0]).toHaveProperty('acpSessionId', binding.acpSessionId)
      expect(fixture.preparePrompt).toHaveBeenCalledTimes(2)
      expect(fixture.startOwnedPrompt).toHaveBeenCalledTimes(2)
      expect(fixture.attachOwnedPrompt).not.toHaveBeenCalled()
      expect(fixture.channel.close).not.toHaveBeenCalled()
    } finally { await fixture.instance.dispose(); await next.instance.dispose() }
  })

  it('never starts a replacement prompt for attach-only recovery', async () => {
    const fixture = ownedChannel()
    const recoveryRequest = {
      ...request,
      remoteRecoveryOnly: true,
      remoteSemanticAfterSequence: '7'
    }

    await expect(
      collect(
        fixture.instance.run(
          recoveryRequest,
          new AbortController().signal
        )
      )
    ).rejects.toThrow(/不会重放任务/iu)
    expect(fixture.preparePrompt).not.toHaveBeenCalled()
    expect(fixture.startOwnedPrompt).not.toHaveBeenCalled()
    expect(fixture.attachOwnedPrompt).not.toHaveBeenCalled()
  })

  it('definitively ends recovery after the original Agent installation is replaced', async () => {
    const fixture = ownedChannel({ waitForCancellation: true })
    const first = fixture.instance.run(request, new AbortController().signal)
    await first.next()
    await first.return()
    const channelFactory = vi.fn(async () => fixture.channel)
    const replacement = factoryRuntime(channelFactory, fixture.store, {
      identity: { ...identity, agentInstallationId: 'replacement-agent' },
      modelBridgePolicy,
      modelProfile: ownedModelProfile
    })
    try {
      await expect(collect(replacement.run(
        { ...request, remoteRecoveryOnly: true },
        new AbortController().signal
      ))).rejects.toBeInstanceOf(RemotePromptRecoveryUnavailableError)
      expect(channelFactory).not.toHaveBeenCalled()
      expect(fixture.startOwnedPrompt).toHaveBeenCalledOnce()
      expect(fixture.attachOwnedPrompt).not.toHaveBeenCalled()
    } finally {
      await Promise.all([replacement.dispose(), fixture.instance.dispose()])
    }
  })

  it('reconciles an owned cancellation before the next prompt in the same conversation', async () => {
    const fixture = ownedChannel()
    fixture.pageOwnedPromptTranscript.mockImplementationOnce(() => new Promise<never>(() => {}))
    const controller = new AbortController()
    const stream = fixture.instance.run(request, controller.signal)
    await stream.next()
    const pending = stream.next()
    await vi.waitFor(() => expect(fixture.pageOwnedPromptTranscript).toHaveBeenCalledOnce())
    controller.abort(new Error('cancel pending question'))
    await expect(pending).rejects.toBeInstanceOf(RemotePromptCancelledError)
    expect(await fixture.store.getByConversation(request.conversationId)).toBeUndefined()
    const events = await collect(fixture.instance.run(
      { ...request, requestId: 'after-cancel' }, new AbortController().signal
    ))
    expect(events.some(event => event.type === 'done')).toBe(true)
    expect(fixture.startOwnedPrompt).toHaveBeenCalledTimes(2)
    await fixture.instance.dispose()
  })

  it('waits for the in-flight Agent cancellation before releasing its lease', async () => {
    let releaseEscalation!: () => void
    const escalation = new Promise<void>((resolve) => {
      releaseEscalation = resolve
    })
    const fixture = ownedChannel({
      waitForCancellation: true,
      escalateCancellation: async () => await escalation
    })
    const controller = new AbortController()
    const stream = fixture.instance.run(request, controller.signal)

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    const pending = stream.next()
    await vi.waitFor(() =>
      expect(fixture.pageOwnedPromptTranscript).toHaveBeenCalledOnce()
    )
    controller.abort(new Error('cancel owned prompt'))
    await vi.waitFor(() =>
      expect(fixture.escalateCancellation).toHaveBeenCalledOnce()
    )
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)

    releaseEscalation()
    await expect(pending).rejects.toBeInstanceOf(RemotePromptCancelledError)
  })

  it.each([
    ['cancelled', /请求已取消/iu],
    ['failed', /owned failure/iu],
    ['outcome-unknown', /终态未知/iu]
  ] as const)('maps the %s terminal exactly', async (state, message) => {
    const fixture = ownedChannel({ state })

    await expect(
      collect(
        fixture.instance.run(
          request,
          new AbortController().signal
        )
      )
    ).rejects.toThrow(message)
    await expect(
      fixture.store.getByConversation(request.conversationId)
    ).resolves.toMatchObject({
      state:
        state === 'outcome-unknown'
          ? 'outcome-unknown'
          : 'ready'
    })
  })
})
