import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantExpert } from '../../shared/assistant-contracts'
import type {
  DesktopApi,
  RuntimeSettings
} from '../../shared/contracts'
import type { CapabilitySnapshot } from '../../shared/capability-contracts'
import type {
  EmbeddingDiagnosticResult,
  EmbeddingIndexStatus,
  EmbeddingSettingsSnapshot
} from '../../shared/embedding-contracts'
import { builtinMcpServers } from '../../shared/builtin-mcp-servers'
import { builtinModelTools } from '../../shared/builtin-model-tools'
import { SettingsPanel } from './SettingsPanel'

const modelProfileId = '00000000-0000-4000-8000-000000000001'
const browserProfileId = '00000000-0000-4000-8000-000000000201'
const runtimeSettings: RuntimeSettings = {
  provider: 'auto',
  modelBaseUrl: 'https://bigtoken.ai',
  modelName: 'sonnet-5',
  modelProtocol: 'anthropic-messages',
  modelAuthentication: 'api-key',
  imageGenerationQuality: 'auto',
  opencodeBaseUrl: '',
  opencodeEmbedded: false,
  opencodeBinaryPath: '',
  opencodeConfigPath: '',
  continueBinaryPath: '',
  continueConfigPath: '',
  continueMode: 'chat',
  runtimeSandboxMode: 'auto',
  subagentSmartRoutingEnabled: false,
  intranetCompatibilityEnabled: true,
  knowledgeEmbeddingEnabled: false,
  knowledgeEmbeddingBaseUrl:
    'http://127.0.0.1:11434/v1/embeddings',
  knowledgeEmbeddingModel: 'nomic-embed-text',
  knowledgeEmbeddingApiKeyConfigured: false,
  knowledgeEmbeddingCredentialSource: 'none',
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
      imageGenerationQuality: 'auto',
      apiKeyConfigured: false,
      credentialSource: 'none'
    }
  ],
  defaultModelProfileId: modelProfileId,
  opencodeModelSource: {
    kind: 'profile',
    profileId: modelProfileId
  },
  continueModelSource: {
    kind: 'profile',
    profileId: modelProfileId
  },
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
const openRuntimeConfig = vi.fn<
  DesktopApi['settings']['openRuntimeConfig']
>(async () => {})
const testModelConnection = vi.fn<
  DesktopApi['settings']['testModelConnection']
