import { describe, expect, it } from 'vitest'
import {
  CHANNEL_SETTINGS_LIMITS,
  channelConnectionTestResultSchema,
  channelSecretUpdateSchema,
  channelSettingsApplySchema,
  channelSettingsSnapshotSchema
} from './channel-settings-contracts'

describe('channel settings contracts', () => {
  it('accepts bounded strict WeCom and DingTalk updates', () => {
    expect(
      channelSettingsApplySchema.parse({
        wecom: {
          enabled: true,
          botId: ' bot-id ',
          secret: { action: 'replace', value: ' secret ' },
          allowedSenderIds: [' user-1 ', 'user-1'],
          allowGroupMessages: false
        },
        dingtalk: {
          enabled: false,
          clientId: '',
          secret: { action: 'clear' },
          allowedSenderIds: [],
          allowGroupMessages: true
        }
      })
    ).toEqual({
      wecom: {
        enabled: true,
        botId: 'bot-id',
        secret: { action: 'replace', value: 'secret' },
        allowedSenderIds: ['user-1'],
        allowGroupMessages: false
      },
      dingtalk: {
        enabled: false,
        clientId: '',
        secret: { action: 'clear' },
        allowedSenderIds: [],
        allowGroupMessages: true
      }
    })
  })

  it('rejects unknown fields and unbounded values', () => {
    expect(() =>
      channelSecretUpdateSchema.parse({
        action: 'keep',
        value: 'must-not-be-accepted'
      })
    ).toThrow()
    expect(() =>
      channelSettingsApplySchema.parse({
        wecom: {
          enabled: true,
          botId: 'x'.repeat(
            CHANNEL_SETTINGS_LIMITS.maximumIdentifierLength + 1
          ),
          secret: { action: 'keep' },
          allowedSenderIds: [],
          allowGroupMessages: false
        }
      })
    ).toThrow()
    expect(() => channelSettingsApplySchema.parse({})).toThrow()
  })

  it('models public credential source and runtime status without secrets', () => {
    const snapshot = channelSettingsSnapshotSchema.parse({
      wecom: {
        enabled: true,
        botId: 'bot-id',
        secretConfigured: true,
        source: 'environment',
        readOnly: true,
        allowedSenderIds: ['user-1'],
        allowGroupMessages: false,
        status: { state: 'running' }
      },
      dingtalk: {
        enabled: false,
        clientId: '',
        secretConfigured: false,
        source: 'none',
        readOnly: false,
        allowedSenderIds: [],
        allowGroupMessages: false,
        status: {
          state: 'error',
          lastError: '连接失败'
        }
      }
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret":')
  })

  it('requires errors only for failed connection tests', () => {
    expect(
      channelConnectionTestResultSchema.parse({
        channel: 'wecom',
        ok: true
      })
    ).toEqual({ channel: 'wecom', ok: true })
    expect(() =>
      channelConnectionTestResultSchema.parse({
        channel: 'dingtalk',
        ok: false
      })
    ).toThrow()
    expect(() =>
      channelConnectionTestResultSchema.parse({
        channel: 'dingtalk',
        ok: true,
        error: '不应存在'
      })
    ).toThrow()
  })
})
