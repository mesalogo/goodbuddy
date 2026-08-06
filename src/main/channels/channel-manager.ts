import {
  CHANNEL_SETTINGS_LIMITS,
  channelConnectionTestResultSchema,
  dingTalkChannelSettingsInputSchema,
  weComChannelSettingsInputSchema,
  type ChannelConnectionTestResult,
  type ChannelRuntimeStatus,
  type ChannelSettingsApply,
  type ChannelSettingsSnapshot,
  type DingTalkChannelSettingsInput,
  type ManagedChannel,
  type WeComChannelSettingsInput
} from '../../shared/channel-settings-contracts'
import type {
  ChannelDriver,
  ChannelExecutor
} from './channel-driver'
import { ChannelService } from './channel-service'
import { redactChannelError } from './channel-service'
import {
  ChannelSettingsStore,
  type ResolvedChannelSettings
} from './channel-settings-store'
import { DingTalkChannelDriver } from './dingtalk-channel-driver'
import { WeComChannelDriver } from './wecom-channel-driver'

export type ManagedChannelService = Pick<
  ChannelService,
  'start' | 'stop'
>

export type ChannelDriverFactory = (
  settings: ResolvedChannelSettings
) => ChannelDriver | Promise<ChannelDriver>

export type ChannelServiceFactory = (
  driver: ChannelDriver,
  executor: ChannelExecutor,
  options: {
    allowedSenderIds: readonly string[]
    allowGroupMessages: boolean
  }
) => ManagedChannelService | Promise<ManagedChannelService>

export type ChannelManagerOptions = {
  createDriver?: ChannelDriverFactory
  createService?: ChannelServiceFactory
}

type TestSettingsInput =
  | {
      channel: 'wecom'
      settings?: WeComChannelSettingsInput
    }
  | {
      channel: 'dingtalk'
      settings?: DingTalkChannelSettingsInput
    }

function defaultDriverFactory(
  settings: ResolvedChannelSettings
): ChannelDriver {
  if (settings.secret === undefined) {
    throw new Error('通道 Secret 尚未配置')
  }
  return settings.channel === 'wecom'
    ? new WeComChannelDriver({
        botId: settings.botId,
        secret: settings.secret
      })
    : new DingTalkChannelDriver({
        clientId: settings.clientId,
        clientSecret: settings.secret,
        allowedSenderIds: settings.allowedSenderIds
      })
}

function defaultServiceFactory(
  driver: ChannelDriver,
  executor: ChannelExecutor,
  options: {
    allowedSenderIds: readonly string[]
    allowGroupMessages: boolean
  }
): ChannelService {
  return new ChannelService(driver, executor, options)
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return typeof error === 'string' ? error : '未知错误'
}

function redactManagerError(
  error: unknown,
  secrets: readonly (string | undefined)[]
): string {
  let message = errorText(error)
  for (const secret of secrets) {
    if (secret !== undefined && secret.length > 0) {
      message = message.split(secret).join('[凭据已隐藏]')
    }
  }
  const redacted = redactChannelError(message).trim()
  const bounded = redacted.slice(
    0,
    CHANNEL_SETTINGS_LIMITS.maximumStatusMessageLength
  )
  return bounded || '通道操作失败'
}

function sanitizedManagerFailure(message: string): Error {
  return new Error(message)
}

function validateResolved(settings: ResolvedChannelSettings): void {
  const identifier =
    settings.channel === 'wecom' ? settings.botId : settings.clientId
  if (
    identifier.length === 0 ||
    settings.secret === undefined ||
    settings.allowedSenderIds.length === 0
  ) {
    throw new Error(
      settings.channel === 'wecom'
        ? '企业微信需要机器人 ID、Secret 和允许的发送者'
        : '钉钉需要 Client ID、Secret 和允许的发送者'
    )
  }
}

