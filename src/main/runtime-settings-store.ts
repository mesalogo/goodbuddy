import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
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
  RuntimeSettings,
  type RuntimeSettingsInput
} from '../shared/contracts'

const credentialSchema = z
  .object({
    formatVersion: z.literal(1),
    scheme: z.literal('electron-safe-storage'),
    ciphertextBase64: z.string()
  })
  .optional()

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

const storedSettingsSchema = version11StoredSettingsSchema
  .omit({ version: true, intranetCompatibilityEnabled: true })
  .extend({
    version: z.literal(12)
  })

class UnsupportedRuntimeSettingsVersionError extends Error {}

type StoredSettings = z.infer<typeof storedSettingsSchema>
type Version10StoredSettings = z.infer<
  typeof version10StoredSettingsSchema
>
type Version11StoredSettings = z.infer<
  typeof version11StoredSettingsSchema
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

export type CredentialCipher = {
  isAvailable: () => boolean
  encrypt: (value: string) => Buffer
  decrypt: (value: Buffer) => string
}

export type ResolvedRuntimeSettings = {
  provider: RuntimeSettings['provider']
  modelBaseUrl: string
  modelName: string
  modelProtocol: RuntimeSettings['modelProtocol']
  modelAuthentication: RuntimeSettings['modelAuthentication']
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
  workspacePath: string
  toolApproval: RuntimeSettings['toolApproval']
}

export type ResolvedModelProfile = {
  id: string
  name: string
  baseUrl: string
  modelName: string
  protocol: RuntimeSettings['modelProtocol']
  authentication: RuntimeSettings['modelAuthentication']
  imageGenerationQuality?: RuntimeSettings['imageGenerationQuality']
  apiKey?: string
}

