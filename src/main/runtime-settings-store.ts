import {
  readFile,
  realpath,
  stat
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { z } from 'zod'
import {
  continueModeSchema,
  builtinEmbeddingConnectionId,
  contextCompressionSettingsSchema,
  defaultContextCompressionSettings,
  defaultModelProfileId,
  defaultRuntimeCustomizationSettings,
  defaultRuntimeSettings,
  imageGenerationQualitySchema,
  legacyEmbeddingConnectionId,
  isAgentRuntimeModelProtocol,
  isDeepSeekHarnessModelProfile,
  minimumModelContextWindowTokens,
  modelAuthenticationSchema,
  modelProtocolSchema,
  modelRequestBodySchema,
  modelRequestHeadersSchema,
  runtimeModelSourceSchema,
  runtimeCustomizationSettingsSchema,
  runtimePathSchema,
  runtimeProviderSchema,
  toolApprovalPolicySchema,
  type RuntimeSettings,
  type RuntimeCustomizationSettings,
  type RuntimeSettingsInput
} from '../shared/contracts'
import {
  settingsWarningsEqual,
  type SettingsWarning
} from '../shared/settings-warning-contracts'
import {
  assertSupportedSettingsVersion,
  isolateCorruptSettingsFile,
  isMissingFileError,
  UnsupportedSettingsVersionError,
  writeJsonFileAtomically
} from './settings-file-utils'
import {
  decryptSettingsCredential,
  encryptedSettingsCredentialSchema,
  encryptSettingsCredential,
  type SettingsCredentialCipher
} from './settings-credential-cipher'

const credentialSchema = encryptedSettingsCredentialSchema.optional()
const CURRENT_SETTINGS_VERSION = 21
const legacyRuntimeSandboxModeSchema = z.enum([
  'off',
  'auto',
  'strict'
])

const version4StoredSettingsSchema = z.object({
  version: z.literal(4),
  provider: runtimeProviderSchema,
  modelBaseUrl: z.string(),
  modelName: z.string(),
  opencodeBaseUrl: z.string().default(''),
  opencodeEmbedded: z.boolean().default(false),
  opencodeBinaryPath: runtimePathSchema.default(''),
  opencodeConfigPath: runtimePathSchema.default(''),
  continueBinaryPath: runtimePathSchema.default(''),
  continueConfigPath: runtimePathSchema.default(''),
  continueMode: continueModeSchema.default('chat'),
  workspacePath: z.string().default(''),
  credential: credentialSchema,
  toolApproval: toolApprovalPolicySchema
})

const version5StoredModelProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  baseUrl: z.string(),
  modelName: z.string(),
  credential: credentialSchema
})

const version5StoredSettingsSchema = z.object({
  version: z.literal(5),
  provider: runtimeProviderSchema,
  modelProfiles: z.array(version5StoredModelProfileSchema).min(1).max(20),
  defaultModelProfileId: z.string().uuid(),
  opencodeModelSource: runtimeModelSourceSchema,
  continueModelSource: runtimeModelSourceSchema,
  opencodeBaseUrl: z.string().default(''),
  opencodeEmbedded: z.boolean().default(false),
  opencodeBinaryPath: runtimePathSchema.default(''),
  opencodeConfigPath: runtimePathSchema.default(''),
  continueBinaryPath: runtimePathSchema.default(''),
  continueConfigPath: runtimePathSchema.default(''),
  continueMode: continueModeSchema.default('chat'),
  workspacePath: z.string().default(''),
  toolApproval: toolApprovalPolicySchema
})

const version6StoredModelProfileSchema =
  version5StoredModelProfileSchema.extend({
    protocol: modelProtocolSchema,
    authentication: modelAuthenticationSchema
  })

const version6StoredSettingsSchema = version5StoredSettingsSchema
  .omit({ version: true, modelProfiles: true })
  .extend({
    version: z.literal(6),
    modelProfiles: z
      .array(version6StoredModelProfileSchema)
      .min(1)
      .max(20),
    runtimeSandboxMode: legacyRuntimeSandboxModeSchema.default('auto'),
    knowledgeEmbeddingEnabled: z.boolean().default(false),
    knowledgeEmbeddingBaseUrl: z
      .string()
      .default('http://127.0.0.1:11434'),
    knowledgeEmbeddingModel: z.string().default('nomic-embed-text')
  })

const version7StoredSettingsSchema = version6StoredSettingsSchema
  .omit({ version: true })
  .extend({
    version: z.literal(7),
    knowledgeEmbeddingCredential: credentialSchema
  })

const storedModelProfileSchema = version6StoredModelProfileSchema.extend({
  imageGenerationQuality: imageGenerationQualitySchema
})

const version8StoredSettingsSchema = version7StoredSettingsSchema
  .omit({ version: true, modelProfiles: true })
  .extend({
    version: z.literal(8),
    modelProfiles: z.array(storedModelProfileSchema).min(1).max(20)
  })

const version9StoredSettingsSchema = version8StoredSettingsSchema
  .omit({ version: true })
  .extend({
    version: z.literal(9),
    subagentSmartRoutingEnabled: z.boolean()
  })

const version10StoredSettingsSchema = version9StoredSettingsSchema
  .omit({ version: true })
  .extend({
    version: z.literal(10),
    intranetCompatibilityEnabled: z.boolean()
  })

const version11StoredSettingsSchema = version10StoredSettingsSchema
  .omit({ version: true })
  .extend({
    version: z.literal(11)
  })

const version12StoredSettingsSchema = version11StoredSettingsSchema
  .omit({ version: true, intranetCompatibilityEnabled: true })
  .extend({
    version: z.literal(12)
  })

const currentStoredModelProfileSchema = storedModelProfileSchema.extend({
  supportsImageInput: z.boolean(),
  contextWindowTokens: z
    .number()
    .int()
    .min(8_000)
    .max(10_000_000)
    .optional(),
  maximumOutputTokens: z
    .number()
    .int()
    .min(1)
    .max(10_000_000)
    .optional()
})

const version13StoredSettingsSchema = version12StoredSettingsSchema
  .omit({ version: true, modelProfiles: true })
  .extend({
    version: z.literal(13),
    modelProfiles: z
      .array(currentStoredModelProfileSchema)
      .min(1)
      .max(20)
  })

const version14StoredSettingsSchema = version13StoredSettingsSchema
  .omit({ version: true })
  .extend({
    version: z.literal(14),
    knowledgeRerankEnabled: z.boolean(),
    knowledgeRerankEndpoint: z
      .string()
      .url()
      .max(2_048)
      .refine(
        (value) => ['http:', 'https:'].includes(new URL(value).protocol)
      ),
    knowledgeRerankModel: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[\w./:-]+$/u),
    knowledgeRerankCredential: credentialSchema
  })

const version15StoredSettingsSchema = version14StoredSettingsSchema
  .omit({ version: true })
  .extend({
    version: z.literal(15),
    deepseekHarnessModelSource: runtimeModelSourceSchema,
    deepseekHarnessBinaryPath: runtimePathSchema.default('')
  })

const version16StoredSettingsSchema = version15StoredSettingsSchema
  .omit({
    version: true,
    deepseekHarnessBinaryPath: true,
    runtimeSandboxMode: true
  })
  .extend({
    version: z.literal(16)
  })

const version17StoredSettingsSchema = version16StoredSettingsSchema
  .omit({ version: true })
  .extend({
    version: z.literal(17),
    contextCompression: contextCompressionSettingsSchema
  })

const version18StoredSettingsSchema = version17StoredSettingsSchema
  .omit({ version: true })
  .extend({
    version: z.literal(18),
    runtimeCustomization: runtimeCustomizationSettingsSchema
  })

const storedEmbeddingConnectionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.literal(builtinEmbeddingConnectionId),
      name: z.string().trim().min(1).max(64),
      kind: z.literal('builtin')
    })
    .strict(),
  z
    .object({
      id: z.string().uuid().refine(
        (id) => id !== builtinEmbeddingConnectionId
      ),
      name: z.string().trim().min(1).max(64),
      kind: z.literal('openai-compatible'),
      baseUrl: z.string().url().max(2_048),
      modelName: z.string().trim().min(1).max(256),
      authentication: modelAuthenticationSchema,
      credential: credentialSchema
    })
    .strict()
])

const version19StoredSettingsSchema = version18StoredSettingsSchema
  .omit({ version: true })
  .extend({
    version: z.literal(19),
    embeddingConnections: z
      .array(storedEmbeddingConnectionSchema)
      .min(1)
      .max(20),
    activeEmbeddingConnectionId: z.string().uuid()
  })

const version20StoredSettingsSchema = version19StoredSettingsSchema
  .omit({ version: true })
  .extend({
    version: z.literal(20)
  })

const storedSettingsSchema = version20StoredSettingsSchema
  .omit({ version: true, modelProfiles: true })
  .extend({
    version: z.literal(CURRENT_SETTINGS_VERSION),
    modelProfiles: z
      .array(
        currentStoredModelProfileSchema.extend({
          requestHeaders: modelRequestHeadersSchema,
          requestBody: modelRequestBodySchema
        })
      )
      .min(1)
      .max(20)
  })

type StoredSettings = z.infer<typeof storedSettingsSchema>
export type RuntimeSettingsRollback = {
  publicSettings: RuntimeSettings
  restore(): Promise<RuntimeSettings>
}
type Version17StoredSettings = z.infer<
  typeof version17StoredSettingsSchema
>
type Version18StoredSettings = z.infer<
  typeof version18StoredSettingsSchema
>
type Version19StoredSettings = z.infer<
  typeof version19StoredSettingsSchema
>
type Version20StoredSettings = z.infer<
  typeof version20StoredSettingsSchema
>
type Version16StoredSettings = z.infer<
  typeof version16StoredSettingsSchema
>
type Version15StoredSettings = z.infer<
  typeof version15StoredSettingsSchema
>
type Version10StoredSettings = z.infer<
  typeof version10StoredSettingsSchema
>
type Version11StoredSettings = z.infer<
  typeof version11StoredSettingsSchema
>
type Version12StoredSettings = z.infer<
  typeof version12StoredSettingsSchema
>
type Version13StoredSettings = z.infer<
  typeof version13StoredSettingsSchema
