import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  CHANNEL_SETTINGS_LIMITS,
  allowedSenderIdsSchema,
  channelSettingsApplySchema,
  type ChannelRuntimeStatus,
  type ChannelSettingsApply,
  type ChannelSettingsSnapshot,
  type DingTalkChannelSettingsInput,
  type ManagedChannel,
  type WeComChannelSettingsInput
} from '../../shared/channel-settings-contracts'

export interface ChannelCredentialCipher {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

const encryptedCredentialSchema = z
  .object({
    formatVersion: z.literal(1),
    scheme: z.literal('electron-safe-storage'),
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

const storedSettingsSchema = z
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

type StoredSettings = z.infer<typeof storedSettingsSchema>
type StoredChannel = StoredSettings['wecom'] | StoredSettings['dingtalk']

const credentialPayloadSchema = z
  .object({
    version: z.literal(1),
    channel: z.enum(['wecom', 'dingtalk']),
    secret: z
      .string()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumSecretLength)
  })
  .strict()

type EnvironmentChannel = {
  owned: boolean
  enabled: boolean
  id: string
  secret?: string
  allowedSenderIds: readonly string[]
  allowGroupMessages: boolean
  error?: string
}

export type ResolvedChannelSettings =
  | {
      channel: 'wecom'
      enabled: boolean
      botId: string
      secret?: string
      allowedSenderIds: readonly string[]
      allowGroupMessages: boolean
      source: 'none' | 'encrypted' | 'environment'
      readOnly: boolean
    }
  | {
      channel: 'dingtalk'
      enabled: boolean
      clientId: string
      secret?: string
      allowedSenderIds: readonly string[]
      allowGroupMessages: boolean
      source: 'none' | 'encrypted' | 'environment'
      readOnly: boolean
    }

const defaultStoredSettings: StoredSettings = {
  version: 1,
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

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

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

export class ChannelSettingsStore {
  private settings?: StoredSettings
  private warning?: string
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly cipher: ChannelCredentialCipher,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now
  ) {}

  async snapshot(
    statuses: Partial<Record<ManagedChannel, ChannelRuntimeStatus>> = {}
  ): Promise<ChannelSettingsSnapshot> {
    const [wecom, dingtalk] = await Promise.all([
      this.resolve('wecom'),
      this.resolve('dingtalk')
    ])
    const weComEnvironment = this.environmentChannel('wecom')
    const dingTalkEnvironment = this.environmentChannel('dingtalk')
    const environmentWarning =
      weComEnvironment.error ?? dingTalkEnvironment.error
    const warning = this.warning ?? environmentWarning
    return {
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
          (weComEnvironment.error === undefined
            ? defaultStatus(wecom.enabled)
            : {
                state: 'error',
                lastError: weComEnvironment.error
              })
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
          (dingTalkEnvironment.error === undefined
            ? defaultStatus(dingtalk.enabled)
            : {
                state: 'error',
                lastError: dingTalkEnvironment.error
              })
      },
      ...(warning === undefined ? {} : { warning })
    }
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
  resolve(channel: ManagedChannel): Promise<ResolvedChannelSettings>
  async resolve(channel: ManagedChannel): Promise<ResolvedChannelSettings> {
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
    const common = {
      enabled: stored.enabled,
      ...(secret === undefined ? {} : { secret }),
      allowedSenderIds: [...stored.allowedSenderIds],
      allowGroupMessages: stored.allowGroupMessages,
      source: secret === undefined ? ('none' as const) : ('encrypted' as const),
      readOnly: false
    }
    return channel === 'wecom'
      ? { channel, botId: settings.wecom.botId, ...common }
      : { channel, clientId: settings.dingtalk.clientId, ...common }
  }

  resolveAll(): Promise<readonly [
    Extract<ResolvedChannelSettings, { channel: 'wecom' }>,
    Extract<ResolvedChannelSettings, { channel: 'dingtalk' }>
  ]> {
    return Promise.all([this.resolve('wecom'), this.resolve('dingtalk')])
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

    this.validateEnabledChannel('wecom', current.wecom)
    this.validateEnabledChannel('dingtalk', current.dingtalk)
    await this.persist(current)
    this.settings = current
    this.warning = undefined
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
    channel: ManagedChannel,
    current: StoredChannel,
    input: WeComChannelSettingsInput | DingTalkChannelSettingsInput
  ): StoredChannel {
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

  private validateEnabledChannel(
    channel: ManagedChannel,
    stored: StoredChannel
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
    channel: ManagedChannel,
    secret: string
  ): StoredChannel['credential'] {
    if (!this.cipher.isAvailable()) {
      throw new Error('系统安全存储不可用，无法保存通道 Secret')
    }
    const encrypted = this.cipher.encrypt(
      JSON.stringify({ version: 1, channel, secret })
    )
    return {
      formatVersion: 1,
      scheme: 'electron-safe-storage',
      ciphertextBase64: encrypted.toString('base64')
    }
  }

  private decryptCredential(
    channel: ManagedChannel,
    stored: StoredChannel
  ): string | undefined {
    if (stored.credential === undefined || !this.cipher.isAvailable()) {
      return undefined
    }
    try {
      const payload = credentialPayloadSchema.parse(
        JSON.parse(
          this.cipher.decrypt(
            Buffer.from(stored.credential.ciphertextBase64, 'base64')
          )
        )
      )
      return payload.channel === channel ? payload.secret : undefined
    } catch {
      return undefined
    }
  }

  private async load(): Promise<StoredSettings> {
    if (this.settings !== undefined) {
      return this.settings
    }
    try {
      this.settings = storedSettingsSchema.parse(
        JSON.parse(await readFile(this.filePath, 'utf8'))
      )
    } catch (error) {
      if (!isMissingFile(error)) {
        this.warning = '通道设置文件已损坏，已隔离原文件并恢复默认设置'
        await rename(
          this.filePath,
          `${this.filePath}.corrupt-${this.now()}`
        ).catch(() => undefined)
      }
      this.settings = cloneStored(defaultStoredSettings)
    }
    return this.settings
  }

  private async persist(settings: StoredSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(settings, null, 2)}\n`,
        {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx'
        }
      )
      await rename(temporaryPath, this.filePath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  private environmentChannel(channel: ManagedChannel): EnvironmentChannel {
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
            error:
              channel === 'wecom'
                ? '企业微信环境变量配置无效或不完整'
                : '钉钉环境变量配置无效或不完整'
          })
    }
  }
}
