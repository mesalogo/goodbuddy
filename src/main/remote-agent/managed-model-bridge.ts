import { createHash } from 'node:crypto'
import { canonicalJson } from '../../shared/agent-protocol/canonical'
import {
  agentPromptModelProfileSchema,
  modelBridgePolicySchema,
  type AgentPromptModelProfile,
  type ModelBridgePolicy
} from '../../shared/model-bridge-contracts'
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

export function createResolvedModelProfileDigest(
  profile: ResolvedModelProfile
): string {
  const canonical = canonicalJson({
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    modelName: profile.modelName,
    protocol: profile.protocol,
    authentication: profile.authentication,
    supportsImageInput: profile.supportsImageInput === true,
    contextWindowTokens: profile.contextWindowTokens ?? null,
    maximumOutputTokens: profile.maximumOutputTokens ?? null,
    imageGenerationQuality: profile.imageGenerationQuality ?? null,
    requestHeaders: Object.fromEntries(
      Object.entries(profile.requestHeaders ?? {}).map(
        ([name, value]) => [name.toLowerCase(), value]
      )
    ),
    requestBody: profile.requestBody ?? {}
  })
  return `sha256:${createHash('sha256')
    .update(canonical)
    .digest('hex')}`
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
    ...(selected.requestHeaders &&
    Object.keys(selected.requestHeaders).length > 0
      ? { requestHeaders: selected.requestHeaders }
      : {}),
    ...(selected.requestBody &&
    Object.keys(selected.requestBody).length > 0
      ? { requestBody: selected.requestBody }
      : {}),
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
