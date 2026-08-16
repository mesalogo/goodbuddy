import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantExpert } from '../../shared/assistant-contracts'
import type {
  DesktopApi,
  RuntimeSettings
} from '../../shared/contracts'
import type { CapabilitySnapshot } from '../../shared/capability-contracts'
import type { ApplicationSettings } from '../../shared/application-settings-contracts'
import type {
  EmbeddingDiagnosticResult,
  EmbeddingSettingsSnapshot
} from '../../shared/embedding-contracts'
import type { SpeechModelSnapshot } from '../../shared/speech-model-contracts'
import { builtinMcpServers } from '../../shared/builtin-mcp-servers'
import { builtinModelToolGroups } from '../../shared/builtin-model-tools'
import { SettingsPanel } from './SettingsPanel'
import { changeUiLocale } from './i18n'
import { UiLocaleProvider } from './i18n/UiLocaleProvider'

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
  subagentSmartRoutingEnabled: false,
  knowledgeEmbeddingEnabled: false,
  knowledgeEmbeddingBaseUrl:
    'http://127.0.0.1:11434/v1/embeddings',
  knowledgeEmbeddingModel: 'nomic-embed-text',
  knowledgeEmbeddingApiKeyConfigured: false,
  knowledgeEmbeddingCredentialSource: 'none',
  knowledgeRerankEnabled: false,
  knowledgeRerankEndpoint: 'https://api.cohere.com/v1/rerank',
  knowledgeRerankModel: 'rerank-v3.5',
  knowledgeRerankApiKeyConfigured: false,
  knowledgeRerankCredentialSource: 'none',
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
  deepseekHarnessModelSource: { kind: 'platform' },
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
    source: 'automatic',
    detail: '通过 PATH 检测'
  },
  continue: {
    available: true,
    path: 'bundled://continue',
    version: '1.5.47',
    source: 'bundled',
    detail: '内置 Continue CLI 1.5.47 已就绪'
  },
  deepseekHarness: {
    available: true,
    path: 'bundled://deepseek-harness',
    version: '0.1.0-rc.6',
    source: 'bundled',
    detail: '内置 Harness Adapter 已就绪'
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
      assignments: [
        'model',
        'opencode',
        'continue',
        'deepseek-harness'
      ] as (
        | 'model'
        | 'opencode'
        | 'continue'
        | 'deepseek-harness'
      )[]
    }
  ],
  mcpServers: [] as CapabilitySnapshot['mcpServers'],
  webSearch: {
    provider: 'exa' as const,
    enabled: true,
    availableIn: ['ask', 'execute'] as const,
    tools: ['web_search', 'web_fetch'] as const
  },
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
const importSkill = vi.fn<DesktopApi['capabilities']['importSkill']>(
  async () => capabilitySnapshot
)
const saveMcpServer = vi.fn(async () => capabilitySnapshot)
const setWebSearchEnabled = vi.fn(async (enabled: boolean) => ({
  ...capabilitySnapshot,
  webSearch: {
    ...capabilitySnapshot.webSearch,
    enabled
  }
}))
const testWebSearch = vi.fn(async () => ({
  provider: 'exa' as const,
  query: 'GoodBuddy desktop assistant',
  durationMs: 321,
  preview: 'GoodBuddy search result'
}))
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
  onRunHeartbeat: vi.fn(async () => {}),
  onUpdateProject: vi.fn(async () => {
    throw new Error('Project update is not used in this test')
  }),
  projects: []
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
const embeddingSnapshot: EmbeddingSettingsSnapshot = {
  configuration: {
    provider: 'openai-compatible',
    model: 'nomic-embed-text',
    endpoint: 'http://127.0.0.1:11434/v1/embeddings',
    credentialConfigured: false
  }
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
let applicationSettings: ApplicationSettings = {
  checkUpdatesOnStartup: true,
  magicNotesEnabled: false,
  magicNoteCommentMode: 'immediate',
  magicNoteCommentFormat: 'combined'
}
const getApplicationSettings = vi.fn(async () => ({
  ...applicationSettings
}))
const updateApplicationSettings = vi.fn<
  NonNullable<DesktopApi['updates']>['updateSettings']
>(async (input) => {
  applicationSettings = {
    ...applicationSettings,
    ...input
  }
  return { ...applicationSettings }
})
const speechCatalog: SpeechModelSnapshot['catalog'] = [
  {
    id: 'sensevoice-small-int8',
    displayName: 'SenseVoiceSmall INT8',
    description: 'Fast multilingual local speech recognition.',
    languages: ['中文', '英语'],
    family: 'sensevoice',
    quantization: 'int8',
    quality: 'high',
    speed: 'fast',
    recommended: true,
    repositoryUrl: 'https://example.com/sensevoice',
    license: {
      name: 'Model License',
      notice: 'Review the model license before use.',
      url: 'https://example.com/license'
    },
    manualOnly: false,
    files: []
  },
  {
    id: 'paraformer-bilingual-zh-en-int8',
    displayName: 'Paraformer 中英双语 INT8',
    description: 'Fast local Mandarin and English recognition.',
    languages: ['中文', '英语'],
    family: 'paraformer',
    quantization: 'int8',
    quality: 'high',
    speed: 'fast',
    recommended: true,
    repositoryUrl: 'https://example.com/paraformer',
    license: {
      name: 'MIT License',
      notice: 'Review the model license before use.',
      url: 'https://example.com/license'
    },
    manualOnly: false,
    files: []
  }
]
const createSpeechModelSnapshot = (
  selectedModelId: string | null = 'sensevoice-small-int8'
): SpeechModelSnapshot => ({
  rootDirectory: 'C:\\Users\\test\\models\\speech',
  catalog: speechCatalog,
  installed: speechCatalog.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    source: 'download',
    installedAt: '2026-08-11T00:00:00.000Z',
    files: []
  })),
  operations: [],
  selectedModelId
})
let speechModelSnapshot = createSpeechModelSnapshot()
const getSpeechModelSnapshot = vi.fn(async () => speechModelSnapshot)
const selectSpeechModel = vi.fn<
  NonNullable<DesktopApi['speechModels']>['select']
