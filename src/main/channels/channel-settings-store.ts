import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  CHANNEL_SETTINGS_LIMITS,
  allowedSenderIdsSchema,
  channelSettingsApplySchema,
  type ChannelRuntimeStatus,
  type ChannelSettingsApply,
  type ChannelSettingsSnapshot,
  type CredentialChannel,
  type DingTalkChannelSettingsInput,
  type ManagedChannel,
  type WeComChannelSettingsInput
} from '../../shared/channel-settings-contracts'
import { weixinAccountDisplay } from '../../shared/weixin-channel-contracts'
import {
  settingsWarningsEqual,
  type SettingsWarning
} from '../../shared/settings-warning-contracts'
import {
  assertSupportedSettingsVersion,
  isolateCorruptSettingsFile,
  isMissingFileError,
  UnsupportedSettingsVersionError,
  writeJsonFileAtomically
} from '../settings-file-utils'
import {
  decryptSettingsCredential,
  encryptedSettingsCredentialSchema,
  encryptSettingsCredential,
  type SettingsCredentialCipher
} from '../settings-credential-cipher'

export type ChannelCredentialCipher = SettingsCredentialCipher

const encryptedCredentialSchema = encryptedSettingsCredentialSchema
  .extend({
    ciphertextBase64: z
      .string()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumSecretLength * 8)
      .regex(/^[a-z0-9+/]+={0,2}$/iu)
  })
  .strict()

const storedChannelFields = {
  enabled: z.boolean(),
  credential: encryptedCredentialSchema.optional(),
  allowedSenderIds: allowedSenderIdsSchema,
  allowGroupMessages: z.boolean()
} as const

const legacyStoredSettingsSchema = z
  .object({
    version: z.literal(1),
    wecom: z
      .object({
        ...storedChannelFields,
        botId: z
          .string()
          .trim()
          .max(CHANNEL_SETTINGS_LIMITS.maximumIdentifierLength)
      })
      .strict(),
    dingtalk: z
      .object({
        ...storedChannelFields,
        clientId: z
          .string()
          .trim()
          .max(CHANNEL_SETTINGS_LIMITS.maximumIdentifierLength)
      })
      .strict()
  })
  .strict()

const legacyWeixinStoredChannelSchema = z
  .object({
    enabled: z.boolean(),
    credential: encryptedCredentialSchema.optional(),
    accountId: z
      .string()
      .trim()
      .max(CHANNEL_SETTINGS_LIMITS.maximumIdentifierLength),
    userId: z
      .string()
      .trim()
      .max(CHANNEL_SETTINGS_LIMITS.maximumIdentifierLength),
    baseUrl: z.union([
      z.literal(''),
      z.string().url().max(2_048)
    ])
  })
  .strict()

const storedSettingsSchema = z
  .object({
    version: z.literal(3),
    weixin: z
      .object({
        enabled: z.boolean(),
        credential: encryptedCredentialSchema.optional()
      })
      .strict(),
    wecom: legacyStoredSettingsSchema.shape.wecom,
    dingtalk: legacyStoredSettingsSchema.shape.dingtalk
  })
  .strict()

type StoredSettings = z.infer<typeof storedSettingsSchema>
type StoredCredentialChannel =
  | StoredSettings['wecom']
  | StoredSettings['dingtalk']
type StoredEncryptedCredential = z.infer<
  typeof encryptedCredentialSchema
>

class DeferredWeixinMigrationError extends Error {}

const credentialPayloadSchema = z
  .object({
    version: z.literal(1),
    channel: z.enum(['weixin', 'wecom', 'dingtalk']),
    secret: z
      .string()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumSecretLength)
  })
  .strict()

const weixinCredentialPayloadSchema = z
  .object({
    version: z.literal(2),
    channel: z.literal('weixin'),
    accountId: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumIdentifierLength),
    userId: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumIdentifierLength),
    baseUrl: z.string().url().max(2_048),
    token: z
      .string()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumSecretLength)
  })
  .strict()

const versionTwoStoredSettingsSchema = z
  .object({
    version: z.literal(2),
    weixin: legacyWeixinStoredChannelSchema,
    wecom: legacyStoredSettingsSchema.shape.wecom,
    dingtalk: legacyStoredSettingsSchema.shape.dingtalk
  })
  .strict()

