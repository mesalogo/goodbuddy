import type { ChannelInboundText } from '../../shared/channel-contracts'
import type { ChannelExecutor } from './channel-driver'
import { ChannelService } from './channel-service'
import {
  DingTalkChannelDriver,
  type DingTalkChannelDriverOptions
} from './dingtalk-channel-driver'
import {
  normalizeDingTalkStaffId,
  type DingTalkTransportFactory
} from './dingtalk-driver'
import {
  WeComChannelDriver,
  type WeComChannelDriverOptions
} from './wecom-channel-driver'
import type { WeComTransportFactory } from './wecom-driver'

type ChannelEnvironmentConfig =
  | {
      channel: 'dingtalk'
      clientId: string
      clientSecret: string
      allowedSenderIds: readonly string[]
      allowGroupMessages: boolean
    }
  | {
      channel: 'wecom'
      botId: string
      secret: string
      allowedSenderIds: readonly string[]
      allowGroupMessages: boolean
    }

export type EnvironmentChannelService = Pick<
  ChannelService,
  'start' | 'stop'
>

export type EnvironmentChannelBootstrapOptions = {
  executor: ChannelExecutor
  env?: NodeJS.ProcessEnv
  dingtalkTransportFactory?: DingTalkTransportFactory
  wecomTransportFactory?: WeComTransportFactory
  createDingTalkDriver?: (
    options: DingTalkChannelDriverOptions
  ) => DingTalkChannelDriver
  createWeComDriver?: (
    options: WeComChannelDriverOptions
  ) => WeComChannelDriver
  createService?: (
    driver: DingTalkChannelDriver | WeComChannelDriver,
    executor: ChannelExecutor,
    options: {
      allowedSenderIds: readonly string[]
      allowGroupMessages: boolean
    }
  ) => EnvironmentChannelService
  onStartError?: (channel: string, error: string) => void
}

function optionalCredential(
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    return undefined
  }
  return value.trim()
}

function parseBoolean(
  env: NodeJS.ProcessEnv,
  name: string
): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return false
  }
  if (raw === 'true') {
    return true
  }
  if (raw === 'false') {
    return false
  }
  throw new Error(`${name} 必须是 true 或 false`)
}

function parseList(
  env: NodeJS.ProcessEnv,
  name: string
): readonly string[] {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return []
  }
  const values = raw.split(',').map((value) => value.trim())
  if (values.some((value) => value === '')) {
    throw new Error(`${name} 包含空白身份`)
  }
  return [...new Set(values)]
}

export function parseChannelEnvironment(
  env: NodeJS.ProcessEnv
): readonly ChannelEnvironmentConfig[] {
  const configs: ChannelEnvironmentConfig[] = []
  const dingTalkClientId = optionalCredential(
    env,
    'GOODBUDDY_DINGTALK_CLIENT_ID'
  )
  const dingTalkClientSecret = optionalCredential(
    env,
    'GOODBUDDY_DINGTALK_CLIENT_SECRET'
  )
  const dingTalkAllowedSenderIds = parseList(
    env,
    'GOODBUDDY_DINGTALK_ALLOWED_SENDERS'
  ).map(normalizeDingTalkStaffId)
  const dingTalkAllowGroupMessages = parseBoolean(
    env,
    'GOODBUDDY_DINGTALK_ALLOW_GROUPS'
  )
  if (
    dingTalkClientId &&
    dingTalkClientSecret &&
    dingTalkAllowedSenderIds.length > 0
  ) {
    configs.push({
      channel: 'dingtalk',
      clientId: dingTalkClientId,
      clientSecret: dingTalkClientSecret,
      allowedSenderIds: dingTalkAllowedSenderIds,
      allowGroupMessages: dingTalkAllowGroupMessages
    })
  }

  const weComBotId = optionalCredential(
    env,
    'GOODBUDDY_WECOM_BOT_ID'
  )
  const weComSecret = optionalCredential(
    env,
    'GOODBUDDY_WECOM_SECRET'
  )
  const weComAllowedSenderIds = parseList(
    env,
    'GOODBUDDY_WECOM_ALLOWED_SENDERS'
  )
  const weComAllowGroupMessages = parseBoolean(
    env,
    'GOODBUDDY_WECOM_ALLOW_GROUPS'
  )
  if (
    weComBotId &&
    weComSecret &&
    weComAllowedSenderIds.length > 0
  ) {
    configs.push({
      channel: 'wecom',
      botId: weComBotId,
      secret: weComSecret,
      allowedSenderIds: weComAllowedSenderIds,
      allowGroupMessages: weComAllowGroupMessages
    })
  }
  return configs
}

export function startEnvironmentChannels(
  options: EnvironmentChannelBootstrapOptions
): readonly EnvironmentChannelService[] {
  let configs: readonly ChannelEnvironmentConfig[]
  try {
    configs = parseChannelEnvironment(options.env ?? process.env)
  } catch {
    options.onStartError?.('environment', '通道环境变量配置无效')
    return []
  }
  const services = configs.map((config) => {
    const driver =
      config.channel === 'dingtalk'
        ? (options.createDingTalkDriver ??
          ((driverOptions) =>
            new DingTalkChannelDriver(driverOptions)))({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            allowedSenderIds: config.allowedSenderIds,
            ...(options.dingtalkTransportFactory
              ? {
                  transportFactory:
                    options.dingtalkTransportFactory
                }
              : {})
          })
        : (options.createWeComDriver ??
          ((driverOptions) =>
            new WeComChannelDriver(driverOptions)))({
            botId: config.botId,
            secret: config.secret,
            ...(options.wecomTransportFactory
              ? { transportFactory: options.wecomTransportFactory }
              : {})
          })
    const service = (
      options.createService ??
      ((channelDriver, executor, serviceOptions) =>
        new ChannelService(channelDriver, executor, serviceOptions))
    )(driver, options.executor, {
      allowedSenderIds: config.allowedSenderIds,
      allowGroupMessages: config.allowGroupMessages
    })
    void Promise.resolve()
      .then(() => service.start())
      .catch(() => {
        options.onStartError?.(
          config.channel,
          `${config.channel} 通道启动失败`
        )
      })
    return service
  })
  return services
}

export function isReadOnlyChannelMessage(
  message: ChannelInboundText
): boolean {
  return message.workMode === 'ask' || message.workMode === 'plan'
}