>(async (modelId) => {
  speechModelSnapshot = createSpeechModelSnapshot(modelId)
  return speechModelSnapshot
})
const runtimeExtensionSnapshot = {
  marketplaceEnabled: true,
  catalog: [],
  installed: []
}
const getRuntimeExtensionSnapshot = vi.fn(
  async () => runtimeExtensionSnapshot
)
const applyRuntimeExtension = vi.fn(
  async () => runtimeExtensionSnapshot
)

describe('SettingsPanel runtime files', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.removeItem('goodbuddy.ui-locale')
    await changeUiLocale('zh-CN')
    applicationSettings = {
      checkUpdatesOnStartup: true,
      magicNotesEnabled: false,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    }
    speechModelSnapshot = createSpeechModelSnapshot()
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
          importSkill,
          removeSkill: vi.fn(async () => capabilitySnapshot),
          setSkillEnabled,
          setSkillAssignments: vi.fn(async () => capabilitySnapshot),
          saveMcpServer,
          removeMcpServer: vi.fn(async () => capabilitySnapshot),
          testMcpServer: vi.fn(async () => ({
            dynamicToolsSupported: false,
            toolCount: 0,
            tools: []
          })),
          setWebSearchEnabled,
          testWebSearch,
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
          diagnose: diagnoseEmbedding
        },
        speechModels: {
          getSnapshot: getSpeechModelSnapshot,
          install: vi.fn(),
          cancel: vi.fn(async () => true),
          remove: vi.fn(),
          select: selectSpeechModel,
          importArchive: vi.fn(),
          exportArchive: vi.fn(),
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        },
        runtimeExtensions: {
          getSnapshot: getRuntimeExtensionSnapshot,
          apply: applyRuntimeExtension
        },
        updates: {
          getSettings: getApplicationSettings,
          updateSettings: updateApplicationSettings,
          check: vi.fn(),
          openReleasePage: vi.fn(),
          onResult: vi.fn(() => () => {})
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
    const themeOptions = screen.getByRole('radiogroup', {
      name: '界面主题'
    })
    expect(
      within(themeOptions).getByRole('radio', { name: /跟随系统/u })
    ).toBeChecked()
    fireEvent.click(
      within(themeOptions).getByRole('radio', { name: /暗色/u })
    )
    expect(onAppearanceThemeChange).toHaveBeenCalledWith('dark')
  })

  it('configures direct model context compression with explicit token budgets', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        initialCategory="context-control"
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: '上下文控制'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByText('直连模型的历史压缩与原文保留')
    ).toBeInTheDocument()
    const enabled = screen.getByRole('switch', {
      name: '自动压缩较早的对话'
    })
    const trigger = screen.getByLabelText('压缩触发阈值')
    const recent = screen.getByLabelText('最近原文预算')
    expect(enabled).not.toBeChecked()
    expect(trigger).toHaveValue(200)
    expect(trigger).toBeDisabled()
    expect(recent).toHaveValue(32)

    fireEvent.click(enabled)
    fireEvent.change(trigger, { target: { value: '240' } })
    fireEvent.change(recent, { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenLastCalledWith(
        expect.objectContaining({
          contextCompression: expect.objectContaining({
            enabled: true,
            triggerTokens: 240_000,
            recentRawTokens: 40_000,
            modelSource: { kind: 'current' }
          })
        })
      )
    )
  })

  it('allows editing context compression budgets through empty and single-digit states', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        initialCategory="context-control"
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(
      await screen.findByRole('switch', {
        name: '自动压缩较早的对话'
      })
    )
    const trigger = screen.getByLabelText('压缩触发阈值')
    const recent = screen.getByLabelText('最近原文预算')

    fireEvent.change(trigger, { target: { value: '' } })
    expect(trigger).toHaveValue(null)
    fireEvent.blur(trigger)
    expect(trigger).toHaveValue(200)
    fireEvent.change(trigger, { target: { value: '8' } })
    expect(trigger).toHaveValue(8)
    expect(recent).toHaveValue(32)
    expect(recent).toHaveAttribute('max', '7')

    fireEvent.change(recent, { target: { value: '4' } })
    expect(recent).toHaveValue(4)
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenLastCalledWith(
        expect.objectContaining({
          contextCompression: expect.objectContaining({
            triggerTokens: 8_000,
            recentRawTokens: 4_000
          })
        })
      )
    )
  })

  it('normalizes context compression limits only after editing finishes', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        initialCategory="context-control"
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(
      await screen.findByRole('switch', {
        name: '自动压缩较早的对话'
      })
    )
    const trigger = screen.getByLabelText('压缩触发阈值')
    const recent = screen.getByLabelText('最近原文预算')

    fireEvent.change(trigger, { target: { value: '2' } })
    expect(trigger).toHaveValue(2)
    expect(recent).toHaveAttribute('max', '7')
    fireEvent.blur(trigger)
    expect(trigger).toHaveValue(8)
    expect(recent).toHaveValue(7)

    fireEvent.change(trigger, { target: { value: '1200' } })
    fireEvent.blur(trigger)
    expect(trigger).toHaveValue(1000)

    fireEvent.change(recent, { target: { value: '999' } })
    fireEvent.blur(recent)
    expect(recent).toHaveValue(256)
  })

  it('stores an optional context window on direct text models', async () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        initialCategory="model"
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    const contextWindow = await screen.findByLabelText(
      '上下文上限（可选）'
    )
    expect(contextWindow).toHaveValue(null)
    expect(contextWindow).toHaveAttribute('min', '32')
    fireEvent.change(contextWindow, { target: { value: '256' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenLastCalledWith(
        expect.objectContaining({
          modelProfiles: expect.arrayContaining([
            expect.objectContaining({
              id: modelProfileId,
              contextWindowTokens: 256_000
            })
          ])
        })
      )
    )
  })

  it('applies and persists an English interface language immediately', async () => {
    render(
      <UiLocaleProvider initialPreference="zh-CN">
        <SettingsPanel
          {...heartbeatSettingsProps}
          open
          onClearLocalData={vi.fn(async () => {})}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          presentation="page"
        />
      </UiLocaleProvider>
    )

    fireEvent.click(screen.getByRole('tab', { name: '外观' }))
    fireEvent.click(
      screen.getByRole('radio', {
        name: /^English/u
      })
    )

    await waitFor(() => {
      expect(localStorage.getItem('goodbuddy.ui-locale')).toBe('en-US')
      expect(document.documentElement.lang).toBe('en-US')
    })
    expect(
      screen.getByRole('heading', { level: 1, name: 'Settings' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Close settings' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tablist', { name: 'Settings categories' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: 'Appearance' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('heading', { level: 2, name: 'Appearance' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radiogroup', { name: 'Interface theme' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: /Use system theme/u })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radiogroup', { name: 'Interface language' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: /Use system language/u })
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('tab', { name: 'Model connections' })
    )
    expect(
      await screen.findByRole('button', {
        name: 'Edit model connection Default model'
      })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Default model')
    fireEvent.click(
      screen.getByRole('button', { name: 'Save settings' })
    )
    await waitFor(() =>
      expect(updateRuntime).toHaveBeenLastCalledWith(
        expect.objectContaining({
          modelProfiles: expect.arrayContaining([
            expect.objectContaining({
              id: modelProfileId,
              name: '默认模型'
            })
          ])
        })
      )
    )

    fireEvent.click(
      screen.getByRole('tab', { name: 'Agent Runtime' })
    )
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Agent Runtime'
      })
    ).toBeInTheDocument()
    expect(screen.getByText('Default workspace')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Default workspace folder')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save settings' })
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/OpenCode and Continue are bundled with GoodBuddy/u)
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Automatically detected OpenCode 1.2.3'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('通过 PATH 检测')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(
      screen.getByText('Bundled Continue 1.5.47 is ready')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('内置 Continue CLI 1.5.47 已就绪')
    ).not.toBeInTheDocument()
  })

  it('does not translate user-defined model connection names', async () => {
    const userProfileId = '00000000-0000-4000-8000-000000000099'
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      modelProfiles: [
        {
          ...runtimeSettings.modelProfiles[0]!,
          name: 'My renamed model'
        },
        {
          ...runtimeSettings.modelProfiles[0]!,
          id: userProfileId,
          name: '默认模型'
        }
      ]
    })
    await changeUiLocale('en-US')
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
      screen.getByRole('tab', { name: 'Model connections' })
    )
    expect(
      await screen.findByRole('button', {
        name: 'Edit model connection My renamed model'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Edit model connection 默认模型'
      })
    ).toBeInTheDocument()
  })

  it('localizes structured Runtime recovery warnings', async () => {
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      warnings: [{ code: 'runtime-settings-recovered' }]
    })
    await changeUiLocale('en-US')
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
      await screen.findByText(/The Runtime settings file was corrupt/u)
    ).toBeInTheDocument()
  })

  it('toggles the Magic Notes platform entry setting', async () => {
    const onMagicNotesEnabledChange = vi.fn()
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        onMagicNotesEnabledChange={onMagicNotesEnabledChange}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))
    const toggle = await screen.findByRole('switch', {
      name: '显示魔法笔记入口'
    })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(/默认关闭/)).toBeInTheDocument()
    fireEvent.click(toggle)

    await waitFor(() =>
      expect(updateApplicationSettings).toHaveBeenCalledWith({
        magicNotesEnabled: true
      })
    )
    expect(onMagicNotesEnabledChange).toHaveBeenCalledWith(true)
    fireEvent.click(
      screen.getByRole('button', { name: '保存后自动' })
    )
    await waitFor(() =>
      expect(updateApplicationSettings).toHaveBeenCalledWith({
        magicNoteCommentMode: 'after-save-auto'
      })
    )

    expect(
      screen.getByRole('button', { name: '长评 + 要点' })
    ).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '要点' }))
    await waitFor(() =>
      expect(updateApplicationSettings).toHaveBeenCalledWith({
        magicNoteCommentFormat: 'structured'
      })
    )
  })

  it('refreshes built-in Notes MCP after enabling Magic Notes', async () => {
    function Harness(): React.JSX.Element {
      const [magicNotesEnabled, setMagicNotesEnabled] = useState(false)
      return (
        <SettingsPanel
          {...heartbeatSettingsProps}
          magicNotesEnabled={magicNotesEnabled}
          onMagicNotesEnabledChange={setMagicNotesEnabled}
          open
          onClearLocalData={vi.fn(async () => {})}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      )
    }

    render(
      <Harness />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'MCP' }))
    const noteServerToggle = await screen.findByRole('button', {
      name: '展开服务器 笔记'
    })
    expect(noteServerToggle.closest('article')).toHaveClass(
      'mcp-server-card--disabled'
    )

    fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))
    fireEvent.click(
      await screen.findByRole('switch', {
        name: '显示魔法笔记入口'
      })
    )
    await waitFor(() =>
      expect(updateApplicationSettings).toHaveBeenCalledWith({
        magicNotesEnabled: true
      })
    )

    fireEvent.click(screen.getByRole('tab', { name: 'MCP' }))
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: '展开服务器 笔记' })
          .closest('article')
      ).not.toHaveClass('mcp-server-card--disabled')
    )
    expect(
      screen.getAllByText('内置 MCP Server · 按模式读写 · 按对话授权')
    ).not.toHaveLength(0)
  })

  it('keeps page navigation beside an independently scrollable panel', () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        presentation="page"
      />
    )

    const navigation = screen.getByRole('tablist', {
      name: '设置分类'
    })
    const content = screen.getByRole('tabpanel')
    expect(navigation.parentElement).toHaveClass('settings-panel__body')
    expect(content.parentElement).toBe(navigation.parentElement)
    expect(content).toHaveClass('settings-panel__content')
  })

  it('omits the redundant close-only footer on passive settings pages', () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        presentation="page"
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))

    expect(
      screen.getByRole('button', { name: '关闭设置' })
    ).toBeInTheDocument()
    expect(
      screen
        .getByRole('region', { name: '设置中心' })
        .querySelector('.settings-panel__footer')
    ).toBeNull()
  })

  it('uses one category header for titles and explicit actions', () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        presentation="page"
      />
    )

    const settings = screen.getByRole('region', {
      name: '设置中心'
    })
    const content = screen.getByRole('tabpanel')
    const categoryHeader = content.querySelector(
      '.settings-category-header'
    )

    expect(categoryHeader).toBe(content.firstElementChild)
    expect(
      within(categoryHeader as HTMLElement).getByRole('heading', {
        level: 2,
        name: 'Agent Runtime'
      })
    ).toBeInTheDocument()
    expect(
      within(categoryHeader as HTMLElement).getByRole('button', {
        name: '保存设置'
      })
    ).toBeInTheDocument()
    expect(
      within(categoryHeader as HTMLElement).getByRole('button', {
        name: '保存并测试 OpenCode'
      })
    ).toBeInTheDocument()
    expect(
      settings.querySelector('.settings-panel__footer')
    ).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: '外观' }))
    expect(
      screen.queryByRole('button', { name: '保存设置' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: '外观' })
    ).toBeInTheDocument()
  })

  it('routes save success through the transient app notification', async () => {
    const onNotify = vi.fn()
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onNotify={onNotify}
        onSaved={vi.fn()}
      />
    )

    await screen.findByDisplayValue('C:\\Workspace')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith({
        tone: 'success',
        message: '设置已保存',
        dedupeKey: 'runtime-settings-saved'
      })
    )
    expect(screen.queryByText('设置已保存')).not.toBeInTheDocument()
  })

  it('submits configured model values while environment values are effective', async () => {
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      modelBaseUrl: 'https://environment.example/v1',
      modelName: 'environment-model',
      apiKeyConfigured: true,
      credentialSource: 'environment',
      modelProfiles: [
        {
          ...runtimeSettings.modelProfiles[0]!,
          baseUrl: 'https://environment.example/v1',
          modelName: 'environment-model',
          apiKeyConfigured: true,
          credentialSource: 'environment'
        }
      ],
      configured: {
        modelProfiles: [
          {
            ...runtimeSettings.modelProfiles[0]!,
            baseUrl: 'https://stored.example/v1',
            modelName: 'stored-model',
            apiKeyConfigured: true,
            credentialSource: 'environment'
          }
        ],
        opencodeBaseUrl: '',
        opencodeBinaryPath: '',
        opencodeConfigPath: '',
        continueBinaryPath: '',
        continueConfigPath: '',
        workspacePath: 'C:\\Workspace',
        opencodeModelSource: runtimeSettings.opencodeModelSource,
        continueModelSource: runtimeSettings.continueModelSource,
        deepseekHarnessModelSource:
          runtimeSettings.deepseekHarnessModelSource
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

    await screen.findByDisplayValue('C:\\Workspace')
    fireEvent.click(screen.getByRole('tab', { name: '模型连接' }))
    expect(
      await screen.findByDisplayValue('https://environment.example/v1')
    ).toBeDisabled()
    expect(screen.getByDisplayValue('environment-model')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          modelBaseUrl: 'https://stored.example/v1',
          modelName: 'stored-model',
          modelProfiles: [
            expect.objectContaining({
              baseUrl: 'https://stored.example/v1',
              modelName: 'stored-model',
              apiKey: { action: 'keep' }
            })
          ]
        })
      )
    )
  })

  it('applies a speech model draft only when Settings is saved', async () => {
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
      screen.getByRole('button', { name: '语音模型' })
    )
    const speechModelSelector = await screen.findByRole('combobox', {
      name: '当前语音模型'
    })

    fireEvent.change(speechModelSelector, {
      target: { value: 'paraformer-bilingual-zh-en-int8' }
    })

    expect(selectSpeechModel).not.toHaveBeenCalled()
    expect(screen.getByText('待保存')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '保存设置' })
    )

    await waitFor(() =>
      expect(selectSpeechModel).toHaveBeenCalledWith(
        'paraformer-bilingual-zh-en-int8'
      )
    )
    expect(screen.queryByText('待保存')).not.toBeInTheDocument()
    expect(screen.getByText('正在使用')).toBeInTheDocument()
    expect(speechModelSelector).toHaveValue(
      'paraformer-bilingual-zh-en-int8'
    )
  })

  it('keeps a speech model draft when saving the selection fails', async () => {
    selectSpeechModel.mockRejectedValueOnce(
      new Error('语音模型切换失败')
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
      screen.getByRole('button', { name: '语音模型' })
    )
    const speechModelSelector = await screen.findByRole('combobox', {
      name: '当前语音模型'
    })
    fireEvent.change(speechModelSelector, {
      target: { value: 'paraformer-bilingual-zh-en-int8' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '保存设置' })
    )

    expect(
      await screen.findByText('语音模型切换失败')
    ).toBeInTheDocument()
    expect(screen.getByText('待保存')).toBeInTheDocument()
    expect(speechModelSelector).toHaveValue(
      'paraformer-bilingual-zh-en-int8'
    )
  })

  it('uses one first-level heading for the settings page', () => {
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        presentation="page"
      />
    )

    expect(
      screen.getAllByRole('heading', { level: 1 })
    ).toHaveLength(1)
    expect(
      screen.getByRole('heading', { level: 1, name: '设置中心' })
    ).toBeInTheDocument()
  })

  it('keeps local progress but does not duplicate clear-data success', async () => {
    let finishClear: (() => void) | undefined
    const onClearLocalData = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve
        })
    )
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={onClearLocalData}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '安全与数据' }))
    fireEvent.click(
      screen.getByRole('button', { name: '清除本地数据' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: '清除本地数据' })
    )

    expect(
      screen.getByRole('button', { name: '正在清除…' })
    ).toBeDisabled()
    await act(async () => finishClear?.())
    await waitFor(() =>
      expect(
        screen.queryByText('本地数据已清除')
      ).not.toBeInTheDocument()
    )
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
      screen.queryByRole('switch', {
        name: '启用 Subagent 智能路由'
      })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '角色与提示词' }))
    const smartRouting = await screen.findByRole('switch', {
      name: '启用 Subagent 智能路由'
    })
    expect(smartRouting).not.toBeChecked()
    expect(screen.getByText(/仅在 Ask 模式/)).toHaveTextContent(
      '自动选择 1 位专家'
    )
    expect(screen.getByText(/仅在 Ask 模式/)).toHaveTextContent(
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


  it('places Runtime detection details in the semantic overview card', async () => {
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
    const runtimeLabel = await screen.findByText('Runtime：', {
      selector: 'dt'
    })
    const overview = runtimeLabel.closest<HTMLElement>(
      '.runtime-overview'
    )
    if (!overview) {
      throw new Error('Missing OpenCode Runtime overview')
    }
    expect(
      within(overview).getByText('GoodBuddy 内置 OpenCode')
    ).toBeInTheDocument()
    expect(
      within(overview).getByText('模型配置：', { selector: 'dt' })
    ).toBeInTheDocument()
    const status = within(overview).getByText('已就绪')
    expect(status.tagName).toBe('DD')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(
      within(overview).getByText('C:\\Tools\\opencode.exe')
    ).toHaveClass('runtime-overview__path')
    expect(within(overview).getByText('1.2.3')).toBeInTheDocument()
    expect(
      within(overview).getByText('已自动检测到 OpenCode 1.2.3')
    ).toBeInTheDocument()
    expect(
      screen.queryByText(
        '已就绪 · C:\\Tools\\opencode.exe · 1.2.3 · 通过 PATH 检测'
      )
    ).not.toBeInTheDocument()
    await screen.findByText('GoodBuddy 内置 OpenCode')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const continueOverview = screen
      .getByText('GoodBuddy 内置 Continue')
      .closest<HTMLElement>('.runtime-overview')
    if (!continueOverview) {
      throw new Error('Missing Continue Runtime overview')
    }
    expect(
      within(continueOverview).getByText('已就绪')
    ).toBeInTheDocument()
    expect(
      within(continueOverview).getByText('1.5.47')
    ).toBeInTheDocument()
    expect(
      within(continueOverview).getByText('bundled://continue')
    ).toHaveClass('runtime-overview__path')

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

  it('configures DeepSeek Harness with an OpenAI-compatible gateway', async () => {
    const harnessProfileId =
      '00000000-0000-4000-8000-000000000051'
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      modelProfiles: [
        runtimeSettings.modelProfiles[0]!,
        {
          ...runtimeSettings.modelProfiles[0]!,
          id: harnessProfileId,
          name: 'Compatible Gateway',
          baseUrl: 'https://gateway.example/openai/v1',
          modelName: 'qwen-plus',
          protocol: 'openai-chat-completions'
        }
      ],
      deepseekHarnessModelSource: {
        kind: 'profile',
        profileId: harnessProfileId
      }
    } as unknown as RuntimeSettings)
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
        name: 'DeepSeek Harness（预览）'
      })
    )
    expect(
      screen.getByText('开发者预览 · OpenAI 兼容')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'DSH 插件市场' })
    ).toBeInTheDocument()
    expect(
      await screen.findByText(
        /第三方插件的安装脚本、初始化代码及工具均以当前用户权限运行/
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('switch', {
        name: '启用 DSH 插件市场'
      })
    ).toBeChecked()
    const harnessOverview = screen
      .getByText('GoodBuddy 内置 DeepSeek Harness')
      .closest<HTMLElement>('.runtime-overview')
    if (!harnessOverview) {
      throw new Error('Missing DeepSeek Harness overview')
    }
    expect(
      within(harnessOverview).getByText('已就绪')
    ).toHaveAttribute('aria-live', 'polite')
    expect(
      within(harnessOverview).getByText(
        'bundled://deepseek-harness'
      )
    ).toHaveClass('runtime-overview__path')
    expect(
      within(harnessOverview).getByText('0.1.0-rc.6')
    ).toBeInTheDocument()
    expect(
      within(harnessOverview).getByText(
        '内置 DeepSeek Harness 0.1.0-rc.6 已就绪'
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/自定义 Harness Host/)
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('高级设置'))
    expect(
      screen.getByText(
        /已启用的市场插件由 GoodBuddy 托管并随 Host 启动/
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /选择.*Harness/
      })
    ).not.toBeInTheDocument()
    const source = screen.getByLabelText(
      'DeepSeek Harness OpenAI 兼容模型连接'
    )
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(
      screen.queryByText('使用管理员预置模型连接')
    ).not.toBeInTheDocument()
    expect(
      within(source).getByRole('option', { name: '默认模型（不兼容）' })
    ).toBeDisabled()
    expect(
      within(source).getByRole('option', {
        name: 'Compatible Gateway'
      })
    ).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          deepseekHarnessModelSource: {
            kind: 'profile',
            profileId: harnessProfileId
          }
        })
      )
    )
  })

  it('keeps an environment-managed source compatible without exposing it as an option', async () => {
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      modelBaseUrl: 'https://gateway.example/openai/v1',
      modelName: 'qwen-plus',
      modelProtocol: 'openai-chat-completions',
      modelProfiles: [
        {
          ...runtimeSettings.modelProfiles[0]!,
          baseUrl: 'https://gateway.example/openai/v1',
          modelName: 'qwen-plus',
          protocol: 'openai-chat-completions',
          credentialSource: 'environment'
        }
      ],
      deepseekHarnessModelSource: { kind: 'platform' },
      configured: {
        modelProfiles: [
          {
            ...runtimeSettings.modelProfiles[0]!,
            baseUrl: 'https://bigtoken.ai',
            modelName: 'sonnet-5',
            protocol: 'openai-chat-completions',
            credentialSource: 'environment'
          }
        ],
        opencodeBaseUrl: '',
        opencodeBinaryPath: '',
        opencodeConfigPath: '',
        continueBinaryPath: '',
        continueConfigPath: '',
        workspacePath: 'C:\\Workspace',
        opencodeModelSource: runtimeSettings.opencodeModelSource,
        continueModelSource: runtimeSettings.continueModelSource,
        deepseekHarnessModelSource: { kind: 'platform' }
      }
    } as unknown as RuntimeSettings)
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
        name: 'DeepSeek Harness（预览）'
      })
    )
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(
      screen.getByText('管理员预置的 OpenAI 兼容连接')
    ).toBeInTheDocument()
    const source = screen.getByLabelText(
      'DeepSeek Harness OpenAI 兼容模型连接'
    )
    expect(source).toHaveValue('')
    fireEvent.change(source, {
      target: { value: runtimeSettings.modelProfiles[0]!.id }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          deepseekHarnessModelSource: { kind: 'platform' }
        })
      )
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

    await screen.findByText('GoodBuddy 内置 OpenCode')
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
      screen.getByText(/Ask 仅可调用知识库与全局笔记读取工具/)
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

    await screen.findByText('GoodBuddy 内置 OpenCode')
    expect(
      screen.queryByText(/配置可兼容的直连文本模型后即可使用/)
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'OpenCode' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('默认 Runtime')).not.toBeInTheDocument()
    expect(
      screen.getAllByText(/GoodBuddy 内置 OpenCode/).length
    ).toBeGreaterThan(0)
    expect(
      screen.getByText(/模型配置：/).closest('.runtime-note')
    ).toHaveTextContent(
      '跟随 GoodBuddy · 默认模型（sonnet-5）'
    )
    expect(screen.getByText('已就绪')).toBeInTheDocument()
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
      screen.getAllByText(/GoodBuddy 内置 Continue/).length
    ).toBeGreaterThan(0)
    expect(
      screen.getByText(/模型配置：/).closest('.runtime-note')
    ).toHaveTextContent(
      '跟随 GoodBuddy · 默认模型（sonnet-5）'
    )
    expect(screen.getByText('已就绪')).toBeInTheDocument()
    expect(screen.getByText('1.5.47')).toBeInTheDocument()
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

    await screen.findByText('GoodBuddy 内置 OpenCode')
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

    await screen.findByText('GoodBuddy 内置 OpenCode')
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
    expect(screen.getByLabelText('模型接口 URL')).toHaveValue('')
    expect(screen.getByLabelText('模型接口 URL')).toHaveAttribute(
      'placeholder',
      'https://api.example.com/v1'
    )
    expect(screen.getByLabelText('模型')).toHaveValue('')
    expect(screen.getByLabelText('模型')).toHaveAttribute(
      'placeholder',
      'model-name'
    )
    expect(
      screen.getByLabelText('接口协议 模型连接 2')
    ).toHaveValue('openai-chat-completions')
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

  it('orders model protocols by the preferred connection flow', async () => {
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
    const protocol = await screen.findByLabelText('接口协议 默认模型')
    expect(
      within(protocol)
        .getAllByRole('option')
        .map((option) => (option as HTMLOptionElement).value)
    ).toEqual([
      'openai-chat-completions',
      'openai-responses',
      'anthropic-messages',
      'openai-images-generations'
    ])
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

  it('saves the image input capability for a model connection', async () => {
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
    const imageInput = await screen.findByRole('switch', {
      name: '支持图像输入'
    })
    expect(imageInput).not.toBeChecked()
    fireEvent.click(imageInput)
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProfiles: [
            expect.objectContaining({
              id: modelProfileId,
              supportsImageInput: true
            })
          ]
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
    const onNotify = vi.fn()
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
        onNotify={onNotify}
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
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith({
        tone: 'success',
        message: '连接成功：sonnet-5',
        dedupeKey: 'model-connection-tested'
      })
    )
    expect(screen.queryByText('连接成功：sonnet-5')).not.toBeInTheDocument()
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
        "Error invoking remote method 'settings:runtime:update': [ { \"code\": \"custom\", \"path\": [ \"modelProfiles\", 0, \"baseUrl\" ], \"message\": \"模型服务地址必须使用 HTTP 或 HTTPS\" } ]"
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
      await screen.findByText('模型服务地址必须使用 HTTP 或 HTTPS')
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
      screen.queryByRole('switch', { name: '启用向量模型' })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '模型连接' }))
    await screen.findByDisplayValue('默认模型')
    fireEvent.click(screen.getByRole('button', { name: '向量模型' }))
    expect(
      screen
        .getByLabelText('API Key（可选）')
        .closest('.runtime-note')
    ).toHaveClass('model-service-form')
    expect(
      screen.getByText('向量模型连接', { selector: 'strong' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '保存并测试模型' })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('switch', { name: '启用向量模型' })
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

  it('configures learned reranking as an accessible model subtype', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: '重排模型' }))

    expect(
      screen
        .getByLabelText('API Key（可选）')
        .closest('.runtime-note')
    ).toHaveClass('model-service-form')
    const rerankSwitch = screen.getByRole('switch', {
      name: '启用学习型重排'
    })
    expect(rerankSwitch).not.toBeChecked()
    fireEvent.click(rerankSwitch)
    fireEvent.change(screen.getByLabelText('重排接口 URL'), {
      target: { value: 'https://rerank.example/v1/rerank' }
    })
    fireEvent.change(screen.getByLabelText('模型名称'), {
      target: { value: 'vendor/rerank-large' }
    })
    fireEvent.change(screen.getByLabelText('API Key（可选）'), {
      target: { value: 'rerank-secret' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeRerankEnabled: true,
          knowledgeRerankEndpoint:
            'https://rerank.example/v1/rerank',
          knowledgeRerankModel: 'vendor/rerank-large',
          knowledgeRerankApiKey: {
            action: 'replace',
            value: 'rerank-secret'
          }
        })
      )
    )
  })

  it('tests vector generation without exposing index controls', async () => {
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
      screen.getByRole('switch', { name: '启用向量模型' })
    )
    fireEvent.click(
      within(section).getByRole('button', { name: '测试向量模型' })
    )
    await waitFor(() => expect(diagnoseEmbedding).toHaveBeenCalledTimes(1))
    expect(
      await within(section).findByText(/服务返回 768 维向量/u)
    ).toBeInTheDocument()
    expect(
      within(section).queryByRole('button', { name: '重建向量索引' })
    ).not.toBeInTheDocument()
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
    expect(
      screen.getByText(
        '支持直连模型、OpenCode、Continue 和 DeepSeek Harness'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(/新导入的 Skill 默认启用/)
    ).toHaveTextContent(
      '分配给直连模型、OpenCode、Continue 和 DeepSeek Harness'
    )
    expect(
      screen.getByLabelText('DeepSeek Harness')
    ).toBeChecked()
    fireEvent.click(
      screen.getByRole('button', { name: '导入 Skill 目录' })
    )
    await waitFor(() =>
      expect(importSkill).toHaveBeenCalledWith('directory')
    )
    fireEvent.click(
      screen.getByRole('button', { name: '导入 Skill ZIP' })
    )
    await waitFor(() => expect(importSkill).toHaveBeenCalledWith('zip'))
    fireEvent.click(
      screen.getByRole('switch', { name: '启用 文档写作' })
    )
    await waitFor(() =>
      expect(setSkillEnabled).toHaveBeenCalledWith(
        'document-writing',
        false
      )
    )

    fireEvent.click(screen.getByRole('tab', { name: 'MCP' }))
    const mcpTabs = screen.getByRole('tablist', {
      name: 'MCP 设置分类'
    })
    expect(
      within(mcpTabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent)
    ).toEqual(['内置能力', '电脑控制', '自定义 MCP'])
    expect(
      within(mcpTabs).getByRole('tab', { name: '内置能力' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('浏览器能力')).toBeInTheDocument()
    expect(screen.getAllByText('托管浏览器配置').length).toBeGreaterThan(0)
    expect(
      screen.queryByRole('switch', {
        name: '启用 Linux 桌面控制'
      })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /添加 Server/ })
    ).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('switch', { name: '启用 浏览器控制' })
    )
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
    fireEvent.click(
      within(mcpTabs).getByRole('tab', { name: '电脑控制' })
    )
    expect(await screen.findByText('电脑控制能力')).toBeInTheDocument()
    expect(
      screen.getByRole('switch', {
        name: '启用 Linux 桌面控制'
      })
    ).toBeDisabled()
    expect(
      screen.queryByRole('switch', { name: '启用 浏览器控制' })
    ).not.toBeInTheDocument()
    fireEvent.click(
      within(mcpTabs).getByRole('tab', { name: '内置能力' })
    )
    expect(await screen.findByText('文件系统操作')).toBeInTheDocument()
    expect(screen.getByText('浏览器操作')).toBeInTheDocument()
    expect(screen.getByText('联网搜索')).toBeInTheDocument()
    expect(screen.getByText('web_search')).toBeInTheDocument()
    expect(screen.getByText('web_fetch')).toBeInTheDocument()
    expect(
      screen.getByText(/查询词和公开网页地址会发送给第三方 Exa/)
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('switch', {
        name: '启用直连模型联网搜索'
      })
    )
    await waitFor(() =>
      expect(setWebSearchEnabled).toHaveBeenCalledWith(false)
    )
    fireEvent.click(
      screen.getByRole('button', { name: '测试真实搜索' })
    )
    expect(
      await screen.findByText('真实搜索成功 · 321 毫秒')
    ).toBeInTheDocument()
    expect(screen.getByText('GoodBuddy search result')).toBeInTheDocument()
    expect(testWebSearch).toHaveBeenCalledOnce()
    expect(screen.queryByText('读取工作区文本')).not.toBeInTheDocument()
    expect(screen.getByText('知识库')).toBeInTheDocument()
    expect(screen.queryByText('knowledge_list')).not.toBeInTheDocument()
    expect(screen.queryByText('knowledge_search')).not.toBeInTheDocument()
    expect(screen.queryByText('note_search')).not.toBeInTheDocument()
    const knowledgeServerToggle = screen.getByRole('button', {
      name: '展开服务器 知识库'
    })
    expect(knowledgeServerToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(knowledgeServerToggle)
    expect(knowledgeServerToggle).toHaveAttribute('aria-expanded', 'true')
    const knowledgeTools = screen.getByRole('region', {
      name: '知识库 工具'
    })
    expect(knowledgeTools).toContainElement(
      screen.getByText('knowledge_list')
    )
    expect(knowledgeTools).toContainElement(
      screen.getByText('knowledge_search')
    )
    expect(within(knowledgeTools).queryByText(/可用于：/u))
      .not.toBeInTheDocument()
    const noteServerToggle = screen.getByRole('button', {
      name: '展开服务器 笔记'
    })
    expect(
      await screen.findByText(
        '内置 MCP Server · 未启用 · 需要开启魔法笔记'
      )
    ).toBeInTheDocument()
    expect(noteServerToggle.closest('article')).toHaveClass(
      'mcp-server-card--disabled'
    )
    fireEvent.click(noteServerToggle)
    expect(
      screen.getByRole('region', { name: '笔记 工具' })
    ).toContainElement(screen.getByText('note_search'))
    expect(
      screen.getByText(/此内置能力当前不会向任何 Runtime 提供工具/)
    ).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', {
        name: /(?:展开|收起)服务器 (?:知识库|笔记|GoodBuddy 配置)/u
      })
    ).toHaveLength(builtinMcpServers.length)
    expect(
      screen.getByText('可用于：模型、OpenCode、Continue')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/不公开服务地址或凭据/)
    ).toBeInTheDocument()
    const filesystemToggle = screen.getByRole('button', {
      name: '展开工具组 文件系统操作'
    })
    const browserToggle = screen.getByRole('button', {
      name: '展开工具组 浏览器操作'
    })
    fireEvent.click(filesystemToggle)
    expect(screen.getByText('读取工作区文本')).toBeInTheDocument()
    expect(screen.getByText('列出工作区目录')).toBeInTheDocument()
    expect(screen.getByText('写入工作区文本')).toBeInTheDocument()
    fireEvent.click(browserToggle)
    expect(screen.getByText('浏览器导航')).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: /工具组/u })
    ).toHaveLength(
      builtinModelToolGroups.filter((group) => group.id !== 'web').length
    )
    fireEvent.click(
      within(mcpTabs).getByRole('tab', { name: '自定义 MCP' })
    )
    expect(
      screen.getByText(
        /自定义 MCP 可分配给直连模型、GoodBuddy 管理的 OpenCode、Continue Agent 或 DeepSeek Harness/
      )
    ).toHaveTextContent('新建时默认分配给直连模型')
    expect(
      screen.getByText(/服务地址、命令和凭据始终由 GoodBuddy 主进程保管/)
    ).toBeInTheDocument()
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
    expect(
      within(dialog).getByRole('switch', {
        name: '启用此 MCP Server'
      })
    ).toBeChecked()
    expect(
      within(dialog).getByRole('switch', {
        name: '允许动态更新工具列表'
      })
    ).not.toBeChecked()
    expect(within(dialog).getByLabelText('模型')).toBeChecked()
    expect(
      within(dialog).getByLabelText('DeepSeek Harness')
    ).not.toBeChecked()
    expect(within(dialog).getByLabelText('OpenCode')).not.toBeChecked()
    expect(within(dialog).getByLabelText('Continue')).not.toBeChecked()
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
    fireEvent.click(screen.getByRole('tab', { name: '自定义 MCP' }))
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
    fireEvent.click(
      within(dialog).getByRole('switch', {
        name: '允许动态更新工具列表'
      })
    )
    fireEvent.click(saveButton)
    await waitFor(() =>
      expect(saveMcpServer).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          name: '本地文件工具',
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          allowDynamicTools: true,
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
          allowDynamicTools: true,
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
    fireEvent.click(screen.getByRole('tab', { name: '自定义 MCP' }))
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
    expect(
      within(dialog).getByRole('switch', {
        name: '允许动态更新工具列表'
      })
    ).toBeChecked()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(editButton).toHaveFocus())
    expect(
      screen.queryByRole('dialog', { name: '编辑 MCP Server' })
    ).not.toBeInTheDocument()
  })

  it('shows custom MCP tools under their expandable server after testing', async () => {
    getCapabilitySnapshot.mockResolvedValueOnce({
      ...capabilitySnapshot,
      mcpServers: [
        {
          id: '00000000-0000-4000-8000-000000000302',
          name: '团队工具服务',
          description: '公司内部工具',
          enabled: true,
          allowDynamicTools: true,
          assignments: ['model'],
          secretConfigured: false,
          transport: 'http',
          url: 'https://mcp.example.com/mcp'
        }
      ]
    })
    vi.mocked(
      window.goodbuddy.capabilities.testMcpServer
    ).mockResolvedValueOnce({
      serverName: 'Team MCP',
      serverVersion: '1.2.0',
      dynamicToolsSupported: true,
      toolCount: 1,
      tools: [
        {
          name: 'team_search',
          description: '搜索团队资料'
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
    fireEvent.click(screen.getByRole('tab', { name: '自定义 MCP' }))
    const serverToggle = await screen.findByRole('button', {
      name: '展开服务器 团队工具服务'
    })
    expect(serverToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('team_search')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '测试 团队工具服务' })
    )
    expect(await screen.findByText('team_search')).toBeInTheDocument()
    expect(
      screen.getByText('服务端支持动态更新工具列表')
    ).toBeInTheDocument()
    expect(serverToggle).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByRole('region', { name: '团队工具服务 工具' })
    ).toHaveTextContent('搜索团队资料')
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
