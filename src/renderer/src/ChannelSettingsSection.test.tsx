import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelSettingsSnapshot } from '../../shared/channel-settings-contracts'
import type { DesktopApi } from '../../shared/contracts'
import type {
  AssistantProject,
  ProjectCreateInput
} from '../../shared/assistant-contracts'
import { ChannelSettingsSection } from './ChannelSettingsSection'

const snapshot: ChannelSettingsSnapshot = {
  weixin: {
    enabled: false,
    bindingConfigured: false,
    source: 'none',
    status: { state: 'disabled' }
  },
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

const projects: AssistantProject[] = [
  ['weixin', '微信 ClawBot'],
  ['wecom', '企业微信'],
  ['dingtalk', '钉钉']
].map(([channel, name], index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  name: name!,
  description: `${name}通道项目`,
  rootPath: 'C:\\Users\\tester',
  defaultWorkMode: 'ask',
  kind: 'channel',
  channel: channel as 'weixin' | 'wecom' | 'dingtalk',
  status: 'active',
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z'
}))

function bindingApi() {
  return {
    getWeixinBinding: vi.fn(async () => ({ status: 'stopped' as const })),
    startWeixinBinding: vi.fn(async () => ({
      status: 'starting' as const
    })),
    submitWeixinVerification: vi.fn(async () => ({
      status: 'scanned' as const
    })),
    disconnectWeixin: vi.fn(async () => ({
      status: 'stopped' as const
    })),
    onWeixinBindingChanged: vi.fn(() => () => undefined),
    respondRemoteApproval: vi.fn(async () => true),
    getPendingRemoteApprovals: vi.fn(async () => []),
    onRemoteApproval: vi.fn(() => () => undefined)
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ChannelSettingsSection', () => {
  it('saves editable channel settings without returning stored secrets', async () => {
    const updateProject = vi.fn(async (
      projectId: string,
      input: ProjectCreateInput
    ) => ({
      ...projects.find((project) => project.id === projectId)!,
      ...input
    }))
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
          ...bindingApi(),
          getSnapshot: vi.fn(async () => snapshot),
          apply,
          testConnection: vi.fn(async () => ({
            channel: 'wecom',
            ok: true
          }))
        },
        projects: {
          list: vi.fn(async () => projects),
          update: updateProject
        },
        settings: {
          selectWorkspace: vi.fn(async () => undefined)
        }
      } as unknown as DesktopApi
    })

    render(<ChannelSettingsSection />)
    fireEvent.click(
      await screen.findByRole('tab', { name: '企业微信' })
    )
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
    fireEvent.change(screen.getByLabelText('企业微信默认工作目录'), {
      target: { value: 'C:\\RemoteWorkspace' }
    })
    fireEvent.click(
      within(
        screen.getByRole('group', {
          name: '企业微信默认模式'
        })
      ).getByRole('button', { name: '执行' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: '保存通道设置' })
    )
    expect(updateProject).toHaveBeenCalledWith(
      projects[1]!.id,
      expect.objectContaining({
        rootPath: 'C:\\RemoteWorkspace',
        defaultWorkMode: 'execute'
      })
    )

    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({
        weixin: {
          enabled: false
        },
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
    expect(await screen.findByText('消息通道设置已保存并应用'))
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
          ...bindingApi(),
          getSnapshot: vi.fn(async () => snapshot),
          apply: vi.fn(),
          testConnection
        },
        projects: {
          list: vi.fn(async () => projects),
          update: vi.fn()
        },
        settings: {
          selectWorkspace: vi.fn(async () => undefined)
        }
      } as unknown as DesktopApi
    })

    render(<ChannelSettingsSection />)
    fireEvent.click(
      await screen.findByRole('tab', { name: '钉钉' })
    )
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

  it('focuses and restores the Weixin binding trigger', async () => {
    const api = bindingApi()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          ...api,
          getSnapshot: vi.fn(async () => snapshot),
          apply: vi.fn(),
          testConnection: vi.fn()
        },
        projects: {
          list: vi.fn(async () => projects),
          update: vi.fn()
        },
        settings: {
          selectWorkspace: vi.fn(async () => undefined)
        }
      } as unknown as DesktopApi
    })

    render(<ChannelSettingsSection />)
    const trigger = await screen.findByRole('button', {
      name: '扫码绑定'
    })
    fireEvent.click(trigger)
    const close = await screen.findByRole('button', {
      name: '关闭微信绑定'
    })
    await waitFor(() => expect(close).toHaveFocus())

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(trigger).toHaveFocus()
  })

  it('presents the three channel configurations as keyboard tabs', async () => {
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          ...bindingApi(),
          getSnapshot: vi.fn(async () => snapshot),
          apply: vi.fn(),
          testConnection: vi.fn()
        },
        projects: {
          list: vi.fn(async () => projects),
          update: vi.fn()
        },
        settings: {
          selectWorkspace: vi.fn(async () => undefined)
        }
      } as unknown as DesktopApi
    })

    render(<ChannelSettingsSection />)
    const tablist = await screen.findByRole('tablist', {
      name: '消息通道配置'
    })
    const weixinTab = within(tablist).getByRole('tab', {
      name: '微信 ClawBot'
    })
    const wecomTab = within(tablist).getByRole('tab', {
      name: '企业微信'
    })
    const dingtalkTab = within(tablist).getByRole('tab', {
      name: '钉钉'
    })

    expect(weixinTab).toHaveAttribute('aria-selected', 'true')
    expect(wecomTab).toHaveAttribute('tabindex', '-1')
    expect(dingtalkTab).toHaveAttribute('tabindex', '-1')
    expect(
      screen.queryByRole('checkbox', { name: '启用企业微信通道' })
    ).not.toBeInTheDocument()

    fireEvent.keyDown(weixinTab, { key: 'ArrowRight' })

    expect(wecomTab).toHaveFocus()
    expect(wecomTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'channel-settings-tab-wecom'
    )
    expect(
      screen.getByRole('checkbox', { name: '启用企业微信通道' })
    ).toBeInTheDocument()
  })
})
