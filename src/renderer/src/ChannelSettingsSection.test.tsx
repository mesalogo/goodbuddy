import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelRuntimeStatusChange, ChannelSettingsSnapshot } from '../../shared/channel-settings-contracts'
import {
  defaultRuntimeSettings,
  type DesktopApi,
  type RuntimeSettings
} from '../../shared/contracts'
import type {
  AssistantProject,
  ProjectCreateInput
} from '../../shared/assistant-contracts'
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
  telegram: {
    enabled: false,
    secretConfigured: false,
    source: 'none',
    readOnly: false,
    allowedSenderIds: [],
    allowGroupMessages: false,
    status: { state: 'disabled' }
  },
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
  ['dingtalk', '钉钉'],
  ['telegram', 'Telegram']
].map(([channel, name], index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  name: name!,
  description: `${name}通道项目`,
  rootPath: 'C:\\Users\\tester',
  executionSpace: {
    kind: 'local',
    rootPath: 'C:\\Users\\tester'
  },
  runtimeSelection: { provider: 'model' },
  kind: 'channel',
  channel: channel as AssistantProject['channel'],
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

function renderChannelSettings(
  props: Pick<
    ComponentProps<typeof ChannelSettingsSection>,
    'initialChannel' | 'onNotify'
  > = {}
) {
  return render(
    <ChannelSettingsSection
      {...props}
      onUpdateProject={(projectId, input) =>
        window.goodbuddy.projects.update(projectId, input)
      }
      projectList={projects}
    />
  )
}

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await i18n.changeLanguage('zh-CN')
})