>
type Version14StoredSettings = z.infer<
  typeof version14StoredSettingsSchema
>

const version3StoredSettingsSchema = version4StoredSettingsSchema
  .omit({ version: true, continueMode: true })
  .extend({ version: z.literal(3) })

const version2StoredSettingsSchema = z.object({
  version: z.literal(2),
  provider: runtimeProviderSchema,
  modelBaseUrl: z.string(),
  modelName: z.string(),
  opencodeBaseUrl: z.string().default(''),
  opencodeEmbedded: z.boolean().default(false),
  continueCommand: runtimePathSchema.default('cn'),
  workspacePath: z.string().default(''),
  credential: credentialSchema,
  toolApproval: toolApprovalPolicySchema
})

const legacyStoredSettingsSchema = z.object({
  version: z.literal(1),
  provider: z.enum(['auto', 'bigtoken', 'opencode', 'continue']),
  bigtokenBaseUrl: z.string(),
  bigtokenModel: z.string(),
  opencodeBaseUrl: z.string().default(''),
  opencodeEmbedded: z.boolean().default(false),
  continueCommand: runtimePathSchema.default('cn'),
  workspacePath: z.string().default(''),
  credential: credentialSchema,
  toolApproval: toolApprovalPolicySchema
})

const savedApiKeyPayloadSchema = z.object({
  version: z.literal(2),
  apiKey: z.string()
})

const credentialPayloadSchema = z.union([
  savedApiKeyPayloadSchema,
  z.object({
    version: z.literal(1),
    apiKey: z.string(),
    origin: z.string()
  })
])

const endpointCredentialPayloadSchema = z.union([
  savedApiKeyPayloadSchema,
  z.object({
    version: z.literal(1),
    apiKey: z.string(),
    endpoint: z.string()
  })
])

const encryptSavedApiKey = (
  cipher: SettingsCredentialCipher,
  apiKey: string
) =>
  encryptSettingsCredential(cipher, {
    version: 2,
    apiKey
  })

const platformHarnessProfileId = 'goodbuddy-platform-harness'
const historicalDefaultModelBaseUrl = 'https://bigtoken.ai'
const historicalDefaultModelName = 'sonnet-5'
const historicalDefaultModelProtocol = 'anthropic-messages'

export type CredentialCipher = SettingsCredentialCipher

export type ResolvedRuntimeSettings = {
  provider: RuntimeSettings['provider']
  modelBaseUrl: string
  modelName: string
  modelProtocol: RuntimeSettings['modelProtocol']
  modelAuthentication: RuntimeSettings['modelAuthentication']
  supportsImageInput?: boolean
  imageGenerationQuality: RuntimeSettings['imageGenerationQuality']
  apiKey?: string
  modelProfiles: ResolvedModelProfile[]
  defaultModelProfileId: string
  opencodeModelProfile?: ResolvedModelProfile
  continueModelProfile?: ResolvedModelProfile
  deepseekHarnessModelProfile?: ResolvedModelProfile
  opencodeBaseUrl: string
  opencodeEmbedded: boolean
  opencodeBinaryPath: string
  opencodeConfigPath: string
  continueBinaryPath: string
  continueConfigPath: string
  continueMode: RuntimeSettings['continueMode']
  subagentSmartRoutingEnabled: boolean
  knowledgeEmbeddingEnabled: boolean
  knowledgeEmbeddingBaseUrl: string
  knowledgeEmbeddingModel: string
  knowledgeEmbeddingApiKey?: string
  embeddingConnections?: ResolvedEmbeddingConnection[]
  activeEmbeddingConnectionId?: string
  activeEmbeddingConnection?: ResolvedEmbeddingConnection
  knowledgeRerankEnabled: boolean
  knowledgeRerankEndpoint: string
  knowledgeRerankModel: string
  knowledgeRerankApiKey?: string
  contextCompression?: RuntimeSettings['contextCompression']
  runtimeCustomization: RuntimeCustomizationSettings
  workspacePath: string
  toolApproval: RuntimeSettings['toolApproval']
}

export type RuntimePolicySettings = Pick<
  ResolvedRuntimeSettings,
  'subagentSmartRoutingEnabled' | 'toolApproval'
>

export type ResolvedModelProfile = {
  id: string
  name: string
  baseUrl: string
  modelName: string
  protocol: RuntimeSettings['modelProtocol']
  authentication: RuntimeSettings['modelAuthentication']
  supportsImageInput?: boolean
  contextWindowTokens?: number
  maximumOutputTokens?: number
  imageGenerationQuality?: RuntimeSettings['imageGenerationQuality']
  requestHeaders?: RuntimeSettings['modelProfiles'][number]['requestHeaders']
  requestBody?: RuntimeSettings['modelProfiles'][number]['requestBody']
  apiKey?: string
}

export type ResolvedEmbeddingConnection =
  | {
      id: typeof builtinEmbeddingConnectionId
      name: string
      kind: 'builtin'
    }
  | {
      id: string
      name: string
      kind: 'openai-compatible'
      baseUrl: string
      modelName: string
      authentication: RuntimeSettings['modelAuthentication']
      apiKey?: string
    }

type ResolvedModelCredential = {
  activeApiKey?: string
  configured: boolean
  source: RuntimeSettings['credentialSource']
}

const defaultSettings: StoredSettings = {
  version: CURRENT_SETTINGS_VERSION,
  provider: defaultRuntimeSettings.provider,
  modelProfiles: [
    {
      id: defaultModelProfileId,
      name: '默认模型',
      baseUrl: defaultRuntimeSettings.modelBaseUrl,
      modelName: defaultRuntimeSettings.modelName,
      protocol: defaultRuntimeSettings.modelProtocol,
      authentication: defaultRuntimeSettings.modelAuthentication,
      supportsImageInput: defaultRuntimeSettings.supportsImageInput,
      imageGenerationQuality:
        defaultRuntimeSettings.imageGenerationQuality,
      requestHeaders: {},
      requestBody: {}
    }
  ],
  defaultModelProfileId,
  opencodeModelSource: {
    kind: 'profile',
    profileId: defaultModelProfileId
  },
  continueModelSource: {
    kind: 'profile',
    profileId: defaultModelProfileId
  },
  opencodeBaseUrl: defaultRuntimeSettings.opencodeBaseUrl,
  opencodeEmbedded: defaultRuntimeSettings.opencodeEmbedded,
  opencodeBinaryPath: defaultRuntimeSettings.opencodeBinaryPath,
  opencodeConfigPath: defaultRuntimeSettings.opencodeConfigPath,
  continueBinaryPath: defaultRuntimeSettings.continueBinaryPath,
  continueConfigPath: defaultRuntimeSettings.continueConfigPath,
  continueMode: defaultRuntimeSettings.continueMode,
  deepseekHarnessModelSource: { kind: 'platform' },
  subagentSmartRoutingEnabled:
    defaultRuntimeSettings.subagentSmartRoutingEnabled,
  knowledgeEmbeddingEnabled:
    defaultRuntimeSettings.knowledgeEmbeddingEnabled,
  knowledgeEmbeddingBaseUrl:
    defaultRuntimeSettings.knowledgeEmbeddingBaseUrl,
  knowledgeEmbeddingModel:
    defaultRuntimeSettings.knowledgeEmbeddingModel,
  embeddingConnections: [
    {
      id: builtinEmbeddingConnectionId,
      name: 'GoodBuddy 内置向量模型',
      kind: 'builtin'
    },
    {
      id: legacyEmbeddingConnectionId,
      name: '自定义向量模型',
      kind: 'openai-compatible',
      baseUrl: defaultRuntimeSettings.knowledgeEmbeddingBaseUrl,
      modelName: defaultRuntimeSettings.knowledgeEmbeddingModel,
      authentication: 'api-key'
    }
  ],
  activeEmbeddingConnectionId: builtinEmbeddingConnectionId,
  knowledgeRerankEnabled:
    defaultRuntimeSettings.knowledgeRerankEnabled,
  knowledgeRerankEndpoint:
    defaultRuntimeSettings.knowledgeRerankEndpoint,
  knowledgeRerankModel:
    defaultRuntimeSettings.knowledgeRerankModel,
  contextCompression: defaultContextCompressionSettings,
  runtimeCustomization: defaultRuntimeCustomizationSettings,
  workspacePath: defaultRuntimeSettings.workspacePath,
  toolApproval: defaultRuntimeSettings.toolApproval
}

function migrateContinueCommand(command: string): string {
  const value = command.trim()
  return value === 'cn' ? '' : value
}

function normalizeModelBaseUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('模型服务地址必须使用 HTTP 或 HTTPS')
  }
  url.pathname = url.pathname.replace(/\/+$/u, '')
  return url.toString().replace(/\/$/u, '')
}

function compatibleTextProfileId(
  settings: Pick<
    Version10StoredSettings,
    'modelProfiles' | 'defaultModelProfileId'
  >
): string | undefined {
  const defaultProfile = settings.modelProfiles.find(
    (profile) => profile.id === settings.defaultModelProfileId
  )
  if (
    defaultProfile &&
    defaultProfile.protocol !== 'openai-images-generations'
  ) {
    return defaultProfile.id
  }
  return settings.modelProfiles.find(
    (profile) => profile.protocol !== 'openai-images-generations'
  )?.id
}

function migrateVersion11(
  settings: Version11StoredSettings
): StoredSettings {
  const {
    intranetCompatibilityEnabled: _obsolete,
    ...current
  } = settings
  void _obsolete
  return migrateVersion12({
    ...current,
    version: 12
  })
}

function migrateVersion12(
  settings: Version12StoredSettings
): StoredSettings {
  return migrateVersion13({
    ...settings,
    version: 13,
    modelProfiles: settings.modelProfiles.map((profile) => ({
      ...profile,
      supportsImageInput: false
    }))
  })
}

function migrateVersion13(
  settings: Version13StoredSettings
): StoredSettings {
  return migrateVersion14({
    ...settings,
    version: 14,
    knowledgeRerankEnabled:
      defaultRuntimeSettings.knowledgeRerankEnabled,
    knowledgeRerankEndpoint:
      defaultRuntimeSettings.knowledgeRerankEndpoint,
    knowledgeRerankModel:
      defaultRuntimeSettings.knowledgeRerankModel,
    knowledgeRerankCredential: undefined
  })
}

