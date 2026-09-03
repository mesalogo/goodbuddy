import {
  agentPromptModelProfileSchema,
  modelBridgePolicySchema,
  type AgentPromptModelProfile,
  type ModelBridgePolicy
} from '../../shared/model-bridge-contracts'
import { createResolvedModelProfileDigest } from '../agent/remote-model-gateway'
import type { ResolvedModelProfile } from '../runtime-settings-store'

const DEFAULT_MAXIMUM_OUTPUT_TOKENS = 32_000
const MODEL_REQUEST_TIMEOUT_MILLISECONDS = 60_000

/**
 * Prompt-scoped model material passed directly to the Agent. The policy is
 * safe to persist; the profile (and its credential) is not.
 */
export type ManagedModelBridge = {
  policy: ModelBridgePolicy
  profile: AgentPromptModelProfile
}

export function createManagedModelBridge(options: {
  profile: ResolvedModelProfile
}): ManagedModelBridge {
  const selected = structuredClone(options.profile)
  if (
    selected.protocol === 'openai-images-generations' ||
    (selected.authentication === 'api-key' && !selected.apiKey)
  ) {
    throw new Error(
      'Managed remote OpenCode requires a usable text model profile'
    )
  }
  const maximumOutputTokens = Math.min(
    1_000_000,
    Math.max(
      1,
      selected.maximumOutputTokens ??
        DEFAULT_MAXIMUM_OUTPUT_TOKENS
    )
  )
  const modelProfileDigest =
    createResolvedModelProfileDigest(selected)
  const profile = agentPromptModelProfileSchema.parse({
    profileId: selected.id,
    modelProfileDigest,
    provider:
      selected.protocol === 'anthropic-messages'
        ? 'anthropic'
        : 'openai',
    baseUrl: selected.baseUrl,
    model: selected.modelName,
    protocol: selected.protocol,
    authentication: selected.authentication,
    ...(selected.apiKey === undefined
      ? {}
      : { apiKey: selected.apiKey }),
    capabilities: {
      imageInput: selected.supportsImageInput === true
    },
    limits: {
      maximumOutputTokens,
      requestTimeoutMilliseconds:
        MODEL_REQUEST_TIMEOUT_MILLISECONDS
    }
  })
  const policy = modelBridgePolicySchema.parse({
    protocol: profile.protocol,
    model: profile.model,
    modelProfileDigest: profile.modelProfileDigest,
    supportsImageInput: profile.capabilities.imageInput
  })
  return {
    profile: structuredClone(profile),
    policy
  }
}
