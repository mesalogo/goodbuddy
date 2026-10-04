import {
  CHANNEL_SETTINGS_LIMITS,
  channelConnectionTestResultSchema,
  channelSettingsApplySchema,
  dingTalkChannelSettingsInputSchema,
  telegramChannelSettingsInputSchema,
  weComChannelSettingsInputSchema,
  type ChannelConnectionTestResult,
  type ChannelRuntimeStatus,
  type ChannelRuntimeStatusChange,
  type ChannelSettingsApply,
  type ChannelSettingsSnapshot,
  type CredentialChannel,
  type DingTalkChannelSettingsInput,
  type ManagedChannel,
  type TelegramChannelSettingsInput,
  type WeComChannelSettingsInput
} from '../../shared/channel-settings-contracts'
import type {
  ChannelDriver,
  ChannelExecutor
} from './channel-driver'
import {
  ChannelService,
  type ChannelServiceOptions
} from './channel-service'
import { redactChannelError } from './channel-service'
import {
  ChannelSettingsStore,
  type ResolvedChannelSettings
} from './channel-settings-store'
import { DingTalkChannelDriver } from './dingtalk-channel-driver'
import { WeComChannelDriver } from './wecom-channel-driver'
import { WechatChannelDriver } from './wechat-channel-driver'
import type { WechatSidecarLauncher } from './wechat-sidecar-client'

export type ManagedChannelService = Pick<
  ChannelService,
  'start' | 'stop'
> & { updateAllowedSenderIds?: (ids: readonly string[]) => void }

export type ChannelDriverFactory = (
  settings: ResolvedChannelSettings,
  onStatus?: (status: ChannelRuntimeStatus) => void
) => TestableChannelDriver | Promise<TestableChannelDriver>

type TestableChannelDriver = ChannelDriver & {
  testConnection?: () => Promise<{ botId: string; botUsername?: string }>
  updateAllowedSenderIds?: (ids: readonly string[]) => void
}

export type ChannelServiceFactory = (
  driver: ChannelDriver,
  executor: ChannelExecutor,
  options: {
    allowedSenderIds: readonly string[]
    allowGroupMessages: boolean
    dedupStore?: ChannelServiceOptions['dedupStore']
    outbox?: ChannelServiceOptions['outbox']
    onDeliveryFailure?: ChannelServiceOptions['onDeliveryFailure']
    onDeliverySuccess?: ChannelServiceOptions['onDeliverySuccess']
  }
) => ManagedChannelService | Promise<ManagedChannelService>

export type ChannelManagerOptions = {
  onStatusChanged?: (change: ChannelRuntimeStatusChange) => void
  createDriver?: ChannelDriverFactory
  createService?: ChannelServiceFactory
  launchWechatSidecar?: WechatSidecarLauncher
  dedupStore?: ChannelServiceOptions['dedupStore']
  outbox?: ChannelServiceOptions['outbox']
}

type TestSettingsInput =
  | {
      channel: 'telegram'
      settings?: TelegramChannelSettingsInput
    }
  | {
      channel: 'wecom'
      settings?: WeComChannelSettingsInput
    }
  | {
      channel: 'dingtalk'
      settings?: DingTalkChannelSettingsInput
    }