type EnvironmentChannel = {
  owned: boolean
  enabled: boolean
  id: string
  secret?: string
  allowedSenderIds: readonly string[]
  allowGroupMessages: boolean
  warning?: SettingsWarning
}

export type ResolvedChannelSettings =
  | {
      channel: 'weixin'
      enabled: boolean
      accountId: string
      userId: string
      baseUrl: string
      token?: string
      allowedSenderIds: readonly string[]
      allowGroupMessages: false
      source: 'none' | 'encrypted'
      readOnly: false
    }
  | {
      channel: 'wecom'
      enabled: boolean
      botId: string
      secret?: string
      allowedSenderIds: readonly string[]
      allowGroupMessages: boolean
      source: 'none' | 'encrypted' | 'environment' | 'unreadable'
      readOnly: boolean
    }
  | {
      channel: 'dingtalk'
      enabled: boolean
      clientId: string
      secret?: string
      allowedSenderIds: readonly string[]
      allowGroupMessages: boolean
      source: 'none' | 'encrypted' | 'environment' | 'unreadable'
      readOnly: boolean
    }

const defaultStoredSettings: StoredSettings = {
  version: 3,
  weixin: {
    enabled: false
  },
  wecom: {
    enabled: false,
    botId: '',
    allowedSenderIds: [],
    allowGroupMessages: false
  },
  dingtalk: {
    enabled: false,
    clientId: '',
    allowedSenderIds: [],
    allowGroupMessages: false
  }
}

const defaultStatus = (enabled: boolean): ChannelRuntimeStatus => ({
  state: enabled ? 'stopped' : 'disabled'
})

function boundedEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  maximum: number
): { value?: string; invalid: boolean } {
  const raw = environment[name]
  if (raw === undefined || raw.trim() === '') {
    return { invalid: false }
  }
  const value = raw.trim()
  return value.length <= maximum
    ? { value, invalid: false }
    : { invalid: true }
}

function environmentBoolean(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean
): { value: boolean; invalid: boolean } {
  const raw = environment[name]
  if (raw === undefined || raw.trim() === '') {
    return { value: fallback, invalid: false }
  }
  if (raw === 'true') {
    return { value: true, invalid: false }
  }
  if (raw === 'false') {
    return { value: false, invalid: false }
  }
  return { value: false, invalid: true }
}

function environmentSenders(
  environment: NodeJS.ProcessEnv,
  name: string,
  normalize: (value: string) => string
): { value: readonly string[]; invalid: boolean } {
  const raw = environment[name]
  if (raw === undefined || raw.trim() === '') {
    return { value: [], invalid: false }
  }
  const parsed = allowedSenderIdsSchema.safeParse(
    raw.split(',').map((value) => normalize(value.trim()))
  )
  return parsed.success
    ? { value: parsed.data, invalid: false }
    : { value: [], invalid: true }
}

function normalizeDingTalkSender(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US')
}

function cloneStored(settings: StoredSettings): StoredSettings {
  return structuredClone(settings)
}

const weixinBindingSchema = z
  .object({
    accountId: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumIdentifierLength),
    userId: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumIdentifierLength),
    baseUrl: z
      .string()
      .url()
      .max(2_048)
      .refine(
        (value) =>
          ['http:', 'https:'].includes(new URL(value).protocol),
        {
          message: '微信服务地址必须使用 HTTP 或 HTTPS'
        }
      ),
    token: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumSecretLength)
  })
  .strict()

export type WeixinBinding = z.infer<typeof weixinBindingSchema>

export class ChannelSettingsStore {
  private settings?: StoredSettings
  private settingsLoad?: Promise<StoredSettings>
  private temporarilyDisabledWeixin = false
  private warnings: SettingsWarning[] = []
  private runtimeRepairWarning?: SettingsWarning
  private updateQueue: Promise<void> = Promise.resolve()
  private readonly environmentChannels: Record<
    CredentialChannel,
    EnvironmentChannel
  >

  constructor(
    private readonly filePath: string,
    private readonly cipher: ChannelCredentialCipher,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now
  ) {
    this.environmentChannels = {
      wecom: this.readEnvironmentChannel('wecom'),
      dingtalk: this.readEnvironmentChannel('dingtalk')
    }
  }

