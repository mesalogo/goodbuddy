import { isDeepStrictEqual } from 'node:util'
import {
  modelBridgePolicySchema,
  type ModelBridgePolicy
} from '../../shared/model-bridge-contracts'
import { runtimeSessionBindingSchema } from '../../shared/remote-agent-contracts'
import {
  RemoteModelGateway,
  RemoteModelGatewayError,
  createResolvedModelProfileDigest
} from '../agent/remote-model-gateway'
import { ModelCallCapacityError } from '../agent/model-call-operation-store'
import type { RuntimeSessionBindingStore } from '../agent/runtime-session-binding-store'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import {
  MainModelBridgeDispatchError,
  type MainModelBridgeDispatchInput
} from './main-model-bridge-dispatcher'
import type { ProtocolRemoteRuntimeChannelOptions } from './protocol-remote-runtime-channel'

const PRE_DISPATCH_GATEWAY_ERRORS = new Set([
  'invalid-provider-endpoint',
  'missing-provider-credential',
  'model-profile-digest-mismatch',
  'protocol-path-mismatch',
  'request-policy-mismatch'
])

export type ManagedModelBridge = {
  policy: ModelBridgePolicy
  channel: NonNullable<ProtocolRemoteRuntimeChannelOptions['modelBridge']>
}

export function createManagedModelBridge(options: {
  profile: ResolvedModelProfile
  gateway: RemoteModelGateway
  bindingStore: RuntimeSessionBindingStore
}): ManagedModelBridge {
  const profile = structuredClone(options.profile)
  if (
    profile.protocol === 'openai-images-generations' ||
    (profile.authentication === 'api-key' && !profile.apiKey)
  ) {
    throw new Error(
      'Managed remote OpenCode requires a usable text model profile'
    )
  }
  const policy = modelBridgePolicySchema.parse({
    protocol: profile.protocol,
    model: profile.modelName,
    modelProfileDigest: createResolvedModelProfileDigest(profile),
    supportsImageInput: profile.supportsImageInput === true
  })

  const assertActiveBinding = async (
    input: Pick<
      MainModelBridgeDispatchInput['identity'],
      'bindingId' | 'promptOperationId'
    >
  ) => {
    const binding = await options.bindingStore.getById(input.bindingId)
    if (
      binding === undefined ||
      binding.state !== 'prompt-running' ||
      binding.activePromptOperationId !== input.promptOperationId ||
      binding.modelBridgeVersion !== 'goodbuddy-model-bridge-v1' ||
      !isDeepStrictEqual(binding.modelBridgePolicy, policy)
    ) {
      throw new MainModelBridgeDispatchError(
        'binding-policy-mismatch',
        { outcomeUnknown: false, postDispatch: false }
      )
    }
    return binding
  }

  return {
    policy,
    channel: {
      dispatch: async (input, signal) => {
        const binding = await assertActiveBinding(input.identity)
        if (!isDeepStrictEqual(input.policy, policy)) {
          throw new MainModelBridgeDispatchError(
            'model-policy-mismatch',
            { outcomeUnknown: false, postDispatch: false }
          )
        }
        try {
          return await options.gateway.dispatch(
            {
              requestId: input.identity.requestId,
              bindingId: input.identity.bindingId,
              promptOperationId:
                input.identity.promptOperationId,
              promptSequence: binding.promptSequence,
              roundIndex: input.identity.roundIndex,
              modelProfileDigest: policy.modelProfileDigest,
              modelProfile: profile
            },
            input.request,
            signal
          )
        } catch (error) {
          if (
            error instanceof MainModelBridgeDispatchError
          ) {
            throw error
          }
          if (
            error instanceof RemoteModelGatewayError &&
            PRE_DISPATCH_GATEWAY_ERRORS.has(error.code)
          ) {
            throw new MainModelBridgeDispatchError(error.code, {
              outcomeUnknown: false,
              postDispatch: false,
              cause: error
            })
          }
          if (error instanceof ModelCallCapacityError) {
            throw new MainModelBridgeDispatchError(
              'model-ledger-capacity',
              {
                outcomeUnknown: false,
                postDispatch: false,
                cause: error
              }
            )
          }
          throw new MainModelBridgeDispatchError(
            error instanceof RemoteModelGatewayError
              ? error.code
              : 'dispatch-failed',
            {
              outcomeUnknown: true,
              postDispatch: true,
              cause: error
            }
          )
        }
      },
      onDelivered: async (identity) => {
        await assertActiveBinding(identity)
        options.gateway.markResponseDelivered({
          bindingId: identity.bindingId,
          promptOperationId: identity.promptOperationId,
          roundIndex: identity.roundIndex
        })
      },
      finalizePrompt: async (identity) => {
        const binding = await assertActiveBinding(identity)
        options.gateway.finalizePrompt({
          bindingId: identity.bindingId,
          promptOperationId: identity.promptOperationId,
          promptSequence: binding.promptSequence
        })
      },
      poison: async (
        bindingId,
        promptOperationId
      ) => {
        const binding =
          await options.bindingStore.getById(bindingId)
        if (
          binding === undefined ||
          binding.state === 'closed' ||
          binding.state === 'outcome-unknown' ||
          binding.activePromptOperationId !== promptOperationId
        ) {
          return
        }
        await options.bindingStore.put(
          runtimeSessionBindingSchema.parse({
            ...binding,
            state: 'outcome-unknown'
          })
        )
      }
    }
  }
}

export async function reconcileStartupModelCalls(options: {
  gatewayStore: {
    listStartupRecords(input?: {
      cursor?: {
        updatedAt: number
        callOperationId: string
      }
      limit?: number
    }): {
      records: Array<{
        status:
          | 'prepared'
          | 'dispatched'
          | 'completed'
          | 'failed-definitive'
          | 'outcome-unknown'
        identity: {
          bindingId: string
          promptOperationId: string
        }
      }>
      nextCursor?: {
        updatedAt: number
        callOperationId: string
      }
    }
  }
  bindingStore: RuntimeSessionBindingStore
}): Promise<void> {
  let cursor:
    | { updatedAt: number; callOperationId: string }
    | undefined
  do {
    const page = options.gatewayStore.listStartupRecords({
      ...(cursor === undefined ? {} : { cursor }),
      limit: 100
    })
    for (const record of page.records) {
      const binding = await options.bindingStore.getById(
        record.identity.bindingId
      )
      if (
        binding === undefined ||
        binding.state === 'closed' ||
        binding.state === 'outcome-unknown' ||
        binding.activePromptOperationId !==
          record.identity.promptOperationId
      ) {
        continue
      }
      await options.bindingStore.put(
        runtimeSessionBindingSchema.parse({
          ...binding,
          state:
            record.status === 'prepared'
              ? 'interrupted'
              : 'outcome-unknown',
          ...(record.status === 'prepared'
            ? { activePromptOperationId: undefined }
            : {})
        })
      )
    }
    cursor = page.nextCursor
  } while (cursor !== undefined)
}