async function defaultDriverFactory(
  settings: ResolvedChannelSettings,
  launchWechatSidecar?: WechatSidecarLauncher,
  onStatus?: (status: ChannelRuntimeStatus) => void
): Promise<TestableChannelDriver> {
  if (settings.channel === 'weixin') {
    if (!launchWechatSidecar) {
      throw new Error('微信 Sidecar 启动器不可用')
    }
    return new WechatChannelDriver(settings, launchWechatSidecar)
  }
  if (settings.secret === undefined) {
    throw new Error('通道 Secret 尚未配置')
  }
  if (settings.channel === 'telegram') {
    const [{ TelegramChannelDriver }, { net }] = await Promise.all([
      import('./telegram-channel-driver'),
      import('electron')
    ])
    return new TelegramChannelDriver({
      secret: settings.secret,
      allowedSenderIds: settings.allowedSenderIds,
      fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
      onStatus
    })
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
  if (settings.channel === 'telegram') {
    if (!settings.secret) throw new Error('Telegram 需要 Bot Token')
    return
  }
  if (settings.channel === 'weixin') {
    if (
      settings.accountId.length === 0 ||
      settings.userId.length === 0 ||
      settings.baseUrl.length === 0 ||
      settings.token === undefined
    ) {
      throw new Error('微信 ClawBot 需要先完成扫码绑定')
    }
    return
  }
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
  private readonly dedupStore?: ChannelServiceOptions['dedupStore']
  private readonly outbox?: ChannelServiceOptions['outbox']
  private readonly onStatusChanged?: ChannelManagerOptions['onStatusChanged']
  private operationQueue: Promise<void> = Promise.resolve()
  private readonly serviceGenerations = new Map<ManagedChannel, symbol>()
  private activeTelegram?: {
    settings: Extract<ResolvedChannelSettings, { channel: 'telegram' }>
    driver: TestableChannelDriver
  }

  constructor(
    private readonly store: ChannelSettingsStore,
    private readonly executor: ChannelExecutor,
    options: ChannelManagerOptions = {}
  ) {
    this.createDriver =
      options.createDriver ??
      ((settings, onStatus) =>
        defaultDriverFactory(settings, options.launchWechatSidecar, onStatus))
    this.createService = options.createService ?? defaultServiceFactory
    this.dedupStore = options.dedupStore
    this.outbox = options.outbox
    this.onStatusChanged = options.onStatusChanged
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
          this.setStatus(channelSettings.channel, {
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
      input = channelSettingsApplySchema.parse(input)
      if (input.telegram?.secret.action === 'replace') {
        const result = await this.test('telegram', input.telegram)
        if (!result.ok) throw sanitizedManagerFailure(result.error!)
      }
      await this.store.apply(input)
      const channels: ManagedChannel[] = [
        ...(input.weixin === undefined ? [] : (['weixin'] as const)),
        ...(input.wecom === undefined ? [] : (['wecom'] as const)),
        ...(input.dingtalk === undefined ? [] : (['dingtalk'] as const)),
        ...(input.telegram === undefined ? [] : (['telegram'] as const))
      ]
      for (const channel of channels) {
        const settings = await this.store.resolve(channel)
        if (!settings.enabled) {
          await this.disableService(channel)
          continue
        }
        const active = this.activeTelegram
        const service = this.services.get(channel)
        if (settings.channel === 'telegram' && active &&
          active.settings.secret === settings.secret &&
          (this.statuses.get(channel)?.state === 'running' || this.statuses.get(channel)?.state === 'starting') &&
          active.driver.updateAllowedSenderIds && service?.updateAllowedSenderIds) {
          active.driver.updateAllowedSenderIds(settings.allowedSenderIds)
          service.updateAllowedSenderIds(settings.allowedSenderIds)
          active.settings = settings
          continue
        }
        await this.replaceService(settings)
      }
      return this.snapshot()
    })
  }

  test(
    channel: 'telegram',
    settings?: TelegramChannelSettingsInput
  ): Promise<ChannelConnectionTestResult>
  test(
    channel: 'wecom',
    settings?: WeComChannelSettingsInput
  ): Promise<ChannelConnectionTestResult>
  test(
    channel: 'dingtalk',
    settings?: DingTalkChannelSettingsInput
  ): Promise<ChannelConnectionTestResult>
  async test(
    channel: CredentialChannel,
    settings?: WeComChannelSettingsInput | DingTalkChannelSettingsInput | TelegramChannelSettingsInput
  ): Promise<ChannelConnectionTestResult> {
    let resolved: ResolvedChannelSettings | undefined
    try {
      resolved = await this.settingsForTest({
        channel,
        ...(settings === undefined ? {} : { settings })
      } as TestSettingsInput)
      validateResolved(resolved)
      if (channel === 'telegram') {
        const driver = await this.createDriver(resolved)
        try {
          if (!driver.testConnection) throw new Error('Telegram connection test is unavailable')
          const identity = await driver.testConnection()
          return channelConnectionTestResultSchema.parse({
            channel,
            ok: true,
            ...(identity.botUsername ? { botUsername: identity.botUsername } : {})
          })
        } finally {
          await Promise.resolve(driver.stop()).catch(() => undefined)
        }
      }
      const { service } = await this.buildService(resolved)
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
          resolved && resolved.channel !== 'weixin'
            ? resolved.secret
            : undefined,
          settings?.secret.action === 'replace'
            ? settings.secret.value
            : undefined
        ])
      })
    }
  }

  testConnection(
    channel: 'telegram',
    settings?: TelegramChannelSettingsInput
  ): Promise<ChannelConnectionTestResult>
  testConnection(
    channel: 'wecom',
    settings?: WeComChannelSettingsInput
  ): Promise<ChannelConnectionTestResult>
  testConnection(
    channel: 'dingtalk',
    settings?: DingTalkChannelSettingsInput
  ): Promise<ChannelConnectionTestResult>
  testConnection(
    channel: CredentialChannel,
    settings?: WeComChannelSettingsInput | DingTalkChannelSettingsInput | TelegramChannelSettingsInput
  ): Promise<ChannelConnectionTestResult> {
    if (channel === 'telegram') {
      return this.test(channel, settings as TelegramChannelSettingsInput | undefined)
    }
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
      this.serviceGenerations.clear()
      this.activeTelegram = undefined
      this.services.clear()
      const results = await Promise.allSettled(
        active.map(([, service]) => Promise.resolve(service.stop()))
      )
      const resolved = await this.store.resolveAll()
      for (const settings of resolved) {
        this.setStatus(settings.channel, {
          state: settings.enabled ? 'stopped' : 'disabled'
        })
      }
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        throw new Error(redactManagerError(failure.reason, []))
      }
    })
  }

  reload(channel: ManagedChannel): Promise<ChannelSettingsSnapshot> {
    return this.enqueue(async () => {
      const settings = await this.store.resolve(channel)
      if (!settings.enabled) {
        await this.disableService(channel)
      } else {
        await this.replaceService(settings)
      }
      return this.snapshot()
    })
  }

  private async replaceService(
    settings: ResolvedChannelSettings
  ): Promise<void> {
    const channel = settings.channel
    const previous = this.services.get(channel)
    const generation = Symbol(channel)
    this.serviceGenerations.set(channel, generation)
    this.setStatus(channel, { state: 'starting' })
    let replacement: ManagedChannelService | undefined
    let driver: TestableChannelDriver | undefined
    try {
      validateResolved(settings)
      const built = await this.buildService(settings, generation)
      replacement = built.service
      driver = built.driver
      if (previous !== undefined) {
        await previous.stop()
        this.services.delete(channel)
      }
      await replacement.start()
    } catch (error) {
      if (channel === 'telegram') this.activeTelegram = undefined
      this.serviceGenerations.delete(channel)
      await Promise.resolve(replacement?.stop()).catch(() => undefined)
      if (
        previous !== undefined &&
        this.services.get(channel) === previous
      ) {
        this.services.delete(channel)
        await Promise.resolve(previous.stop()).catch(() => undefined)
      }
      const redacted = redactManagerError(error, [
        settings.channel === 'weixin'
          ? settings.token
          : settings.secret
      ])
      this.setStatus(channel, {
        state: 'error',
        lastError: redacted
      })
      throw sanitizedManagerFailure(redacted)
    }

    this.services.set(channel, replacement)
    if (settings.channel === 'telegram') {
      this.activeTelegram = { settings, driver: driver! }
    } else if (this.statuses.get(channel)?.state === 'starting') {
      this.setStatus(channel, { state: 'running' })
    }
  }

  private async disableService(channel: ManagedChannel): Promise<void> {
    if (channel === 'telegram') this.activeTelegram = undefined
    this.serviceGenerations.delete(channel)
    const previous = this.services.get(channel)
    if (previous !== undefined) {
      await previous.stop()
      this.services.delete(channel)
    }
    this.setStatus(channel, { state: 'disabled' })
  }

  private async buildService(
    settings: ResolvedChannelSettings,
    generation?: symbol
  ): Promise<{ service: ManagedChannelService; driver: TestableChannelDriver }> {
    const onStatus = (status: ChannelRuntimeStatus): void => {
      if (generation === undefined || this.serviceGenerations.get(settings.channel) !== generation) return
      this.setStatus(settings.channel, {
        state: status.state,
        ...(status.lastError ? {
          lastError: redactManagerError(status.lastError, [
            settings.channel === 'weixin' ? settings.token : settings.secret
          ])
        } : {})
      })
    }
    const driver = await this.createDriver(settings, onStatus)
    const service = await this.createService(driver, this.executor, {
      allowedSenderIds: settings.allowedSenderIds,
      allowGroupMessages: settings.allowGroupMessages,
      dedupStore: this.dedupStore,
      outbox: this.outbox,
      onDeliveryFailure: (error) => {
        if (settings.channel === 'telegram') return
        onStatus({
          state: 'error',
          lastError: redactManagerError(error, [
            settings.channel === 'weixin'
              ? settings.token
              : settings.secret
          ])
        })
      },
      onDeliverySuccess: () => {
        if (settings.channel === 'telegram') return
        onStatus({ state: 'running' })
      }
    })
    return { service, driver }
  }

  private async settingsForTest(
    input: TestSettingsInput
  ): Promise<ResolvedChannelSettings> {
    if (input.channel === 'telegram') {
      const current = await this.store.resolve('telegram')
      if (input.settings === undefined) return current
      if (current.readOnly) throw new Error('环境变量通道配置为只读，不能使用临时设置')
      const parsed = telegramChannelSettingsInputSchema.parse(input.settings)
      return {
        channel: 'telegram',
        enabled: parsed.enabled,
        ...this.testCommonSettings(current.secret, parsed),
        allowGroupMessages: false
      }
    }
    if (input.channel === 'wecom') {
      const current = await this.store.resolve('wecom')
      if (input.settings === undefined) {
        return current
      }
      if (current.readOnly) {
        throw new Error('环境变量通道配置为只读，不能使用临时设置')
      }
      const parsed = weComChannelSettingsInputSchema.parse(input.settings)
      return {
        channel: 'wecom',
        enabled: parsed.enabled,
        botId: parsed.botId,
        ...this.testCommonSettings(current.secret, parsed)
      }
    }
    const current = await this.store.resolve('dingtalk')
    if (input.settings === undefined) {
      return current
    }
    if (current.readOnly) {
      throw new Error('环境变量通道配置为只读，不能使用临时设置')
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
    input: WeComChannelSettingsInput | DingTalkChannelSettingsInput | TelegramChannelSettingsInput
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

  private setStatus(channel: ManagedChannel, status: ChannelRuntimeStatus): void {
    const previous = this.statuses.get(channel)
    if (previous?.state === status.state && previous.lastError === status.lastError) return
    this.statuses.set(channel, status)
    this.onStatusChanged?.({ channel, status: { ...status } })
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
