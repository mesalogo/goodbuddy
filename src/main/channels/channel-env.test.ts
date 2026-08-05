import { describe, expect, it, vi } from 'vitest'
import {
  parseChannelEnvironment,
  startEnvironmentChannels
} from './channel-env'

describe('channel environment bootstrap', () => {
  it('starts only complete credentials with a non-empty explicit allowlist', () => {
    expect(
      parseChannelEnvironment({
        GOODBUDDY_DINGTALK_CLIENT_ID: ' client-id ',
        GOODBUDDY_DINGTALK_CLIENT_SECRET: ' secret ',
        GOODBUDDY_DINGTALK_ALLOWED_SENDERS: ' USER-1,user-2 ',
        GOODBUDDY_DINGTALK_ALLOW_GROUPS: 'true',
        GOODBUDDY_WECOM_BOT_ID: 'bot-id',
        GOODBUDDY_WECOM_SECRET: 'wecom-secret'
      })
    ).toEqual([
      {
        channel: 'dingtalk',
        clientId: 'client-id',
        clientSecret: 'secret',
        allowedSenderIds: ['user-1', 'user-2'],
        allowGroupMessages: true
      }
    ])
  })

  it('strictly parses booleans and comma-separated identities', () => {
    expect(() =>
      parseChannelEnvironment({
        GOODBUDDY_WECOM_ALLOW_GROUPS: 'TRUE'
      })
    ).toThrow('必须是 true 或 false')
    expect(() =>
      parseChannelEnvironment({
        GOODBUDDY_WECOM_ALLOWED_SENDERS: 'user-1,,user-2'
      })
    ).toThrow('包含空白身份')
  })

  it('defaults groups off and contains asynchronous startup failures', async () => {
    const start = vi.fn(async () => {
      throw new Error('secret=must-not-escape')
    })
    const stop = vi.fn(async () => undefined)
    const onStartError = vi.fn()
    const createService = vi.fn(() => ({ start, stop }))
    const services = startEnvironmentChannels({
      env: {
        GOODBUDDY_WECOM_BOT_ID: 'bot-id',
        GOODBUDDY_WECOM_SECRET: 'secret',
        GOODBUDDY_WECOM_ALLOWED_SENDERS: 'user-1'
      },
      executor: vi.fn(async () => ({ status: 'completed' })),
      createWeComDriver: vi.fn(() => ({ channel: 'wecom' }) as never),
      createService,
      onStartError
    })

    expect(services).toHaveLength(1)
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'wecom' }),
      expect.any(Function),
      {
        allowedSenderIds: ['user-1'],
        allowGroupMessages: false
      }
    )
    await vi.waitFor(() => {
      expect(onStartError).toHaveBeenCalledWith(
        'wecom',
        'wecom 通道启动失败'
      )
    })
    expect(JSON.stringify(onStartError.mock.calls)).not.toContain(
      'must-not-escape'
    )
  })
})
