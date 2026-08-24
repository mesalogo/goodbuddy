import { describe, expect, it, vi } from 'vitest'
import {
  runtimeSessionBindingSchema,
  type RuntimeSessionBinding
} from '../../shared/remote-agent-contracts'
import type { RemoteModelGateway } from '../agent/remote-model-gateway'
import { RemoteModelGatewayError } from '../agent/remote-model-gateway'
import { ModelCallCapacityError } from '../agent/model-call-operation-store'
import { MemoryRuntimeSessionBindingStore } from '../agent/runtime-session-binding-store'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import {
  createManagedModelBridge,
  reconcileStartupModelCalls
} from './managed-model-bridge'
import { MainModelBridgeDispatchError } from './main-model-bridge-dispatcher'

const digest = (character: string): string =>
  `sha256:${character.repeat(64)}`

const profile: ResolvedModelProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Private profile',
  baseUrl: 'https://provider.example/v1',
  modelName: 'private-model',
  protocol: 'openai-responses',
  authentication: 'api-key',
  supportsImageInput: false,
  apiKey: 'main-only-secret'
}

const response = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  bodyBase64: Buffer.from('{}').toString('base64')
}

function bridgeFixture(options?: {
  bindingStore?: MemoryRuntimeSessionBindingStore
}) {
  const bindingStore =
    options?.bindingStore ??
    new MemoryRuntimeSessionBindingStore()
  const dispatch = vi.fn(async () => response)
  const markResponseDelivered = vi.fn()
  const finalizePrompt = vi.fn()
  const gateway = {
    dispatch,
    markResponseDelivered,
    finalizePrompt
  } as unknown as RemoteModelGateway
  const bridge = createManagedModelBridge({
    profile,
    gateway,
    bindingStore
  })
  return {
    bindingStore,
    dispatch,
    markResponseDelivered,
    finalizePrompt,
    bridge
  }
}

function binding(
  policy: ReturnType<typeof bridgeFixture>['bridge']['policy'],
  state: RuntimeSessionBinding['state'] = 'prompt-running'
): RuntimeSessionBinding {
  return runtimeSessionBindingSchema.parse({
    bindingId: 'binding-1',
    controllerId: 'controller-1',
    controllerGeneration: 2,
    conversationId: 'conversation-1',
    hostId: 'host-1',
    hostRevision: 1,
    hostKeyGeneration: 1,
    workspaceIdentity: 'workspace-1',
    agentInstallationId: 'agent-1',
    daemonBootIdAtOpen: 'boot-1',
    runtimeId: 'opencode',
    runtimeBundleDigest: digest('a'),
    runtimeAdapterDigest: digest('b'),
    modelBridgeVersion: 'goodbuddy-model-bridge-v1',
    modelBridgePolicy: policy,
    acpSessionId: 'session-1',
    acpCapabilitiesDigest: digest('c'),
    state,
    activePromptOperationId:
      state === 'prompt-running' || state === 'outcome-unknown'
        ? 'prompt-1'
        : undefined,
    channelEpoch: '1',
    lastOutboundJournaledSequence: '0',
    lastOutboundDeliveredSequence: '0',
    lastInboundJournaledSequence: '0',
    lastMainAckSequence: '0'
  })
}

function dispatchInput(
  policy: ReturnType<typeof bridgeFixture>['bridge']['policy']
) {
  return {
    identity: {
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1',
      requestId: 'local-model-request-1',
      roundIndex: 0,
      modelProfileDigest: policy.modelProfileDigest,
      messageId: 'message-1'
    },
    policy,
    request: {
      method: 'POST' as const,
      path: '/v1/responses' as const,
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(
        JSON.stringify({ model: 'private-model' })
      ).toString('base64')
    },
    requestDigest: digest('e')
  }
}