  async snapshot(
    statuses: Partial<Record<ManagedChannel, ChannelRuntimeStatus>> = {}
  ): Promise<ChannelSettingsSnapshot> {
    const [weixin, wecom, dingtalk] = await Promise.all([
      this.resolve('weixin'),
      this.resolve('wecom'),
      this.resolve('dingtalk')
    ])
    const weComEnvironment = this.environmentChannel('wecom')
    const dingTalkEnvironment = this.environmentChannel('dingtalk')
    const warnings = [
      ...this.warnings,
      ...(this.runtimeRepairWarning ? [this.runtimeRepairWarning] : []),
      ...(weComEnvironment.warning ? [weComEnvironment.warning] : []),
      ...(dingTalkEnvironment.warning ? [dingTalkEnvironment.warning] : [])
    ].filter(
      (warning, index, values) =>
        values.findIndex(
          (candidate) => settingsWarningsEqual(candidate, warning)
        ) === index
    )
    return {
      weixin: {
        enabled: weixin.enabled,
        bindingConfigured: weixin.token !== undefined,
        source: weixin.source,
        accountDisplay: weixinAccountDisplay(weixin.userId),
        status: statuses.weixin ?? defaultStatus(weixin.enabled)
      },
      wecom: {
        enabled: wecom.enabled,
        botId: wecom.botId,
        secretConfigured: wecom.secret !== undefined,
        source: wecom.source,
        readOnly: wecom.readOnly,
        allowedSenderIds: [...wecom.allowedSenderIds],
        allowGroupMessages: wecom.allowGroupMessages,
        status:
          statuses.wecom ??
          (weComEnvironment.warning === undefined
            ? defaultStatus(wecom.enabled)
            : { state: 'error' })
      },
      dingtalk: {
        enabled: dingtalk.enabled,
        clientId: dingtalk.clientId,
        secretConfigured: dingtalk.secret !== undefined,
        source: dingtalk.source,
        readOnly: dingtalk.readOnly,
        allowedSenderIds: [...dingtalk.allowedSenderIds],
        allowGroupMessages: dingtalk.allowGroupMessages,
        status:
          statuses.dingtalk ??
          (dingTalkEnvironment.warning === undefined
            ? defaultStatus(dingtalk.enabled)
            : { state: 'error' })
      },
      ...(warnings.length > 0 ? { warnings } : {})
    }
  }

  reportRuntimeSelectionRepairs(count: number): void {
    this.runtimeRepairWarning =
      count > 0
        ? {
            code: 'channel-runtime-selections-repaired',
            count
          }
        : undefined
  }

  getSnapshot(
    statuses?: Partial<Record<ManagedChannel, ChannelRuntimeStatus>>
  ): Promise<ChannelSettingsSnapshot> {
    return this.snapshot(statuses)
  }

  resolve(channel: 'wecom'): Promise<Extract<ResolvedChannelSettings, {
    channel: 'wecom'
  }>>
  resolve(channel: 'dingtalk'): Promise<Extract<ResolvedChannelSettings, {
    channel: 'dingtalk'
  }>>
  resolve(channel: 'weixin'): Promise<Extract<ResolvedChannelSettings, {
    channel: 'weixin'
  }>>
  resolve(channel: ManagedChannel): Promise<ResolvedChannelSettings>
  async resolve(channel: ManagedChannel): Promise<ResolvedChannelSettings> {
    if (channel === 'weixin') {
      const settings = await this.load()
      const stored = settings.weixin
      const binding = this.decryptWeixinBinding(stored)
      if (this.temporarilyDisabledWeixin && binding) {
        this.temporarilyDisabledWeixin = false
        this.removeWarnings([
          'channel-weixin-credential-unreadable',
          'channel-weixin-secure-storage-unavailable'
        ])
      }
      return {
        channel,
        enabled: stored.enabled && !this.temporarilyDisabledWeixin,
        accountId: binding?.accountId ?? '',
        userId: binding?.userId ?? '',
        baseUrl: binding?.baseUrl ?? '',
        ...(binding === undefined ? {} : { token: binding.token }),
        allowedSenderIds: binding ? [binding.userId] : [],
        allowGroupMessages: false,
        source: binding === undefined ? 'none' : 'encrypted',
        readOnly: false
      }
    }
    const environment = this.environmentChannel(channel)
    if (environment.owned) {
      const common = {
        enabled: environment.enabled,
        secret: environment.secret,
        allowedSenderIds: environment.allowedSenderIds,
        allowGroupMessages: environment.allowGroupMessages,
        source: 'environment' as const,
        readOnly: true
      }
      return channel === 'wecom'
        ? {
            channel,
            botId: environment.id,
            ...common
          }
        : {
            channel,
            clientId: environment.id,
            ...common
          }
    }

    const settings = await this.load()
    const stored = settings[channel]
    const secret = this.decryptCredential(channel, stored)
    const credentialUnreadable =
      stored.credential !== undefined && secret === undefined
    const common = {
      enabled: stored.enabled,
      ...(secret === undefined ? {} : { secret }),
      allowedSenderIds: [...stored.allowedSenderIds],
      allowGroupMessages: stored.allowGroupMessages,
      source: credentialUnreadable
        ? ('unreadable' as const)
        : secret === undefined
          ? ('none' as const)
          : ('encrypted' as const),
      readOnly: false
    }
    return channel === 'wecom'
      ? { channel, botId: settings.wecom.botId, ...common }
      : { channel, clientId: settings.dingtalk.clientId, ...common }
  }

