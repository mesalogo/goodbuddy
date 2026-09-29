import { z } from 'zod'
import { isDeepSeekHarnessModelProfile } from './deepseek-harness-compatibility'

/**
 * Runtime selection is layered: global settings, then an optional project
 * layer, then an optional conversation layer. Each layer may independently
 * leave the execution mode (`provider`) or the model unset, which means
 * "inherit from the layer above". Only the resolver turns layers into a
 * concrete `AgentRuntimeSelection` that a runtime can be created from.
 */

export const agentRuntimeProviders = [
  'model',
  'opencode',
  'continue',
  'deepseek-harness'
] as const

export const agentRuntimeProviderSchema = z.enum(agentRuntimeProviders)
export type AgentRuntimeProvider = z.infer<typeof agentRuntimeProviderSchema>

const profileIdSchema = z.string().uuid()

export const runtimeModelChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), profileId: profileIdSchema }).strict(),
  z.object({ kind: z.literal('runtime-config') }).strict()
])
export type RuntimeModelChoice = z.infer<typeof runtimeModelChoiceSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Accepts the pre-layer `{ provider, profileId? }` and `{ provider: 'auto' }` shapes. */
function upgradeLegacyLayer(value: unknown): unknown {
  if (!isRecord(value) || 'model' in value || !('provider' in value)) {
    return value
  }
  if (value.provider === 'auto') return {}
  const { profileId, ...rest } = value
  return typeof profileId === 'string'
    ? { ...rest, model: { kind: 'profile', profileId } }
    : rest
}

export const runtimeSelectionLayerSchema = z.preprocess(
  upgradeLegacyLayer,
  z
    .object({
      provider: agentRuntimeProviderSchema.optional(),
      model: runtimeModelChoiceSchema.optional()
    })
    .strict()
    .refine(
      (layer) =>
        layer.provider !== 'model' || layer.model?.kind !== 'runtime-config',
      { message: '直连模型不能使用 Runtime 自有配置', path: ['model'] }
    )
)
export type RuntimeSelectionLayer = z.infer<typeof runtimeSelectionLayerSchema>

export function isEmptyRuntimeSelectionLayer(
  layer: RuntimeSelectionLayer | undefined
): boolean {
  return !layer || (layer.provider === undefined && layer.model === undefined)
}

/** Normalizes an empty layer to `undefined` so storage keeps "inherit" as NULL. */
export function compactRuntimeSelectionLayer(
  layer: RuntimeSelectionLayer | undefined
): RuntimeSelectionLayer | undefined {
  if (isEmptyRuntimeSelectionLayer(layer)) return undefined
  return {
    ...(layer!.provider ? { provider: layer!.provider } : {}),
    ...(layer!.model ? { model: layer!.model } : {})
  }
}

const concreteRuntimeSelectionShape = {
  profileId: profileIdSchema.optional(),
  runtimeConfig: z.literal(true).optional()
}

/** A fully resolved selection. `profileId` and `runtimeConfig` are exclusive. */
export const agentRuntimeSelectionSchema = z
  .discriminatedUnion('provider', [
    z
      .object({
        provider: z.literal('model'),
        profileId: profileIdSchema.optional()
      })
      .strict(),
    z
      .object({ provider: z.literal('opencode'), ...concreteRuntimeSelectionShape })
      .strict(),
    z
      .object({ provider: z.literal('continue'), ...concreteRuntimeSelectionShape })
      .strict(),
    z
      .object({
        provider: z.literal('deepseek-harness'),
        ...concreteRuntimeSelectionShape
      })
      .strict()
  ])
  .refine(
    (selection) =>
      !('runtimeConfig' in selection && selection.runtimeConfig && selection.profileId),
    { message: '模型连接与 Runtime 自有配置不能同时选择' }
  )

export type AgentRuntimeSelection = z.infer<typeof agentRuntimeSelectionSchema>

/**
 * Stored queue items, schedules and older renderers may still send
 * `{ provider: 'auto' }`. It now means "not specified" so Main resolves
 * the layers; any other invalid shape is still rejected.
 */