describe('managed model bridge composition', () => {
  it('does not impose call-count or token quotas', () => {
    const fixture = bridgeFixture()

    expect(fixture.bridge.policy).toEqual({
      protocol: 'openai-responses',
      model: 'private-model',
      modelProfileDigest: expect.stringMatching(
        /^sha256:[a-f0-9]{64}$/u
      ),
      supportsImageInput: false
    })
  })

  it('keeps credentials in Main and maps exact dispatch plus delivery identity', async () => {
    const fixture = bridgeFixture()
    await fixture.bindingStore.put(binding(fixture.bridge.policy))
    const input = dispatchInput(fixture.bridge.policy)

    await expect(
      fixture.bridge.channel.dispatch(
        input,
        new AbortController().signal
      )
    ).resolves.toEqual(response)
    expect(fixture.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'local-model-request-1',
        bindingId: 'binding-1',
        promptOperationId: 'prompt-1',
        promptSequence: 0,
        roundIndex: 0,
        modelProfile: expect.objectContaining({
          apiKey: 'main-only-secret'
        })
      }),
      input.request,
      expect.any(AbortSignal)
    )
    expect(JSON.stringify(fixture.bridge.policy)).not.toContain(
      'main-only-secret'
    )
    expect(JSON.stringify(fixture.bridge.policy)).not.toContain(
      'provider.example'
    )

    await fixture.bridge.channel.onDelivered(
      input.identity,
      input.requestDigest
    )
    expect(fixture.markResponseDelivered).toHaveBeenCalledWith({
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1',
      roundIndex: 0
    })
    await fixture.bridge.channel.finalizePrompt(input.identity)
    expect(fixture.finalizePrompt).toHaveBeenCalledWith({
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1',
      promptSequence: 0
    })
  })

  it('classifies only known pre-dispatch gateway failures as definitive', async () => {
    const fixture = bridgeFixture()
    await fixture.bindingStore.put(binding(fixture.bridge.policy))
    vi.mocked(fixture.dispatch).mockRejectedValueOnce(
      new RemoteModelGatewayError(
        'request-policy-mismatch',
        'safe failure'
      )
    )

    await expect(
      fixture.bridge.channel.dispatch(
        dispatchInput(fixture.bridge.policy),
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'request-policy-mismatch',
      outcomeUnknown: false,
      postDispatch: false
    })

    vi.mocked(fixture.dispatch).mockRejectedValueOnce(
      new ModelCallCapacityError()
    )
    await expect(
      fixture.bridge.channel.dispatch(
        dispatchInput(fixture.bridge.policy),
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'model-ledger-capacity',
      outcomeUnknown: false,
      postDispatch: false
    })

    vi.mocked(fixture.dispatch).mockRejectedValueOnce(
      new RemoteModelGatewayError(
        'network-error',
        'must not escape'
      )
    )
    await expect(
      fixture.bridge.channel.dispatch(
        dispatchInput(fixture.bridge.policy),
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(MainModelBridgeDispatchError)
    await expect(
      fixture.bridge.channel.dispatch(
        {
          ...dispatchInput(fixture.bridge.policy),
          policy: {
            ...fixture.bridge.policy,
            model: 'different-model'
          }
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'model-policy-mismatch',
      outcomeUnknown: false
    })
  })

  it('durably poisons the exact active binding', async () => {
    const fixture = bridgeFixture()
    await fixture.bindingStore.put(binding(fixture.bridge.policy))

    await fixture.bridge.channel.poison(
      'binding-1',
      'prompt-1',
      'delivery-unknown'
    )
    await expect(
      fixture.bindingStore.getById('binding-1')
    ).resolves.toMatchObject({ state: 'outcome-unknown' })
  })

  it('paginates startup uncertainty and poisons only matching live prompts', async () => {
    const fixture = bridgeFixture()
    await fixture.bindingStore.put(binding(fixture.bridge.policy))
    const firstCursor = {
      updatedAt: 10,
      callOperationId: 'call-1'
    }
    const listStartupRecords = vi
      .fn()
      .mockReturnValueOnce({
        records: [
          {
            status: 'completed',
            identity: {
              bindingId: 'binding-1',
              promptOperationId: 'prompt-1'
            }
          }
        ],
        nextCursor: firstCursor
      })
      .mockReturnValueOnce({ records: [] })

    await reconcileStartupModelCalls({
      gatewayStore: { listStartupRecords },
      bindingStore: fixture.bindingStore
    })
    expect(listStartupRecords).toHaveBeenNthCalledWith(2, {
      cursor: firstCursor,
      limit: 100
    })
    await expect(
      fixture.bindingStore.getById('binding-1')
    ).resolves.toMatchObject({ state: 'outcome-unknown' })
  })

  it('marks a prepared but undispatched startup call as interrupted', async () => {
    const fixture = bridgeFixture()
    await fixture.bindingStore.put(binding(fixture.bridge.policy))

    await reconcileStartupModelCalls({
      gatewayStore: {
        listStartupRecords: () => ({
          records: [
            {
              status: 'prepared',
              identity: {
                bindingId: 'binding-1',
                promptOperationId: 'prompt-1'
              }
            }
          ]
        })
      },
      bindingStore: fixture.bindingStore
    })

    await expect(
      fixture.bindingStore.getById('binding-1')
    ).resolves.toMatchObject({
      state: 'interrupted',
      activePromptOperationId: undefined
    })
  })
})