  resolveAll(): Promise<readonly [
    Extract<ResolvedChannelSettings, { channel: 'weixin' }>,
    Extract<ResolvedChannelSettings, { channel: 'wecom' }>,
    Extract<ResolvedChannelSettings, { channel: 'dingtalk' }>
  ]> {
    return Promise.all([
      this.resolve('weixin'),
      this.resolve('wecom'),
      this.resolve('dingtalk')
    ])
  }

  async saveWeixinBinding(input: WeixinBinding): Promise<ChannelSettingsSnapshot> {
    const parsed = weixinBindingSchema.parse(input)
    let snapshot!: ChannelSettingsSnapshot
    const update = async (): Promise<void> => {
      const current = cloneStored(await this.load())
      current.weixin = {
        enabled: true,
        credential: this.encryptWeixinBinding(parsed)
      }
      await this.persist(current)
      this.settings = current
      this.temporarilyDisabledWeixin = false
      this.removeWarnings([
        'channel-weixin-credential-unreadable',
        'channel-weixin-secure-storage-unavailable',
        'channel-weixin-legacy-binding-invalid'
      ])
      snapshot = await this.snapshot()
    }
    const operation = this.updateQueue.then(update, update)
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation.then(() => snapshot)
  }

  async clearWeixinBinding(): Promise<ChannelSettingsSnapshot> {
    let snapshot!: ChannelSettingsSnapshot
    const update = async (): Promise<void> => {
      const current = cloneStored(await this.load())
      current.weixin = {
        enabled: false
      }
      await this.persist(current)
      this.settings = current
      this.temporarilyDisabledWeixin = false
      this.removeWarnings([
        'channel-weixin-credential-unreadable',
        'channel-weixin-secure-storage-unavailable',
        'channel-weixin-legacy-binding-invalid'
      ])
      snapshot = await this.snapshot()
    }
    const operation = this.updateQueue.then(update, update)
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation.then(() => snapshot)
  }

  apply(input: ChannelSettingsApply): Promise<ChannelSettingsSnapshot> {
    const parsed = channelSettingsApplySchema.parse(input)
    let snapshot!: ChannelSettingsSnapshot
    const update = async (): Promise<void> => {
      snapshot = await this.applyNow(parsed)
    }
    const operation = this.updateQueue.then(update, update)
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation.then(() => snapshot)
  }