const defaultSettings: StoredSettings = {
  version: 12,
  provider: defaultRuntimeSettings.provider,
  modelProfiles: [
    {
      id: defaultModelProfileId,
      name: '默认模型',
      baseUrl: defaultRuntimeSettings.modelBaseUrl,
      modelName: defaultRuntimeSettings.modelName,
      protocol: defaultRuntimeSettings.modelProtocol,
      authentication: defaultRuntimeSettings.modelAuthentication,
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
  workspacePath: defaultRuntimeSettings.workspacePath,
  toolApproval: defaultRuntimeSettings.toolApproval
}

function migrateContinueCommand(command: string): string {
  const value = command.trim()
  return value === 'cn' ? '' : value
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
  return {
    ...current,
    version: 12
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
  const fallbackProfileId = compatibleTextProfileId(settings)
  const normalizeSource = (
    source: RuntimeSettings['opencodeModelSource']
  ): RuntimeSettings['opencodeModelSource'] => {
    if (source.kind === 'platform') {
      return source
    }
    const profile = settings.modelProfiles.find(
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
  const defaultModelProfileId = settings.modelProfiles.some(
    (profile) => profile.id === settings.defaultModelProfileId
  )
    ? settings.defaultModelProfileId
    : settings.modelProfiles[0]!.id

  return {
    ...settings,
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
  const endpoint = new URL(settings.knowledgeEmbeddingBaseUrl)
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}/v1/embeddings`
  return migrateVersion10({
    ...settings,
    version: 10,
    subagentSmartRoutingEnabled:
      defaultRuntimeSettings.subagentSmartRoutingEnabled,
    intranetCompatibilityEnabled: true,
    knowledgeEmbeddingBaseUrl: endpoint.toString(),
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

function normalizeModelBaseUrl(value: string): string {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/u, '')
  return url.toString().replace(/\/$/u, '')
}

export class RuntimeSettingsStore {
  private settings?: StoredSettings
  private loadWarning?: string
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly cipher: CredentialCipher,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  private async load(): Promise<StoredSettings> {
    if (this.settings) {
      return this.settings
    }

    try {
      const contents = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(contents)
      if (
        parsed &&
        typeof parsed === 'object' &&
        'version' in parsed &&
        typeof parsed.version === 'number' &&
        parsed.version > 12
      ) {
        throw new UnsupportedRuntimeSettingsVersionError(
          `当前 GoodBuddy 不支持 Runtime 设置版本 ${parsed.version}，请升级应用后重试`
        )
      }
      const current = storedSettingsSchema.safeParse(parsed)
      if (current.success) {
        this.settings = current.data
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
                            continueMode: 'chat',
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
      this.settings = normalizeStoredSettings(this.settings)
    } catch (error) {
      if (error instanceof UnsupportedRuntimeSettingsVersionError) {
        throw error
      }
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        this.loadWarning =
          'Runtime 设置文件已损坏，已隔离原文件并恢复默认设置'
        await rename(
          this.filePath,
          `${this.filePath}.corrupt-${Date.now()}`
        ).catch(() => undefined)
      }
      this.settings = { ...defaultSettings }
    }
    return this.settings
  }

  private getStoredApiKey(
    profile: StoredSettings['modelProfiles'][number]
  ): string | undefined {
    if (!profile.credential || !this.cipher.isAvailable()) {
      return undefined
    }
    try {
      const payload = credentialPayloadSchema.parse(
        JSON.parse(
          this.cipher.decrypt(
            Buffer.from(profile.credential.ciphertextBase64, 'base64')
          )
        )
      )
      if (payload.origin !== new URL(profile.baseUrl).origin) {
        this.loadWarning =
          `模型连接“${profile.name}”的服务地址与已保存 API Key 不匹配，请重新输入或清除 API Key`
        return undefined
      }
      return payload.apiKey
    } catch {
      return undefined
    }
  }

  private getStoredEmbeddingApiKey(
    settings: StoredSettings
  ): string | undefined {
    if (
      !settings.knowledgeEmbeddingCredential ||
      !this.cipher.isAvailable()
    ) {
      return undefined
    }
    try {
      const payload = embeddingCredentialPayloadSchema.parse(
        JSON.parse(
          this.cipher.decrypt(
            Buffer.from(
              settings.knowledgeEmbeddingCredential.ciphertextBase64,
              'base64'
            )
          )
        )
      )
      return payload.endpoint === settings.knowledgeEmbeddingBaseUrl
        ? payload.apiKey
        : undefined
    } catch {
      return undefined
    }
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
      profile.authentication === 'api-key'
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
    return {
      apiKey: environmentApiKey ?? storedApiKey,
      baseUrl,
      model,
      protocol: profile.protocol,
      authentication: profile.authentication,
      imageGenerationQuality: profile.imageGenerationQuality,
      credentialSource: environmentApiKey
        ? 'environment'
        : storedApiKey
          ? 'encrypted'
          : 'none'
    }
  }

  private resolveProfile(
    settings: StoredSettings,
    profileId: string
  ): ResolvedModelProfile | undefined {
    const profile = settings.modelProfiles.find(
      (candidate) => candidate.id === profileId
    )
    if (!profile) {
      return undefined
    }
    if (profile.id === settings.defaultModelProfileId) {
      const effective = this.resolveEffectiveModelSettings(settings)
      return {
        id: profile.id,
        name: profile.name,
        baseUrl: effective.baseUrl,
        modelName: effective.model,
        protocol: effective.protocol,
        authentication: effective.authentication,
        imageGenerationQuality: effective.imageGenerationQuality,
        apiKey: effective.apiKey
      }
    }
    return {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      modelName: profile.modelName,
      protocol: profile.protocol,
      authentication: profile.authentication,
      imageGenerationQuality: profile.imageGenerationQuality,
      apiKey:
        profile.authentication === 'api-key'
          ? this.getStoredApiKey(profile)
          : undefined
    }
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
    const modelProfiles = settings.modelProfiles.map((profile) => {
      const isDefault = profile.id === settings.defaultModelProfileId
      const apiKey =
        profile.authentication === 'api-key'
          ? this.getStoredApiKey(profile)
          : undefined
      return {
        id: profile.id,
        name: profile.name,
        baseUrl: isDefault
          ? effective.baseUrl
          : profile.baseUrl,
        modelName: isDefault ? effective.model : profile.modelName,
        protocol: isDefault
          ? effective.protocol
          : profile.protocol,
        authentication: isDefault
          ? effective.authentication
          : profile.authentication,
        imageGenerationQuality: isDefault
          ? effective.imageGenerationQuality
          : profile.imageGenerationQuality,
        apiKeyConfigured: isDefault
          ? Boolean(effective.apiKey)
          : Boolean(apiKey),
        credentialSource: isDefault
          ? effective.credentialSource
          : apiKey
            ? ('encrypted' as const)
            : ('none' as const)
      }
    })
    const embeddingEnvironmentApiKey =
      this.environment.GOODBUDDY_EMBEDDING_API_KEY?.trim()
    const embeddingStoredApiKey =
      this.getStoredEmbeddingApiKey(settings)
    return {
      provider: settings.provider,
      modelBaseUrl: effective.baseUrl,
      modelName: effective.model,
      modelProtocol: effective.protocol,
      modelAuthentication: effective.authentication,
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
      warning: this.loadWarning
    }
  }

  async getPublicSettings(): Promise<RuntimeSettings> {
    return this.toPublicSettings(await this.load())
  }

  async getResolvedSettings(): Promise<ResolvedRuntimeSettings> {
    const settings = await this.load()
    const effective = this.resolveEffectiveModelSettings(settings)
    const agent = this.resolveAgentSettings(settings)
    const opencodeModelProfile =
      !agent.opencodeBaseUrl &&
      settings.opencodeModelSource.kind === 'profile'
        ? this.resolveProfile(
            settings,
            settings.opencodeModelSource.profileId
          )
        : undefined
    const continueModelProfile =
      settings.continueModelSource.kind === 'profile'
        ? this.resolveProfile(
            settings,
            settings.continueModelSource.profileId
          )
        : undefined
    return {
      provider: settings.provider,
      modelBaseUrl: effective.baseUrl,
      modelName: effective.model,
      modelProtocol: effective.protocol,
      modelAuthentication: effective.authentication,
      imageGenerationQuality: effective.imageGenerationQuality,
      apiKey: effective.apiKey,
      modelProfiles: settings.modelProfiles.map((profile) => {
        const resolved = this.resolveProfile(settings, profile.id)
        if (!resolved) {
          throw new Error(`模型连接不存在：${profile.id}`)
        }
        return resolved
      }),
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
        input.knowledgeEmbeddingApiKey?.action === 'replace'
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
        const normalizedBaseUrl = normalizeModelBaseUrl(profile.baseUrl)
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
          modelName: profile.modelName,
          protocol: profile.protocol,
          authentication: profile.authentication,
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
          nextProfile.credential = {
            formatVersion: 1,
            scheme: 'electron-safe-storage',
            ciphertextBase64: this.cipher
              .encrypt(
                JSON.stringify({
                  version: 1,
                  apiKey: profile.apiKey.value,
                  origin: new URL(normalizedBaseUrl).origin
                })
              )
              .toString('base64')
          }
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
      knowledgeEmbeddingCredential = {
        formatVersion: 1,
        scheme: 'electron-safe-storage',
        ciphertextBase64: this.cipher
          .encrypt(
            JSON.stringify({
              version: 1,
              apiKey: embeddingApiKeyUpdate.value,
              endpoint: embeddingEndpoint
            })
          )
          .toString('base64')
      }
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
      version: 12,
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
      workspacePath: input.workspacePath,
      toolApproval: input.toolApproval
    }

    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      await rename(temporaryPath, this.filePath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
    this.settings = next
    this.loadWarning = undefined
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
