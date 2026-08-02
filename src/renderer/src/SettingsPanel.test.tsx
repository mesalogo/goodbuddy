import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopApi,
  RuntimeSettings
} from '../../shared/contracts'
import { SettingsPanel } from './SettingsPanel'

const modelProfileId = '00000000-0000-4000-8000-000000000001'
const runtimeSettings: RuntimeSettings = {
  provider: 'auto',
  modelBaseUrl: 'https://bigtoken.ai',
  modelName: 'sonnet-5',
  modelProtocol: 'anthropic-messages',
  modelAuthentication: 'api-key',
  opencodeBaseUrl: '',
  opencodeEmbedded: false,
  opencodeBinaryPath: '',
  opencodeConfigPath: '',
  continueBinaryPath: '',
  continueConfigPath: '',
  continueMode: 'chat',
  runtimeSandboxMode: 'auto',
  knowledgeEmbeddingEnabled: false,
  knowledgeEmbeddingBaseUrl: 'http://127.0.0.1:11434',
  knowledgeEmbeddingModel: 'nomic-embed-text',
  workspacePath: 'C:\\Workspace',
  apiKeyConfigured: false,
  credentialSource: 'none',
  modelProfiles: [
    {
      id: modelProfileId,
      name: '默认模型',
      baseUrl: 'https://bigtoken.ai',
      modelName: 'sonnet-5',
      protocol: 'anthropic-messages',
      authentication: 'api-key',
      apiKeyConfigured: false,
      credentialSource: 'none'
    }
  ],
  defaultModelProfileId: modelProfileId,
  opencodeModelSource: { kind: 'platform' },
  continueModelSource: { kind: 'platform' },
  secureStorageAvailable: true,
  toolApproval: 'always'
}

const getRuntime = vi.fn(async () => runtimeSettings)
const updateRuntime = vi.fn<DesktopApi['settings']['updateRuntime']>(
  async (input) => ({
    ...runtimeSettings,
    ...input,
    modelProfiles: (input.modelProfiles ?? []).map(
      ({ apiKey, ...profile }) => ({
        ...profile,
        apiKeyConfigured: apiKey.action === 'replace',
        credentialSource:
          apiKey.action === 'replace'
            ? ('encrypted' as const)
            : ('none' as const)
      })
    ),
    defaultModelProfileId:
      input.defaultModelProfileId ?? modelProfileId,
    opencodeModelSource:
      input.opencodeModelSource ?? { kind: 'platform' },
    continueModelSource:
      input.continueModelSource ?? { kind: 'platform' },
    apiKeyConfigured: false,
    credentialSource: 'none',
    secureStorageAvailable: true
  })
)
const detectAgentRuntimes = vi.fn<
  DesktopApi['settings']['detectAgentRuntimes']
>(async () => ({
  opencode: {
    available: true,
    path: 'C:\\Tools\\opencode.exe',
    version: '1.2.3',
    detail: '通过 PATH 检测'
  },
  continue: {
    available: false,
    detail: '未检测到 Continue'
  }
}))
const selectRuntimeFile = vi.fn<
  DesktopApi['settings']['selectRuntimeFile']
>(async (kind) =>
  kind === 'continueBinary' ? 'C:\\Tools\\cn.exe' : undefined
)
const capabilitySnapshot = {
  skills: [
    {
      id: 'document-writing',
      name: '文档写作',
      description: '起草专业办公文档',
      version: '1.0.0',
      tags: ['文档', '办公'],
      source: 'builtin' as const,
      digest: 'a'.repeat(64),
      enabled: true,
      assignments: ['model', 'opencode', 'continue'] as (
        | 'model'
        | 'opencode'
        | 'continue'
      )[]
    }
  ],
  mcpServers: []
}
const getCapabilitySnapshot = vi.fn(async () => capabilitySnapshot)
const setSkillEnabled = vi.fn(async (_skillId: string, enabled: boolean) => ({
  ...capabilitySnapshot,
  skills: capabilitySnapshot.skills.map((skill) => ({
    ...skill,
    enabled
  }))
}))
const heartbeatSettingsProps = {
  heartbeats: [],
  onCreateHeartbeat: vi.fn(async () => {}),
  onSetHeartbeatPaused: vi.fn(async () => {}),
  onRemoveHeartbeat: vi.fn(async () => {}),
  onRunHeartbeat: vi.fn(async () => {})
}

