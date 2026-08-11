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
import {
  defaultRuntimeSettings,
  type DesktopApi,
  type RuntimeSettings
} from '../../shared/contracts'
import type {
  AssistantProject,
  ProjectCreateInput
} from '../../shared/assistant-contracts'
import { agentRuntimeSelectionKey } from '../../shared/runtime-selection-contracts'
import { ChannelSettingsSection } from './ChannelSettingsSection'
import i18n from './i18n'

const directProfileId = '00000000-0000-4000-8000-000000000011'
const runtimeSettings: RuntimeSettings = {
  ...defaultRuntimeSettings,
  workspacePath: 'C:\\Users\\tester',
  apiKeyConfigured: true,
  credentialSource: 'encrypted',
  modelProfiles: [
    {
      id: directProfileId,
      name: '默认模型',
      baseUrl: 'https://example.com',
      modelName: 'text-model',
      protocol: 'openai-responses',
      authentication: 'api-key',
      imageGenerationQuality: 'auto',
      apiKeyConfigured: true,
      credentialSource: 'encrypted'
    },
    {
      id: '00000000-0000-4000-8000-000000000012',
      name: '图片模型',
      baseUrl: 'https://example.com',
      modelName: 'image-model',
      protocol: 'openai-images-generations',
      authentication: 'api-key',
      imageGenerationQuality: 'auto',
      apiKeyConfigured: true,
      credentialSource: 'encrypted'
    },
    {
      id: '00000000-0000-4000-8000-000000000013',
      name: '未配置模型',
      baseUrl: 'https://example.com',
      modelName: 'missing-key-model',
      protocol: 'openai-responses',
      authentication: 'api-key',
      imageGenerationQuality: 'auto',
      apiKeyConfigured: false,
      credentialSource: 'none'
    }
  ],
  defaultModelProfileId: directProfileId,
  opencodeModelSource: { kind: 'platform' },
  continueModelSource: { kind: 'platform' },
  knowledgeEmbeddingApiKeyConfigured: false,
  knowledgeEmbeddingCredentialSource: 'none',
  secureStorageAvailable: true
}

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
  runtimeSelection: { provider: 'auto' },
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
    onWeixinBindingChanged: vi.fn(() => () => undefined)
  }
}

