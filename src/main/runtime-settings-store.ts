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

const storedModelProfileSchema = version5StoredModelProfileSchema.extend({
  protocol: modelProtocolSchema,
  authentication: modelAuthenticationSchema
})

const storedSettingsSchema = version5StoredSettingsSchema
  .omit({ version: true, modelProfiles: true })
  .extend({
    version: z.literal(6),
    modelProfiles: z.array(storedModelProfileSchema).min(1).max(20),
    runtimeSandboxMode: runtimeSandboxModeSchema.default('auto'),
    knowledgeEmbeddingEnabled: z.boolean().default(false),
    knowledgeEmbeddingBaseUrl: z
      .string()
      .default('http://127.0.0.1:11434'),
    knowledgeEmbeddingModel: z.string().default('nomic-embed-text')
  })

type StoredSettings = z.infer<typeof storedSettingsSchema>

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
  apiKey?: string
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
  knowledgeEmbeddingEnabled: boolean
  knowledgeEmbeddingBaseUrl: string
  knowledgeEmbeddingModel: string
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
  apiKey?: string
}

const defaultSettings: StoredSettings = {
  version: 6,
  provider: defaultRuntimeSettings.provider,
  modelProfiles: [
    {
      id: defaultModelProfileId,
      name: '默认模型',
      baseUrl: defaultRuntimeSettings.modelBaseUrl,
      modelName: defaultRuntimeSettings.modelName,
      protocol: defaultRuntimeSettings.modelProtocol,
      authentication: defaultRuntimeSettings.modelAuthentication
    }
  ],
  defaultModelProfileId,
  opencodeModelSource: { kind: 'platform' },
  continueModelSource: { kind: 'platform' },
  opencodeBaseUrl: defaultRuntimeSettings.opencodeBaseUrl,
  opencodeEmbedded: defaultRuntimeSettings.opencodeEmbedded,
  opencodeBinaryPath: defaultRuntimeSettings.opencodeBinaryPath,
  opencodeConfigPath: defaultRuntimeSettings.opencodeConfigPath,
  continueBinaryPath: defaultRuntimeSettings.continueBinaryPath,
  continueConfigPath: defaultRuntimeSettings.continueConfigPath,
  continueMode: defaultRuntimeSettings.continueMode,
  runtimeSandboxMode: defaultRuntimeSettings.runtimeSandboxMode,
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

function migrateVersion4(
  settings: z.infer<typeof version4StoredSettingsSchema>
): StoredSettings {
  return {
    version: 6,
    provider: settings.provider,
    modelProfiles: [
      {
        id: defaultModelProfileId,
        name: '默认模型',
        baseUrl: settings.modelBaseUrl,
        modelName: settings.modelName,
        protocol: 'anthropic-messages',
        authentication: 'api-key',
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
    knowledgeEmbeddingEnabled:
      defaultRuntimeSettings.knowledgeEmbeddingEnabled,
    knowledgeEmbeddingBaseUrl:
      defaultRuntimeSettings.knowledgeEmbeddingBaseUrl,
    knowledgeEmbeddingModel:
      defaultRuntimeSettings.knowledgeEmbeddingModel,
    workspacePath: settings.workspacePath,
    toolApproval: settings.toolApproval
  }
}

function migrateVersion5(
  settings: z.infer<typeof version5StoredSettingsSchema>
): StoredSettings {
  return {
    ...settings,
    version: 6,
    runtimeSandboxMode: defaultRuntimeSettings.runtimeSandboxMode,
    knowledgeEmbeddingEnabled:
      defaultRuntimeSettings.knowledgeEmbeddingEnabled,
    knowledgeEmbeddingBaseUrl:
      defaultRuntimeSettings.knowledgeEmbeddingBaseUrl,
    knowledgeEmbeddingModel:
      defaultRuntimeSettings.knowledgeEmbeddingModel,
    modelProfiles: settings.modelProfiles.map((profile) => ({
      ...profile,
      protocol: 'anthropic-messages',
      authentication: 'api-key'
    }))
  }
}

function normalizeModelBaseUrl(value: string): string {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/u, '')
  return url.toString().replace(/\/$/u, '')
}

function normalizeEffectiveModelConnection(
  baseUrl: string,
  model: string,
  protocol: RuntimeSettings['modelProtocol']
): {
  baseUrl: string
  protocol: RuntimeSettings['modelProtocol']
} {
  if (!/^gpt-image-/iu.test(model)) {
    return { baseUrl, protocol }
  }
  const url = new URL(baseUrl)
  if (
    protocol !== 'openai-images-generations' &&
    url.hostname.toLowerCase() === 'bigtoken.ai' &&
    (url.pathname === '/' || url.pathname === '')
  ) {
    url.pathname = '/v1'
  }
  return {
    baseUrl: url.toString().replace(/\/$/u, ''),
    protocol: 'openai-images-generations'
  }
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
      const current = storedSettingsSchema.safeParse(parsed)
      if (current.success) {
        this.settings = current.data
      } else {
        const version5 = version5StoredSettingsSchema.safeParse(parsed)
        if (version5.success) {
          this.settings = migrateVersion5(version5.data)
        } else {
          const version4 = version4StoredSettingsSchema.safeParse(parsed)
          if (version4.success) {
            this.settings = migrateVersion4(version4.data)
          } else {
            const version3 = version3StoredSettingsSchema.safeParse(parsed)
            if (version3.success) {
              this.settings = migrateVersion4({
                ...version3.data,
                version: 4,
                continueMode: 'chat'
              })
            } else {
              const version2 = version2StoredSettingsSchema.safeParse(parsed)
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
                const legacy = legacyStoredSettingsSchema.parse(parsed)
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
    } catch (error) {
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
      return payload.origin === new URL(profile.baseUrl).origin
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
    const effectiveConnection = normalizeEffectiveModelConnection(
      baseUrl,
      model,
      profile.protocol
    )
    return {
      apiKey: environmentApiKey ?? storedApiKey,
      baseUrl: effectiveConnection.baseUrl,
      model,
      protocol: effectiveConnection.protocol,
      authentication: profile.authentication,
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
        apiKey: effective.apiKey
      }
    }
    const connection = normalizeEffectiveModelConnection(
      profile.baseUrl,
      profile.modelName,
      profile.protocol
    )
    return {
      id: profile.id,
      name: profile.name,
      baseUrl: connection.baseUrl,
      modelName: profile.modelName,
      protocol: connection.protocol,
      authentication: profile.authentication,
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
    const embeddedEnvironment =
      this.environment.GOODBUDDY_OPENCODE_EMBEDDED?.trim()
    const continueBinaryEnvironment =
      this.environment.GOODBUDDY_CONTINUE_BINARY?.trim()
    const legacyContinueCommand =
      this.environment.GOODBUDDY_CONTINUE_COMMAND?.trim()
    return {
      opencodeBaseUrl:
        this.environment.GOODBUDDY_OPENCODE_URL?.trim() ??
        settings.opencodeBaseUrl,
      opencodeEmbedded:
        embeddedEnvironment === undefined
          ? settings.opencodeEmbedded
          : embeddedEnvironment === 'true',
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
      const connection = isDefault
        ? undefined
        : normalizeEffectiveModelConnection(
            profile.baseUrl,
            profile.modelName,
            profile.protocol
          )
      const apiKey =
        profile.authentication === 'api-key'
          ? this.getStoredApiKey(profile)
          : undefined
      return {
        id: profile.id,
        name: profile.name,
        baseUrl: isDefault
          ? effective.baseUrl
          : (connection?.baseUrl ?? profile.baseUrl),
        modelName: isDefault ? effective.model : profile.modelName,
        protocol: isDefault
          ? effective.protocol
          : (connection?.protocol ?? profile.protocol),
        authentication: isDefault
          ? effective.authentication
          : profile.authentication,
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
    return {
      provider: settings.provider,
      modelBaseUrl: effective.baseUrl,
      modelName: effective.model,
      modelProtocol: effective.protocol,
      modelAuthentication: effective.authentication,
      opencodeBaseUrl: agent.opencodeBaseUrl,
      opencodeEmbedded: agent.opencodeEmbedded,
      opencodeBinaryPath: agent.opencodeBinaryPath,
      opencodeConfigPath: agent.opencodeConfigPath,
      continueBinaryPath: agent.continueBinaryPath,
      continueConfigPath: agent.continueConfigPath,
      continueMode: agent.continueMode,
      runtimeSandboxMode: agent.runtimeSandboxMode,
      knowledgeEmbeddingEnabled: settings.knowledgeEmbeddingEnabled,
      knowledgeEmbeddingBaseUrl: settings.knowledgeEmbeddingBaseUrl,
      knowledgeEmbeddingModel: settings.knowledgeEmbeddingModel,
      workspacePath: agent.workspacePath,
      apiKeyConfigured: Boolean(effective.apiKey),
      credentialSource: effective.credentialSource,
      modelProfiles,
      defaultModelProfileId: settings.defaultModelProfileId,
      opencodeModelSource: settings.opencodeModelSource,
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
      apiKey: effective.apiKey,
      opencodeModelProfile,
      continueModelProfile,
      ...agent,
      knowledgeEmbeddingEnabled: settings.knowledgeEmbeddingEnabled,
      knowledgeEmbeddingBaseUrl: settings.knowledgeEmbeddingBaseUrl,
      knowledgeEmbeddingModel: settings.knowledgeEmbeddingModel,
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
              apiKey: input.apiKey
            }
          : {
              id: profile.id,
              name: profile.name,
              baseUrl: profile.baseUrl,
              modelName: profile.modelName,
              protocol: profile.protocol,
              authentication: profile.authentication,
              apiKey: { action: 'keep' as const }
            }
      )
    if (
      profileInputs.some(
        (profile) =>
          profile.authentication === 'api-key' &&
          profile.apiKey.action === 'replace'
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
          authentication: profile.authentication
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

    const next: StoredSettings = {
      ...current,
      version: 6,
      provider: input.provider,
      modelProfiles,
      defaultModelProfileId:
        input.defaultModelProfileId ??
        (input.modelProfiles
          ? modelProfiles[0]!.id
          : current.defaultModelProfileId),
      opencodeModelSource:
        input.opencodeModelSource ?? current.opencodeModelSource,
      continueModelSource:
        input.continueModelSource ?? current.continueModelSource,
      opencodeBaseUrl: input.opencodeBaseUrl
        ? new URL(input.opencodeBaseUrl).origin
        : '',
      opencodeEmbedded: input.opencodeEmbedded,
      opencodeBinaryPath,
      opencodeConfigPath,
      continueBinaryPath,
      continueConfigPath,
      continueMode: input.continueMode,
      runtimeSandboxMode: input.runtimeSandboxMode,
      knowledgeEmbeddingEnabled: input.knowledgeEmbeddingEnabled,
      knowledgeEmbeddingBaseUrl: new URL(
        input.knowledgeEmbeddingBaseUrl
      ).origin,
      knowledgeEmbeddingModel: input.knowledgeEmbeddingModel,
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