>(async () => ({
  id: 'model',
  label: 'sonnet-5',
  available: true,
  supportsToolExecution: true,
  detail: 'Ready'
}))
const testRuntime = vi.fn<DesktopApi['settings']['testRuntime']>(
  async () => ({
    id: 'continue',
    label: 'Continue',
    available: true,
    supportsToolExecution: true,
    detail: 'Ready'
  })
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
  mcpServers: [] as CapabilitySnapshot['mcpServers'],
  computerCapabilities: [
    {
      id: 'host-browser-control' as const,
      name: '浏览器控制',
      description: '使用隔离的托管浏览器配置执行网页操作。',
      enabled: false,
      supported: true,
      browserProfileId: null,
      riskSummary: '可读取网页内容并代表用户操作网站。'
    },
    {
      id: 'linux-desktop-control' as const,
      name: 'Linux 桌面控制',
      description: '在受支持的 Linux 桌面会话中执行桌面操作。',
      enabled: false,
      supported: false,
      browserProfileId: null,
      riskSummary: '可观察并操作桌面应用。'
    }
  ],
  browserProfiles: {
    profiles: [
      {
        id: browserProfileId,
        name: '工作网站',
        mode: 'managed-isolated' as const
      }
    ],
    defaultProfileId: browserProfileId
  }
} satisfies CapabilitySnapshot
const getCapabilitySnapshot = vi.fn(async () => capabilitySnapshot)
const saveMcpServer = vi.fn(async () => capabilitySnapshot)
const setSkillEnabled = vi.fn(async (_skillId: string, enabled: boolean) => ({
  ...capabilitySnapshot,
  skills: capabilitySnapshot.skills.map((skill) => ({
    ...skill,
    enabled
  }))
}))
const setComputerCapabilityEnabled = vi.fn(
  async (_capabilityId: string, enabled: boolean) => ({
    ...capabilitySnapshot,
    computerCapabilities: capabilitySnapshot.computerCapabilities.map(
      (capability) =>
        capability.id === 'host-browser-control'
          ? { ...capability, enabled }
          : capability
    )
  })
)
const diagnoseComputerCapability = vi.fn(async () => ({
  capabilityId: 'host-browser-control' as const,
  status: 'degraded' as const,
  checkedAt: '2026-08-05T12:00:00.000Z',
  checks: [
    {
      id: 'managed-profile-root',
      status: 'degraded' as const,
      summary: '托管配置可用，但尚未选择默认网站。',
      remedy: '先创建并选择托管配置。'
    }
  ]
}))
const createBrowserProfile = vi.fn(async () => capabilitySnapshot)
const renameBrowserProfile = vi.fn(async () => capabilitySnapshot)
const setDefaultBrowserProfile = vi.fn(async () => capabilitySnapshot)
const removeBrowserProfile = vi.fn(async () => capabilitySnapshot)
const heartbeatSettingsProps = {
  heartbeats: [],
  onCreateHeartbeat: vi.fn(async () => {}),
  onSetHeartbeatPaused: vi.fn(async () => {}),
  onRemoveHeartbeat: vi.fn(async () => {}),
  onRunHeartbeat: vi.fn(async () => {})
}
const assistantExpert: AssistantExpert = {
  id: '00000000-0000-4000-8000-000000000101',
  name: '研究分析专家',
  description: '负责资料分析',
  systemInstructions: 'Separate evidence from assumptions.',
  routingKeywords: ['研究', '分析'],
  enabled: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
}
const listExperts = vi.fn<DesktopApi['experts']['list']>(
  async () => [assistantExpert]
)
const createExpert = vi.fn<DesktopApi['experts']['create']>(
  async (input) => ({
    ...input,
    routingKeywords: input.routingKeywords ?? [],
    id: '00000000-0000-4000-8000-000000000102',
    enabled: true,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z'
  })
)
const updateExpert = vi.fn<DesktopApi['experts']['update']>(
  async (expertId, input) => ({
    ...input,
    routingKeywords: input.routingKeywords ?? [],
    id: expertId,
    enabled: true,
    createdAt: assistantExpert.createdAt,
    updatedAt: '2026-08-04T00:00:00.000Z'
  })
)
const removeExpert = vi.fn<DesktopApi['experts']['remove']>(
  async () => {}
)
const embeddingIndexStatus: EmbeddingIndexStatus = {
  job: null
}
const embeddingSnapshot: EmbeddingSettingsSnapshot = {
  configuration: {
    provider: 'openai-compatible',
    model: 'nomic-embed-text',
    endpoint: 'http://127.0.0.1:11434/v1/embeddings',
    credentialConfigured: false
  },
  indexStatus: embeddingIndexStatus
}
const getEmbeddingSnapshot = vi.fn(async () => embeddingSnapshot)
const diagnoseEmbedding = vi.fn(
  async (): Promise<EmbeddingDiagnosticResult> => ({
    status: 'available',
    provider: 'openai-compatible',
    model: 'nomic-embed-text',
    dimensions: 768,
    latencyMs: 128,
    checkedAt: Date.UTC(2026, 7, 5, 12, 0, 0)
  })
)
const rebuildEmbeddingIndex = vi.fn(
  async (): Promise<EmbeddingIndexStatus> => ({
    ...embeddingIndexStatus,
    job: {
      id: 'job-1',
      status: 'running',
      provider: 'openai-compatible',
      model: 'nomic-embed-text',
      progress: { completed: 3, total: 42, percent: (3 / 42) * 100 },
      createdAt: Date.UTC(2026, 7, 5, 12, 0, 0),
      startedAt: Date.UTC(2026, 7, 5, 12, 0, 1)
    }
  })
)
const cancelEmbeddingIndex = vi.fn(async () => true)
const embeddingStatusListeners: ((status: EmbeddingIndexStatus) => void)[] = []
const onEmbeddingStatus = vi.fn(
  (listener: (status: EmbeddingIndexStatus) => void) => {
    embeddingStatusListeners.push(listener)
    return () => {
      const index = embeddingStatusListeners.indexOf(listener)
      if (index >= 0) {
        embeddingStatusListeners.splice(index, 1)
      }
    }
  }
)