function migrateVersion14(
  settings: Version14StoredSettings
): StoredSettings {
  const {
    runtimeSandboxMode: _obsolete,
    ...current
  } = settings
  void _obsolete
  return migrateVersion18({
    ...current,
    version: 18,
    deepseekHarnessModelSource: { kind: 'platform' },
    contextCompression: defaultContextCompressionSettings,
    runtimeCustomization: defaultRuntimeCustomizationSettings
  })
}

function migrateVersion15(
  settings: Version15StoredSettings
): StoredSettings {
  const {
    deepseekHarnessBinaryPath: _obsolete,
    runtimeSandboxMode: _obsoleteSandbox,
    ...current
  } = settings
  void _obsolete
  void _obsoleteSandbox
  return migrateVersion18({
    ...current,
    version: 18,
    contextCompression: defaultContextCompressionSettings,
    runtimeCustomization: defaultRuntimeCustomizationSettings
  })
}

function migrateVersion16(
  settings: Version16StoredSettings
): StoredSettings {
  return migrateVersion18({
    ...settings,
    version: 18,
    contextCompression: defaultContextCompressionSettings,
    runtimeCustomization: defaultRuntimeCustomizationSettings
  })
}

function migrateVersion17(
  settings: Version17StoredSettings
): StoredSettings {
  return migrateVersion18({
    ...settings,
    version: 18,
    runtimeCustomization: defaultRuntimeCustomizationSettings
  })
}

function migrateVersion18(
  settings: Version18StoredSettings
): StoredSettings {
  return migrateVersion19({
    ...settings,
    version: 19,
    embeddingConnections: [
      {
        id: builtinEmbeddingConnectionId,
        name: 'GoodBuddy 内置向量模型',
        kind: 'builtin'
      },
      {
        id: legacyEmbeddingConnectionId,
        name: '自定义向量模型',
        kind: 'openai-compatible',
        baseUrl: settings.knowledgeEmbeddingBaseUrl,
        modelName: settings.knowledgeEmbeddingModel,
        authentication: 'api-key',
        credential: settings.knowledgeEmbeddingCredential
      }
    ],
    activeEmbeddingConnectionId: legacyEmbeddingConnectionId
  })
}

function migrateVersion19(
  settings: Version19StoredSettings
): StoredSettings {
  return migrateVersion20({
    ...settings,
    version: 20,
    modelProfiles: settings.modelProfiles.map((profile) =>
      profile.id === defaultModelProfileId &&
      profile.name === '默认模型' &&
      profile.baseUrl === historicalDefaultModelBaseUrl &&
      profile.modelName === historicalDefaultModelName &&
      profile.protocol === historicalDefaultModelProtocol &&
      profile.authentication === 'api-key' &&
      profile.supportsImageInput === false &&
      profile.imageGenerationQuality === 'auto' &&
      profile.contextWindowTokens === undefined &&
      profile.credential === undefined
        ? {
            ...profile,
            baseUrl: defaultRuntimeSettings.modelBaseUrl,
            modelName: defaultRuntimeSettings.modelName,
            protocol: defaultRuntimeSettings.modelProtocol,
            authentication:
              defaultRuntimeSettings.modelAuthentication
          }
        : profile
    )
  })
}

function migrateVersion20(
  settings: Version20StoredSettings
): StoredSettings {
  return {
    ...settings,
    version: CURRENT_SETTINGS_VERSION,
    modelProfiles: settings.modelProfiles.map((profile) => ({
      ...profile,
      requestHeaders: {},
      requestBody: {}
    }))
  }
}

function migrateVersion10(
  settings: Version10StoredSettings
): StoredSettings {
  const profileId = compatibleTextProfileId(settings)
  const preserveOpenCodePlatform =
    settings.opencodeModelSource.kind === 'platform' &&
    (settings.provider === 'opencode' ||
      Boolean(settings.opencodeBaseUrl.trim()) ||
      Boolean(settings.opencodeConfigPath.trim()))
  const preserveContinuePlatform =
    settings.continueModelSource.kind === 'platform' &&
    (settings.provider === 'continue' ||
      Boolean(settings.continueConfigPath.trim()))

  return migrateVersion11({
    ...settings,
    version: 11,
    provider: settings.provider === 'auto' ? 'model' : settings.provider,
    opencodeModelSource:
      settings.opencodeModelSource.kind === 'profile' ||
      preserveOpenCodePlatform ||
      !profileId
        ? settings.opencodeModelSource
        : { kind: 'profile', profileId },
    continueModelSource:
      settings.continueModelSource.kind === 'profile' ||
      preserveContinuePlatform ||
      !profileId
        ? settings.continueModelSource
        : { kind: 'profile', profileId },
    opencodeEmbedded: !settings.opencodeBaseUrl.trim()
  })
}

function normalizeStoredSettings(settings: StoredSettings): StoredSettings {
  const modelProfiles = settings.modelProfiles.map((profile) => ({
    ...profile,
    baseUrl: normalizeModelBaseUrl(profile.baseUrl),
    contextWindowTokens:
      profile.contextWindowTokens === undefined ||
      profile.contextWindowTokens >= minimumModelContextWindowTokens
        ? profile.contextWindowTokens
        : undefined
  }))
  const fallbackProfileId = compatibleTextProfileId({
    modelProfiles,
    defaultModelProfileId: settings.defaultModelProfileId
  })
  const normalizeSource = (
    source: RuntimeSettings['opencodeModelSource']
  ): RuntimeSettings['opencodeModelSource'] => {
    if (source.kind === 'platform') {
      return source
    }
    const profile = modelProfiles.find(
      (candidate) => candidate.id === source.profileId
    )
    if (profile && isAgentRuntimeModelProtocol(profile.protocol)) {
      return source
    }
    return fallbackProfileId
      ? { kind: 'profile', profileId: fallbackProfileId }
      : { kind: 'platform' }
  }
  const normalizeDeepSeekHarnessSource = (
    source: RuntimeSettings['deepseekHarnessModelSource']
  ): NonNullable<RuntimeSettings['deepseekHarnessModelSource']> => {
    if (!source || source.kind === 'platform') {
      return { kind: 'platform' }
    }
    const profile = modelProfiles.find(
      (candidate) => candidate.id === source.profileId
    )
    return profile && isDeepSeekHarnessModelProfile(profile)
      ? source
      : { kind: 'platform' }
  }
  const opencodeBaseUrl = settings.opencodeBaseUrl.trim()
  if (opencodeBaseUrl) {
    const url = new URL(opencodeBaseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('OpenCode 地址必须使用 HTTP 或 HTTPS')
    }
  }
  const defaultModelProfileId = modelProfiles.some(
    (profile) => profile.id === settings.defaultModelProfileId
  )
    ? settings.defaultModelProfileId
    : modelProfiles[0]!.id
  const compressionSource = settings.contextCompression.modelSource
  const compressionProfile =
    compressionSource.kind === 'profile'
      ? modelProfiles.find(
          (profile) => profile.id === compressionSource.profileId
        )
      : undefined
  const contextCompression = {
    ...settings.contextCompression,
    modelSource:
      compressionSource.kind === 'profile' &&
      compressionProfile &&
      isAgentRuntimeModelProtocol(compressionProfile.protocol)
        ? compressionSource
        : ({ kind: 'current' } as const)
  }
  const userEmbeddingConnections = settings.embeddingConnections
    .filter((connection) => connection.kind === 'openai-compatible')
    .map((connection) => ({
      ...connection,
      baseUrl: normalizeModelBaseUrl(connection.baseUrl)
    }))
  const embeddingConnections: StoredSettings['embeddingConnections'] = [
    {
      id: builtinEmbeddingConnectionId,
      name: 'GoodBuddy 内置向量模型',
      kind: 'builtin'
    },
    ...userEmbeddingConnections
  ]
  const activeEmbeddingConnectionId = embeddingConnections.some(
    (connection) =>
      connection.id === settings.activeEmbeddingConnectionId
  )
    ? settings.activeEmbeddingConnectionId
    : builtinEmbeddingConnectionId

  return {
    ...settings,
    modelProfiles,
    provider:
      settings.provider === 'auto' ? 'model' : settings.provider,
    defaultModelProfileId,
    opencodeModelSource: opencodeBaseUrl
      ? { kind: 'platform' }
      : normalizeSource(settings.opencodeModelSource),
    continueModelSource: normalizeSource(
      settings.continueModelSource
    ),
    deepseekHarnessModelSource: normalizeDeepSeekHarnessSource(
      settings.deepseekHarnessModelSource
    ),
    contextCompression,
    embeddingConnections,
    activeEmbeddingConnectionId,
    opencodeBaseUrl,
    opencodeEmbedded: !opencodeBaseUrl
  }
}

function migrateVersion4(
  settings: z.infer<typeof version4StoredSettingsSchema>
): StoredSettings {
  return migrateVersion10({
    version: 10,
    provider: settings.provider,
    modelProfiles: [
      {
        id: defaultModelProfileId,
        name: '默认模型',
        baseUrl: settings.modelBaseUrl,
        modelName: settings.modelName,
        protocol: 'anthropic-messages',
        authentication: 'api-key',
        imageGenerationQuality:
          defaultRuntimeSettings.imageGenerationQuality,
        credential: settings.credential
      }
    ],
    defaultModelProfileId,
    opencodeModelSource: { kind: 'platform' },
    continueModelSource: { kind: 'platform' },
    opencodeBaseUrl: settings.opencodeBaseUrl,
    opencodeEmbedded: settings.opencodeEmbedded,
    opencodeBinaryPath: settings.opencodeBinaryPath,
    opencodeConfigPath: settings.opencodeConfigPath,
    continueBinaryPath: settings.continueBinaryPath,
    continueConfigPath: settings.continueConfigPath,
    continueMode: settings.continueMode,
    runtimeSandboxMode: 'auto',
    subagentSmartRoutingEnabled:
      defaultRuntimeSettings.subagentSmartRoutingEnabled,
    intranetCompatibilityEnabled: true,
    knowledgeEmbeddingEnabled:
      defaultRuntimeSettings.knowledgeEmbeddingEnabled,
    knowledgeEmbeddingBaseUrl:
      defaultRuntimeSettings.knowledgeEmbeddingBaseUrl,
    knowledgeEmbeddingModel:
      defaultRuntimeSettings.knowledgeEmbeddingModel,
    workspacePath: settings.workspacePath,
    toolApproval: settings.toolApproval
  })
}