describe('ChannelSettingsSection', () => {
  it('keeps pushed channel status newer than loading and updates reconnect errors without resetting drafts', async () => {
    let receive!: (change: ChannelRuntimeStatusChange) => void
    const unsubscribe = vi.fn()
    const onStatusChanged = vi.fn((listener: typeof receive) => {
      receive = listener
      return unsubscribe
    })
    const getSnapshot = vi.fn(async () => {
      receive({ channel: 'telegram', status: { state: 'running' } })
      return { ...snapshot, telegram: { ...snapshot.telegram, enabled: true, secretConfigured: true, status: { state: 'starting' } } }
    })
    const apply = vi.fn()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: { ...bindingApi(), onStatusChanged, getSnapshot, apply, testConnection: vi.fn() },
        settings: settingsApi(), projects: { update: vi.fn() }
      } as unknown as DesktopApi
    })
    const { unmount } = renderChannelSettings({ initialChannel: 'telegram' })
    const token = await screen.findByLabelText('TelegramBot Token')
    expect(screen.getByText('已连接')).toBeInTheDocument()
    expect(screen.queryByText('正在连接')).not.toBeInTheDocument()
    fireEvent.change(token, { target: { value: 'unsaved-token-placeholder' } })
    const senders = screen.getByLabelText('Telegram允许的发送者 ID')
    fireEvent.change(senders, { target: { value: '12345\n67890' } })
    act(() => receive({ channel: 'telegram', status: { state: 'error', lastError: 'Network unavailable' } }))
    expect(screen.getByText('连接失败')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable')
    act(() => receive({ channel: 'telegram', status: { state: 'starting' } }))
    expect(screen.getByText('正在连接')).toBeInTheDocument()
    expect(screen.queryByText('Network unavailable')).not.toBeInTheDocument()
    act(() => receive({ channel: 'telegram', status: { state: 'running' } }))
    expect(screen.getByText('已连接')).toBeInTheDocument()
    expect(token).toHaveValue('unsaved-token-placeholder')
    expect(senders).toHaveValue('12345\n67890')
    expect(getSnapshot).toHaveBeenCalledOnce()
    expect(onStatusChanged).toHaveBeenCalledOnce()
    expect(apply).not.toHaveBeenCalled()
    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('tests and saves Telegram credentials, keeps them on whitelist edits, and clears them explicitly', async () => {
    const configured = {
      ...snapshot,
      telegram: { ...snapshot.telegram, enabled: true, secretConfigured: true, source: 'encrypted' as const }
    }
    const apply = vi.fn()
      .mockResolvedValueOnce(configured)
      .mockResolvedValueOnce({ ...configured, telegram: { ...configured.telegram, allowedSenderIds: ['12345', '67890'] } })
      .mockResolvedValueOnce(snapshot)
    const testConnection = vi.fn(async () => ({ channel: 'telegram', ok: true, botUsername: 'goodbuddy_test_bot' }))
    const updateProject = vi.fn(async (id: string, input: ProjectCreateInput) => ({ ...projects.find((p) => p.id === id)!, ...input }))
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: { ...bindingApi(), getSnapshot: vi.fn(async () => snapshot), apply, testConnection },
        settings: settingsApi(),
        projects: { update: updateProject }
      } as unknown as DesktopApi
    })
    const onNotify = vi.fn()
    renderChannelSettings({ initialChannel: 'telegram', onNotify })
    const token = await screen.findByLabelText('TelegramBot Token')
    expect(token).toHaveAttribute('type', 'password')
    expect(screen.getByRole('link', { name: '打开官方 BotFather' })).toHaveAttribute('href', 'https://t.me/BotFather')
    expect(screen.getByText(/尚未授权用户/u)).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /群聊/u })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/机器人 ID/u)).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /默认模式/u })).not.toBeInTheDocument()
    fireEvent.change(token, { target: { value: 'test-token-placeholder' } })
    fireEvent.click(screen.getByRole('button', { name: '测试Telegram连接' }))
    await waitFor(() => {
      expect(testConnection).toHaveBeenCalledWith('telegram', {
        enabled: false, secret: { action: 'replace', value: 'test-token-placeholder' }, allowedSenderIds: [], allowGroupMessages: false
      })
      expect(screen.getByRole('link', { name: '@goodbuddy_test_bot' })).toHaveAttribute('href', 'https://t.me/goodbuddy_test_bot')
      expect(screen.getByRole('button', { name: '保存通道设置' })).toBeEnabled()
    })
    expect(apply).not.toHaveBeenCalled()
    expect(screen.getByRole('switch', { name: '启用Telegram通道' })).not.toBeChecked()
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ message: 'Telegram 凭据验证成功；测试不会启用消息接收。' }))
    fireEvent.click(screen.getByRole('switch', { name: '启用Telegram通道' }))
    fireEvent.click(screen.getByRole('button', { name: '保存通道设置' }))
    await waitFor(() => {
      expect(apply).toHaveBeenLastCalledWith({ telegram: {
        enabled: true, secret: { action: 'replace', value: 'test-token-placeholder' }, allowedSenderIds: [], allowGroupMessages: false
      } })
      expect(token).toHaveValue('')
      expect(screen.getByRole('button', { name: '保存通道设置' })).toBeEnabled()
    })
    fireEvent.change(screen.getByLabelText('Telegram允许的发送者 ID'), { target: { value: '12345，67890\n12345' } })
    fireEvent.change(screen.getByLabelText('Telegram 默认工作目录'), { target: { value: 'C:\\TelegramWorkspace' } })
    fireEvent.click(screen.getByRole('button', { name: '保存通道设置' }))
    await waitFor(() => {
      expect(apply).toHaveBeenLastCalledWith({ telegram: {
        enabled: true, secret: { action: 'keep' }, allowedSenderIds: ['12345', '67890'], allowGroupMessages: false
      } })
      expect(screen.getByRole('button', { name: '保存通道设置' })).toBeEnabled()
    })
    expect(updateProject).toHaveBeenCalledWith(projects[3]!.id, expect.objectContaining({ rootPath: 'C:\\TelegramWorkspace' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /保存时清除 Token/u }))
    expect(screen.queryByRole('link', { name: '@goodbuddy_test_bot' })).not.toBeInTheDocument()
    expect(token).toBeDisabled()
    expect(screen.getByRole('button', { name: '测试Telegram连接' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '保存通道设置' }))
    await waitFor(() => {
      expect(apply).toHaveBeenLastCalledWith({ telegram: {
        enabled: false, secret: { action: 'clear' }, allowedSenderIds: ['12345', '67890'], allowGroupMessages: false
      } })
      expect(screen.queryByRole('checkbox', { name: /保存时清除 Token/u })).not.toBeInTheDocument()
      expect(token).toHaveValue('')
      expect(token).toBeEnabled()
      expect(screen.getByRole('switch', { name: '启用Telegram通道' })).not.toBeChecked()
    })
  })

  it('validates Telegram IDs and retains the draft after test and save failures', async () => {
    const apply = vi.fn().mockRejectedValue(new Error('Save failed'))
    const testConnection = vi.fn().mockResolvedValue({ channel: 'telegram', ok: false, error: 'Webhook in use' })
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: { ...bindingApi(), getSnapshot: vi.fn(async () => snapshot), apply, testConnection },
        settings: settingsApi(), projects: { update: vi.fn(async () => projects[3]) }
      } as unknown as DesktopApi
    })
    renderChannelSettings({ initialChannel: 'telegram' })
    const token = await screen.findByLabelText('TelegramBot Token')
    fireEvent.change(token, { target: { value: 'test-token-placeholder' } })
    const senders = screen.getByLabelText('Telegram允许的发送者 ID')
    fireEvent.change(senders, { target: { value: '@username' } })
    expect(senders).toHaveAttribute('aria-invalid', 'true')
    expect(senders).toHaveAccessibleDescription('请填写正整数用户 ID，最多 100 个，每个不超过 256 位，不要填写 @用户名。')
    fireEvent.click(screen.getByRole('button', { name: '保存通道设置' }))
    expect(apply).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '测试Telegram连接' })).toBeDisabled()
    fireEvent.change(senders, { target: { value: '12345' } })
    fireEvent.click(screen.getByRole('button', { name: '测试Telegram连接' }))
    await waitFor(() => {
      expect(screen.getByText('Webhook in use')).toBeInTheDocument()
      expect(token).toBeEnabled()
      expect(token).toHaveValue('test-token-placeholder')
    })
    fireEvent.click(screen.getByRole('button', { name: '保存通道设置' }))
    await waitFor(() => {
      expect(screen.getByText('Save failed')).toBeInTheDocument()
      expect(token).toHaveValue('test-token-placeholder')
      expect(senders).toHaveValue('12345')
      expect(screen.getByRole('button', { name: '保存通道设置' })).toBeEnabled()
    })
  })

  it('tests saved Telegram Tokens without replacement and locks edits until the result arrives', async () => {
    let resolveTest!: (value: { channel: 'telegram'; ok: boolean; botUsername: string }) => void
    const testConnection = vi.fn(() => new Promise((resolve) => { resolveTest = resolve }))
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          ...bindingApi(),
          getSnapshot: vi.fn(async () => ({ ...snapshot, telegram: { ...snapshot.telegram, secretConfigured: true, source: 'encrypted' } })),
          apply: vi.fn(), testConnection
        },
        settings: settingsApi(), projects: { update: vi.fn() }
      } as unknown as DesktopApi
    })
    renderChannelSettings({ initialChannel: 'telegram' })
    const token = await screen.findByLabelText('TelegramBot Token')
    fireEvent.click(screen.getByRole('button', { name: '测试Telegram连接' }))
    expect(testConnection).toHaveBeenCalledWith('telegram', {
      enabled: false, secret: { action: 'keep' }, allowedSenderIds: [], allowGroupMessages: false
    })
    expect(token).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /保存时清除 Token/u })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存通道设置' })).toBeDisabled()
    await act(async () => resolveTest({ channel: 'telegram', ok: true, botUsername: 'saved_test_bot' }))
    await waitFor(() => {
      expect(token).toBeEnabled()
      expect(screen.getByRole('link', { name: '@saved_test_bot' })).toBeInTheDocument()
    })
    fireEvent.change(token, { target: { value: 'replacement-placeholder' } })
    expect(screen.queryByRole('link', { name: '@saved_test_bot' })).not.toBeInTheDocument()
  })

  it('renders English Telegram setup and tests read-only environment credentials', async () => {
    const testConnection = vi.fn(async () => ({ channel: 'telegram', ok: true }))
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          ...bindingApi(),
          getSnapshot: vi.fn(async () => ({ ...snapshot, telegram: { ...snapshot.telegram, secretConfigured: true, readOnly: true, source: 'environment' } })),
          apply: vi.fn(), testConnection
        },
        settings: settingsApi(), projects: { update: vi.fn() }
      } as unknown as DesktopApi
    })
    await i18n.changeLanguage('en-US')
    renderChannelSettings({ initialChannel: 'telegram' })
    expect(await screen.findByLabelText('Telegram Bot Token')).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Enable the Telegram channel' })).toBeDisabled()
    expect(screen.getByLabelText('Telegram allowed sender IDs')).toBeDisabled()
    expect(screen.getByText(/Send \/newbot to BotFather/u)).toHaveTextContent('/whoami')
    expect(screen.getByText(/No users authorized/u)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connection and offline messages' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('operating system proxy')
    fireEvent.click(screen.getByRole('button', { name: 'Test Telegram connection' }))
    await waitFor(() => {
      expect(testConnection).toHaveBeenCalledWith('telegram', undefined)
      expect(screen.getByRole('button', { name: 'Test Telegram connection' })).toBeEnabled()
    })
    expect(screen.queryByRole('link', { name: /^@/u })).not.toBeInTheDocument()
  })

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
    renderChannelSettings({ onNotify })
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
    fireEvent.change(screen.getByLabelText('企业微信 项目说明'), {
      target: { value: '企业微信同步项目' }
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
    fireEvent.change(screen.getByLabelText('企业微信 模型'), {
      target: { value: directProfileId }
    })
    expect(screen.queryByRole('group', { name: '企业微信 默认模式' })).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: '保存通道设置' })
    )
    expect(updateProject).toHaveBeenCalledWith(
      projects[1]!.id,
      expect.objectContaining({
        description: '企业微信同步项目',
        rootPath: 'C:\\RemoteWorkspace',
        runtimeSelection: {
          provider: 'model',
          model: { kind: 'profile', profileId: directProfileId }
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
    renderChannelSettings({ onNotify })
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

    renderChannelSettings()
    const trigger = await screen.findByRole('button', {
      name: '扫码绑定'
    })
    fireEvent.click(trigger)
    const close = await screen.findByRole('button', {
      name: '关闭微信绑定'
    })
    expect(screen.getByRole('dialog').parentElement?.parentElement).toBe(
      document.body
    )
    expect(
      screen.getByText(
        '请在微信中依次打开“设置 → 插件 → ClawBot → 开始扫一扫”，扫描下方二维码。二维码不会发送到第三方页面。'
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

    renderChannelSettings()
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

    renderChannelSettings()
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

    renderChannelSettings()
    const backend = await screen.findByLabelText('微信 ClawBot 执行方式')
    // Channel projects start on the direct model; the model follows global settings.
    expect(backend).toHaveValue('model')
    expect(within(backend).queryByRole('option', { name: /自动/u })).not.toBeInTheDocument()
    for (const name of ['直连模型', 'OpenCode', 'Continue', 'DeepSeek Harness']) {
      expect(within(backend).getByRole('option', { name })).toBeInTheDocument()
    }
    const model = screen.getByLabelText('微信 ClawBot 模型')
    expect(within(model).getByRole('option', { name: '默认模型 · text-model' })).toBeInTheDocument()
    expect(within(model).queryByRole('option', { name: /image-model/u })).not.toBeInTheDocument()
    expect(within(model).getByRole('option', { name: /missing-key-model.*缺少 API Key/u })).toBeInTheDocument()

    fireEvent.change(backend, { target: { value: 'opencode' } })
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

    renderChannelSettings()
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

  it('presents the four channel configurations as keyboard tabs', async () => {
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

    renderChannelSettings()
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
    expect(within(tablist).getByRole('tab', { name: 'Telegram' })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByText('项目设置')).toBeInTheDocument()
    expect(
      screen.getByText('与左上角当前通道项目的设置保持同步。')
    ).toBeInTheDocument()
    expect(screen.queryByText('通道项目')).not.toBeInTheDocument()
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
    fireEvent.keyDown(wecomTab, { key: 'End' })
    expect(within(tablist).getByRole('tab', { name: 'Telegram' })).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'channel-settings-tab-telegram')
  })

  it('opens the requested channel configuration', async () => {
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

    renderChannelSettings({ initialChannel: 'wecom' })

    expect(
      await screen.findByRole('tab', { name: '企业微信' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'channel-settings-tab-wecom'
    )
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
    renderChannelSettings()

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
    expect(screen.queryByText('Channel project')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'The working directory for this channel project.'
      )
    ).toBeInTheDocument()
  })
})