export const optionalAgentRuntimeSelectionSchema = agentRuntimeSelectionSchema.optional()

/** Maps legacy `{ provider: 'auto' }` to "not specified"; other values pass through for validation. */
export function withoutLegacyAutoSelection<T>(value: T): T {
  if (!isRecord(value)) return value
  if (value.provider === 'auto') return undefined as T
  if (isRecord(value.runtimeSelection) && value.runtimeSelection.provider === 'auto') {
    const { runtimeSelection: _legacy, ...rest } = value
    void _legacy
    return rest as T
  }
  return value
}

export function agentRuntimeSelectionKey(
  selection: AgentRuntimeSelection
): string {
  const model =
    selection.profileId ??
    ('runtimeConfig' in selection && selection.runtimeConfig
      ? 'runtime-config'
      : 'default')
  return `${selection.provider}:${model}`
}

export function runtimeSelectionFromChoice(
  provider: AgentRuntimeProvider,
  model: RuntimeModelChoice | undefined
): AgentRuntimeSelection {
  if (model?.kind === 'profile') return { provider, profileId: model.profileId }
  if (model?.kind === 'runtime-config' && provider !== 'model') {
    return { provider, runtimeConfig: true }
  }
  return { provider }
}

type RuntimeModelSource =
  | { kind: 'default' }
  | { kind: 'platform' }
  | { kind: 'profile'; profileId: string }

export type RuntimeResolutionProfile = {
  id: string
  name?: string
  modelName?: string
  baseUrl?: string
  protocol?: string
  authentication?: 'api-key' | 'none'
  apiKeyConfigured?: boolean
}

export type RuntimeResolutionSettings = {
  /** Global default execution mode. Legacy `auto` is treated as the direct model. */
  provider: string
  defaultModelProfileId: string
  modelProfiles: ReadonlyArray<RuntimeResolutionProfile>
  opencodeModelSource?: RuntimeModelSource
  continueModelSource?: RuntimeModelSource
  deepseekHarnessModelSource?: RuntimeModelSource
  /** An external OpenCode server can only use its own configuration. */
  opencodeBaseUrl?: string
}

export type RuntimeResolutionOptions = {
  /** Managed SSH projects: OpenCode or Continue with a GoodBuddy model connection. */
  remote?: boolean
}

export type RuntimeSelectionLayerName = 'global' | 'project' | 'conversation'

export type RuntimeModelChoiceStatus =
  | 'ok'
  | 'missing'
  | 'incompatible'
  | 'unavailable'

export type ResolvedRuntimeChoice = {
  selection: AgentRuntimeSelection
  provider: AgentRuntimeProvider
  providerSource: RuntimeSelectionLayerName
  model?: RuntimeModelChoice
  modelSource: RuntimeSelectionLayerName
  /** A project or conversation choice that could not be used. */
  ignored?: {
    layer: Exclude<RuntimeSelectionLayerName, 'global'>
    kind: 'provider' | 'model'
    reason: Exclude<RuntimeModelChoiceStatus, 'ok'>
  }
}

export function allowedRuntimeProviders(
  options: RuntimeResolutionOptions = {}
): readonly AgentRuntimeProvider[] {
  return options.remote ? ['opencode', 'continue'] : agentRuntimeProviders
}

function normalizedGlobalProvider(
  settings: RuntimeResolutionSettings,
  options: RuntimeResolutionOptions
): AgentRuntimeProvider {
  const parsed = agentRuntimeProviderSchema.safeParse(settings.provider)
  const provider = parsed.success ? parsed.data : 'model'
  return allowedRuntimeProviders(options).includes(provider)
    ? provider
    : 'opencode'
}

function isProfileCredentialReady(profile: RuntimeResolutionProfile): boolean {
  return !(profile.authentication === 'api-key' && profile.apiKeyConfigured === false)
}