function migrateVersion5(
  settings: z.infer<typeof version5StoredSettingsSchema>
): StoredSettings {
  return migrateVersion10({
    ...settings,
    version: 10,
    runtimeSandboxMode: 'auto',
    subagentSmartRoutingEnabled:
      defaultRuntimeSettings.subagentSmartRoutingEnabled,
    intranetCompatibilityEnabled: true,
    knowledgeEmbeddingEnabled:
      defaultRuntimeSettings.knowledgeEmbeddingEnabled,
    knowledgeEmbeddingBaseUrl:
      defaultRuntimeSettings.knowledgeEmbeddingBaseUrl,
    knowledgeEmbeddingModel:
      defaultRuntimeSettings.knowledgeEmbeddingModel,
    modelProfiles: settings.modelProfiles.map((profile) => ({
      ...profile,
      protocol: 'anthropic-messages',
      authentication: 'api-key',
      imageGenerationQuality:
        defaultRuntimeSettings.imageGenerationQuality
    }))
  })
}

function migrateVersion6(
  settings: z.infer<typeof version6StoredSettingsSchema>
): StoredSettings {
  let knowledgeEmbeddingBaseUrl: string =
    defaultRuntimeSettings.knowledgeEmbeddingBaseUrl
  try {
    const endpoint = new URL(settings.knowledgeEmbeddingBaseUrl)
    if (['http:', 'https:'].includes(endpoint.protocol)) {
      const path = endpoint.pathname.replace(/\/+$/u, '')
      if (!/\/v1\/embeddings$/iu.test(path)) {
        endpoint.pathname = `${path}/v1/embeddings`
      }
      knowledgeEmbeddingBaseUrl = endpoint.toString()
    }
  } catch {
    // Preserve the rest of the legacy settings and repair only this endpoint.
  }
  return migrateVersion10({
    ...settings,
    version: 10,
    subagentSmartRoutingEnabled:
      defaultRuntimeSettings.subagentSmartRoutingEnabled,
    intranetCompatibilityEnabled: true,
    knowledgeEmbeddingBaseUrl,
    modelProfiles: settings.modelProfiles.map((profile) => ({
      ...profile,
      imageGenerationQuality:
        defaultRuntimeSettings.imageGenerationQuality
    }))
  })
}

function migrateVersion7(
  settings: z.infer<typeof version7StoredSettingsSchema>
): StoredSettings {
  return migrateVersion10({
    ...settings,
    version: 10,
    subagentSmartRoutingEnabled:
      defaultRuntimeSettings.subagentSmartRoutingEnabled,
    intranetCompatibilityEnabled: true,
    modelProfiles: settings.modelProfiles.map((profile) => ({
      ...profile,
      imageGenerationQuality:
        defaultRuntimeSettings.imageGenerationQuality
    }))
  })
}

function migrateVersion8(
  settings: z.infer<typeof version8StoredSettingsSchema>
): StoredSettings {
  return migrateVersion10({
    ...settings,
    version: 10,
    subagentSmartRoutingEnabled: false,
    intranetCompatibilityEnabled: true
  })
}

function migrateVersion9(
  settings: z.infer<typeof version9StoredSettingsSchema>
): StoredSettings {
  return migrateVersion10({
    ...settings,
    version: 10,
    intranetCompatibilityEnabled: true
  })
}

function migrateVersion3(
  settings: z.infer<typeof version3StoredSettingsSchema>
): StoredSettings {
  return migrateVersion4({
    ...settings,
    version: 4,
    continueMode: 'chat'
  })
}

function migrateVersion2(
  settings: z.infer<typeof version2StoredSettingsSchema>
): StoredSettings {
  return migrateVersion4({
    version: 4,
    provider: settings.provider,
    modelBaseUrl: settings.modelBaseUrl,
    modelName: settings.modelName,
    opencodeBaseUrl: settings.opencodeBaseUrl,
    opencodeEmbedded: settings.opencodeEmbedded,
    opencodeBinaryPath: '',
    opencodeConfigPath: '',
    continueBinaryPath: migrateContinueCommand(
      settings.continueCommand
    ),
    continueConfigPath: '',
    continueMode: 'chat',
    workspacePath: settings.workspacePath,
    credential: settings.credential,
    toolApproval: settings.toolApproval
  })
}

function migrateLegacySettings(
  settings: z.infer<typeof legacyStoredSettingsSchema>
): StoredSettings {
  return migrateVersion4({
    version: 4,
    provider:
      settings.provider === 'bigtoken' ? 'model' : settings.provider,
    modelBaseUrl: settings.bigtokenBaseUrl,
    modelName: settings.bigtokenModel,
    opencodeBaseUrl: settings.opencodeBaseUrl,
    opencodeEmbedded: settings.opencodeEmbedded,
    opencodeBinaryPath: '',
    opencodeConfigPath: '',
    continueBinaryPath: migrateContinueCommand(
      settings.continueCommand
    ),
    continueConfigPath: '',
    continueMode: 'chat',
    workspacePath: settings.workspacePath,
    credential: settings.credential,
    toolApproval: settings.toolApproval
  })
}

function parseStoredSettings(value: unknown): StoredSettings {
  const version =
    value !== null &&
    typeof value === 'object' &&
    'version' in value &&
    typeof value.version === 'number'
      ? value.version
      : undefined
  switch (version) {
    case CURRENT_SETTINGS_VERSION:
      return storedSettingsSchema.parse(value)
    case 20:
      return migrateVersion20(version20StoredSettingsSchema.parse(value))
    case 19:
      return migrateVersion19(version19StoredSettingsSchema.parse(value))
    case 18:
      return migrateVersion18(version18StoredSettingsSchema.parse(value))
    case 17:
      return migrateVersion17(version17StoredSettingsSchema.parse(value))
    case 16:
      return migrateVersion16(version16StoredSettingsSchema.parse(value))
    case 15:
      return migrateVersion15(version15StoredSettingsSchema.parse(value))
    case 14:
      return migrateVersion14(version14StoredSettingsSchema.parse(value))
    case 13:
      return migrateVersion13(version13StoredSettingsSchema.parse(value))
    case 12:
      return migrateVersion12(version12StoredSettingsSchema.parse(value))
    case 11:
      return migrateVersion11(version11StoredSettingsSchema.parse(value))
    case 10:
      return migrateVersion10(version10StoredSettingsSchema.parse(value))
    case 9:
      return migrateVersion9(version9StoredSettingsSchema.parse(value))
    case 8:
      return migrateVersion8(version8StoredSettingsSchema.parse(value))
    case 7:
      return migrateVersion7(version7StoredSettingsSchema.parse(value))
    case 6:
      return migrateVersion6(version6StoredSettingsSchema.parse(value))
    case 5:
      return migrateVersion5(version5StoredSettingsSchema.parse(value))
    case 4:
      return migrateVersion4(version4StoredSettingsSchema.parse(value))
    case 3:
      return migrateVersion3(version3StoredSettingsSchema.parse(value))
    case 2:
      return migrateVersion2(version2StoredSettingsSchema.parse(value))
    default:
      return migrateLegacySettings(
        legacyStoredSettingsSchema.parse(value)
      )
  }
}

export class RuntimeSettingsStore {
  private settings?: StoredSettings
  private settingsLoad?: Promise<StoredSettings>
  private loadWarnings: SettingsWarning[] = []
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly cipher: CredentialCipher,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  private load(): Promise<StoredSettings> {
    if (this.settings) {
      return Promise.resolve(this.settings)
    }
    if (!this.settingsLoad) {
      this.settingsLoad = this.readSettings().finally(() => {
        this.settingsLoad = undefined
      })
    }
    return this.settingsLoad
  }

  private async readSettings(): Promise<StoredSettings> {
    try {
      const contents = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(contents)
      assertSupportedSettingsVersion(
        parsed,
        CURRENT_SETTINGS_VERSION,
        (version) =>
          `当前 GoodBuddy 不支持 Runtime 设置版本 ${version}，请升级应用后重试`
      )
      this.settings = parseStoredSettings(parsed)
      this.settings = normalizeStoredSettings(this.settings)
    } catch (error) {
      if (error instanceof UnsupportedSettingsVersionError) {
        throw error
      }
      if (!isMissingFileError(error)) {
        await isolateCorruptSettingsFile(
          this.filePath,
          'Runtime 设置已损坏且无法隔离'
        )
        this.loadWarnings = [{ code: 'runtime-settings-recovered' }]
      }
      this.settings = { ...defaultSettings }
    }
    return this.settings
  }

  private getStoredApiKey(
    profile: StoredSettings['modelProfiles'][number]
  ): string | undefined {
    if (!profile.credential) {
      return undefined
    }
    const warning = (code: SettingsWarning['code']): undefined => {
      this.addWarning({ code, subject: profile.name })
      return undefined
    }
    if (!this.cipher.isAvailable()) {
      return warning('runtime-model-credential-unreadable')
    }
    try {
      const payload = credentialPayloadSchema.parse(
        decryptSettingsCredential(this.cipher, profile.credential)
      )
      this.removeWarnings(
        ['runtime-model-credential-unreadable'],
        profile.name
      )
      return payload.apiKey
    } catch {
      return warning('runtime-model-credential-unreadable')
    }
  }

  private getStoredEmbeddingApiKey(
    settings: StoredSettings
  ): string | undefined {
    if (!settings.knowledgeEmbeddingCredential) {
      return undefined
    }
    if (!this.cipher.isAvailable()) {
      this.addWarning({
        code: 'runtime-embedding-credential-unreadable'
      })
      return undefined
    }
    try {
      const payload = endpointCredentialPayloadSchema.parse(
        decryptSettingsCredential(
          this.cipher,
          settings.knowledgeEmbeddingCredential
        )
      )
      this.removeWarnings(['runtime-embedding-credential-unreadable'])
      return payload.apiKey
    } catch {
      this.addWarning({
        code: 'runtime-embedding-credential-unreadable'
      })
      return undefined
    }
  }