describe('SettingsPanel runtime files', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        settings: {
          getRuntime,
          updateRuntime,
          selectWorkspace: vi.fn(async () => undefined),
          detectAgentRuntimes,
          selectRuntimeFile,
          testRuntime: vi.fn(async () => ({
            id: 'continue',
            label: 'Continue',
            available: true,
            supportsToolExecution: true,
            detail: 'Ready'
          }))
        },
        capabilities: {
          getSnapshot: getCapabilitySnapshot,
          importSkill: vi.fn(async () => capabilitySnapshot),
          removeSkill: vi.fn(async () => capabilitySnapshot),
          setSkillEnabled,
          setSkillAssignments: vi.fn(async () => capabilitySnapshot),
          saveMcpServer: vi.fn(async () => capabilitySnapshot),
          removeMcpServer: vi.fn(async () => capabilitySnapshot),
          testMcpServer: vi.fn(async () => ({
            toolCount: 0,
            tools: []
          }))
        }
      } as unknown as DesktopApi
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('offers system, light, and dark appearance modes', async () => {
    const onAppearanceThemeChange = vi.fn()
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        appearanceTheme="system"
        onAppearanceThemeChange={onAppearanceThemeChange}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '外观' }))
    expect(
      screen.getByRole('radio', { name: /跟随系统/u })
    ).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: /暗色/u }))
    expect(onAppearanceThemeChange).toHaveBeenCalledWith('dark')
  })

  it('automatically detects runtimes and displays path, version, and detail', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    expect(detectAgentRuntimes).toHaveBeenCalledOnce()
    expect(
      await screen.findByText(
        'C:\\Tools\\opencode.exe · 1.2.3 · 通过 PATH 检测'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(/未找到可执行文件 · 未检测到 Continue/)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    await waitFor(() =>
      expect(detectAgentRuntimes).toHaveBeenCalledTimes(2)
    )
  })

  it('selects, warns about, clears, and saves a custom binary', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    const input = await screen.findByLabelText('Continue 可执行文件路径')
    const field = input.closest('label')
    if (!field) {
      throw new Error('Missing Continue binary field')
    }
    fireEvent.click(within(field).getByRole('button', { name: '选择' }))

    await waitFor(() =>
      expect(selectRuntimeFile).toHaveBeenCalledWith('continueBinary')
    )
    await waitFor(() => expect(input).toHaveValue('C:\\Tools\\cn.exe'))
    expect(
      screen.getByText(/自定义 Continue 可执行文件将以当前用户权限运行/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/仅在实际请求高风险工具时暂停/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/不会匿名加载远程默认模型/)
    ).toBeInTheDocument()

    fireEvent.click(within(field).getByRole('button', { name: '清除' }))
    expect(input).toHaveValue('')

    fireEvent.change(input, { target: { value: 'C:\\Tools\\cn.exe' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          continueBinaryPath: 'C:\\Tools\\cn.exe',
          continueConfigPath: '',
          continueMode: 'chat',
          opencodeBinaryPath: '',
          opencodeConfigPath: ''
        })
      )
    )
  })

  it('adds model connections and assigns one to OpenCode', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '模型连接' }))
    await screen.findByDisplayValue('默认模型')
    fireEvent.click(
      screen.getByRole('button', { name: '添加自定义' })
    )
    const nameInputs = screen.getAllByLabelText('名称')
    fireEvent.change(nameInputs[1]!, {
      target: { value: 'OpenCode 独立模型' }
    })
    const radios = screen.getAllByRole('radio', {
      name: '默认连接'
    })
    fireEvent.click(radios[1]!)
    fireEvent.click(screen.getByRole('tab', { name: 'Agent Runtime' }))
    const sourceSelect = screen.getAllByLabelText('模型连接')[0]!
    const sourceOptions = within(sourceSelect).getAllByRole('option')
    fireEvent.change(sourceSelect, {
      target: {
        value: (sourceOptions.at(-1) as HTMLOptionElement).value
      }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProfiles: expect.arrayContaining([
            expect.objectContaining({ name: '默认模型' }),
            expect.objectContaining({ name: 'OpenCode 独立模型' })
          ]),
          opencodeModelSource: expect.objectContaining({
            kind: 'profile'
          })
        })
      )
    )
  })

  it('adds the Ollama preset with OpenAI protocol and no authentication', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '模型连接' }))
    const preset = await screen.findByLabelText('模型预设')
    fireEvent.change(preset, { target: { value: 'ollama' } })
    fireEvent.click(
      screen.getByRole('button', { name: '从预设添加' })
    )
    expect(
      screen
        .getAllByLabelText('名称')
        .some((input) => (input as HTMLInputElement).value === 'Ollama（本机）')
    ).toBe(true)
    expect(
      screen.getByDisplayValue('http://127.0.0.1:11434/v1')
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText('接口协议 Ollama（本机）')
    ).toHaveValue('openai-chat-completions')
    expect(
      screen.getByLabelText('认证方式 Ollama（本机）')
    ).toHaveValue('none')
    expect(
      screen.getByText('无需认证，不会发送 API Key')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProfiles: expect.arrayContaining([
            expect.objectContaining({
              name: 'Ollama（本机）',
              protocol: 'openai-chat-completions',
              authentication: 'none',
              apiKey: { action: 'keep' }
            })
          ])
        })
      )
    )
  })

  it('marks the BigToken gpt-image-2 preset as image generation', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '模型连接' }))
    const preset = await screen.findByLabelText('模型预设')
    fireEvent.change(preset, {
      target: { value: 'bigtoken-gpt-image-2' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '从预设添加' })
    )

    expect(
      screen.getByLabelText('接口协议 BigToken GPT Image 2')
    ).toHaveValue('openai-images-generations')
    expect(screen.getByText('图像生成', { selector: 'span' }))
      .toBeInTheDocument()

    const defaultConnections = screen.getAllByRole('radio')
    fireEvent.click(defaultConnections.at(-1)!)
    vi.mocked(window.goodbuddy.settings.testRuntime).mockResolvedValueOnce({
      id: 'model',
      label: 'gpt-image-2',
      available: true,
      supportsToolExecution: false,
      detail: '图像接口将在发送提示词时实际验证',
      capability: 'image-generation'
    })
    fireEvent.click(screen.getByRole('button', { name: '保存并测试' }))
    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProfiles: expect.arrayContaining([
            expect.objectContaining({
              name: 'BigToken GPT Image 2',
              modelName: 'gpt-image-2',
              protocol: 'openai-images-generations'
            })
          ])
        })
      )
    )
    expect(
      await screen.findByText('图像接口将在发送提示词时实际验证')
    ).toBeInTheDocument()
    expect(screen.queryByText('连接成功：gpt-image-2'))
      .not.toBeInTheDocument()
  })

  it('manages heartbeat automation from Settings', async () => {
    const onCreateHeartbeat = vi.fn(async () => {})
    const onSetHeartbeatPaused = vi.fn(async () => {})
    const onRemoveHeartbeat = vi.fn(async () => {})
    const onRunHeartbeat = vi.fn(async () => {})
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        heartbeats={[
          {
            id: 'heartbeat-1',
            name: '长期记忆回顾',
            timezone: 'Asia/Shanghai',
            recurrence: {
              type: 'daily',
              localTime: '09:00'
            },
            enabled: true,
            lookbackHours: 48,
            retentionDays: 90,
            nextRunAt: '2026-08-02T01:00:00.000Z',
            createdAt: '2026-08-01T01:00:00.000Z',
            updatedAt: '2026-08-01T01:00:00.000Z'
          }
        ]}
        onCreateHeartbeat={onCreateHeartbeat}
        onRemoveHeartbeat={onRemoveHeartbeat}
        onRunHeartbeat={onRunHeartbeat}
        onSetHeartbeatPaused={onSetHeartbeatPaused}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '自动化' }))
    expect(
      await screen.findByRole('heading', { name: '智能心跳' })
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('心跳时间'), {
      target: { value: '08:30' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '启用智能心跳' })
    )
    await waitFor(() =>
      expect(onCreateHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          recurrence: {
            type: 'daily',
            localTime: '08:30'
          },
          enabled: true
        })
      )
    )

    const pauseButton = screen.getByRole('button', {
      name: '暂停 长期记忆回顾'
    })
    fireEvent.click(pauseButton)
    await waitFor(() =>
      expect(onSetHeartbeatPaused).toHaveBeenCalledWith(
        'heartbeat-1',
        true
      )
    )
    await waitFor(() => expect(pauseButton).toBeEnabled())

    const runButton = screen.getByRole('button', {
      name: '立即心跳 长期记忆回顾'
    })
    fireEvent.click(runButton)
    await waitFor(() =>
      expect(onRunHeartbeat).toHaveBeenCalledWith('heartbeat-1')
    )
    await waitFor(() => expect(runButton).toBeEnabled())

    fireEvent.click(
      screen.getByRole('button', {
        name: '删除 长期记忆回顾'
      })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: '确认删除 长期记忆回顾'
      })
    )
    await waitFor(() =>
      expect(onRemoveHeartbeat).toHaveBeenCalledWith('heartbeat-1')
    )
  })

  it('prevents duplicate heartbeat actions and reports failures', async () => {
    let rejectCreate: (reason: Error) => void = () => {}
    const onCreateHeartbeat = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCreate = reject
        })
    )
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        onCreateHeartbeat={onCreateHeartbeat}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '自动化' }))
    const createButton = screen.getByRole('button', {
      name: '启用智能心跳'
    })
    fireEvent.click(createButton)
    fireEvent.click(createButton)
    expect(onCreateHeartbeat).toHaveBeenCalledOnce()
    expect(createButton).toBeDisabled()

    rejectCreate(new Error('创建心跳失败'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '创建心跳失败'
    )
    expect(createButton).toBeEnabled()
  })

  it('shows Skills and MCP as first-class settings tabs', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }))
    expect(await screen.findByText('文档写作')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('启用 文档写作'))
    await waitFor(() =>
      expect(setSkillEnabled).toHaveBeenCalledWith(
        'document-writing',
        false
      )
    )

    fireEvent.click(screen.getByRole('tab', { name: 'MCP' }))
    expect(
      await screen.findByText('尚未配置 MCP Server')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /添加 Server/ })
    ).toBeInTheDocument()
  })
})