export function isChannelModelProfileUsable(
  profile: RuntimeResolutionProfile
): boolean {
  return (
    profile.protocol !== 'openai-images-generations' &&
    isProfileCredentialReady(profile)
  )
}

export function isProfileCompatibleWithProvider(
  provider: AgentRuntimeProvider,
  profile: RuntimeResolutionProfile
): boolean {
  if (!profile.protocol) return false
  // The direct model can also run image-generation connections.
  if (profile.protocol === 'openai-images-generations') return provider === 'model'
  if (provider !== 'deepseek-harness') return true
  return (
    Boolean(profile.baseUrl) &&
    isDeepSeekHarnessModelProfile({
      baseUrl: profile.baseUrl!,
      protocol: profile.protocol,
      authentication: profile.authentication ?? 'none'
    })
  )
}

export function supportsRuntimeConfig(
  provider: AgentRuntimeProvider,
  options: RuntimeResolutionOptions = {}
): boolean {
  return provider !== 'model' && !options.remote
}

function supportsProfiles(
  provider: AgentRuntimeProvider,
  settings: RuntimeResolutionSettings
): boolean {
  return !(provider === 'opencode' && settings.opencodeBaseUrl?.trim())
}

export function runtimeModelChoiceStatus(
  provider: AgentRuntimeProvider,
  choice: RuntimeModelChoice,
  settings: RuntimeResolutionSettings,
  options: RuntimeResolutionOptions = {}
): RuntimeModelChoiceStatus {
  if (choice.kind === 'runtime-config') {
    return supportsRuntimeConfig(provider, options) ? 'ok' : 'incompatible'
  }
  const profile = (settings.modelProfiles ?? []).find(
    (candidate) => candidate.id === choice.profileId
  )
  if (!profile) return 'missing'
  if (
    !supportsProfiles(provider, settings) ||
    !isProfileCompatibleWithProvider(provider, profile)
  ) {
    return 'incompatible'
  }
  return isProfileCredentialReady(profile) ? 'ok' : 'unavailable'
}

export function isResolvableStatus(status: RuntimeModelChoiceStatus): boolean {
  return status === 'ok' || status === 'unavailable'
}

/** Profiles a user can pick for a provider, in configuration order. */
export function selectableModelProfiles(
  provider: AgentRuntimeProvider,
  settings: RuntimeResolutionSettings
): RuntimeResolutionProfile[] {
  if (!supportsProfiles(provider, settings)) return []
  return (settings.modelProfiles ?? []).filter((profile) =>
    isProfileCompatibleWithProvider(provider, profile)
  )
}

function preferredUsableProfile(
  provider: AgentRuntimeProvider,
  settings: RuntimeResolutionSettings
): RuntimeResolutionProfile | undefined {
  // Fallback defaults are text models; image generation is only chosen explicitly.
  const text = selectableModelProfiles(provider, settings).filter(
    (profile) => profile.protocol !== 'openai-images-generations'
  )
  const ready = text.filter(isProfileCredentialReady)
  return (
    ready.find((profile) => profile.id === settings.defaultModelProfileId) ??
    ready[0] ??
    text[0]
  )
}

/** What the global settings configure for a provider, before any fallback. */
export function configuredGlobalModel(
  provider: AgentRuntimeProvider,
  settings: RuntimeResolutionSettings
): RuntimeModelChoice | undefined {
  if (provider === 'model') {
    // No connections yet (first run, tests): let the runtime use its configured model.
    return settings.defaultModelProfileId
      ? { kind: 'profile', profileId: settings.defaultModelProfileId }
      : undefined
  }
  const source =
    provider === 'opencode'
      ? settings.opencodeModelSource
      : provider === 'continue'
        ? settings.continueModelSource
        : settings.deepseekHarnessModelSource
  if (!source || source.kind === 'platform') return { kind: 'runtime-config' }
  if (source.kind === 'profile') {
    return { kind: 'profile', profileId: source.profileId }
  }
  const preferred = preferredUsableProfile(provider, settings)
  return preferred
    ? { kind: 'profile', profileId: preferred.id }
    : { kind: 'runtime-config' }
}