function settingsApi() {
  return {
    getRuntime: vi.fn(async () => runtimeSettings),
    selectWorkspace: vi.fn(async () => undefined)
  }
}

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await i18n.changeLanguage('zh-CN')
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
        settings: settingsApi()
      } as unknown as DesktopApi
    })

    const onNotify = vi.fn()
    render(<ChannelSettingsSection onNotify={onNotify} />)
    fireEvent.click(
      await screen.findByRole('tab', { name: '企业微信' })
    )
    fireEvent.click(
      await screen.findByRole('switch', {
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
    expect(
      screen.getByRole('switch', {
        name: '允许群聊中被提及时响应'
      })
    ).not.toBeChecked()
    fireEvent.change(screen.getByLabelText('企业微信 默认工作目录'), {
      target: { value: 'C:\\RemoteWorkspace' }
    })
    fireEvent.change(screen.getByLabelText('企业微信 消息处理后端'), {
      target: {
        value: agentRuntimeSelectionKey({
          provider: 'model',
          profileId: directProfileId
        })
      }
    })
    fireEvent.click(
      within(
        screen.getByRole('group', {
          name: '企业微信 默认模式'
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
        defaultWorkMode: 'execute',
        runtimeSelection: {
          provider: 'model',
          profileId: directProfileId
        }
      })
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
    expect(onNotify).toHaveBeenCalledWith({
      tone: 'success',
      message: '消息通道设置已保存并应用',
      dedupeKey: 'channel-settings-saved'
    })
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
        settings: settingsApi()
      } as unknown as DesktopApi
    })

    const onNotify = vi.fn()
    render(<ChannelSettingsSection onNotify={onNotify} />)
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
    expect(onNotify).toHaveBeenCalledWith({
      tone: 'success',
      message: '钉钉连接成功',
      dedupeKey: 'channel-test-dingtalk'
    })
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
        settings: settingsApi()
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
    expect(
      screen.getByText(
        '请在微信中依次打开“设置 → ClawBot → 开始扫一扫”，扫描下方二维码。二维码不会发送到第三方页面。'
      )
    ).toBeInTheDocument()
    await waitFor(() => expect(close).toHaveFocus())

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(trigger).toHaveFocus()
  })

  it('renders disconnecting a configured Weixin binding as a danger action', async () => {
    const configuredSnapshot: ChannelSettingsSnapshot = {
      ...snapshot,
      weixin: {
        enabled: true,
        bindingConfigured: true,
        accountDisplay: '微信用户',
        source: 'encrypted',
        status: { state: 'running' }
      }
    }
    const api = bindingApi()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          ...api,
          getSnapshot: vi.fn(async () => configuredSnapshot),
          apply: vi.fn(),
          testConnection: vi.fn()
        },
        projects: {
          list: vi.fn(async () => projects),
          update: vi.fn()
        },
        settings: settingsApi()
      } as unknown as DesktopApi
    })

    render(<ChannelSettingsSection />)
    const disconnect = await screen.findByRole('button', {
      name: '断开本机绑定'
    })
    expect(disconnect).toHaveClass(
      'danger-button',
      'danger-button--quiet'
    )

    fireEvent.click(disconnect)
    await waitFor(() =>
      expect(api.disconnectWeixin).toHaveBeenCalledOnce()
    )
  })

  it('shows Weixin verification failures inside the QR dialog', async () => {
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          ...bindingApi(),
          getSnapshot: vi.fn(async () => snapshot),
          startWeixinBinding: vi.fn(async () => ({
            status: 'verification_required' as const,
            qrPayload: 'verification-qr'
          })),
          submitWeixinVerification: vi.fn(async () => {
            throw new Error('验证码不正确，请重新输入')
          }),
          apply: vi.fn(),
          testConnection: vi.fn()
        },
        projects: {
          list: vi.fn(async () => projects),
          update: vi.fn()
        },
        settings: settingsApi()
      } as unknown as DesktopApi
    })

    render(<ChannelSettingsSection />)
    fireEvent.click(
      await screen.findByRole('button', { name: '扫码绑定' })
    )
    const verificationInput = await screen.findByLabelText('验证码')
    fireEvent.change(verificationInput, { target: { value: '123456' } })
    fireEvent.click(
      screen.getByRole('button', { name: '提交验证码' })
    )

    const error = await screen.findByRole('alert')
    expect(error).toHaveTextContent('验证码不正确，请重新输入')
    expect(verificationInput).toHaveAttribute(
      'aria-describedby',
      error.id
    )
    await waitFor(() => expect(verificationInput).toHaveFocus())
  })

  it('defaults Weixin to a direct text model and also offers Agent Runtimes', async () => {
    const updateProject = vi.fn(async (
      projectId: string,
      input: ProjectCreateInput
    ) => ({
      ...projects.find((project) => project.id === projectId)!,
      ...input
    }))
    const apply = vi.fn(async () => snapshot)
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          ...bindingApi(),
          getSnapshot: vi.fn(async () => snapshot),
          apply,
          testConnection: vi.fn()
        },
        projects: {
          list: vi.fn(async () => projects),
          update: updateProject
        },
        settings: settingsApi()
      } as unknown as DesktopApi
    })

    render(<ChannelSettingsSection />)
    const backend = await screen.findByLabelText(
      '微信 ClawBot 消息处理后端'
    )
    expect(backend).toHaveValue(
      agentRuntimeSelectionKey({
        provider: 'model',
        profileId: directProfileId
      })
    )
    expect(
      within(backend).queryByRole('option', {
        name: /自动/u
      })
    ).not.toBeInTheDocument()
    expect(
      within(backend).getByRole('option', {
        name: '默认模型 · text-model'
      })
    ).toBeInTheDocument()
    expect(
      within(backend).queryByRole('option', {
        name: '图片模型 · image-model'
      })
    ).not.toBeInTheDocument()
    expect(
      within(backend).queryByRole('option', {
        name: '未配置模型 · missing-key-model'
      })
    ).not.toBeInTheDocument()
    expect(
      within(backend).getByRole('option', { name: 'OpenCode' })
    ).toBeInTheDocument()
    expect(
      within(backend).getByRole('option', { name: 'Continue' })
    ).toBeInTheDocument()

    fireEvent.change(backend, {
      target: {
        value: agentRuntimeSelectionKey({ provider: 'opencode' })
      }
    })
    expect(
      screen.getByText(
        '通过 OpenCode Agent Runtime 运行，并跟随“Agent Runtime”设置中的全局 OpenCode 配置。'
      )
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: '保存通道设置' })
    )

    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith(
        projects[0]!.id,
        expect.objectContaining({
          runtimeSelection: { provider: 'opencode' }
        })
      )
    )
    expect(apply).not.toHaveBeenCalled()
  })

  it('validates every project root before saving any channel', async () => {
    const updateProject = vi.fn()
    const apply = vi.fn()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          ...bindingApi(),
          getSnapshot: vi.fn(async () => snapshot),
          apply,
          testConnection: vi.fn()
        },
        projects: {
          list: vi.fn(async () => projects),
          update: updateProject
        },
        settings: settingsApi()
      } as unknown as DesktopApi
    })

    render(<ChannelSettingsSection />)
    fireEvent.change(
      await screen.findByLabelText('微信 ClawBot 默认工作目录'),
      { target: { value: '' } }
    )
    fireEvent.click(
      screen.getByRole('button', { name: '保存通道设置' })
    )

    expect(
      await screen.findByText('微信 ClawBot 必须设置默认工作目录')
    ).toBeInTheDocument()
    expect(updateProject).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
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
        settings: settingsApi()
      } as unknown as DesktopApi
    })

    render(<ChannelSettingsSection />)
    const tablist = await screen.findByRole('tablist', {
      name: '消息通道配置'
    })
    expect(tablist).toHaveClass('page-tabs--segmented')
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
      screen.queryByRole('switch', { name: '启用企业微信通道' })
    ).not.toBeInTheDocument()

    fireEvent.keyDown(weixinTab, { key: 'ArrowRight' })

    expect(wecomTab).toHaveFocus()
    expect(wecomTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'channel-settings-tab-wecom'
    )
    expect(
      screen.getByRole('switch', { name: '启用企业微信通道' })
    ).toBeInTheDocument()
  })

  it('renders English channel copy while preserving project data', async () => {
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
        settings: settingsApi()
      } as unknown as DesktopApi
    })

    await i18n.changeLanguage('en-US')
    render(<ChannelSettingsSection />)

    expect(
      await screen.findByRole('tablist', {
        name: 'Message channel configuration'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save channel settings' })
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText('微信 ClawBot default working directory')
    ).toHaveValue('C:\\Users\\tester')
    expect(screen.getByText('微信 ClawBot')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Remote Execute operations can run only within this project directory.'
      )
    ).toBeInTheDocument()
  })
})
