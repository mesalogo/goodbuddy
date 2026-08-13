import {
  readFile,
  realpath,
  stat
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { z } from 'zod'
import {
  continueModeSchema,
  defaultModelProfileId,
  defaultRuntimeSettings,
  imageGenerationQualitySchema,
  isAgentRuntimeModelProtocol,
  modelAuthenticationSchema,
  modelProtocolSchema,
  runtimeModelSourceSchema,
  runtimePathSchema,
  runtimeProviderSchema,
  runtimeSandboxModeSchema,
  toolApprovalPolicySchema,
  type RuntimeSettings,
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
    runtimeSandboxMode: runtimeSandboxModeSchema.default('auto'),
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
  supportsImageInput: z.boolean()
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

const storedSettingsSchema = version13StoredSettingsSchema
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

type StoredSettings = z.infer<typeof storedSettingsSchema>
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

const credentialPayloadSchema = z.object({
  version: z.literal(1),
  apiKey: z.string(),
  origin: z.string()
})

const embeddingCredentialPayloadSchema = z.object({
  version: z.literal(1),
  apiKey: z.string(),
  endpoint: z.string()
})

const rerankCredentialPayloadSchema = embeddingCredentialPayloadSchema

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
  opencodeBaseUrl: string
  opencodeEmbedded: boolean
  opencodeBinaryPath: string
  opencodeConfigPath: string
  continueBinaryPath: string
  continueConfigPath: string
  continueMode: RuntimeSettings['continueMode']
  runtimeSandboxMode: RuntimeSettings['runtimeSandboxMode']
  subagentSmartRoutingEnabled: boolean
  knowledgeEmbeddingEnabled: boolean
  knowledgeEmbeddingBaseUrl: string
  knowledgeEmbeddingModel: string
  knowledgeEmbeddingApiKey?: string
  knowledgeRerankEnabled: boolean
  knowledgeRerankEndpoint: string
  knowledgeRerankModel: string
  knowledgeRerankApiKey?: string
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
  imageGenerationQuality?: RuntimeSettings['imageGenerationQuality']
  apiKey?: string
}

const defaultSettings: StoredSettings = {
  version: 14,
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
        defaultRuntimeSettings.imageGenerationQuality
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
  runtimeSandboxMode: defaultRuntimeSettings.runtimeSandboxMode,
  subagentSmartRoutingEnabled:
    defaultRuntimeSettings.subagentSmartRoutingEnabled,
  knowledgeEmbeddingEnabled:
    defaultRuntimeSettings.knowledgeEmbeddingEnabled,
  knowledgeEmbeddingBaseUrl:
    defaultRuntimeSettings.knowledgeEmbeddingBaseUrl,
  knowledgeEmbeddingModel:
    defaultRuntimeSettings.knowledgeEmbeddingModel,
  knowledgeRerankEnabled:
    defaultRuntimeSettings.knowledgeRerankEnabled,
  knowledgeRerankEndpoint:
    defaultRuntimeSettings.knowledgeRerankEndpoint,
  knowledgeRerankModel:
    defaultRuntimeSettings.knowledgeRerankModel,
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
  return {
    ...settings,
    version: 14,
    knowledgeRerankEnabled:
      defaultRuntimeSettings.knowledgeRerankEnabled,
    knowledgeRerankEndpoint:
      defaultRuntimeSettings.knowledgeRerankEndpoint,
    knowledgeRerankModel:
      defaultRuntimeSettings.knowledgeRerankModel,
    knowledgeRerankCredential: undefined
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
    baseUrl: normalizeModelBaseUrl(profile.baseUrl)
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
    runtimeSandboxMode: defaultRuntimeSettings.runtimeSandboxMode,
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
    runtimeSandboxMode: defaultRuntimeSettings.runtimeSandboxMode,
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
        14,
        (version) =>
          `当前 GoodBuddy 不支持 Runtime 设置版本 ${version}，请升级应用后重试`
      )
      const current = storedSettingsSchema.safeParse(parsed)
      if (current.success) {
        this.settings = current.data
      } else {
        const version13 =
          version13StoredSettingsSchema.safeParse(parsed)
        if (version13.success) {
          this.settings = migrateVersion13(version13.data)
        } else {
          const version12 =
            version12StoredSettingsSchema.safeParse(parsed)
          if (version12.success) {
            this.settings = migrateVersion12(version12.data)
          } else {
            const version11 =
              version11StoredSettingsSchema.safeParse(parsed)
            if (version11.success) {
              this.settings = migrateVersion11(version11.data)
            } else {
              const version10 =
                version10StoredSettingsSchema.safeParse(parsed)
              if (version10.success) {
                this.settings = migrateVersion10(version10.data)
              } else {
                const version9 =
                  version9StoredSettingsSchema.safeParse(parsed)
                if (version9.success) {
                  this.settings = migrateVersion9(version9.data)
                } else {
                  const version8 =
                    version8StoredSettingsSchema.safeParse(parsed)
                  if (version8.success) {
                    this.settings = migrateVersion8(version8.data)
                  } else {
                    const version7 =
                      version7StoredSettingsSchema.safeParse(parsed)
                    if (version7.success) {
                      this.settings = migrateVersion7(version7.data)
                    } else {
                      const version6 =
                        version6StoredSettingsSchema.safeParse(parsed)
                      if (version6.success) {
                        this.settings = migrateVersion6(version6.data)
                      } else {
                        const version5 =
                          version5StoredSettingsSchema.safeParse(parsed)
                        if (version5.success) {
                          this.settings = migrateVersion5(version5.data)
                        } else {
                          const version4 =
                            version4StoredSettingsSchema.safeParse(parsed)
                          if (version4.success) {
                            this.settings = migrateVersion4(version4.data)
                          } else {
                            const version3 =
                              version3StoredSettingsSchema.safeParse(parsed)
                            if (version3.success) {
                              this.settings = migrateVersion4({
                                ...version3.data,
                                version: 4,
                                continueMode: 'chat'
                              })
                            } else {
                              const version2 =
                                version2StoredSettingsSchema.safeParse(parsed)
                              if (version2.success) {
                                this.settings = migrateVersion4({
                                  version: 4,
                                  provider: version2.data.provider,
                                  modelBaseUrl: version2.data.modelBaseUrl,
                                  modelName: version2.data.modelName,
                                  opencodeBaseUrl: version2.data.opencodeBaseUrl,
                                  opencodeEmbedded: version2.data.opencodeEmbedded,
                                  opencodeBinaryPath: '',
                                  opencodeConfigPath: '',
                                  continueBinaryPath: migrateContinueCommand(
                                    version2.data.continueCommand
                                  ),
                                  continueConfigPath: '',
                                  continueMode: 'chat',
                                  workspacePath: version2.data.workspacePath,
                                  credential: version2.data.credential,
                                  toolApproval: version2.data.toolApproval
                                })
                              } else {
                                const legacy =
                                  legacyStoredSettingsSchema.parse(parsed)
                                this.settings = migrateVersion4({
                                  version: 4,
                                  provider:
                                    legacy.provider === 'bigtoken'
                                      ? 'model'
                                      : legacy.provider,
                                  modelBaseUrl: legacy.bigtokenBaseUrl,
                                  modelName: legacy.bigtokenModel,
                                  opencodeBaseUrl: legacy.opencodeBaseUrl,
                                  opencodeEmbedded: legacy.opencodeEmbedded,
                                  opencodeBinaryPath: '',
                                  opencodeConfigPath: '',
                                  continueBinaryPath: migrateContinueCommand(
                                    legacy.continueCommand
                                  ),
                                  continueConfigPath: '',
                                  continueMode: 'chat',
                                  workspacePath: legacy.workspacePath,
                                  credential: legacy.credential,
                                  toolApproval: legacy.toolApproval
                                })
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
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
      if (payload.origin !== new URL(profile.baseUrl).origin) {
        return warning('runtime-model-credential-binding-mismatch')
      }
      this.removeWarnings(
        [
          'runtime-model-credential-unreadable',
          'runtime-model-credential-binding-mismatch'
        ],
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
      const payload = embeddingCredentialPayloadSchema.parse(
        decryptSettingsCredential(
          this.cipher,
          settings.knowledgeEmbeddingCredential
        )
      )
      if (payload.endpoint !== settings.knowledgeEmbeddingBaseUrl) {
        this.addWarning({
          code: 'runtime-embedding-credential-binding-mismatch'
        })
        return undefined
      }
      this.removeWarnings([
        'runtime-embedding-credential-unreadable',
        'runtime-embedding-credential-binding-mismatch'
      ])
      return payload.apiKey
    } catch {
      this.addWarning({
        code: 'runtime-embedding-credential-unreadable'
      })
      return undefined
    }
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
      const payload = rerankCredentialPayloadSchema.parse(
        decryptSettingsCredential(
          this.cipher,
          settings.knowledgeRerankCredential
        )
      )
      if (payload.endpoint !== settings.knowledgeRerankEndpoint) {
        this.addWarning({
          code: 'runtime-rerank-credential-binding-mismatch'
        })
        return undefined
      }
      this.removeWarnings([
        'runtime-rerank-credential-unreadable',
        'runtime-rerank-credential-binding-mismatch'
      ])
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

  private resolveEffectiveModelSettings(settings: StoredSettings): {
    apiKey?: string
    baseUrl: string
    model: string
    protocol: RuntimeSettings['modelProtocol']
    authentication: RuntimeSettings['modelAuthentication']
    supportsImageInput: boolean
    imageGenerationQuality: RuntimeSettings['imageGenerationQuality']
    credentialSource: RuntimeSettings['credentialSource']
  } {
    const profile =
      settings.modelProfiles.find(
        (candidate) => candidate.id === settings.defaultModelProfileId
      ) ?? settings.modelProfiles[0]
    if (!profile) {
      throw new Error('默认模型连接不存在')
    }
    const environmentApiKey =
      profile.authentication === 'api-key'
        ? this.getEnvironmentApiKey()
        : undefined
    const storedApiKey =
      profile.authentication === 'api-key' && !environmentApiKey
        ? this.getStoredApiKey(profile)
        : undefined
    const environmentBaseUrl =
      this.environment.GOODBUDDY_MODEL_BASE_URL?.trim() ||
      this.environment.GOODBUDDY_BIGTOKEN_BASE_URL?.trim()
    const environmentModel =
      this.environment.GOODBUDDY_MODEL_NAME?.trim() ||
      this.environment.GOODBUDDY_BIGTOKEN_MODEL?.trim()
    const baseUrl = environmentApiKey
      ? environmentBaseUrl || defaultRuntimeSettings.modelBaseUrl
      : profile.baseUrl
    const model = environmentApiKey
      ? environmentModel || defaultRuntimeSettings.modelName
      : profile.modelName
    const credentialSource: RuntimeSettings['credentialSource'] =
      environmentApiKey
        ? 'environment'
        : storedApiKey
          ? 'encrypted'
          : profile.credential
            ? 'unreadable'
            : 'none'
    return {
      apiKey: environmentApiKey ?? storedApiKey,
      baseUrl,
      model,
      protocol: profile.protocol,
      authentication: profile.authentication,
      supportsImageInput: profile.supportsImageInput,
      imageGenerationQuality: profile.imageGenerationQuality,
      credentialSource
    }
  }

  private resolveModelProfiles(
    settings: StoredSettings,
    effective: ReturnType<
      RuntimeSettingsStore['resolveEffectiveModelSettings']
    >
  ): ResolvedModelProfile[] {
    return settings.modelProfiles.map((profile) =>
      profile.id === settings.defaultModelProfileId
        ? {
            id: profile.id,
            name: profile.name,
            baseUrl: effective.baseUrl,
            modelName: effective.model,
            protocol: effective.protocol,
            authentication: effective.authentication,
            supportsImageInput: effective.supportsImageInput,
            imageGenerationQuality:
              effective.imageGenerationQuality,
            apiKey: effective.apiKey
          }
        : {
            id: profile.id,
            name: profile.name,
            baseUrl: profile.baseUrl,
            modelName: profile.modelName,
            protocol: profile.protocol,
            authentication: profile.authentication,
            supportsImageInput: profile.supportsImageInput,
            imageGenerationQuality: profile.imageGenerationQuality,
            apiKey:
              profile.authentication === 'api-key'
                ? this.getStoredApiKey(profile)
                : undefined
          }
    )
  }

  private resolveAgentSettings(settings: StoredSettings): {
    opencodeBaseUrl: string
    opencodeEmbedded: boolean
    opencodeBinaryPath: string
    opencodeConfigPath: string
    continueBinaryPath: string
    continueConfigPath: string
    continueMode: RuntimeSettings['continueMode']
    runtimeSandboxMode: RuntimeSettings['runtimeSandboxMode']
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
      runtimeSandboxMode: settings.runtimeSandboxMode,
      workspacePath:
        this.environment.GOODBUDDY_WORKSPACE?.trim() ||
        settings.workspacePath ||
        homedir()
    }
  }

  private toPublicSettings(settings: StoredSettings): RuntimeSettings {
    const effective = this.resolveEffectiveModelSettings(settings)
    const agent = this.resolveAgentSettings(settings)
    const environmentApiKeyConfigured = Boolean(
      this.getEnvironmentApiKey()
    )
    const resolvedModelProfiles = this.resolveModelProfiles(
      settings,
      effective
    )
    const resolvedProfilesById = new Map(
      resolvedModelProfiles.map((profile) => [profile.id, profile])
    )
    const modelProfiles = settings.modelProfiles.map((profile) => {
      const isDefault = profile.id === settings.defaultModelProfileId
      const resolved = resolvedProfilesById.get(profile.id)
      if (!resolved) {
        throw new Error(`模型连接不存在：${profile.id}`)
      }
      const apiKey = resolved.apiKey
      return {
        id: profile.id,
        name: profile.name,
        baseUrl: resolved.baseUrl,
        modelName: resolved.modelName,
        protocol: resolved.protocol,
        authentication: resolved.authentication,
        supportsImageInput: resolved.supportsImageInput,
        imageGenerationQuality:
          resolved.imageGenerationQuality ??
          defaultRuntimeSettings.imageGenerationQuality,
        apiKeyConfigured: Boolean(apiKey),
        credentialSource: isDefault
          ? effective.credentialSource
          : apiKey
            ? ('encrypted' as const)
            : profile.credential
              ? ('unreadable' as const)
              : ('none' as const)
      }
    })
    const configuredModelProfiles = settings.modelProfiles.map((profile) => {
      const environmentManaged =
        profile.id === settings.defaultModelProfileId &&
        profile.authentication === 'api-key' &&
        environmentApiKeyConfigured
      const apiKey = resolvedProfilesById.get(profile.id)?.apiKey
      return {
        id: profile.id,
        name: profile.name,
        baseUrl: profile.baseUrl,
        modelName: profile.modelName,
        protocol: profile.protocol,
        authentication: profile.authentication,
        supportsImageInput: profile.supportsImageInput,
        imageGenerationQuality:
          profile.imageGenerationQuality ??
          defaultRuntimeSettings.imageGenerationQuality,
        apiKeyConfigured: environmentManaged || Boolean(apiKey),
        credentialSource: environmentManaged
          ? ('environment' as const)
          : apiKey
            ? ('encrypted' as const)
            : profile.credential
              ? ('unreadable' as const)
              : ('none' as const)
      }
    })
    const embeddingEnvironmentApiKey =
      this.environment.GOODBUDDY_EMBEDDING_API_KEY?.trim()
    const embeddingStoredApiKey = embeddingEnvironmentApiKey
      ? undefined
      : this.getStoredEmbeddingApiKey(settings)
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
      runtimeSandboxMode: agent.runtimeSandboxMode,
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
      workspacePath: agent.workspacePath,
      apiKeyConfigured: Boolean(effective.apiKey),
      credentialSource: effective.credentialSource,
      modelProfiles,
      defaultModelProfileId: settings.defaultModelProfileId,
      opencodeModelSource: agent.opencodeBaseUrl
        ? { kind: 'platform' }
        : settings.opencodeModelSource,
      continueModelSource: settings.continueModelSource,
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
        continueModelSource: settings.continueModelSource
      },
      ...(this.loadWarnings.length > 0
        ? { warnings: [...this.loadWarnings] }
        : {})
    }
  }

  async getPublicSettings(): Promise<RuntimeSettings> {
    return this.toPublicSettings(await this.load())
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
    const effective = this.resolveEffectiveModelSettings(settings)
    const agent = this.resolveAgentSettings(settings)
    const modelProfiles = this.resolveModelProfiles(settings, effective)
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
      ...agent,
      subagentSmartRoutingEnabled:
        settings.subagentSmartRoutingEnabled,
      knowledgeEmbeddingEnabled: settings.knowledgeEmbeddingEnabled,
      knowledgeEmbeddingBaseUrl: settings.knowledgeEmbeddingBaseUrl,
      knowledgeEmbeddingModel: settings.knowledgeEmbeddingModel,
      knowledgeEmbeddingApiKey:
        this.environment.GOODBUDDY_EMBEDDING_API_KEY?.trim() ||
        this.getStoredEmbeddingApiKey(settings),
      knowledgeRerankEnabled: settings.knowledgeRerankEnabled,
      knowledgeRerankEndpoint: settings.knowledgeRerankEndpoint,
      knowledgeRerankModel: settings.knowledgeRerankModel,
      knowledgeRerankApiKey:
        this.environment.GOODBUDDY_RERANK_API_KEY?.trim() ||
        this.getStoredRerankApiKey(settings),
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
              imageGenerationQuality: input.imageGenerationQuality,
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
              imageGenerationQuality: profile.imageGenerationQuality,
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
        if (
          profile.authentication === 'api-key' &&
          profile.apiKey.action === 'keep' &&
          existing?.credential &&
          new URL(existing.baseUrl).origin !==
            new URL(normalizedBaseUrl).origin
        ) {
          throw new Error(
            `模型连接“${profile.name}”的服务地址已更改，请重新输入或清除 API Key`
          )
        }
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
          imageGenerationQuality: profile.imageGenerationQuality
        }
        if (
          profile.authentication === 'api-key' &&
          profile.apiKey.action === 'keep' &&
          existing?.credential
        ) {
          nextProfile.credential = existing.credential
        } else if (
          profile.authentication === 'api-key' &&
          profile.apiKey.action === 'replace'
        ) {
          nextProfile.credential = encryptSettingsCredential(
            this.cipher,
            {
              version: 1,
              apiKey: profile.apiKey.value,
              origin: new URL(normalizedBaseUrl).origin
            }
          )
        }
        return nextProfile
      })

    const embeddingEndpoint = new URL(
      input.knowledgeEmbeddingBaseUrl
    ).toString()
    const embeddingApiKeyUpdate =
      input.knowledgeEmbeddingApiKey ?? { action: 'keep' as const }
    if (
      embeddingApiKeyUpdate.action === 'keep' &&
      current.knowledgeEmbeddingCredential &&
      current.knowledgeEmbeddingBaseUrl !== embeddingEndpoint
    ) {
      throw new Error(
        '向量接口 URL 已更改，请重新输入或清除 API Key'
      )
    }
    let knowledgeEmbeddingCredential: StoredSettings['knowledgeEmbeddingCredential']
    if (
      embeddingApiKeyUpdate.action === 'keep' &&
      current.knowledgeEmbeddingCredential
    ) {
      knowledgeEmbeddingCredential =
        current.knowledgeEmbeddingCredential
    } else if (embeddingApiKeyUpdate.action === 'replace') {
      knowledgeEmbeddingCredential = encryptSettingsCredential(
        this.cipher,
        {
          version: 1,
          apiKey: embeddingApiKeyUpdate.value,
          endpoint: embeddingEndpoint
        }
      )
    }

    const rerankEndpoint = new URL(
      input.knowledgeRerankEndpoint
    ).toString()
    const rerankApiKeyUpdate =
      input.knowledgeRerankApiKey ?? { action: 'keep' as const }
    if (
      rerankApiKeyUpdate.action === 'keep' &&
      current.knowledgeRerankCredential &&
      current.knowledgeRerankEndpoint !== rerankEndpoint
    ) {
      throw new Error(
        '重排接口 URL 已更改，请重新输入或清除 API Key'
      )
    }
    let knowledgeRerankCredential: StoredSettings['knowledgeRerankCredential']
    if (
      rerankApiKeyUpdate.action === 'keep' &&
      current.knowledgeRerankCredential
    ) {
      knowledgeRerankCredential = current.knowledgeRerankCredential
    } else if (rerankApiKeyUpdate.action === 'replace') {
      knowledgeRerankCredential = encryptSettingsCredential(
        this.cipher,
        {
          version: 1,
          apiKey: rerankApiKeyUpdate.value,
          endpoint: rerankEndpoint
        }
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

    const next: StoredSettings = {
      ...current,
      version: 14,
      provider: input.provider,
      modelProfiles,
      defaultModelProfileId,
      opencodeModelSource,
      continueModelSource,
      opencodeBaseUrl,
      opencodeEmbedded: !opencodeBaseUrl,
      opencodeBinaryPath,
      opencodeConfigPath,
      continueBinaryPath,
      continueConfigPath,
      continueMode: input.continueMode,
      runtimeSandboxMode: input.runtimeSandboxMode,
      subagentSmartRoutingEnabled:
        input.subagentSmartRoutingEnabled ??
        current.subagentSmartRoutingEnabled,
      knowledgeEmbeddingEnabled: input.knowledgeEmbeddingEnabled,
      knowledgeEmbeddingBaseUrl: embeddingEndpoint,
      knowledgeEmbeddingModel: input.knowledgeEmbeddingModel,
      knowledgeEmbeddingCredential,
      knowledgeRerankEnabled: input.knowledgeRerankEnabled,
      knowledgeRerankEndpoint: rerankEndpoint,
      knowledgeRerankModel: input.knowledgeRerankModel,
      knowledgeRerankCredential,
      workspacePath: input.workspacePath,
      toolApproval: input.toolApproval
    }

    await writeJsonFileAtomically(this.filePath, next)
    this.settings = next
    this.loadWarnings = []
    return this.toPublicSettings(next)
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