/** The global default after skipping unusable connections. */
export function globalDefaultModel(
  provider: AgentRuntimeProvider,
  settings: RuntimeResolutionSettings,
  options: RuntimeResolutionOptions = {}
): RuntimeModelChoice | undefined {
  const configured = configuredGlobalModel(provider, settings)
  const configuredProfile =
    configured?.kind === 'profile'
      ? settings.modelProfiles?.find((profile) => profile.id === configured.profileId)
      : undefined
  if (
    configured &&
    configuredProfile?.protocol !== 'openai-images-generations' &&
    isResolvableStatus(runtimeModelChoiceStatus(provider, configured, settings, options))
  ) {
    return configured
  }
  const preferred = preferredUsableProfile(provider, settings)
  if (preferred) return { kind: 'profile', profileId: preferred.id }
  if (supportsRuntimeConfig(provider, options)) return { kind: 'runtime-config' }
  // Keep the broken choice so the run reports why it cannot start.
  return options.remote ? undefined : configured
}

export function resolveRuntimeChoice(
  settings: RuntimeResolutionSettings,
  layers: {
    project?: RuntimeSelectionLayer
    conversation?: RuntimeSelectionLayer
  } = {},
  options: RuntimeResolutionOptions = {}
): ResolvedRuntimeChoice {
  // Cached renderer state may still hold pre-layer shapes; read them as layers.
  const normalize = (layer: unknown): RuntimeSelectionLayer | undefined => {
    if (layer === undefined) return undefined
    const parsed = runtimeSelectionLayerSchema.safeParse(layer)
    return parsed.success ? parsed.data : undefined
  }
  layers = { project: normalize(layers.project), conversation: normalize(layers.conversation) }
  const allowed = allowedRuntimeProviders(options)
  let ignored: ResolvedRuntimeChoice['ignored']
  let provider = normalizedGlobalProvider(settings, options)
  let providerSource: RuntimeSelectionLayerName = 'global'
  for (const layer of ['project', 'conversation'] as const) {
    const candidate = layers[layer]?.provider
    if (!candidate) continue
    if (allowed.includes(candidate)) {
      provider = candidate
      providerSource = layer
    } else {
      ignored = { layer, kind: 'provider', reason: 'incompatible' }
    }
  }

  let model: RuntimeModelChoice | undefined
  let modelSource: RuntimeSelectionLayerName = 'global'
  for (const layer of ['conversation', 'project'] as const) {
    const candidate = layers[layer]?.model
    if (!candidate) continue
    const status = runtimeModelChoiceStatus(provider, candidate, settings, options)
    // A missing key is reported when the run starts; only structural problems fall back.
    if (isResolvableStatus(status)) {
      model = candidate
      modelSource = layer
      break
    }
    ignored ??= { layer, kind: 'model', reason: status as 'missing' | 'incompatible' }
  }
  model ??= globalDefaultModel(provider, settings, options)

  return {
    selection: runtimeSelectionFromChoice(provider, model),
    provider,
    providerSource,
    model,
    modelSource,
    ...(ignored ? { ignored } : {})
  }
}

/** Drops references to deleted model connections without touching other choices. */
export function repairRuntimeSelectionLayer(
  layer: RuntimeSelectionLayer | undefined,
  settings: Pick<RuntimeResolutionSettings, 'modelProfiles'>
): RuntimeSelectionLayer | undefined {
  if (
    layer?.model?.kind !== 'profile' ||
    (settings.modelProfiles ?? []).some((profile) => profile.id === (layer.model as { profileId: string }).profileId)
  ) {
    return compactRuntimeSelectionLayer(layer)
  }
  return compactRuntimeSelectionLayer({ ...layer, model: undefined })
}

export function runtimeSelectionLayerKey(
  layer: RuntimeSelectionLayer | undefined
): string {
  const compact = compactRuntimeSelectionLayer(layer)
  return compact ? JSON.stringify(compact) : ''
}