  private getEmbeddingConnectionApiKey(
    connection: Extract<
      StoredSettings['embeddingConnections'][number],
      { kind: 'openai-compatible' }
    >
  ): string | undefined {
    if (!connection.credential) {
      return undefined
    }
    if (!this.cipher.isAvailable()) {
      this.addWarning({
        code: 'runtime-embedding-credential-unreadable'
      })
      return undefined
    }
    try {
      return endpointCredentialPayloadSchema.parse(
        decryptSettingsCredential(this.cipher, connection.credential)
      ).apiKey
    } catch {
      this.addWarning({
        code: 'runtime-embedding-credential-unreadable'
      })
      return undefined
    }
  }

  private resolveEmbeddingConnections(
    settings: StoredSettings
  ): ResolvedEmbeddingConnection[] {
    const environmentApiKey =
      this.environment.GOODBUDDY_EMBEDDING_API_KEY?.trim()
    return settings.embeddingConnections.map((connection) => {
      if (connection.kind === 'builtin') {
        return connection
      }
      const storedApiKey =
        connection.id === legacyEmbeddingConnectionId &&
        environmentApiKey
          ? undefined
          : this.getEmbeddingConnectionApiKey(connection)
      return {
        id: connection.id,
        name: connection.name,
        kind: connection.kind,
        baseUrl: connection.baseUrl,
        modelName: connection.modelName,
        authentication: connection.authentication,
        apiKey:
          connection.authentication === 'api-key'
            ? connection.id === legacyEmbeddingConnectionId
              ? environmentApiKey || storedApiKey
              : storedApiKey
            : undefined
      }
    })
  }

  private getStoredRerankApiKey(
    settings: StoredSettings
  ): string | undefined {
    if (!settings.knowledgeRerankCredential) {
      return undefined
    }
    if (!this.cipher.isAvailable()) {
      this.addWarning({
        code: 'runtime-rerank-credential-unreadable'
      })
      return undefined
    }
    try {
      const payload = endpointCredentialPayloadSchema.parse(
        decryptSettingsCredential(
          this.cipher,
          settings.knowledgeRerankCredential
        )
      )
      this.removeWarnings(['runtime-rerank-credential-unreadable'])
      return payload.apiKey
    } catch {
      this.addWarning({
        code: 'runtime-rerank-credential-unreadable'
      })
      return undefined
    }
  }

  private addWarning(warning: SettingsWarning): void {
    if (
      !this.loadWarnings.some(
        (current) => settingsWarningsEqual(current, warning)
      )
    ) {
      this.loadWarnings.push(warning)
    }
  }

  private removeWarnings(
    codes: readonly SettingsWarning['code'][],
    subject?: string
  ): void {
    this.loadWarnings = this.loadWarnings.filter(
      (warning) =>
        !(
          codes.includes(warning.code) &&
          (subject === undefined || warning.subject === subject)
        )
    )
  }

  private getEnvironmentApiKey(): string | undefined {
    return (
      this.environment.GOODBUDDY_MODEL_API_KEY?.trim() ||
      this.environment.GOODBUDDY_BIGTOKEN_API_KEY?.trim() ||
      undefined
    )
  }

  private resolvePlatformHarnessProfile(): ResolvedModelProfile | undefined {
    const apiKey = this.environment.GOODBUDDY_MODEL_API_KEY?.trim()
    const baseUrl = this.environment.GOODBUDDY_MODEL_BASE_URL?.trim()
    const modelName = this.environment.GOODBUDDY_MODEL_NAME?.trim()
    if (!apiKey || !baseUrl || !modelName) {
      return undefined
    }
    if (
      !isDeepSeekHarnessModelProfile({
        baseUrl,
        protocol: 'openai-chat-completions',
        authentication: 'api-key'
      })
    ) {
      return undefined
    }
    return {
      id: platformHarnessProfileId,
      name: '管理员预置模型',
      baseUrl,
      modelName,
      protocol: 'openai-chat-completions',
      authentication: 'api-key',
      supportsImageInput: false,
      imageGenerationQuality: 'auto',
      apiKey
    }
  }

  private resolveDeepSeekHarnessModelProfile(
    settings: StoredSettings,
    modelProfiles: readonly ResolvedModelProfile[]
  ): ResolvedModelProfile | undefined {
    const source = settings.deepseekHarnessModelSource
    if (source.kind === 'profile') {
      return modelProfiles.find(
        (profile) => profile.id === source.profileId
      )
    }
    const platformProfile = this.resolvePlatformHarnessProfile()
    if (platformProfile) {
      return platformProfile
    }
    return (
      modelProfiles.find(
        (profile) =>
          profile.id === settings.defaultModelProfileId &&
          isDeepSeekHarnessModelProfile(profile)
      ) ??
      modelProfiles.find(isDeepSeekHarnessModelProfile)
    )
  }

  private resolveModelCredentials(
    settings: StoredSettings
  ): Map<string, ResolvedModelCredential> {
    const defaultProfile =
      settings.modelProfiles.find(
        (profile) => profile.id === settings.defaultModelProfileId
      ) ?? settings.modelProfiles[0]
    const environmentApiKey = this.getEnvironmentApiKey()
    return new Map(
      settings.modelProfiles.map((profile) => {
        const environmentManaged =
          profile.id === defaultProfile?.id &&
          Boolean(environmentApiKey)
        const storedApiKey = environmentManaged
          ? undefined
          : this.getStoredApiKey(profile)
        const source: RuntimeSettings['credentialSource'] =
          environmentManaged
            ? 'environment'
            : storedApiKey
              ? 'encrypted'
              : profile.credential
                ? 'unreadable'
                : 'none'
        return [
          profile.id,
          {
            activeApiKey:
              environmentManaged
                ? environmentApiKey
                : profile.authentication === 'api-key'
                  ? storedApiKey
                  : undefined,
            configured: environmentManaged || Boolean(storedApiKey),
            source
          }
        ]
      })
    )
  }

  private resolveEffectiveModelSettings(
    settings: StoredSettings,
    credentials: ReadonlyMap<string, ResolvedModelCredential>
  ): {
    apiKey?: string
    baseUrl: string
    model: string
    protocol: RuntimeSettings['modelProtocol']
    authentication: RuntimeSettings['modelAuthentication']
    supportsImageInput: boolean
    contextWindowTokens?: number
    maximumOutputTokens?: number
    imageGenerationQuality: RuntimeSettings['imageGenerationQuality']
    requestHeaders: RuntimeSettings['modelProfiles'][number]['requestHeaders']
    requestBody: RuntimeSettings['modelProfiles'][number]['requestBody']
    credentialSource: RuntimeSettings['credentialSource']
  } {
    const profile =
      settings.modelProfiles.find(
        (candidate) => candidate.id === settings.defaultModelProfileId
      ) ?? settings.modelProfiles[0]
    if (!profile) {
      throw new Error('默认模型连接不存在')
    }
    const credential = credentials.get(profile.id)
    if (!credential) {
      throw new Error(`模型连接不存在：${profile.id}`)
    }
    const environmentManaged = credential.source === 'environment'
    const genericEnvironmentApiKey =
      this.environment.GOODBUDDY_MODEL_API_KEY?.trim()
    const legacyEnvironmentApiKey =
      this.environment.GOODBUDDY_BIGTOKEN_API_KEY?.trim()
    const genericEnvironmentBaseUrl =
      this.environment.GOODBUDDY_MODEL_BASE_URL?.trim()
    const legacyEnvironmentBaseUrl =
      this.environment.GOODBUDDY_BIGTOKEN_BASE_URL?.trim()
    const genericEnvironmentModel =
      this.environment.GOODBUDDY_MODEL_NAME?.trim()
    const legacyEnvironmentModel =
      this.environment.GOODBUDDY_BIGTOKEN_MODEL?.trim()
    const legacyEnvironmentConnection =
      environmentManaged &&
      !genericEnvironmentApiKey &&
      Boolean(legacyEnvironmentApiKey) &&
      !genericEnvironmentBaseUrl &&
      !genericEnvironmentModel
    const environmentBaseUrl =
      genericEnvironmentBaseUrl || legacyEnvironmentBaseUrl
    const environmentModel =
      genericEnvironmentModel || legacyEnvironmentModel
    const baseUrl = environmentManaged
      ? environmentBaseUrl ||
        (legacyEnvironmentConnection
          ? historicalDefaultModelBaseUrl
          : defaultRuntimeSettings.modelBaseUrl)
      : profile.baseUrl
    const model = environmentManaged
      ? environmentModel ||
        (legacyEnvironmentConnection
          ? historicalDefaultModelName
          : defaultRuntimeSettings.modelName)
      : profile.modelName
    return {
      apiKey: credential.activeApiKey,
      baseUrl,
      model,
      protocol: legacyEnvironmentConnection
        ? historicalDefaultModelProtocol
        : profile.protocol,
      authentication: environmentManaged
        ? 'api-key'
        : profile.authentication,
      supportsImageInput: profile.supportsImageInput,
      contextWindowTokens: profile.contextWindowTokens,
      maximumOutputTokens: profile.maximumOutputTokens,
      imageGenerationQuality: profile.imageGenerationQuality,
      requestHeaders: profile.requestHeaders,
      requestBody: profile.requestBody,
      credentialSource: credential.source
    }
  }