  private async applyNow(
    input: ChannelSettingsApply
  ): Promise<ChannelSettingsSnapshot> {
    const current = cloneStored(await this.load())
    if (input.weixin !== undefined) {
      current.weixin.enabled = input.weixin.enabled
    }
    if (input.wecom !== undefined) {
      if (this.environmentChannel('wecom').owned) {
        throw new Error('企业微信由环境变量配置，不能在设置中修改')
      }
      current.wecom = this.updateStoredChannel(
        'wecom',
        current.wecom,
        input.wecom
      )
    }
    if (input.dingtalk !== undefined) {
      if (this.environmentChannel('dingtalk').owned) {
        throw new Error('钉钉由环境变量配置，不能在设置中修改')
      }
      current.dingtalk = this.updateStoredChannel(
        'dingtalk',
        current.dingtalk,
        input.dingtalk
      )
    }

    if (!this.temporarilyDisabledWeixin || input.weixin !== undefined) {
      this.validateEnabledWeixin(current.weixin)
    }
    this.validateEnabledCredentialChannel('wecom', current.wecom)
    this.validateEnabledCredentialChannel('dingtalk', current.dingtalk)
    await this.persist(current)
    this.settings = current
    if (!this.temporarilyDisabledWeixin) {
      this.removeWarnings([
        'channel-weixin-credential-unreadable',
        'channel-weixin-secure-storage-unavailable',
        'channel-weixin-legacy-binding-invalid'
      ])
    }
    const resolvedWarningCodes: SettingsWarning['code'][] = [
      'channel-settings-recovered'
    ]
    if (input.wecom !== undefined) {
      resolvedWarningCodes.push('channel-wecom-credential-unreadable')
    }
    if (input.dingtalk !== undefined) {
      resolvedWarningCodes.push('channel-dingtalk-credential-unreadable')
    }
    this.removeWarnings(resolvedWarningCodes)
    return this.snapshot()
  }

  private updateStoredChannel(
    channel: 'wecom',
    current: StoredSettings['wecom'],
    input: WeComChannelSettingsInput
  ): StoredSettings['wecom']
  private updateStoredChannel(
    channel: 'dingtalk',
    current: StoredSettings['dingtalk'],
    input: DingTalkChannelSettingsInput
  ): StoredSettings['dingtalk']
  private updateStoredChannel(
    channel: CredentialChannel,
    current: StoredCredentialChannel,
    input: WeComChannelSettingsInput | DingTalkChannelSettingsInput
  ): StoredCredentialChannel {
    const credential =
      input.secret.action === 'keep'
        ? current.credential
        : input.secret.action === 'clear'
          ? undefined
          : this.encryptCredential(channel, input.secret.value)
    const allowedSenderIds =
      channel === 'dingtalk'
        ? [...new Set(input.allowedSenderIds.map(normalizeDingTalkSender))]
        : [...input.allowedSenderIds]
    const common = {
      enabled: input.enabled,
      ...(credential === undefined ? {} : { credential }),
      allowedSenderIds,
      allowGroupMessages: input.allowGroupMessages
    }
    return channel === 'wecom'
      ? {
          ...common,
          botId: (input as WeComChannelSettingsInput).botId
        }
      : {
          ...common,
          clientId: (input as DingTalkChannelSettingsInput).clientId
        }
  }

  private validateEnabledWeixin(
    stored: StoredSettings['weixin']
  ): void {
    if (!stored.enabled) {
      return
    }
    if (
      this.decryptWeixinBinding(stored) === undefined
    ) {
      throw new Error('启用微信 ClawBot 前需要先完成扫码绑定')
    }
  }

  private validateEnabledCredentialChannel(
    channel: CredentialChannel,
    stored: StoredCredentialChannel
  ): void {
    if (!stored.enabled) {
      return
    }
    const identifier =
      channel === 'wecom'
        ? (stored as StoredSettings['wecom']).botId
        : (stored as StoredSettings['dingtalk']).clientId
    if (
      identifier.length === 0 ||
      stored.allowedSenderIds.length === 0 ||
      this.decryptCredential(channel, stored) === undefined
    ) {
      throw new Error(
        channel === 'wecom'
          ? '启用企业微信前需要配置机器人 ID、Secret 和允许的发送者'
          : '启用钉钉前需要配置 Client ID、Secret 和允许的发送者'
      )
    }
  }

  private encryptCredential(
    channel: CredentialChannel,
    secret: string
  ): StoredEncryptedCredential {
    if (!this.cipher.isAvailable()) {
      throw new Error('系统安全存储不可用，无法保存通道 Secret')
    }
    return encryptSettingsCredential(this.cipher, {
      version: 1,
      channel,
      secret
    })
  }