describe('SettingsPanel runtime files', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    embeddingStatusListeners.splice(0)
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        settings: {
          getRuntime,
          updateRuntime,
          selectWorkspace: vi.fn(async () => undefined),
          detectAgentRuntimes,
          selectRuntimeFile,
          openRuntimeConfig,
          testModelConnection,
          testRuntime
        },
        capabilities: {
          getSnapshot: getCapabilitySnapshot,
          importSkill: vi.fn(async () => capabilitySnapshot),
          removeSkill: vi.fn(async () => capabilitySnapshot),
          setSkillEnabled,
          setSkillAssignments: vi.fn(async () => capabilitySnapshot),
          saveMcpServer,
          removeMcpServer: vi.fn(async () => capabilitySnapshot),
          testMcpServer: vi.fn(async () => ({
            toolCount: 0,
            tools: []
          })),
          setComputerCapabilityEnabled,
          setComputerCapabilityBrowserProfile: vi.fn(
            async () => capabilitySnapshot
          ),
          diagnoseComputerCapability,
          createBrowserProfile,
          renameBrowserProfile,
          setDefaultBrowserProfile,
          removeBrowserProfile
        },
        experts: {
          list: listExperts,
          create: createExpert,
          update: updateExpert,
          remove: removeExpert
        },
        embeddings: {
          getSnapshot: getEmbeddingSnapshot,
          diagnose: diagnoseEmbedding,
          rebuild: rebuildEmbeddingIndex,
          cancel: cancelEmbeddingIndex,
          onStatus: onEmbeddingStatus
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

  it('supports keyboard navigation between settings tabs', () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    const runtimeTab = screen.getByRole('tab', {
      name: 'Agent Runtime'
    })
    expect(runtimeTab).toHaveAttribute('tabindex', '0')
    runtimeTab.focus()
    fireEvent.keyDown(runtimeTab, { key: 'ArrowRight' })

    const securityTab = screen.getByRole('tab', {
      name: '安全与数据'
    })
    expect(securityTab).toHaveFocus()
    expect(securityTab).toHaveAttribute('aria-selected', 'true')
    expect(securityTab).toHaveAttribute('tabindex', '0')
    expect(runtimeTab).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(securityTab, { key: 'End' })
    const aboutTab = screen.getByRole('tab', { name: '关于与更新' })
    expect(aboutTab).toHaveFocus()
    expect(aboutTab).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('tabpanel')
    ).toHaveAttribute('aria-labelledby', 'settings-tab-about')

    fireEvent.keyDown(aboutTab, { key: 'Home' })
    expect(
      screen.getByRole('tab', { name: '外观' })
    ).toHaveFocus()
  })

  it('explains automatic Execute authorization and the deny-all policy', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '安全与数据' }))
    const policy = await screen.findByLabelText(
      '直连模型工具安全策略'
    )
    expect(
      within(policy).getByRole('option', {
        name: 'Execute 自动授权已启用的工具'
      })
    ).toBeInTheDocument()
    expect(
      within(policy).getByRole('option', {
        name: '禁止所有工具执行'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/选择 Execute 即授权当前交互运行自动调用这些工具/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/禁止策略会拒绝所有工具调用/)
    ).toBeInTheDocument()

    fireEvent.change(policy, { target: { value: 'policy' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ toolApproval: 'policy' })
      )
    )
  })

  it('saves the accessible Subagent smart routing switch', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '安全与数据' }))
    expect(
      screen.queryByRole('checkbox', {
        name: '启用 Subagent 智能路由'
      })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '角色与提示词' }))
    const smartRouting = await screen.findByRole('checkbox', {
      name: '启用 Subagent 智能路由'
    })
    expect(smartRouting).not.toBeChecked()
    expect(screen.getByText(/仅在 Ask 或 Plan 模式/)).toHaveTextContent(
      '自动选择 1 位专家'
    )
    expect(screen.getByText(/仅在 Ask 或 Plan 模式/)).toHaveTextContent(
      '只读运行且不使用工具'
    )

    fireEvent.click(smartRouting)
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          subagentSmartRoutingEnabled: true
        })
      )
    )
  })

  it('offers roles only model connections that have been saved', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: '添加自定义' }))
    fireEvent.change(screen.getByLabelText('名称'), {
      target: { value: '尚未保存的角色模型' }
    })

    fireEvent.click(screen.getByRole('tab', { name: '角色与提示词' }))
    const roleModel = await screen.findByLabelText('角色模型连接')
    expect(
      within(roleModel).queryByRole('option', {
        name: '尚未保存的角色模型'
      })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(
        within(roleModel).getByRole('option', {
          name: '尚未保存的角色模型'
        })
      ).toBeInTheDocument()
    )
  })

  it('shows and saves the global intranet compatibility mode', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '安全与数据' }))
    const intranetCompatibility = await screen.findByRole('checkbox', {
      name: '内网兼容模式'
    })
    expect(intranetCompatibility).toBeChecked()
    const warning = screen.getByText(/HTTP 传输未加密/)
    expect(warning).toHaveTextContent(
      '无效、自签名或已过期的 HTTPS 证书'
    )
    expect(warning).toHaveTextContent('整个应用')
    expect(warning).toHaveTextContent(
      '关闭后恢复严格的地址与证书校验'
    )

    fireEvent.click(intranetCompatibility)
    expect(intranetCompatibility).not.toBeChecked()
    expect(warning).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          intranetCompatibilityEnabled: false
        })
      )
    )
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
        '已就绪 · C:\\Tools\\opencode.exe · 1.2.3 · 通过 PATH 检测'
      )
    ).toBeInTheDocument()
    await screen.findByText(/OpenCode 和 Continue 已随 GoodBuddy 内置/)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(
      screen.getByText('尚未就绪 · 未检测到 Continue')
    ).toBeInTheDocument()

    expect(
      screen.queryByRole('button', { name: '重新检测 Continue' })
    ).not.toBeVisible()
    fireEvent.click(screen.getByText('高级设置'))
    fireEvent.click(
      screen.getByRole('button', { name: '重新检测 Continue' })
    )
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

    await screen.findByText(/OpenCode 和 Continue 已随 GoodBuddy 内置/)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByText('高级设置'))
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
      screen.getByText(/Ask 仅可调用当前授权的知识库搜索/)
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

  it('separates bundled Agent Runtimes and collapses low-level overrides', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    expect(
      await screen.findByText(
        /OpenCode 和 Continue 已随 GoodBuddy 内置/
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(/配置可兼容的直连文本模型后即可使用/)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'OpenCode' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('默认 Runtime')).not.toBeInTheDocument()
    expect(
      screen.getByText(/GoodBuddy 内置 OpenCode/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/模型配置：/).closest('.runtime-note')
    ).toHaveTextContent(
      '跟随 GoodBuddy · 默认模型（sonnet-5）'
    )
    expect(
      screen.getByText(/^已就绪 ·/u)
    ).toBeInTheDocument()
    expect(screen.getByText('高级设置').closest('details'))
      .not.toHaveAttribute('open')
    expect(
      screen.queryByLabelText('OpenCode GoodBuddy 模型连接')
    ).not.toBeVisible()

    fireEvent.click(screen.getByText('高级设置'))
    expect(
      screen.getByLabelText('OpenCode 可执行文件路径')
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText('OpenCode GoodBuddy 模型连接')
    ).toHaveValue(modelProfileId)
    expect(
      screen.getByText(/留空时自动启动 GoodBuddy 内置的本机 OpenCode/)
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', {
        name: /自动启动内置 OpenCode/
      })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(
      screen.getByText(/GoodBuddy 内置 Continue/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/模型配置：/).closest('.runtime-note')
    ).toHaveTextContent(
      '跟随 GoodBuddy · 默认模型（sonnet-5）'
    )
    expect(screen.getByText('尚未就绪 · 未检测到 Continue'))
      .toBeInTheDocument()
    expect(screen.getByText('高级设置').closest('details'))
      .not.toHaveAttribute('open')
  })

  it('opens only saved Runtime-owned config files or fixed config directories', async () => {
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      continueModelSource: { kind: 'platform' },
      continueConfigPath: 'C:\\Users\\test\\.continue\\config.yaml'
    })
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    await screen.findByText(/OpenCode 和 Continue 已随 GoodBuddy 内置/)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByText('高级设置'))
    expect(
      screen.getByRole('radio', {
        name: /使用 Continue 自有配置/
      })
    ).toBeChecked()
    expect(
      screen.getByLabelText('Continue 配置文件路径')
    ).toHaveValue('C:\\Users\\test\\.continue\\config.yaml')

    fireEvent.click(
      screen.getByRole('button', { name: '打开配置文件' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: '在文件夹中显示' })
    )
    await waitFor(() =>
      expect(openRuntimeConfig).toHaveBeenNthCalledWith(1, {
        runtime: 'continue',
        action: 'open-file'
      })
    )
    expect(openRuntimeConfig).toHaveBeenNthCalledWith(2, {
      runtime: 'continue',
      action: 'show-file'
    })

    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }))
    fireEvent.click(screen.getByText('高级设置'))
    fireEvent.click(
      screen.getByRole('radio', {
        name: /使用 OpenCode 自有配置/
      })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: '打开 OpenCode 配置目录'
      })
    )
    await waitFor(() =>
      expect(openRuntimeConfig).toHaveBeenLastCalledWith({
        runtime: 'opencode',
        action: 'open-directory'
      })
    )
  })

  it('saves blank OpenCode Server addresses as bundled local mode', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    await screen.findByText(/OpenCode 和 Continue 已随 GoodBuddy 内置/)
    fireEvent.click(screen.getByText('高级设置'))
    expect(screen.getByLabelText('OpenCode Server 地址')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          opencodeBaseUrl: '',
          opencodeEmbedded: true
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
    expect(
      screen.getByLabelText('模型连接列表')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: '编辑模型连接 默认模型'
      })
    ).toHaveAttribute('aria-current', 'page')
    fireEvent.click(
      screen.getByRole('button', { name: '添加自定义' })
    )
    expect(screen.getAllByLabelText('名称')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('名称'), {
      target: { value: 'OpenCode 独立模型' }
    })
    expect(
      screen.getByRole('button', {
        name: '编辑模型连接 OpenCode 独立模型'
      })
    ).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('radio', { name: '默认连接' }))
    fireEvent.click(
      screen.getByRole('button', {
        name: '编辑模型连接 默认模型'
      })
    )
    expect(screen.getByLabelText('名称')).toHaveValue('默认模型')
    fireEvent.click(
      screen.getByRole('button', {
        name: '编辑模型连接 OpenCode 独立模型'
      })
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Agent Runtime' }))
    fireEvent.click(screen.getByText('高级设置'))
    const profileOption = (
      await screen.findAllByRole('option', {
        name: 'OpenCode 独立模型'
      })
    )[0]!
    const sourceSelect = profileOption.closest('select')
    if (!sourceSelect) {
      throw new Error('Missing OpenCode model source select')
    }
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

  it('assigns an OpenAI Responses connection to both Agent Runtimes', async () => {
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
    fireEvent.change(
      screen.getByLabelText('接口协议 默认模型'),
      {
        target: { value: 'openai-responses' }
      }
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Agent Runtime' }))
    for (const runtimeName of ['OpenCode', 'Continue']) {
      fireEvent.click(screen.getByRole('button', { name: runtimeName }))
      fireEvent.click(screen.getByText('高级设置'))
      const option = await screen.findByRole('option', {
        name: '默认模型'
      })
      expect(option).not.toBeDisabled()
      const select = option.closest('select')
      if (!select) {
        throw new Error('Missing Agent Runtime model source select')
      }
      fireEvent.change(select, {
        target: { value: modelProfileId }
      })
    }
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProfiles: [
            expect.objectContaining({
              id: modelProfileId,
              protocol: 'openai-responses'
            })
          ],
          opencodeModelSource: {
            kind: 'profile',
            profileId: modelProfileId
          },
          continueModelSource: {
            kind: 'profile',
            profileId: modelProfileId
          }
        })
      )
    )
  })

  it('keeps saved Runtime sources valid when defaulting a new text profile', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: '添加自定义' }))
    fireEvent.change(screen.getByLabelText('名称'), {
      target: { value: '新的默认文本模型' }
    })
    fireEvent.click(screen.getByRole('radio', { name: '默认连接' }))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() => expect(updateRuntime).toHaveBeenCalled())
    const savedInput = updateRuntime.mock.lastCall?.[0]
    const nextDefault = savedInput?.modelProfiles?.find(
      (profile) => profile.name === '新的默认文本模型'
    )
    expect(nextDefault).toBeDefined()
    expect(savedInput).toEqual(
      expect.objectContaining({
        defaultModelProfileId: nextDefault?.id,
        opencodeModelSource: {
          kind: 'profile',
          profileId: nextDefault?.id
        },
        continueModelSource: {
          kind: 'profile',
          profileId: nextDefault?.id
        }
      })
    )
  })

  it('preserves explicit profile and platform overrides when defaulting', async () => {
    const explicitProfileId = '00000000-0000-4000-8000-000000000002'
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      modelProfiles: [
        runtimeSettings.modelProfiles[0]!,
        {
          ...runtimeSettings.modelProfiles[0]!,
          id: explicitProfileId,
          name: 'Runtime 专用模型',
          modelName: 'runtime-model'
        }
      ],
      opencodeModelSource: {
        kind: 'profile',
        profileId: explicitProfileId
      },
      continueModelSource: { kind: 'platform' }
    })
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
    fireEvent.click(screen.getByRole('button', { name: '添加自定义' }))
    fireEvent.click(screen.getByRole('radio', { name: '默认连接' }))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          opencodeModelSource: {
            kind: 'profile',
            profileId: explicitProfileId
          },
          continueModelSource: { kind: 'platform' }
        })
      )
    )
  })

  it('repoints a removed Runtime profile to a compatible text profile', async () => {
    const removedProfileId = '00000000-0000-4000-8000-000000000003'
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      modelProfiles: [
        runtimeSettings.modelProfiles[0]!,
        {
          ...runtimeSettings.modelProfiles[0]!,
          id: removedProfileId,
          name: '待删除 Runtime 模型',
          modelName: 'runtime-model'
        }
      ],
      opencodeModelSource: {
        kind: 'profile',
        profileId: removedProfileId
      }
    })
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
      screen.getByRole('button', {
        name: '编辑模型连接 待删除 Runtime 模型'
      })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: '删除模型连接 待删除 Runtime 模型'
      })
    )
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          opencodeModelSource: {
            kind: 'profile',
            profileId: modelProfileId
          }
        })
      )
    )
  })

  it('tests the selected model instead of a selected Continue Runtime', async () => {
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      provider: 'continue',
      modelAuthentication: 'none',
      modelProfiles: [
        {
          ...runtimeSettings.modelProfiles[0]!,
          authentication: 'none',
          apiKeyConfigured: false,
          credentialSource: 'none'
        }
      ]
    })
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
      screen.getByRole('button', { name: '保存并测试模型' })
    )

    await waitFor(() =>
      expect(testModelConnection).toHaveBeenCalledWith(modelProfileId)
    )
    expect(testRuntime).not.toHaveBeenCalled()
    expect(await screen.findByText('连接成功：sonnet-5')).toBeInTheDocument()
  })

  it('shows an actionable model error without Electron IPC prefixes', async () => {
    testModelConnection.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'settings:runtime:test-model': Error: 模型连接“默认模型”未配置 API Key"
      )
    )
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
      screen.getByRole('button', { name: '保存并测试模型' })
    )

    expect(
      await screen.findByText('模型连接“默认模型”未配置 API Key')
    ).toBeInTheDocument()
    expect(screen.queryByText(/Error invoking remote method/u))
      .not.toBeInTheDocument()
  })

  it('shows the first settings validation issue without IPC wrappers', async () => {
    updateRuntime.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'settings:runtime:update': [ { \"code\": \"custom\", \"path\": [ \"modelProfiles\", 0, \"baseUrl\" ], \"message\": \"模型服务地址必须使用 HTTPS\" } ]"
      )
    )
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    await screen.findByDisplayValue('C:\\Workspace')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    expect(
      await screen.findByText('模型服务地址必须使用 HTTPS')
    ).toBeInTheDocument()
    expect(screen.queryByText(/Error invoking remote method/u))
      .not.toBeInTheDocument()
  })

  it('tests the active Runtime with its saved model source', async () => {
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      opencodeModelSource: {
        kind: 'profile',
        profileId: modelProfileId
      },
      continueModelSource: { kind: 'platform' }
    })
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: '保存并测试 OpenCode'
      })
    )

    await waitFor(() =>
      expect(testRuntime).toHaveBeenCalledWith({
        provider: 'opencode',
        profileId: modelProfileId
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(
      screen.getByRole('button', {
        name: '保存并测试 Continue'
      })
    )
    await waitFor(() =>
      expect(testRuntime).toHaveBeenLastCalledWith({
        provider: 'continue'
      })
    )
    expect(testModelConnection).not.toHaveBeenCalled()
  })

  it('moves the detail selection after deleting a model connection', async () => {
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
    fireEvent.change(screen.getByLabelText('名称'), {
      target: { value: '备用模型' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '添加自定义' })
    )
    expect(screen.getByLabelText('名称')).toHaveValue('模型连接 3')

    fireEvent.click(
      screen.getByRole('button', {
        name: '删除模型连接 模型连接 3'
      })
    )

    expect(screen.getByLabelText('名称')).toHaveValue('备用模型')
    expect(
      screen.queryByRole('button', {
        name: '编辑模型连接 模型连接 3'
      })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: '编辑模型连接 备用模型'
      })
    ).toHaveAttribute('aria-current', 'page')
  })

  it('uses only custom model connections and supports image generation', async () => {
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
    expect(screen.queryByLabelText('模型预设')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '从预设添加' })
    ).not.toBeInTheDocument()

    expect(
      screen.queryByRole('checkbox', {
        name: '支持图片输出 默认模型'
      })
    ).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('接口协议 默认模型'), {
      target: { value: 'openai-images-generations' }
    })
    const qualitySelect = screen.getByLabelText('图片质量 默认模型')
    expect(qualitySelect).toHaveValue('auto')
    fireEvent.change(qualitySelect, {
      target: { value: 'high' }
    })
    expect(
      screen.getByText('图像生成', {
        selector: '.model-capability-badge'
      })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProfiles: [
            expect.objectContaining({
              protocol: 'openai-images-generations',
              imageGenerationQuality: 'high'
            })
          ],
          imageGenerationQuality: 'high'
        })
      )
    )
    expect(updateRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        opencodeModelSource: { kind: 'platform' },
        continueModelSource: { kind: 'platform' }
      })
    )
  })

  it('configures vector models under model connections instead of security', async () => {
    getEmbeddingSnapshot
      .mockResolvedValueOnce(embeddingSnapshot)
      .mockResolvedValue({
        ...embeddingSnapshot,
        configuration: {
          provider: 'openai-compatible',
          model: 'bge-m3',
          endpoint: 'https://vectors.example/v1/embeddings',
          credentialConfigured: true
        }
      })
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '安全与数据' }))
    expect(
      screen.queryByRole('checkbox', { name: '启用向量模型' })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '模型连接' }))
    await screen.findByDisplayValue('默认模型')
    fireEvent.click(screen.getByRole('button', { name: '向量模型' }))
    expect(
      screen.getByText('向量模型连接', { selector: 'strong' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '保存并测试模型' })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('checkbox', { name: '启用向量模型' })
    )
    fireEvent.change(screen.getByLabelText('向量接口 URL'), {
      target: { value: 'https://vectors.example/v1/embeddings' }
    })
    fireEvent.change(screen.getByLabelText('模型名称'), {
      target: { value: 'bge-m3' }
    })
    fireEvent.change(screen.getByLabelText('API Key（可选）'), {
      target: { value: 'vector-secret' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeEmbeddingEnabled: true,
          knowledgeEmbeddingBaseUrl:
            'https://vectors.example/v1/embeddings',
          knowledgeEmbeddingModel: 'bge-m3',
          knowledgeEmbeddingApiKey: {
            action: 'replace',
            value: 'vector-secret'
          }
        })
      )
    )
    const section = screen.getByRole('region', { name: '向量模型' })
    await waitFor(() => {
      expect(
        within(section).getByText('bge-m3', { selector: 'strong' })
      ).toBeInTheDocument()
      expect(
        within(section).getByText(
          /https:\/\/vectors\.example\/v1\/embeddings/u
        )
      ).toBeInTheDocument()
      expect(within(section).getByText('已配置凭据'))
        .toBeInTheDocument()
    })
  })

  it('tests vector generation and rebuilds the index by document', async () => {
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
    await waitFor(() => expect(getEmbeddingSnapshot).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '向量模型' }))

    const section = screen.getByRole('region', { name: '向量模型' })
    expect(
      within(section).getByRole('button', { name: '测试向量模型' })
    ).toBeDisabled()

    fireEvent.click(
      screen.getByRole('checkbox', { name: '启用向量模型' })
    )
    fireEvent.click(
      within(section).getByRole('button', { name: '测试向量模型' })
    )
    await waitFor(() => expect(diagnoseEmbedding).toHaveBeenCalledTimes(1))
    expect(
      await within(section).findByText(/服务返回 768 维向量/u)
    ).toBeInTheDocument()

    fireEvent.click(
      within(section).getByRole('button', { name: '重建向量索引' })
    )
    await waitFor(() =>
      expect(rebuildEmbeddingIndex).toHaveBeenCalledTimes(1)
    )
    expect(
      await within(section).findByText('已完成 3 / 42 篇文档')
    ).toBeInTheDocument()
    expect(
      within(section).getByText(
        /每篇文档会一次性更新，处理完成后立即可用于检索/
      )
    ).toBeInTheDocument()

    fireEvent.click(
      within(section).getByRole('button', { name: '取消向量索引重建' })
    )
    await waitFor(() =>
      expect(cancelEmbeddingIndex).toHaveBeenCalledWith('job-1')
    )

    expect(embeddingStatusListeners).toHaveLength(1)
    act(() => {
      embeddingStatusListeners[0]?.({
        job: {
          id: 'job-1',
          status: 'cancelled',
          provider: 'openai-compatible',
          model: 'nomic-embed-text',
          progress: { completed: 3, total: 42, percent: (3 / 42) * 100 },
          createdAt: Date.UTC(2026, 7, 5, 12, 0, 0),
          startedAt: Date.UTC(2026, 7, 5, 12, 0, 1),
          completedAt: Date.UTC(2026, 7, 5, 12, 0, 9)
        }
      })
    })
    expect(
      within(section).getByText('已完成 3 / 42 篇文档。')
    ).toBeInTheDocument()
    expect(
      within(section).getByText(
        /已完成文档保留新向量；其余文档保留原有向量/
      )
    ).toBeInTheDocument()
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
    expect(await screen.findByText('电脑控制能力')).toBeInTheDocument()
    expect(screen.getAllByText('托管浏览器配置').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('启用 Linux 桌面控制')).toBeDisabled()
    fireEvent.click(screen.getByLabelText('启用 浏览器控制'))
    await waitFor(() =>
      expect(setComputerCapabilityEnabled).toHaveBeenCalledWith(
        'host-browser-control',
        true
      )
    )
    fireEvent.click(screen.getByRole('button', { name: '诊断 浏览器控制' }))
    expect(
      await screen.findByText('诊断结果：部分可用')
    ).toBeInTheDocument()
    expect(diagnoseComputerCapability).toHaveBeenCalledWith(
      'host-browser-control'
    )
    fireEvent.change(screen.getByLabelText('新配置名称'), {
      target: { value: '购物网站' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '创建托管配置' })
    )
    await waitFor(() =>
      expect(createBrowserProfile).toHaveBeenCalledWith({
        name: '购物网站'
      })
    )
    fireEvent.change(screen.getByLabelText('配置名称 工作网站'), {
      target: { value: '工作站点' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '重命名配置 工作网站' })
    )
    await waitFor(() =>
      expect(renameBrowserProfile).toHaveBeenCalledWith({
        profileId: browserProfileId,
        name: '工作站点'
      })
    )
    fireEvent.click(
      screen.getByRole('button', { name: '删除配置 工作网站' })
    )
    await waitFor(() =>
      expect(removeBrowserProfile).toHaveBeenCalledWith(browserProfileId)
    )
    expect(
      await screen.findByText('读取工作区文本')
    ).toBeInTheDocument()
    expect(screen.getByText('列出工作区目录')).toBeInTheDocument()
    expect(screen.getByText('写入工作区文本')).toBeInTheDocument()
    expect(screen.getByText('知识库 MCP')).toBeInTheDocument()
    expect(screen.getByText('knowledge_search')).toBeInTheDocument()
    expect(screen.getAllByText('内置 MCP')).toHaveLength(
      builtinMcpServers.length
    )
    expect(
      screen.getByText(/不公开服务地址或凭据/)
    ).toBeInTheDocument()
    expect(screen.getAllByText('直连模型')).toHaveLength(
      builtinModelTools.length
    )
    expect(
      await screen.findByText('尚未配置 MCP Server')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /添加 Server/ })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/自定义 stdio MCP 会以受限环境启动/)
    ).toHaveTextContent('不会获得桌面会话变量')
    const addServer = screen.getByRole('button', { name: /添加 Server/ })
    fireEvent.click(addServer)
    const dialog = screen.getByRole('dialog', {
      name: '添加 MCP Server'
    })
    expect(within(dialog).getByLabelText('模型')).toBeChecked()
    expect(
      within(dialog).queryByLabelText('OpenCode')
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(within(dialog).getByLabelText('名称')).toHaveFocus()
    )
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(addServer).toHaveFocus())
    expect(
      screen.queryByRole('dialog', { name: '添加 MCP Server' })
    ).not.toBeInTheDocument()
  })

  it('traps MCP editor focus and restores it after saving or backdrop dismissal', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'MCP' }))
    const addServer = await screen.findByRole('button', {
      name: '添加 Server'
    })
    fireEvent.click(addServer)
    const dialog = screen.getByRole('dialog', {
      name: '添加 MCP Server'
    })
    const closeButton = within(dialog).getByRole('button', {
      name: '关闭 MCP 编辑器'
    })
    const saveButton = within(dialog).getByRole('button', {
      name: '保存 MCP Server'
    })
    closeButton.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(saveButton).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(closeButton).toHaveFocus()

    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: '本地文件工具' }
    })
    fireEvent.change(within(dialog).getByLabelText('传输方式'), {
      target: { value: 'http' }
    })
    fireEvent.change(within(dialog).getByLabelText('Server URL'), {
      target: { value: 'https://mcp.example.com/mcp' }
    })
    fireEvent.change(within(dialog).getByLabelText('Bearer Token'), {
      target: { value: ' token-with-significant-spaces ' }
    })
    fireEvent.click(saveButton)
    await waitFor(() =>
      expect(saveMcpServer).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          name: '本地文件工具',
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          secret: {
            action: 'replace',
            value: ' token-with-significant-spaces '
          }
        })
      )
    )
    await waitFor(() => expect(addServer).toHaveFocus())
    expect(
      screen.queryByRole('dialog', { name: '添加 MCP Server' })
    ).not.toBeInTheDocument()

    fireEvent.click(addServer)
    const reopenedDialog = screen.getByRole('dialog', {
      name: '添加 MCP Server'
    })
    const backdrop = reopenedDialog.parentElement
    if (!backdrop) {
      throw new Error('Missing MCP editor backdrop')
    }
    fireEvent.mouseDown(backdrop)
    await waitFor(() => expect(addServer).toHaveFocus())
    expect(
      screen.queryByRole('dialog', { name: '添加 MCP Server' })
    ).not.toBeInTheDocument()
  })

  it('opens an existing MCP Server in the same modal and returns focus on Escape', async () => {
    getCapabilitySnapshot.mockResolvedValueOnce({
      ...capabilitySnapshot,
      mcpServers: [
        {
          id: '00000000-0000-4000-8000-000000000301',
          name: '团队知识服务',
          description: '公司内部 MCP',
          enabled: true,
          assignments: ['model'],
          secretConfigured: true,
          transport: 'http',
          url: 'https://mcp.example.com/mcp'
        }
      ]
    })
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'MCP' }))
    const editButton = await screen.findByRole('button', {
      name: '编辑 团队知识服务'
    })
    fireEvent.click(editButton)
    const dialog = screen.getByRole('dialog', {
      name: '编辑 MCP Server'
    })
    expect(within(dialog).getByLabelText('名称')).toHaveValue(
      '团队知识服务'
    )
    expect(within(dialog).getByLabelText('Bearer Token')).toHaveValue('')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(editButton).toHaveFocus())
    expect(
      screen.queryByRole('dialog', { name: '编辑 MCP Server' })
    ).not.toBeInTheDocument()
  })

  it('creates, updates, and removes roles with system prompts', async () => {
    const onExpertsChanged = vi.fn()
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        onExpertsChanged={onExpertsChanged}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(
      screen.getByRole('tab', { name: '角色与提示词' })
    )
    await screen.findByRole('button', {
      name: '编辑角色 研究分析专家'
    })
    fireEvent.change(screen.getByLabelText('系统提示词'), {
      target: { value: 'Use evidence and state uncertainty.' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }))
    await waitFor(() =>
      expect(updateExpert).toHaveBeenCalledWith(
        assistantExpert.id,
        expect.objectContaining({
          systemInstructions: 'Use evidence and state uncertainty.'
        })
      )
    )

    fireEvent.change(screen.getByLabelText('路由关键词'), {
      target: { value: 'x' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }))
    expect(
      await screen.findByText('关键词“x”需为 2 至 48 个字符。')
    ).toBeInTheDocument()
    expect(updateExpert).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByLabelText('路由关键词'), {
      target: {
        value: ' TypeScript，代码 审查\nTYPESCRIPT '
      }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }))
    await waitFor(() =>
      expect(updateExpert).toHaveBeenLastCalledWith(
        assistantExpert.id,
        expect.objectContaining({
          routingKeywords: ['typescript', '代码 审查']
        })
      )
    )

    fireEvent.click(screen.getByRole('button', { name: '新建角色' }))
    fireEvent.change(screen.getByLabelText('角色名称'), {
      target: { value: '代码审查专家' }
    })
    fireEvent.change(screen.getByLabelText('角色说明'), {
      target: { value: '检查代码正确性' }
    })
    fireEvent.change(screen.getByLabelText('系统提示词'), {
      target: { value: 'Review code and report actionable bugs.' }
    })
    fireEvent.click(screen.getByRole('button', { name: '创建角色' }))
    await waitFor(() =>
      expect(createExpert).toHaveBeenCalledWith({
        name: '代码审查专家',
        description: '检查代码正确性',
        systemInstructions: 'Review code and report actionable bugs.',
        routingKeywords: []
      })
    )
    expect(onExpertsChanged).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: '代码审查专家' })
      ])
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: '删除角色 代码审查专家'
      })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: '确认删除角色 代码审查专家'
      })
    )
    await waitFor(() =>
      expect(removeExpert).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000102'
      )
    )
  })
})