  private resolveModelProfiles(
    settings: StoredSettings,
    effective: ReturnType<
      RuntimeSettingsStore['resolveEffectiveModelSettings']
    >,
    credentials: ReadonlyMap<string, ResolvedModelCredential>
  ): ResolvedModelProfile[] {
    return settings.modelProfiles.map((profile) => {
      if (profile.id === settings.defaultModelProfileId) {
        return {
          id: profile.id,
          name: profile.name,
          baseUrl: effective.baseUrl,
          modelName: effective.model,
          protocol: effective.protocol,
          authentication: effective.authentication,
          supportsImageInput: effective.supportsImageInput,
          contextWindowTokens: effective.contextWindowTokens,
          maximumOutputTokens: effective.maximumOutputTokens,
          imageGenerationQuality: effective.imageGenerationQuality,
          requestHeaders: effective.requestHeaders,
          requestBody: effective.requestBody,
          apiKey: effective.apiKey
        }
      }
      const credential = credentials.get(profile.id)
      if (!credential) {
        throw new Error(`模型连接不存在：${profile.id}`)
      }
      return {
        id: profile.id,
        name: profile.name,
        baseUrl: profile.baseUrl,
        modelName: profile.modelName,
        protocol: profile.protocol,
        authentication: profile.authentication,
        supportsImageInput: profile.supportsImageInput,
        contextWindowTokens: profile.contextWindowTokens,
        maximumOutputTokens: profile.maximumOutputTokens,
        imageGenerationQuality: profile.imageGenerationQuality,
        requestHeaders: profile.requestHeaders,
        requestBody: profile.requestBody,
        apiKey: credential.activeApiKey
      }
    })
  }

  private resolveAgentSettings(settings: StoredSettings): {
    opencodeBaseUrl: string
    opencodeEmbedded: boolean
    opencodeBinaryPath: string
    opencodeConfigPath: string
    continueBinaryPath: string
    continueConfigPath: string
    continueMode: RuntimeSettings['continueMode']
    workspacePath: string
  } {
    const continueBinaryEnvironment =
      this.environment.GOODBUDDY_CONTINUE_BINARY?.trim()
    const legacyContinueCommand =
      this.environment.GOODBUDDY_CONTINUE_COMMAND?.trim()
    const opencodeBaseUrl =
      this.environment.GOODBUDDY_OPENCODE_URL?.trim() ??
      settings.opencodeBaseUrl
    return {
      opencodeBaseUrl,
      opencodeEmbedded: !opencodeBaseUrl,
      opencodeBinaryPath:
        this.environment.GOODBUDDY_OPENCODE_BINARY?.trim() ||
        settings.opencodeBinaryPath,
      opencodeConfigPath:
        this.environment.GOODBUDDY_OPENCODE_CONFIG?.trim() ||
        settings.opencodeConfigPath,
      continueBinaryPath:
        continueBinaryEnvironment ||
        (legacyContinueCommand
          ? migrateContinueCommand(legacyContinueCommand)
          : '') ||
        settings.continueBinaryPath,
      continueConfigPath:
        this.environment.GOODBUDDY_CONTINUE_CONFIG?.trim() ||
        settings.continueConfigPath,
      continueMode: settings.continueMode,
      workspacePath:
        this.environment.GOODBUDDY_WORKSPACE?.trim() ||
        settings.workspacePath ||
        homedir()
    }
  }

  private toPublicSettings(settings: StoredSettings): RuntimeSettings {
    const credentials = this.resolveModelCredentials(settings)
    const effective = this.resolveEffectiveModelSettings(
      settings,
      credentials
    )
    const agent = this.resolveAgentSettings(settings)
    const resolvedModelProfiles = this.resolveModelProfiles(
      settings,
      effective,
      credentials
    )
    const resolvedProfilesById = new Map(
      resolvedModelProfiles.map((profile) => [profile.id, profile])
    )
    const modelProfiles = settings.modelProfiles.map((profile) => {
      const resolved = resolvedProfilesById.get(profile.id)
      if (!resolved) {
        throw new Error(`模型连接不存在：${profile.id}`)
      }
      const credential = credentials.get(profile.id)
      if (!credential) {
        throw new Error(`模型连接不存在：${profile.id}`)
      }
      return {
        id: profile.id,
        name: profile.name,
        baseUrl: resolved.baseUrl,
        modelName: resolved.modelName,
        protocol: resolved.protocol,
        authentication: resolved.authentication,
        supportsImageInput: resolved.supportsImageInput,
        contextWindowTokens: resolved.contextWindowTokens,
        maximumOutputTokens: resolved.maximumOutputTokens,
        imageGenerationQuality:
          resolved.imageGenerationQuality ??
          defaultRuntimeSettings.imageGenerationQuality,
        requestHeaders: resolved.requestHeaders ?? {},
        requestBody: resolved.requestBody ?? {},
        apiKeyConfigured: credential.configured,
        credentialSource: credential.source
      }
    })
    const configuredModelProfiles = settings.modelProfiles.map((profile) => {
      const credential = credentials.get(profile.id)
      if (!credential) {
        throw new Error(`模型连接不存在：${profile.id}`)
      }
      return {
        id: profile.id,
        name: profile.name,
        baseUrl: profile.baseUrl,
        modelName: profile.modelName,
        protocol: profile.protocol,
        authentication: profile.authentication,
        supportsImageInput: profile.supportsImageInput,
        contextWindowTokens: profile.contextWindowTokens,
        maximumOutputTokens: profile.maximumOutputTokens,
        imageGenerationQuality:
          profile.imageGenerationQuality ??
          defaultRuntimeSettings.imageGenerationQuality,
        requestHeaders: profile.requestHeaders,
        requestBody: profile.requestBody,
        apiKeyConfigured: credential.configured,
        credentialSource: credential.source
      }
    })
    const deepseekHarnessModelProfile =
      this.resolveDeepSeekHarnessModelProfile(
        settings,
        resolvedModelProfiles
      )
    const deepseekHarnessModelSource =
      settings.deepseekHarnessModelSource.kind === 'platform' &&
      deepseekHarnessModelProfile &&
      resolvedProfilesById.has(deepseekHarnessModelProfile.id)
        ? {
            kind: 'profile' as const,
            profileId: deepseekHarnessModelProfile.id
          }
        : settings.deepseekHarnessModelSource
    const embeddingEnvironmentApiKey =
      this.environment.GOODBUDDY_EMBEDDING_API_KEY?.trim()
    const embeddingStoredApiKey = embeddingEnvironmentApiKey
      ? undefined
      : this.getStoredEmbeddingApiKey(settings)
    const resolvedEmbeddingConnections =
      this.resolveEmbeddingConnections(settings)
    const embeddingConnections = settings.embeddingConnections.map(
      (connection) => {
        if (connection.kind === 'builtin') {
          return {
            ...connection,
            apiKeyConfigured: false as const,
            credentialSource: 'none' as const
          }
        }
        const resolved = resolvedEmbeddingConnections.find(
          (candidate) => candidate.id === connection.id
        )
        const environmentManaged =
          connection.id === legacyEmbeddingConnectionId &&
          Boolean(embeddingEnvironmentApiKey)
        return {
          id: connection.id,
          name: connection.name,
          kind: connection.kind,
          baseUrl: connection.baseUrl,
          modelName: connection.modelName,
          authentication: connection.authentication,
          apiKeyConfigured:
            resolved?.kind === 'openai-compatible' &&
            Boolean(resolved.apiKey),
          credentialSource: environmentManaged
            ? ('environment' as const)
            : resolved?.kind === 'openai-compatible' &&
                resolved.apiKey
              ? ('encrypted' as const)
              : connection.credential
                ? ('unreadable' as const)
                : ('none' as const)
        }
      }
    )
    const rerankEnvironmentApiKey =
      this.environment.GOODBUDDY_RERANK_API_KEY?.trim()
    const rerankStoredApiKey = rerankEnvironmentApiKey
      ? undefined
      : this.getStoredRerankApiKey(settings)
    return {
      provider: settings.provider,
      modelBaseUrl: effective.baseUrl,
      modelName: effective.model,
      modelProtocol: effective.protocol,
      modelAuthentication: effective.authentication,
      supportsImageInput: effective.supportsImageInput,
      imageGenerationQuality: effective.imageGenerationQuality,
      opencodeBaseUrl: agent.opencodeBaseUrl,
      opencodeEmbedded: agent.opencodeEmbedded,
      opencodeBinaryPath: agent.opencodeBinaryPath,
      opencodeConfigPath: agent.opencodeConfigPath,
      continueBinaryPath: agent.continueBinaryPath,
      continueConfigPath: agent.continueConfigPath,
      continueMode: agent.continueMode,
      subagentSmartRoutingEnabled:
        settings.subagentSmartRoutingEnabled,
      knowledgeEmbeddingEnabled: settings.knowledgeEmbeddingEnabled,
      knowledgeEmbeddingBaseUrl: settings.knowledgeEmbeddingBaseUrl,
      knowledgeEmbeddingModel: settings.knowledgeEmbeddingModel,
      knowledgeEmbeddingApiKeyConfigured: Boolean(
        embeddingEnvironmentApiKey ?? embeddingStoredApiKey
      ),
      knowledgeEmbeddingCredentialSource: embeddingEnvironmentApiKey
        ? 'environment'
        : embeddingStoredApiKey
          ? 'encrypted'
          : settings.knowledgeEmbeddingCredential
            ? 'unreadable'
            : 'none',
      embeddingConnections,
      activeEmbeddingConnectionId:
        settings.activeEmbeddingConnectionId,
      knowledgeRerankEnabled: settings.knowledgeRerankEnabled,
      knowledgeRerankEndpoint: settings.knowledgeRerankEndpoint,
      knowledgeRerankModel: settings.knowledgeRerankModel,
      knowledgeRerankApiKeyConfigured: Boolean(
        rerankEnvironmentApiKey ?? rerankStoredApiKey
      ),
      knowledgeRerankCredentialSource: rerankEnvironmentApiKey
        ? 'environment'
        : rerankStoredApiKey
          ? 'encrypted'
          : settings.knowledgeRerankCredential
            ? 'unreadable'
            : 'none',
      contextCompression: settings.contextCompression,
      runtimeCustomization: settings.runtimeCustomization,
      workspacePath: agent.workspacePath,
      apiKeyConfigured: Boolean(effective.apiKey),
      credentialSource: effective.credentialSource,
      modelProfiles,
      defaultModelProfileId: settings.defaultModelProfileId,
      opencodeModelSource: agent.opencodeBaseUrl
        ? { kind: 'platform' }
        : settings.opencodeModelSource,
      continueModelSource: settings.continueModelSource,
      deepseekHarnessModelSource,
      secureStorageAvailable: this.cipher.isAvailable(),
      toolApproval: settings.toolApproval,
      configured: {
        modelProfiles: configuredModelProfiles,
        opencodeBaseUrl: settings.opencodeBaseUrl,
        opencodeBinaryPath: settings.opencodeBinaryPath,
        opencodeConfigPath: settings.opencodeConfigPath,
        continueBinaryPath: settings.continueBinaryPath,
        continueConfigPath: settings.continueConfigPath,
        workspacePath: settings.workspacePath || homedir(),
        opencodeModelSource: settings.opencodeModelSource,
        continueModelSource: settings.continueModelSource,
        deepseekHarnessModelSource:
          settings.deepseekHarnessModelSource
      },
      ...(this.loadWarnings.length > 0
        ? { warnings: [...this.loadWarnings] }
        : {})
    }
  }