  private decryptCredential(
    channel: CredentialChannel,
    stored: StoredCredentialChannel
  ): string | undefined {
    if (stored.credential === undefined) {
      return undefined
    }
    const warn = (): undefined => {
      this.addWarning({
        code:
          channel === 'wecom'
            ? 'channel-wecom-credential-unreadable'
            : 'channel-dingtalk-credential-unreadable'
      })
      return undefined
    }
    if (!this.cipher.isAvailable()) {
      return warn()
    }
    try {
      const payload = credentialPayloadSchema.parse(
        decryptSettingsCredential(this.cipher, stored.credential)
      )
      if (payload.channel !== channel) {
        return warn()
      }
      this.removeWarnings([
        channel === 'wecom'
          ? 'channel-wecom-credential-unreadable'
          : 'channel-dingtalk-credential-unreadable'
      ])
      return payload.secret
    } catch {
      return warn()
    }
  }

  private encryptWeixinBinding(
    binding: WeixinBinding
  ): StoredEncryptedCredential {
    if (!this.cipher.isAvailable()) {
      throw new Error('系统安全存储不可用，无法保存微信绑定')
    }
    return encryptSettingsCredential(this.cipher, {
      version: 2,
      channel: 'weixin',
      accountId: binding.accountId,
      userId: binding.userId,
      baseUrl: binding.baseUrl,
      token: binding.token
    })
  }

  private decryptWeixinBinding(
    stored: StoredSettings['weixin']
  ): WeixinBinding | undefined {
    if (stored.credential === undefined || !this.cipher.isAvailable()) {
      return undefined
    }
    try {
      return weixinCredentialPayloadSchema.parse(
        decryptSettingsCredential(this.cipher, stored.credential)
      )
    } catch {
      return undefined
    }
  }

  private load(): Promise<StoredSettings> {
    if (this.settings !== undefined) {
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
      const raw: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      assertSupportedSettingsVersion(raw, 3, (version) =>
        `当前 GoodBuddy 不支持通道设置版本 ${version}，请升级应用后重试`
      )
      const current = storedSettingsSchema.safeParse(raw)
      if (current.success) {
        this.settings = this.normalizeStoredSettings(current.data)
      } else {
        const versionTwo = versionTwoStoredSettingsSchema.safeParse(raw)
        if (versionTwo.success) {
          this.settings = this.migrateVersionTwo(versionTwo.data)
        } else {
          const legacy = legacyStoredSettingsSchema.parse(raw)
          this.settings = {
            version: 3,
            weixin: {
              enabled: false
            },
            wecom: legacy.wecom,
            dingtalk: legacy.dingtalk
          }
        }
        await this.persist(this.settings)
      }
    } catch (error) {
      if (
        error instanceof UnsupportedSettingsVersionError ||
        error instanceof DeferredWeixinMigrationError
      ) {
        throw error
      }
      if (!isMissingFileError(error)) {
        await isolateCorruptSettingsFile(
          this.filePath,
          '通道设置已损坏且无法隔离',
          this.now
        )
        this.warnings = [{ code: 'channel-settings-recovered' }]
      }
      this.settings = cloneStored(defaultStoredSettings)
    }
    return this.settings
  }

  private normalizeStoredSettings(settings: StoredSettings): StoredSettings {
    if (
      settings.weixin.credential &&
      this.decryptWeixinBinding(settings.weixin) === undefined
    ) {
      this.temporarilyDisabledWeixin = true
      this.addWarning({
        code: this.cipher.isAvailable()
          ? 'channel-weixin-credential-unreadable'
          : 'channel-weixin-secure-storage-unavailable'
      })
    } else {
      this.temporarilyDisabledWeixin = false
    }
    return settings
  }

