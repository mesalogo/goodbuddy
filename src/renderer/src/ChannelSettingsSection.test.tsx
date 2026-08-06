import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelSettingsSnapshot } from '../../shared/channel-settings-contracts'
import type { DesktopApi } from '../../shared/contracts'
import { ChannelSettingsSection } from './ChannelSettingsSection'

const snapshot: ChannelSettingsSnapshot = {
  wecom: {
    enabled: false,
    botId: '',
    secretConfigured: false,
    source: 'none',
    readOnly: false,
    allowedSenderIds: [],
    allowGroupMessages: false,
    status: { state: 'disabled' }
  },
  dingtalk: {
    enabled: false,
    clientId: 'environment-client',
    secretConfigured: true,
    source: 'environment',
    readOnly: true,
    allowedSenderIds: ['staff-1'],
    allowGroupMessages: false,
    status: { state: 'running' }
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ChannelSettingsSection', () => {
  it('saves editable channel settings without returning stored secrets', async () => {
    const apply = vi.fn(async () => ({
      ...snapshot,
      wecom: {
        ...snapshot.wecom,
        enabled: true,
        botId: 'bot-1',
        secretConfigured: true,
        source: 'encrypted' as const,
        allowedSenderIds: ['user-1', 'user-2'],
        status: { state: 'running' as const }
      }
    }))
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          getSnapshot: vi.fn(async () => snapshot),
          apply,
          testConnection: vi.fn(async () => ({
            channel: 'wecom',
            ok: true
          }))
        }
      } as unknown as DesktopApi
    })

    render(<ChannelSettingsSection />)
    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: '启用企业微信通道'
      })
    )
    fireEvent.change(screen.getByLabelText('企业微信机器人 ID'), {
      target: { value: 'bot-1' }
    })
    fireEvent.change(screen.getByLabelText('企业微信Secret'), {
      target: { value: 'channel-secret' }
    })
    fireEvent.change(screen.getByLabelText('企业微信允许的发送者 ID'), {
      target: { value: 'user-1\nuser-2\nuser-1' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '保存通道设置' })
    )

    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({
        wecom: {
          enabled: true,
          botId: 'bot-1',
          secret: {
            action: 'replace',
            value: 'channel-secret'
          },
          allowedSenderIds: ['user-1', 'user-2'],
          allowGroupMessages: false
        }
      })
    )
    expect(screen.queryByDisplayValue('channel-secret')).toBeNull()
    expect(await screen.findByText('企业通信设置已保存并应用'))
      .toBeInTheDocument()
  })

  it('tests environment-owned channels without exposing draft credentials', async () => {
    const testConnection = vi.fn(async () => ({
      channel: 'dingtalk' as const,
      ok: true as const
    }))
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          getSnapshot: vi.fn(async () => snapshot),
          apply: vi.fn(),
          testConnection
        }
      } as unknown as DesktopApi
    })

    render(<ChannelSettingsSection />)
    fireEvent.click(
      await screen.findByRole('button', { name: '测试钉钉连接' })
    )

    await waitFor(() =>
      expect(testConnection).toHaveBeenCalledWith(
        'dingtalk',
        undefined
      )
    )
    expect(screen.getByText('钉钉连接成功')).toBeInTheDocument()
  })
})