  async getPublicSettings(): Promise<RuntimeSettings> {
    return this.toPublicSettings(await this.load())
  }

  captureRollback(): Promise<RuntimeSettingsRollback> {
    let result: RuntimeSettingsRollback | undefined
    const operation = this.updateQueue.then(async () => {
      const snapshot = structuredClone(await this.load())
      result = {
        publicSettings: this.toPublicSettings(snapshot),
        restore: () => this.restoreSnapshot(snapshot)
      }
    })
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation.then(() => result!)
  }

  private restoreSnapshot(
    snapshot: StoredSettings
  ): Promise<RuntimeSettings> {
    const operation = this.updateQueue.then(async () => {
      const restored = structuredClone(snapshot)
      await writeJsonFileAtomically(this.filePath, restored)
      this.settings = restored
      this.loadWarnings = []
      return this.toPublicSettings(restored)
    })
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  async getPolicySettings(): Promise<RuntimePolicySettings> {
    const settings = await this.load()
    return {
      subagentSmartRoutingEnabled:
        settings.subagentSmartRoutingEnabled,
      toolApproval: settings.toolApproval
    }
  }

  async getResolvedSettings(): Promise<ResolvedRuntimeSettings> {
    const settings = await this.load()
    const credentials = this.resolveModelCredentials(settings)
    const effective = this.resolveEffectiveModelSettings(
      settings,
      credentials
    )
    const agent = this.resolveAgentSettings(settings)
    const modelProfiles = this.resolveModelProfiles(
      settings,
      effective,
      credentials
    )
    const profilesById = new Map(
      modelProfiles.map((profile) => [profile.id, profile])
    )
    const opencodeModelProfile =
      !agent.opencodeBaseUrl &&
      settings.opencodeModelSource.kind === 'profile'
        ? profilesById.get(settings.opencodeModelSource.profileId)
        : undefined
    const continueModelProfile =
      settings.continueModelSource.kind === 'profile'
        ? profilesById.get(settings.continueModelSource.profileId)
        : undefined
    const deepseekHarnessModelProfile =
      this.resolveDeepSeekHarnessModelProfile(settings, modelProfiles)
    const embeddingConnections =
      this.resolveEmbeddingConnections(settings)
    const activeEmbeddingConnection =
      embeddingConnections.find(
        (connection) =>
          connection.id === settings.activeEmbeddingConnectionId
      )
    if (!activeEmbeddingConnection) {
      throw new Error('当前向量连接不存在')
    }
    return {
      provider: settings.provider,
      modelBaseUrl: effective.baseUrl,
      modelName: effective.model,
      modelProtocol: effective.protocol,
      modelAuthentication: effective.authentication,
      supportsImageInput: effective.supportsImageInput,
      imageGenerationQuality: effective.imageGenerationQuality,
      apiKey: effective.apiKey,
      modelProfiles,
      defaultModelProfileId: settings.defaultModelProfileId,
      opencodeModelProfile,
      continueModelProfile,
      deepseekHarnessModelProfile,
      ...agent,
      subagentSmartRoutingEnabled:
        settings.subagentSmartRoutingEnabled,
      knowledgeEmbeddingEnabled: settings.knowledgeEmbeddingEnabled,
      knowledgeEmbeddingBaseUrl: settings.knowledgeEmbeddingBaseUrl,
      knowledgeEmbeddingModel: settings.knowledgeEmbeddingModel,
      knowledgeEmbeddingApiKey:
        this.environment.GOODBUDDY_EMBEDDING_API_KEY?.trim() ||
        this.getStoredEmbeddingApiKey(settings),
      embeddingConnections,
      activeEmbeddingConnectionId:
        settings.activeEmbeddingConnectionId,
      activeEmbeddingConnection,
      knowledgeRerankEnabled: settings.knowledgeRerankEnabled,
      knowledgeRerankEndpoint: settings.knowledgeRerankEndpoint,
      knowledgeRerankModel: settings.knowledgeRerankModel,
      knowledgeRerankApiKey:
        this.environment.GOODBUDDY_RERANK_API_KEY?.trim() ||
        this.getStoredRerankApiKey(settings),
      contextCompression: settings.contextCompression,
      runtimeCustomization: settings.runtimeCustomization,
      toolApproval: settings.toolApproval
    }
  }

  update(input: RuntimeSettingsInput): Promise<RuntimeSettings> {
    const operation = this.updateQueue.then(() => this.performUpdate(input))
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async performUpdate(
    input: RuntimeSettingsInput
  ): Promise<RuntimeSettings> {
    const current = await this.load()
    const currentDefault =
      current.modelProfiles.find(
        (profile) => profile.id === current.defaultModelProfileId
      ) ?? current.modelProfiles[0]
    if (!currentDefault) {
      throw new Error('默认模型连接不存在')
    }
    const profileInputs =
      input.modelProfiles ??
      current.modelProfiles.map((profile) =>
        profile.id === currentDefault.id
          ? {
              id: profile.id,
              name: profile.name,
              baseUrl: input.modelBaseUrl,
              modelName: input.modelName,
              protocol: input.modelProtocol,
              authentication: input.modelAuthentication,
              supportsImageInput: profile.supportsImageInput,
              contextWindowTokens: profile.contextWindowTokens,
              maximumOutputTokens: profile.maximumOutputTokens,
              imageGenerationQuality: input.imageGenerationQuality,
              requestHeaders: profile.requestHeaders,
              requestBody: profile.requestBody,
              apiKey: input.apiKey
            }
          : {
              id: profile.id,
              name: profile.name,
              baseUrl: profile.baseUrl,
              modelName: profile.modelName,
              protocol: profile.protocol,
              authentication: profile.authentication,
              supportsImageInput: profile.supportsImageInput,
              contextWindowTokens: profile.contextWindowTokens,
              maximumOutputTokens: profile.maximumOutputTokens,
              imageGenerationQuality: profile.imageGenerationQuality,
              requestHeaders: profile.requestHeaders,
              requestBody: profile.requestBody,
              apiKey: { action: 'keep' as const }
            }
      )
    if (
      (
        profileInputs.some(
          (profile) =>
            profile.authentication === 'api-key' &&
            profile.apiKey.action === 'replace'
        ) ||
        input.knowledgeEmbeddingApiKey?.action === 'replace' ||
        input.embeddingConnections?.some(
          (connection) =>
            connection.kind === 'openai-compatible' &&
            connection.authentication === 'api-key' &&
            connection.apiKey.action === 'replace'
        ) ||
        input.knowledgeRerankApiKey?.action === 'replace'
      ) &&
      !this.cipher.isAvailable()
    ) {
      throw new Error(
        '当前系统安全存储不可用，API Key 未保存。请启用系统密钥服务或使用环境变量。'
      )
    }
    const modelProfiles: StoredSettings['modelProfiles'] =
      profileInputs.map((profile) => {
        const existing = current.modelProfiles.find(
          (candidate) => candidate.id === profile.id
        )
        const environmentManaged =
          profile.id === current.defaultModelProfileId &&
          profile.authentication === 'api-key' &&
          profile.apiKey.action === 'keep' &&
          existing !== undefined &&
          Boolean(this.getEnvironmentApiKey())
        const normalizedBaseUrl = normalizeModelBaseUrl(
          environmentManaged ? existing.baseUrl : profile.baseUrl
        )
        const nextProfile: StoredSettings['modelProfiles'][number] = {
          id: profile.id,
          name: profile.name,
          baseUrl: normalizedBaseUrl,
          modelName: environmentManaged
            ? existing.modelName
            : profile.modelName,
          protocol: profile.protocol,
          authentication: profile.authentication,
          supportsImageInput: profile.supportsImageInput ?? false,
          contextWindowTokens: profile.contextWindowTokens,
          maximumOutputTokens: profile.maximumOutputTokens,
          imageGenerationQuality: profile.imageGenerationQuality,
          requestHeaders: profile.requestHeaders ?? {},
          requestBody: profile.requestBody ?? {}
        }
        if (
          profile.apiKey.action === 'keep' &&
          existing?.credential
        ) {
          nextProfile.credential = existing.credential
        } else if (
          profile.authentication === 'api-key' &&
          profile.apiKey.action === 'replace'
        ) {
          nextProfile.credential = encryptSavedApiKey(
            this.cipher,
            profile.apiKey.value
          )
        }
        return nextProfile
      })

    const embeddingConnections: StoredSettings['embeddingConnections'] =
      input.embeddingConnections
        ? input.embeddingConnections.map((connection) => {
            if (connection.kind === 'builtin') {
              return {
                id: builtinEmbeddingConnectionId,
                name: 'GoodBuddy 内置向量模型',
                kind: 'builtin'
              }
            }
            const existing = current.embeddingConnections.find(
              (candidate) =>
                candidate.kind === 'openai-compatible' &&
                candidate.id === connection.id
            )
            const nextConnection: Extract<
              StoredSettings['embeddingConnections'][number],
              { kind: 'openai-compatible' }
            > = {
              id: connection.id,
              name: connection.name,
              kind: connection.kind,
              baseUrl: normalizeModelBaseUrl(connection.baseUrl),
              modelName: connection.modelName,
              authentication: connection.authentication
            }
            if (
              connection.apiKey.action === 'keep' &&
              existing?.kind === 'openai-compatible' &&
              existing.credential
            ) {
              nextConnection.credential = existing.credential
            } else if (
              connection.authentication === 'api-key' &&
              connection.apiKey.action === 'replace'
            ) {
              nextConnection.credential = encryptSavedApiKey(
                this.cipher,
                connection.apiKey.value
              )
            }
            return nextConnection
          })
        : current.embeddingConnections
    if (
      !embeddingConnections.some(
        (connection) =>
          connection.id === builtinEmbeddingConnectionId &&
          connection.kind === 'builtin'
      )
    ) {
      throw new Error('系统向量连接不能删除')
    }
    const activeEmbeddingConnectionId =
      input.activeEmbeddingConnectionId ??
      current.activeEmbeddingConnectionId
    if (
      !embeddingConnections.some(
        (connection) =>
          connection.id === activeEmbeddingConnectionId
      )
    ) {
      throw new Error('当前向量连接不存在')
    }

    const embeddingEndpoint = new URL(
      input.knowledgeEmbeddingBaseUrl
    ).toString()
    const embeddingApiKeyUpdate =
      input.knowledgeEmbeddingApiKey ?? { action: 'keep' as const }
    let knowledgeEmbeddingCredential: StoredSettings['knowledgeEmbeddingCredential']
    if (
      embeddingApiKeyUpdate.action === 'keep' &&
      current.knowledgeEmbeddingCredential
    ) {
      knowledgeEmbeddingCredential =
        current.knowledgeEmbeddingCredential
    } else if (embeddingApiKeyUpdate.action === 'replace') {
      knowledgeEmbeddingCredential = encryptSavedApiKey(
        this.cipher,
        embeddingApiKeyUpdate.value
      )
    }
    const synchronizedEmbeddingConnections =
      input.embeddingConnections
        ? embeddingConnections
        : embeddingConnections.map((connection) =>
            connection.id === legacyEmbeddingConnectionId &&
            connection.kind === 'openai-compatible'
              ? {
                  ...connection,
                  baseUrl: embeddingEndpoint,
                  modelName: input.knowledgeEmbeddingModel,
                  credential: knowledgeEmbeddingCredential
                }
              : connection
          )
    const activeEmbeddingConnection =
      synchronizedEmbeddingConnections.find(
        (connection) =>
          connection.id === activeEmbeddingConnectionId
      )
    const compatibleEmbeddingConnection =
      activeEmbeddingConnection?.kind === 'openai-compatible'
        ? activeEmbeddingConnection
        : undefined

    const rerankEndpoint = new URL(
      input.knowledgeRerankEndpoint
    ).toString()
    const rerankApiKeyUpdate =
      input.knowledgeRerankApiKey ?? { action: 'keep' as const }
    let knowledgeRerankCredential: StoredSettings['knowledgeRerankCredential']
    if (
      rerankApiKeyUpdate.action === 'keep' &&
      current.knowledgeRerankCredential
    ) {
      knowledgeRerankCredential = current.knowledgeRerankCredential
    } else if (rerankApiKeyUpdate.action === 'replace') {
      knowledgeRerankCredential = encryptSavedApiKey(
        this.cipher,
        rerankApiKeyUpdate.value
      )
    }

    const [
      opencodeBinaryPath,
      opencodeConfigPath,
      continueBinaryPath,
      continueConfigPath
    ] = await Promise.all([
      this.canonicalizeRuntimeFile(
        input.opencodeBinaryPath,
        'OpenCode 可执行文件'
      ),
      this.canonicalizeRuntimeFile(
        input.opencodeConfigPath,
        'OpenCode 配置文件'
      ),
      this.canonicalizeRuntimeFile(
        input.continueBinaryPath,
        'Continue 可执行文件'
      ),
      this.canonicalizeRuntimeFile(
        input.continueConfigPath,
        'Continue 配置文件'
      )
    ])

    const defaultModelProfileId =
      input.defaultModelProfileId ??
      (input.modelProfiles
        ? modelProfiles[0]!.id
        : current.defaultModelProfileId)
    if (
      !modelProfiles.some(
        (profile) => profile.id === defaultModelProfileId
      )
    ) {
      throw new Error('默认模型连接不存在')
    }
    const validateRuntimeSource = (
      source: RuntimeSettings['opencodeModelSource'],
      runtimeLabel: 'OpenCode' | 'Continue'
    ): void => {
      if (source.kind === 'platform') {
        return
      }
      const profile = modelProfiles.find(
        (candidate) => candidate.id === source.profileId
      )
      if (!profile) {
        throw new Error(`${runtimeLabel} 引用的模型连接不存在`)
      }
      if (!isAgentRuntimeModelProtocol(profile.protocol)) {
        throw new Error(
          `${runtimeLabel} 模型连接仅支持文本对话协议，不支持图像生成协议`
        )
      }
    }
    const opencodeBaseUrl = input.opencodeBaseUrl
      ? normalizeModelBaseUrl(input.opencodeBaseUrl)
      : ''
    const fallbackRuntimeProfileId = modelProfiles.find(
      (profile) => isAgentRuntimeModelProtocol(profile.protocol)
    )?.id
    const repairRuntimeSource = (
      source: RuntimeSettings['opencodeModelSource']
    ): RuntimeSettings['opencodeModelSource'] => {
      if (source.kind === 'platform') {
        return source
      }
      const profile = modelProfiles.find(
        (candidate) => candidate.id === source.profileId
      )
      if (profile && isAgentRuntimeModelProtocol(profile.protocol)) {
        return source
      }
      return fallbackRuntimeProfileId
        ? { kind: 'profile', profileId: fallbackRuntimeProfileId }
        : { kind: 'platform' }
    }
    const requestedOpenCodeSource = input.opencodeModelSource
      ? input.opencodeModelSource
      : repairRuntimeSource(current.opencodeModelSource)
    const opencodeModelSource = opencodeBaseUrl
      ? ({ kind: 'platform' } as const)
      : requestedOpenCodeSource
    const continueModelSource = input.continueModelSource
      ? input.continueModelSource
      : repairRuntimeSource(current.continueModelSource)
    validateRuntimeSource(opencodeModelSource, 'OpenCode')
    validateRuntimeSource(continueModelSource, 'Continue')
    const requestedDeepSeekHarnessSource =
      input.deepseekHarnessModelSource ??
      current.deepseekHarnessModelSource
    if (requestedDeepSeekHarnessSource.kind === 'profile') {
      const profile = modelProfiles.find(
        (candidate) =>
          candidate.id === requestedDeepSeekHarnessSource.profileId
      )
      if (!profile) {
        throw new Error('DeepSeek Harness 引用的模型连接不存在')
      }
      if (!isDeepSeekHarnessModelProfile(profile)) {
        throw new Error(
          'DeepSeek Harness 仅支持使用 API Key 的 OpenAI 兼容 Chat Completions 连接'
        )
      }
    }
    const requestedContextCompression =
      input.contextCompression ?? current.contextCompression
    const requestedContextModelSource =
      requestedContextCompression.modelSource
    const contextCompression =
      requestedContextModelSource.kind === 'profile' &&
      !modelProfiles.some(
        (profile) =>
          profile.id === requestedContextModelSource.profileId &&
          isAgentRuntimeModelProtocol(profile.protocol)
      )
        ? {
            ...requestedContextCompression,
            modelSource: { kind: 'current' as const }
          }
        : requestedContextCompression

    const next: StoredSettings = {
      ...current,
      version: CURRENT_SETTINGS_VERSION,
      provider: input.provider,
      modelProfiles,
      defaultModelProfileId,
      opencodeModelSource,
      continueModelSource,
      deepseekHarnessModelSource:
        requestedDeepSeekHarnessSource,
      opencodeBaseUrl,
      opencodeEmbedded: !opencodeBaseUrl,
      opencodeBinaryPath,
      opencodeConfigPath,
      continueBinaryPath,
      continueConfigPath,
      continueMode: input.continueMode,
      subagentSmartRoutingEnabled:
        input.subagentSmartRoutingEnabled ??
        current.subagentSmartRoutingEnabled,
      knowledgeEmbeddingEnabled: input.knowledgeEmbeddingEnabled,
      knowledgeEmbeddingBaseUrl:
        compatibleEmbeddingConnection?.baseUrl ?? embeddingEndpoint,
      knowledgeEmbeddingModel:
        compatibleEmbeddingConnection?.modelName ??
        input.knowledgeEmbeddingModel,
      knowledgeEmbeddingCredential:
        compatibleEmbeddingConnection
          ? compatibleEmbeddingConnection.credential
          : knowledgeEmbeddingCredential,
      embeddingConnections: synchronizedEmbeddingConnections,
      activeEmbeddingConnectionId,
      knowledgeRerankEnabled: input.knowledgeRerankEnabled,
      knowledgeRerankEndpoint: rerankEndpoint,
      knowledgeRerankModel: input.knowledgeRerankModel,
      knowledgeRerankCredential,
      contextCompression,
      runtimeCustomization:
        input.runtimeCustomization ??
        current.runtimeCustomization,
      workspacePath: input.workspacePath,
      toolApproval: input.toolApproval
    }

    await writeJsonFileAtomically(this.filePath, next)
    this.settings = next
    this.loadWarnings = []
    return this.toPublicSettings(next)
  }

  async getRuntimeCustomization(): Promise<RuntimeCustomizationSettings> {
    return structuredClone((await this.load()).runtimeCustomization)
  }

  updateRuntimeCustomization(
    input: RuntimeCustomizationSettings
  ): Promise<RuntimeCustomizationSettings> {
    const parsed = runtimeCustomizationSettingsSchema.parse(input)
    let result: RuntimeCustomizationSettings | undefined
    const operation = this.updateQueue.then(async () => {
      const current = await this.load()
      const next: StoredSettings = {
        ...current,
        version: CURRENT_SETTINGS_VERSION,
        runtimeCustomization: parsed
      }
      await writeJsonFileAtomically(this.filePath, next)
      this.settings = next
      result = structuredClone(next.runtimeCustomization)
    })
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation.then(() => result!)
  }

  private async canonicalizeRuntimeFile(
    filePath: string,
    label: string
  ): Promise<string> {
    if (!filePath) {
      return ''
    }
    try {
      const canonicalPath = await realpath(filePath)
      if (!(await stat(canonicalPath)).isFile()) {
        throw new Error('Not a regular file')
      }
      return canonicalPath
    } catch {
      throw new Error(`${label}不存在、不可访问或不是普通文件`)
    }
  }
}