  private migrateVersionTwo(
    settings: z.infer<typeof versionTwoStoredSettingsSchema>
  ): StoredSettings {
    const legacyWeixin = settings.weixin
    if (legacyWeixin.credential && !this.cipher.isAvailable()) {
      throw new DeferredWeixinMigrationError(
        '系统安全存储暂不可用，旧版微信绑定尚未迁移；原设置已保留，请恢复安全存储后重试'
      )
    }
    let token: string | undefined
    if (legacyWeixin.credential) {
      try {
        const payload = credentialPayloadSchema.parse(
          decryptSettingsCredential(
            this.cipher,
            legacyWeixin.credential
          )
        )
        token =
          payload.channel === 'weixin' ? payload.secret : undefined
      } catch {
        throw new DeferredWeixinMigrationError(
          '旧版微信绑定无法解密，原设置已保留；请恢复原安全存储后重试'
        )
      }
    }
    const binding =
      token &&
      legacyWeixin.accountId &&
      legacyWeixin.userId &&
      legacyWeixin.baseUrl
        ? {
            accountId: legacyWeixin.accountId,
            userId: legacyWeixin.userId,
            baseUrl: legacyWeixin.baseUrl,
            token
          }
        : undefined
    if (legacyWeixin.credential && !binding) {
      throw new DeferredWeixinMigrationError(
        '旧版微信绑定信息不完整或无法验证，原设置已保留；请恢复原配置后重试'
      )
    }
    if (legacyWeixin.enabled && !binding) {
      this.addWarning({
        code: 'channel-weixin-legacy-binding-invalid'
      })
    }
    return {
      version: 3,
      weixin: {
        enabled: binding ? legacyWeixin.enabled : false,
        ...(binding
          ? { credential: this.encryptWeixinBinding(binding) }
          : {})
      },
      wecom: settings.wecom,
      dingtalk: settings.dingtalk
    }
  }

  private async persist(settings: StoredSettings): Promise<void> {
    await writeJsonFileAtomically(this.filePath, settings)
  }

  private environmentChannel(channel: CredentialChannel): EnvironmentChannel {
    return this.environmentChannels[channel]
  }

  private readEnvironmentChannel(
    channel: CredentialChannel
  ): EnvironmentChannel {
    const prefix =
      channel === 'wecom' ? 'GOODBUDDY_WECOM' : 'GOODBUDDY_DINGTALK'
    const idName =
      channel === 'wecom'
        ? `${prefix}_BOT_ID`
        : `${prefix}_CLIENT_ID`
    const secretName =
      channel === 'wecom'
        ? `${prefix}_SECRET`
        : `${prefix}_CLIENT_SECRET`
    const id = boundedEnvironmentValue(
      this.environment,
      idName,
      CHANNEL_SETTINGS_LIMITS.maximumIdentifierLength
    )
    const secret = boundedEnvironmentValue(
      this.environment,
      secretName,
      CHANNEL_SETTINGS_LIMITS.maximumSecretLength
    )
    const owned = id.value !== undefined || secret.value !== undefined ||
      id.invalid || secret.invalid
    if (!owned) {
      return {
        owned: false,
        enabled: false,
        id: '',
        allowedSenderIds: [],
        allowGroupMessages: false
      }
    }

    const enabled = environmentBoolean(
      this.environment,
      `${prefix}_ENABLED`,
      true
    )
    const allowGroups = environmentBoolean(
      this.environment,
      `${prefix}_ALLOW_GROUPS`,
      false
    )
    const senders = environmentSenders(
      this.environment,
      `${prefix}_ALLOWED_SENDERS`,
      channel === 'dingtalk'
        ? normalizeDingTalkSender
        : (value) => value
    )
    const invalid =
      id.invalid ||
      secret.invalid ||
      enabled.invalid ||
      allowGroups.invalid ||
      senders.invalid
    return {
      owned: true,
      enabled: invalid ? false : enabled.value,
      id: id.value ?? '',
      ...(secret.value === undefined ? {} : { secret: secret.value }),
      allowedSenderIds: senders.value,
      allowGroupMessages: allowGroups.value,
      ...(!invalid &&
      id.value !== undefined &&
      secret.value !== undefined &&
      senders.value.length > 0
        ? {}
        : {
            warning: {
              code:
                channel === 'wecom'
                  ? 'channel-wecom-environment-invalid'
                  : 'channel-dingtalk-environment-invalid'
            }
          })
    }
  }

  private addWarning(warning: SettingsWarning): void {
    if (
      !this.warnings.some(
        (current) => settingsWarningsEqual(current, warning)
      )
    ) {
      this.warnings.push(warning)
    }
  }

  private removeWarnings(
    codes: readonly SettingsWarning['code'][]
  ): void {
    this.warnings = this.warnings.filter(
      (warning) => !codes.includes(warning.code)
    )
  }
}