export class ChannelManager {
  private readonly services = new Map<
    ManagedChannel,
    ManagedChannelService
  >()
  private readonly statuses = new Map<
    ManagedChannel,
    ChannelRuntimeStatus
  >()
  private readonly createDriver: ChannelDriverFactory
  private readonly createService: ChannelServiceFactory
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: ChannelSettingsStore,
    private readonly executor: ChannelExecutor,
    options: ChannelManagerOptions = {}
  ) {
    this.createDriver = options.createDriver ?? defaultDriverFactory
    this.createService = options.createService ?? defaultServiceFactory
  }

  snapshot(): Promise<ChannelSettingsSnapshot> {
    return this.store.snapshot(Object.fromEntries(this.statuses))
  }

  getSnapshot(): Promise<ChannelSettingsSnapshot> {
    return this.snapshot()
  }

  initialize(): Promise<ChannelSettingsSnapshot> {
    return this.enqueue(async () => {
      const settings = await this.store.resolveAll()
      for (const channelSettings of settings) {
        if (!channelSettings.enabled) {
          this.statuses.set(channelSettings.channel, {
            state: 'disabled'
          })
          continue
        }
        try {
          await this.replaceService(channelSettings)
        } catch {
          // Each channel is isolated; its sanitized error is kept in status.
        }
      }
      return this.snapshot()
    })
  }

  apply(input: ChannelSettingsApply): Promise<ChannelSettingsSnapshot> {
    return this.enqueue(async () => {
      await this.store.apply(input)
      const channels: ManagedChannel[] = [
        ...(input.wecom === undefined ? [] : (['wecom'] as const)),
        ...(input.dingtalk === undefined ? [] : (['dingtalk'] as const))
      ]
      for (const channel of channels) {
        const settings = await this.store.resolve(channel)
        if (!settings.enabled) {
          await this.disableService(channel)
          continue
        }
        await this.replaceService(settings)
      }
      return this.snapshot()
    })
  }

  test(
    channel: 'wecom',
    settings?: WeComChannelSettingsInput
  ): Promise<ChannelConnectionTestResult>
  test(
    channel: 'dingtalk',
    settings?: DingTalkChannelSettingsInput
  ): Promise<ChannelConnectionTestResult>
  async test(
    channel: ManagedChannel,
    settings?: WeComChannelSettingsInput | DingTalkChannelSettingsInput
  ): Promise<ChannelConnectionTestResult> {
    let resolved: ResolvedChannelSettings | undefined
    try {
      resolved = await this.settingsForTest({
        channel,
        ...(settings === undefined ? {} : { settings })
      } as TestSettingsInput)
      validateResolved(resolved)
      const service = await this.buildService(resolved)
      try {
        await service.start()
      } finally {
        await Promise.resolve(service.stop()).catch(() => undefined)
      }
      return channelConnectionTestResultSchema.parse({
        channel,
        ok: true
      })
    } catch (error) {
      return channelConnectionTestResultSchema.parse({
        channel,
        ok: false,
        error: redactManagerError(error, [
          resolved?.secret,
          settings?.secret.action === 'replace'
            ? settings.secret.value
            : undefined
        ])
      })
    }
  }

  testConnection(
    channel: 'wecom',
    settings?: WeComChannelSettingsInput
  ): Promise<ChannelConnectionTestResult>
  testConnection(
    channel: 'dingtalk',
    settings?: DingTalkChannelSettingsInput
  ): Promise<ChannelConnectionTestResult>
  testConnection(
    channel: ManagedChannel,
    settings?: WeComChannelSettingsInput | DingTalkChannelSettingsInput
  ): Promise<ChannelConnectionTestResult> {
    return channel === 'wecom'
      ? this.test(
          channel,
          settings as WeComChannelSettingsInput | undefined
        )
      : this.test(
          channel,
          settings as DingTalkChannelSettingsInput | undefined
        )
  }

  stopAll(): Promise<void> {
    return this.enqueue(async () => {
      const active = [...this.services.entries()]
      this.services.clear()
      const results = await Promise.allSettled(
        active.map(([, service]) => Promise.resolve(service.stop()))
      )
      const resolved = await this.store.resolveAll()
      for (const settings of resolved) {
        this.statuses.set(settings.channel, {
          state: settings.enabled ? 'stopped' : 'disabled'
        })
      }
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        throw new Error(redactManagerError(failure.reason, []))
      }
    })
  }

  private async replaceService(
    settings: ResolvedChannelSettings
  ): Promise<void> {
    const channel = settings.channel
    const previous = this.services.get(channel)
    this.statuses.set(channel, { state: 'starting' })
    let replacement: ManagedChannelService | undefined
    try {
      validateResolved(settings)
      replacement = await this.buildService(settings)
      if (previous !== undefined) {
        await previous.stop()
        this.services.delete(channel)
      }
      await replacement.start()
    } catch (error) {
      await Promise.resolve(replacement?.stop()).catch(() => undefined)
      if (
        previous !== undefined &&
        this.services.get(channel) === previous
      ) {
        this.services.delete(channel)
        await Promise.resolve(previous.stop()).catch(() => undefined)
      }
      const redacted = redactManagerError(error, [settings.secret])
      this.statuses.set(channel, {
        state: 'error',
        lastError: redacted
      })
      throw sanitizedManagerFailure(redacted)
    }

    this.services.set(channel, replacement)
    this.statuses.set(channel, { state: 'running' })
  }

  private async disableService(channel: ManagedChannel): Promise<void> {
    const previous = this.services.get(channel)
    if (previous !== undefined) {
      await previous.stop()
      this.services.delete(channel)
    }
    this.statuses.set(channel, { state: 'disabled' })
  }

  private async buildService(
    settings: ResolvedChannelSettings
  ): Promise<ManagedChannelService> {
    const driver = await this.createDriver(settings)
    return this.createService(driver, this.executor, {
      allowedSenderIds: settings.allowedSenderIds,
      allowGroupMessages: settings.allowGroupMessages
    })
  }

  private async settingsForTest(
    input: TestSettingsInput
  ): Promise<ResolvedChannelSettings> {
    const current = await this.store.resolve(input.channel)
    if (input.settings === undefined) {
      return current
    }
    if (current.readOnly) {
      throw new Error('环境变量通道配置为只读，不能使用临时设置')
    }

    if (input.channel === 'wecom') {
      const parsed = weComChannelSettingsInputSchema.parse(input.settings)
      return {
        channel: 'wecom',
        enabled: parsed.enabled,
        botId: parsed.botId,
        ...this.testCommonSettings(current.secret, parsed)
      }
    }
    const parsed = dingTalkChannelSettingsInputSchema.parse(input.settings)
    return {
      channel: 'dingtalk',
      enabled: parsed.enabled,
      clientId: parsed.clientId,
      ...this.testCommonSettings(current.secret, parsed)
    }
  }

  private testCommonSettings(
    currentSecret: string | undefined,
    input: WeComChannelSettingsInput | DingTalkChannelSettingsInput
  ): {
    secret?: string
    allowedSenderIds: readonly string[]
    allowGroupMessages: boolean
    source: 'none' | 'encrypted'
    readOnly: false
  } {
    const secret =
      input.secret.action === 'keep'
        ? currentSecret
        : input.secret.action === 'replace'
          ? input.secret.value
          : undefined
    return {
      ...(secret === undefined ? {} : { secret }),
      allowedSenderIds: input.allowedSenderIds,
      allowGroupMessages: input.allowGroupMessages,
      source: secret === undefined ? 'none' : 'encrypted',
      readOnly: false
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    let value!: T
    const run = async (): Promise<void> => {
      value = await operation()
    }
    const result = this.operationQueue.then(run, run)
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result.then(() => value)
  }
}
