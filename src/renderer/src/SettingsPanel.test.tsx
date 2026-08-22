import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantExpert } from '../../shared/assistant-contracts'
import type {
  CustomizableRuntimeProvider,
  DesktopApi,
  RuntimeSettings
} from '../../shared/contracts'
import type {
  CapabilityAssignments,
  CapabilitySnapshot
} from '../../shared/capability-contracts'
import type { ApplicationSettings } from '../../shared/application-settings-contracts'
import type {
  GlobalShortcutSettingsSnapshot
} from '../../shared/shortcut'
import type {
  EmbeddingDiagnosticResult,
  EmbeddingSettingsSnapshot
} from '../../shared/embedding-contracts'
import type { SpeechModelSnapshot } from '../../shared/speech-model-contracts'
import { builtinMcpServers } from '../../shared/builtin-mcp-servers'
import { builtinModelToolGroups } from '../../shared/builtin-model-tools'
import {
  SettingsPanel,
  type SettingsLeaveRequester
} from './SettingsPanel'
import {
  RuntimeCustomizationSection,
  type RuntimeCustomizationSectionHandle
} from './RuntimeCustomizationSection'
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
  builtinMcpServers: [
    {
      id: 'knowledge-base' as const,
      enabled: true,
      assignments: ['model', 'opencode', 'continue'] as (
        | 'model'
        | 'opencode'
        | 'continue'
      )[]
    },
    {
      id: 'magic-notes' as const,
      enabled: true,
      assignments: ['model', 'opencode', 'continue'] as (
        | 'model'
        | 'opencode'
        | 'continue'
      )[]
    },
    {
      id: 'goodbuddy-config' as const,
      enabled: true,
      assignments: ['model', 'opencode', 'continue'] as (
        | 'model'
        | 'opencode'
        | 'continue'
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
      name: '内置浏览器',
      description: '使用 GoodBuddy 内置的临时隔离浏览器执行网页操作。',
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
const setBuiltinMcpServerEnabled = vi.fn(
  async (serverId: string, enabled: boolean) => ({
    ...capabilitySnapshot,
    builtinMcpServers: capabilitySnapshot.builtinMcpServers.map(
      (server) =>
        server.id === serverId ? { ...server, enabled } : server
    )
  })
)
const setBuiltinMcpServerAssignments = vi.fn(
  async (serverId: string, assignments: CapabilityAssignments) => ({
    ...capabilitySnapshot,
    builtinMcpServers: capabilitySnapshot.builtinMcpServers.map(
      (server) =>
        server.id === serverId ? { ...server, assignments } : server
    )
  })
)
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
      id: 'browser-executable',
      status: 'degraded' as const,
      summary: '内置浏览器核心可用，但当前未启动会话。',
      remedy: '开始一次浏览器任务后重试。'
    }
  ]
}))
const createBrowserProfile = vi.fn(async () => capabilitySnapshot)
const renameBrowserProfile = vi.fn(async () => capabilitySnapshot)
const setDefaultBrowserProfile = vi.fn(async () => capabilitySnapshot)
const removeBrowserProfile = vi.fn(async () => capabilitySnapshot)
const heartbeatSettingsProps = {
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
  updateSource: 'github',
  modelDownloadSource: 'modelscope',
  magicNotesEnabled: false,
  magicNotesShowIncompleteTodoCount: true,
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
let shortcutSettingsSnapshot: GlobalShortcutSettingsSnapshot = {
  settings: {
    enabled: true,
    accelerator: 'CommandOrControl+Shift+Space'
  },
  defaultSettings: {
    enabled: true,
    accelerator: 'CommandOrControl+Shift+Space'
  },
  platform: 'win32',
  displayAccelerator: 'Ctrl+Shift+Space',
  registered: true,
  registeredAccelerator: 'CommandOrControl+Shift+Space',
  status: 'registered'
}
const getShortcutSettings = vi.fn(async () => shortcutSettingsSnapshot)
const updateShortcutSettings = vi.fn<
  NonNullable<DesktopApi['shortcuts']>['updateSettings']
>(async (input) => {
  shortcutSettingsSnapshot = {
    ...shortcutSettingsSnapshot,
    settings: input,
    displayAccelerator: input.accelerator,
    registered: input.enabled,
    registeredAccelerator: input.enabled
      ? input.accelerator
      : undefined,
    status: input.enabled ? 'registered' : 'disabled'
  }
  return { ok: true, snapshot: shortcutSettingsSnapshot }
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
    license: {
      name: 'Model License',
      notice: 'Review the model license before use.',
      url: 'https://example.com/license'
    },
    manualOnly: false,
    files: [],
    downloadAvailability: [
      {
        source: 'modelscope',
        available: true,
        totalBytes: 1
      },
      {
        source: 'hugging-face',
        available: true,
        totalBytes: 1
      }
    ]
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
    license: {
      name: 'MIT License',
      notice: 'Review the model license before use.',
      url: 'https://example.com/license'
    },
    manualOnly: false,
    files: [],
    downloadAvailability: [
      {
        source: 'modelscope',
        available: true,
        totalBytes: 1
      },
      {
        source: 'hugging-face',
        available: true,
        totalBytes: 1
      }
    ]
  }
]
const createSpeechModelSnapshot = (
  selectedModelId: string | null = 'sensevoice-small-int8'
): SpeechModelSnapshot => ({
  rootDirectory: 'C:\\Users\\test\\models\\speech',
  selectedDownloadSource: 'modelscope',
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
const runtimeCustomizationSettings = {
  opencode: {},
  continue: { presets: [] }
}
const getRuntimeCustomizationSettings = vi.fn<
  DesktopApi['runtimeCustomization']['getSettings']
>(
  async () => runtimeCustomizationSettings
)
const updateRuntimeCustomizationSettings = vi.fn<
  DesktopApi['runtimeCustomization']['updateSettings']
>(
  async () => runtimeCustomizationSettings
)
const getRuntimeNativeSnapshot = vi.fn<
  DesktopApi['runtimeCustomization']['getNativeSnapshot']
>(async (input) => ({
  provider: input.provider,
  available: true,
  inventoryStatus: 'available',
  detail: 'Ready',
  agents: [],
  tools: [],
  toolsSupported: input.provider !== 'continue',
  commands: [],
  lsp: [],
  formatters: [],
  mcpServers: [],
  skills: [],
  rules: [],
  prompts: [],
  resources: [],
  resourcesSupported: input.provider === 'opencode',
  context: {
    strategy:
      input.provider === 'opencode'
        ? ('native' as const)
        : input.provider === 'continue'
          ? ('goodbuddy-summary' as const)
          : ('unsupported' as const),
    manualCompact: input.provider !== 'deepseek-harness',
    detail: 'Context status'
  }
}))

function RuntimeCustomizationTestHarness({
  provider
}: {
  provider: CustomizableRuntimeProvider
}): React.JSX.Element {
  const customizationRef =
    useRef<RuntimeCustomizationSectionHandle>(null)
  return (
    <>
      <RuntimeCustomizationSection
        provider={provider}
        ref={customizationRef}
      />
      <button
        onClick={() => void customizationRef.current?.save()}
        type="button"
      >
        保存 Runtime 定制
      </button>
    </>
  )
}

describe('SettingsPanel runtime files', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.removeItem('goodbuddy.ui-locale')
    await changeUiLocale('zh-CN')
    applicationSettings = {
      checkUpdatesOnStartup: true,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      magicNotesEnabled: false,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    }
    speechModelSnapshot = createSpeechModelSnapshot()
    shortcutSettingsSnapshot = {
      settings: {
        enabled: true,
        accelerator: 'CommandOrControl+Shift+Space'
      },
      defaultSettings: {
        enabled: true,
        accelerator: 'CommandOrControl+Shift+Space'
      },
      platform: 'win32',
      displayAccelerator: 'Ctrl+Shift+Space',
      registered: true,
      registeredAccelerator: 'CommandOrControl+Shift+Space',
      status: 'registered'
    }
    getShortcutSettings.mockImplementation(
      async () => shortcutSettingsSnapshot
    )
    updateShortcutSettings.mockImplementation(async (input) => {
      shortcutSettingsSnapshot = {
        ...shortcutSettingsSnapshot,
        settings: input,
        displayAccelerator: input.accelerator,
        registered: input.enabled,
        registeredAccelerator: input.enabled
          ? input.accelerator
          : undefined,
        status: input.enabled ? 'registered' : 'disabled'
      }
      return { ok: true, snapshot: shortcutSettingsSnapshot }
    })
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
          setBuiltinMcpServerEnabled,
          setBuiltinMcpServerAssignments,
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
        runtimeCustomization: {
          getSettings: getRuntimeCustomizationSettings,
          updateSettings: updateRuntimeCustomizationSettings,
          getNativeSnapshot: getRuntimeNativeSnapshot
        },
        updates: {
          getSettings: getApplicationSettings,
          updateSettings: updateApplicationSettings,
          check: vi.fn(),
          openReleasePage: vi.fn(),
          onResult: vi.fn(() => () => {})
        },
        shortcuts: {
          getSettings: getShortcutSettings,
          updateSettings: updateShortcutSettings
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

  it('toggles Magic Notes navigation settings', async () => {
    const onMagicNotesEnabledChange = vi.fn()
    const onMagicNotesShowIncompleteTodoCountChange = vi.fn()
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        onMagicNotesEnabledChange={onMagicNotesEnabledChange}
        onMagicNotesShowIncompleteTodoCountChange={
          onMagicNotesShowIncompleteTodoCountChange
        }
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))
    fireEvent.click(
      await screen.findByRole('tab', { name: '魔法笔记' })
    )
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
    const countToggle = screen.getByRole('switch', {
      name: '显示未完成待办数量'
    })
    expect(countToggle).toBeChecked()
    fireEvent.click(countToggle)
    await waitFor(() =>
      expect(updateApplicationSettings).toHaveBeenCalledWith({
        magicNotesShowIncompleteTodoCount: false
      })
    )
    expect(
      onMagicNotesShowIncompleteTodoCountChange
    ).toHaveBeenCalledWith(false)
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

  it('switches the global model download source from General settings', async () => {
    const onNotify = vi.fn()
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        onNotify={onNotify}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))
    expect(
      await screen.findByRole('tab', { name: '通用设置' })
    ).toHaveAttribute('aria-selected', 'true')
    const modelScope = screen.getByRole('radio', {
      name: /ModelScope/u
    })
    const huggingFace = screen.getByRole('radio', {
      name: /Hugging Face/u
    })
    expect(modelScope).toBeChecked()
    expect(huggingFace).not.toBeChecked()
    expect(
      screen.queryByRole('switch', { name: '显示魔法笔记入口' })
    ).not.toBeInTheDocument()

    fireEvent.click(huggingFace)
    await waitFor(() =>
      expect(updateApplicationSettings).toHaveBeenCalledWith({
        modelDownloadSource: 'hugging-face'
      })
    )
    expect(huggingFace).toBeChecked()
    expect(onNotify).toHaveBeenCalledWith({
      tone: 'success',
      message: '模型下载源已切换为 Hugging Face。',
      dedupeKey: 'model-download-source'
    })

    fireEvent.click(screen.getByRole('tab', { name: '魔法笔记' }))
    expect(
      screen.getByRole('switch', { name: '显示魔法笔记入口' })
    ).toBeInTheDocument()
  })

  it('does not guess a model download source when settings fail to load', async () => {
    getApplicationSettings.mockRejectedValueOnce(
      new Error('read failed')
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

    fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))

    expect(
      await screen.findByText('读取平台功能设置失败')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('radio', { name: /ModelScope/u })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('当前选择：ModelScope')
    ).not.toBeInTheDocument()
    expect(
      await screen.findByText('全局快捷唤起')
    ).toBeInTheDocument()
    expect(screen.getByLabelText('快捷键')).toHaveValue(
      'CommandOrControl+Shift+Space'
    )
  })

  it('keeps the confirmed model download source when saving fails', async () => {
    updateApplicationSettings.mockRejectedValueOnce(
      new Error('save failed')
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

    fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))
    const modelScope = await screen.findByRole('radio', {
      name: /ModelScope/u
    })
    const huggingFace = screen.getByRole('radio', {
      name: /Hugging Face/u
    })
    fireEvent.click(huggingFace)

    expect(
      await screen.findByText('保存模型下载源失败，请重试')
    ).toBeInTheDocument()
    expect(modelScope).toBeChecked()
    expect(huggingFace).not.toBeChecked()
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
      'capability-card--disabled'
    )

    fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))
    fireEvent.click(
      await screen.findByRole('tab', { name: '魔法笔记' })
    )
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
      ).not.toHaveClass('capability-card--disabled')
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
    expect(
      screen.getByRole('tab', { name: 'Agent Runtime' })
    ).toHaveTextContent('配置 Agent Runtime、默认工作区与原生能力')
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
      screen.getByRole('button', { name: '语音输入' })
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

  it('records and saves the global shortcut in General settings', async () => {
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
    fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))
    expect(
      screen.getByRole('tab', { name: '平台功能' })
    ).toHaveAttribute('aria-selected', 'true')
    await waitFor(() =>
      expect(getShortcutSettings).toHaveBeenCalled()
    )
    await waitFor(() =>
      expect(
        screen.queryByText('正在读取快捷键状态…')
      ).not.toBeInTheDocument()
    )
    expect(
      await screen.findByText('全局快捷唤起')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('读取快捷键设置失败，请重试')
    ).not.toBeInTheDocument()
    const accelerator = await screen.findByLabelText('快捷键')
    expect(accelerator).toHaveValue(
      'CommandOrControl+Shift+Space'
    )
    fireEvent.keyDown(accelerator, {
      key: 'k',
      ctrlKey: true,
      altKey: true
    })
    expect(accelerator).toHaveValue('CommandOrControl+Alt+K')
    const platformTab = screen.getByRole('tab', {
      name: '平台功能'
    })
    fireEvent.keyDown(platformTab, { key: 'ArrowRight' })
    expect(platformTab).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(
      screen.getByRole('button', { name: '保存快捷键' })
    )
    await waitFor(() =>
      expect(updateShortcutSettings).toHaveBeenCalledWith({
        enabled: true,
        accelerator: 'CommandOrControl+Alt+K'
      })
    )
    expect(
      await screen.findByText('已注册：CommandOrControl+Alt+K')
    ).toBeInTheDocument()
  })

  it('records physical Control separately from Command on macOS', async () => {
    shortcutSettingsSnapshot = {
      ...shortcutSettingsSnapshot,
      platform: 'darwin',
      displayAccelerator: 'Command+Shift+Space'
    }
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
    fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))
    const accelerator = await screen.findByLabelText('快捷键')
    fireEvent.keyDown(accelerator, {
      key: 'k',
      ctrlKey: true
    })
    expect(accelerator).toHaveValue('Control+K')
    fireEvent.keyDown(accelerator, {
      key: 'k',
      ctrlKey: true,
      metaKey: true
    })
    expect(accelerator).toHaveValue('Control+Command+K')
  })

  it('preserves runtime drafts across navigation and protects them on close', async () => {
    const onClose = vi.fn()
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={onClose}
        onSaved={vi.fn()}
      />
    )

    const workspace = await screen.findByLabelText('默认工作区目录')
    fireEvent.change(workspace, {
      target: { value: 'C:\\Unsaved workspace' }
    })
    const runtimeTab = screen.getByRole('tab', {
      name: 'Agent Runtime'
    })
    fireEvent.click(screen.getByRole('tab', { name: '外观' }))
    expect(
      screen.getByRole('tab', { name: '外观' })
    ).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(
      screen.getByRole('alert')
    ).toHaveTextContent('当前设置有未保存更改')

    fireEvent.click(
      screen.getByRole('button', { name: '继续编辑' })
    )
    fireEvent.click(runtimeTab)
    expect(await screen.findByLabelText('默认工作区目录')).toHaveValue(
      'C:\\Unsaved workspace'
    )
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(
      screen.getByRole('button', { name: '放弃更改并关闭' })
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: '放弃更改并关闭' })
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('routes external leave requests through the existing dirty confirmation', async () => {
    let requestLeave: SettingsLeaveRequester | undefined
    const proceed = vi.fn()
    const onClose = vi.fn()
    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        onLeaveRequestReady={(requester) => {
          requestLeave = requester
        }}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={onClose}
        onSaved={vi.fn()}
      />
    )

    fireEvent.change(await screen.findByLabelText('默认工作区目录'), {
      target: { value: 'C:\\Pending external navigation' }
    })
    act(() => requestLeave?.(proceed))

    expect(proceed).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      '当前设置有未保存更改'
    )
    fireEvent.click(
      screen.getByRole('button', { name: '放弃更改并关闭' })
    )
    expect(proceed).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps shortcut input after a registration conflict', async () => {
    updateShortcutSettings.mockResolvedValueOnce({
      ok: false,
      error: 'conflict',
      snapshot: shortcutSettingsSnapshot
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
    fireEvent.click(screen.getByRole('tab', { name: '平台功能' }))
    await waitFor(() =>
      expect(getShortcutSettings).toHaveBeenCalled()
    )
    const accelerator = await screen.findByLabelText('快捷键')
    fireEvent.change(accelerator, {
      target: { value: 'Control+Alt+K' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '保存快捷键' })
    )

    expect(
      await screen.findByText(/已被其他应用占用/u)
    ).toBeInTheDocument()
    expect(accelerator).toHaveValue('Control+Alt+K')
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
      screen.getByRole('button', { name: '语音输入' })
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
      screen.getByText(/Ask 仅可调用当前 Runtime 允许的只读能力/)
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

  it('selects a native OpenCode Agent and excludes GoodBuddy assignments from inventory', async () => {
    const settings = {
      opencode: { defaultAgent: 'planner' },
      continue: { presets: [] }
    }
    getRuntimeCustomizationSettings.mockResolvedValueOnce(settings)
    getRuntimeNativeSnapshot.mockResolvedValueOnce({
      provider: 'opencode',
      available: true,
      inventoryStatus: 'available',
      detail: 'OpenCode 原生能力已就绪',
      agents: [
        {
          id: 'planner',
          name: 'Planner',
          mode: 'primary',
          native: true,
          hidden: false
        },
        {
          id: 'reviewer',
          name: 'Reviewer',
          mode: 'all',
          native: true,
          hidden: false
        },
        {
          id: 'explorer',
          name: 'Explorer',
          mode: 'subagent',
          native: true,
          hidden: false
        }
      ],
      tools: [
        {
          id: 'edit',
          name: 'edit',
          description: 'Edit a file',
          kind: 'write',
          source: 'runtime',
          ask: 'blocked',
          execute: 'allowed'
        }
      ],
      toolsSupported: true,
      commands: [],
      lsp: [],
      formatters: [],
      mcpServers: [
        {
          id: 'native-mcp',
          name: 'Native MCP',
          status: 'connected'
        }
      ],
      skills: [
        {
          id: 'native-skill',
          name: 'Native Skill',
          source: 'runtime'
        }
      ],
      rules: [],
      prompts: [],
      resources: [],
      resourcesSupported: true,
      context: {
        strategy: 'native',
        manualCompact: true,
        detail: '由 OpenCode 原生管理'
      }
    })
    updateRuntimeCustomizationSettings.mockImplementationOnce(
      async (input) => input
    )

    render(<RuntimeCustomizationTestHarness provider="opencode" />)

    const agent = await screen.findByLabelText('默认 Agent')
    expect(agent).toHaveValue('planner')
    expect(
      screen.queryByText('OpenCode 原生能力已就绪')
    ).not.toBeInTheDocument()
    expect(screen.getByText('能力与默认配置')).toBeInTheDocument()
    expect(screen.queryByText('Runtime 原生能力')).not.toBeInTheDocument()
    expect(screen.queryByText('OpenCode 默认 Agent')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Runtime 原生能力可用')
    ).not.toBeInTheDocument()
    const inventoryTabs = screen.getByRole('tablist', {
      name: '能力清单'
    })
    expect(within(inventoryTabs).getAllByRole('tab')).toHaveLength(11)
    const agentsTab = within(inventoryTabs).getByRole('tab', {
      name: /^Agents/u
    })
    const agentsPanel = screen.getByRole('tabpanel')
    expect(agentsTab).toHaveAttribute('aria-selected', 'true')
    expect(agentsTab).toHaveAttribute('aria-controls', agentsPanel.id)
    expect(agentsPanel).toHaveAttribute(
      'aria-labelledby',
      agentsTab.id
    )
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(screen.getByText('Explorer')).toBeInTheDocument()
    fireEvent.keyDown(agentsTab, { key: 'ArrowRight' })
    const toolsTab = within(inventoryTabs).getByRole('tab', {
      name: /^Tools/u
    })
    expect(toolsTab).toHaveAttribute('aria-selected', 'true')
    expect(toolsTab).toHaveFocus()
    expect(screen.getByText('edit')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Edit a file · 文件修改 · Runtime 内置 · Ask：不可用 · Execute：可用'
      )
    ).toBeInTheDocument()
    const commandsTab = within(inventoryTabs).getByRole('tab', {
      name: /Commands/u
    })
    fireEvent.click(commandsTab)
    expect(commandsTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('未发现')).toBeInTheDocument()
    expect(
      screen.getByText(
        '当前 Runtime 未报告此类别中的可用能力。'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('Native MCP')).not.toBeInTheDocument()
    fireEvent.click(
      within(inventoryTabs).getByRole('tab', {
        name: /^MCP/u
      })
    )
    expect(screen.getByText('Native MCP')).toBeInTheDocument()
    expect(screen.queryByText('Explorer')).not.toBeInTheDocument()
    fireEvent.click(
      within(inventoryTabs).getByRole('tab', {
        name: /^Skills/u
      })
    )
    expect(screen.getByText('Native Skill')).toBeInTheDocument()
    expect(screen.queryByText('Native MCP')).not.toBeInTheDocument()
    expect(screen.queryByText('GoodBuddy MCP')).not.toBeInTheDocument()

    fireEvent.change(agent, { target: { value: 'reviewer' } })
    expect(
      screen.getByText(/有未保存的 Runtime 定制更改/u)
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: '保存 Runtime 定制' })
    )
    await waitFor(() =>
      expect(updateRuntimeCustomizationSettings).toHaveBeenCalledWith({
        opencode: { defaultAgent: 'reviewer' },
        continue: { presets: [] }
      })
    )
    await waitFor(() =>
      expect(
        screen.queryByText(/有未保存的 Runtime 定制更改/u)
      ).not.toBeInTheDocument()
    )
  })

  it.each([
    ['opencode', 'OpenCode 原生能力已就绪'],
    [
      'continue',
      '内置 Continue CLI 已就绪；Rules 与 Prompts 来自原始静态配置；MCP Prompt 仅在 MCPService 运行并连接后可发现，非运行快照不会启动服务器。Continue MCPService 不提供 Resources。'
    ],
    [
      'deepseek-harness',
      '显示 DeepSeek Harness Host 与插件原生能力；GoodBuddy 分配的 Skill 和 MCP 不在此清单中。'
    ]
  ] as const)(
    'hides the redundant ready detail for %s',
    async (provider, detail) => {
      const fallbackSnapshot = await getRuntimeNativeSnapshot({
        provider
      })
      getRuntimeNativeSnapshot.mockResolvedValueOnce({
        ...fallbackSnapshot,
        detail
      })

      render(<RuntimeCustomizationSection provider={provider} />)

      await screen.findByRole('tablist', { name: '能力清单' })
      expect(screen.queryByText(detail)).not.toBeInTheDocument()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    }
  )

  it('distinguishes external OpenCode connectivity from readable native inventory', async () => {
    const fallbackSnapshot = await getRuntimeNativeSnapshot({
      provider: 'opencode'
    })
    getRuntimeNativeSnapshot.mockResolvedValueOnce({
      ...fallbackSnapshot,
      provider: 'opencode',
      available: true,
      inventoryStatus: 'connection-only',
      detail: 'External OpenCode connection only',
      toolsSupported: false
    })

    render(<RuntimeCustomizationSection provider="opencode" />)

    expect(await screen.findByRole('status')).toHaveTextContent(
      'External OpenCode connection only'
    )
    expect(
      screen.queryByText('仅确认 Runtime 连接')
    ).not.toBeInTheDocument()
  })

  it('uses a guided empty state without a second save action', async () => {
    render(<RuntimeCustomizationSection provider="continue" />)

    expect(
      await screen.findByText('还没有 Continue 预设')
    ).toBeInTheDocument()
    expect(
      screen.getByText('使用上方“添加预设”创建 Rules 与 Prompt 模板。')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '添加预设' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '保存 Runtime 定制' })
    ).not.toBeInTheDocument()
  })

  it('edits Continue presets, Rules, Prompt metadata, and merged native Rules', async () => {
    const presetId = '00000000-0000-4000-8000-000000000701'
    const ruleId = '00000000-0000-4000-8000-000000000702'
    const promptId = '00000000-0000-4000-8000-000000000703'
    const settings = {
      opencode: {},
      continue: {
        defaultPresetId: presetId,
        presets: [
          {
            id: presetId,
            name: '代码审查',
            rules: [
              {
                id: ruleId,
                name: '安全优先',
                content: '先检查安全边界。',
                enabled: true
              }
            ],
            prompts: [
              {
                id: promptId,
                name: '审查变更',
                prompt: '请审查当前变更。'
              }
            ]
          }
        ]
      }
    }
    getRuntimeCustomizationSettings.mockResolvedValueOnce(settings)
    getRuntimeNativeSnapshot.mockResolvedValueOnce({
      provider: 'continue',
      available: true,
      inventoryStatus: 'available',
      detail: 'Continue 原生能力已就绪',
      agents: [],
      tools: [],
      toolsSupported: false,
      commands: [],
      lsp: [],
      formatters: [],
      mcpServers: [],
      skills: [],
      rules: [
        {
          id: 'configuration-rule-1',
          name: 'Native Rule',
          content: '遵循原生规则。',
          source: 'configuration'
        }
      ],
      prompts: [],
      resources: [],
      resourcesSupported: false,
      context: {
        strategy: 'goodbuddy-summary',
        manualCompact: true,
        detail: '由 GoodBuddy 摘要压缩'
      }
    })
    updateRuntimeCustomizationSettings.mockImplementationOnce(
      async (input) => input
    )

    render(<RuntimeCustomizationTestHarness provider="continue" />)

    expect(
      await screen.findByLabelText('默认配置预设')
    ).toHaveValue(presetId)
    expect(
      screen.getByText('查看最终合并的 2 条 Rule')
    ).toBeInTheDocument()
    const inventoryTabs = screen.getByRole('tablist', {
      name: '能力清单'
    })
    fireEvent.click(
      within(inventoryTabs).getByRole('tab', {
        name: /^Tools/u
      })
    )
    expect(
      screen.getByText('当前 Runtime 不支持静态发现 Tools')
    ).toBeInTheDocument()
    fireEvent.click(
      within(inventoryTabs).getByRole('tab', {
        name: /^Skills/u
      })
    )
    expect(screen.getByText('未发现')).toBeInTheDocument()
    fireEvent.click(
      within(inventoryTabs).getByRole('tab', {
        name: /^Resources/u
      })
    )
    expect(
      screen.getByText('当前 Runtime 不支持')
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('安全优先 内容'), {
      target: { value: '先检查权限和数据边界。' }
    })
    fireEvent.change(screen.getByLabelText('审查变更 说明'), {
      target: { value: '用于提交前检查' }
    })
    fireEvent.change(screen.getByLabelText('审查变更 内容'), {
      target: { value: '请审查当前提交。' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '保存 Runtime 定制' })
    )

    await waitFor(() =>
      expect(updateRuntimeCustomizationSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          continue: expect.objectContaining({
            presets: [
              expect.objectContaining({
                rules: [
                  expect.objectContaining({
                    content: '先检查权限和数据边界。'
                  })
                ],
                prompts: [
                  expect.objectContaining({
                    description: '用于提交前检查',
                    prompt: '请审查当前提交。'
                  })
                ]
              })
            ]
          })
        })
      )
    )
  })

  it('preserves Continue drafts across inventory refreshes and failed-save retries', async () => {
    const presetId = '00000000-0000-4000-8000-000000000704'
    getRuntimeCustomizationSettings.mockResolvedValueOnce({
      opencode: {},
      continue: {
        presets: [
          {
            id: presetId,
            name: 'Draft preset',
            rules: [],
            prompts: []
          }
        ]
      }
    })
    updateRuntimeCustomizationSettings
      .mockRejectedValueOnce(new Error('保存失败'))
      .mockImplementationOnce(async (input) => input)

    render(<RuntimeCustomizationTestHarness provider="continue" />)

    const nameInput = await screen.findByLabelText('预设名称')
    fireEvent.change(nameInput, {
      target: { value: 'Unsaved draft' }
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: '刷新能力清单'
      })
    )
    await waitFor(() =>
      expect(getRuntimeNativeSnapshot).toHaveBeenCalledTimes(2)
    )
    expect(nameInput).toHaveValue('Unsaved draft')
    expect(getRuntimeCustomizationSettings).toHaveBeenCalledOnce()

    fireEvent.click(
      screen.getByRole('button', { name: '保存 Runtime 定制' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '保存失败'
    )
    fireEvent.click(
      screen.getByRole('button', { name: '重试' })
    )

    await waitFor(() =>
      expect(updateRuntimeCustomizationSettings).toHaveBeenCalledTimes(2)
    )
    expect(
      updateRuntimeCustomizationSettings
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        continue: expect.objectContaining({
          presets: [
            expect.objectContaining({ name: 'Unsaved draft' })
          ]
        })
      })
    )
    expect(getRuntimeCustomizationSettings).toHaveBeenCalledOnce()
  })

  it('saves Runtime customization with the page action and protects unsaved drafts', async () => {
    const presetId = '00000000-0000-4000-8000-000000000705'
    const customization = {
      opencode: {},
      continue: {
        presets: [
          {
            id: presetId,
            name: 'Saved preset',
            rules: [],
            prompts: []
          }
        ]
      }
    }
    getRuntimeCustomizationSettings
      .mockResolvedValueOnce(customization)
      .mockResolvedValueOnce(customization)
    updateRuntimeCustomizationSettings.mockImplementationOnce(
      async (input) => input
    )
    const onClose = vi.fn()

    render(
      <SettingsPanel
        {...heartbeatSettingsProps}
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={onClose}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    const presetName = await screen.findByLabelText('预设名称')
    fireEvent.change(presetName, {
      target: { value: 'Unsaved preset' }
    })
    expect(
      screen.getByText(/有未保存的 Runtime 定制更改/u)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '外观' }))
    expect(presetName).toHaveValue('Unsaved preset')
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))

    expect(onClose).not.toHaveBeenCalled()
    expect(
      await screen.findByText(
        '请先保存或撤销 Runtime 定制更改，再关闭设置中心。'
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(updateRuntimeCustomizationSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          continue: expect.objectContaining({
            presets: [
              expect.objectContaining({ name: 'Unsaved preset' })
            ]
          })
        })
      )
    )
    expect(updateRuntime).toHaveBeenCalled()
    await waitFor(() =>
      expect(
        screen.queryByText(/有未保存的 Runtime 定制更改/u)
      ).not.toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(onClose).toHaveBeenCalledOnce()
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
        message: '真实生成测试通过：sonnet-5',
        dedupeKey: 'model-connection-tested'
      })
    )
    expect(
      screen.queryByText('真实生成测试通过：sonnet-5')
    ).not.toBeInTheDocument()
  })

  it('places the API Key directly after authentication and keeps it when the model URL changes', async () => {
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      apiKeyConfigured: true,
      credentialSource: 'encrypted',
      modelProfiles: [
        {
          ...runtimeSettings.modelProfiles[0]!,
          apiKeyConfigured: true,
          credentialSource: 'encrypted'
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
    const authentication = screen.getByLabelText(
      '认证方式 默认模型'
    )
    const apiKey = screen.getByLabelText('API Key')
    expect(
      authentication.closest('label')?.nextElementSibling
    ).toBe(apiKey.closest('label'))
    expect(apiKey).toHaveAttribute(
      'placeholder',
      '已配置，留空保持不变'
    )

    fireEvent.change(screen.getByDisplayValue('https://bigtoken.ai'), {
      target: { value: 'https://new-model.example/v1' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProfiles: [
            expect.objectContaining({
              baseUrl: 'https://new-model.example/v1',
              apiKey: { action: 'keep' }
            })
          ]
        })
      )
    )
  })

  it('does not clear a saved API Key when authentication is temporarily disabled', async () => {
    getRuntime.mockResolvedValueOnce({
      ...runtimeSettings,
      apiKeyConfigured: true,
      credentialSource: 'encrypted',
      modelProfiles: [
        {
          ...runtimeSettings.modelProfiles[0]!,
          apiKeyConfigured: true,
          credentialSource: 'encrypted'
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
    fireEvent.change(screen.getByLabelText('认证方式 默认模型'), {
      target: { value: 'none' }
    })
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        '当前无需认证；已保存的 API Key 仍保留在此连接中'
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProfiles: [
            expect.objectContaining({
              authentication: 'none',
              apiKey: { action: 'keep' }
            })
          ]
        })
      )
    )
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

  it('keeps Smart Heartbeat configuration out of Settings', () => {
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
      screen.queryByRole('tab', { name: '自动化' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('智能心跳')).not.toBeInTheDocument()
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
    ).toEqual(['内置 MCP', '直连模型', '自定义 MCP', '电脑控制'])
    expect(
      within(mcpTabs).getByRole('tab', { name: '内置 MCP' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('GoodBuddy 内置 MCP')).toBeInTheDocument()
    expect(
      screen.queryByRole('switch', {
        name: '启用 Linux 桌面控制'
      })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /添加 Server/ })
    ).not.toBeInTheDocument()
    const knowledgeBuiltinCard = screen
      .getByRole('switch', { name: '启用 知识库 内置 MCP' })
      .closest('article')
    expect(knowledgeBuiltinCard).not.toBeNull()
    expect(
      within(knowledgeBuiltinCard!).getByLabelText(
        /知识库 无法分配给 DeepSeek Harness/
      )
    ).toBeDisabled()
    expect(
      within(knowledgeBuiltinCard!).getByLabelText(
        /知识库 无法分配给 DeepSeek Harness/
      )
    ).not.toBeChecked()
    fireEvent.click(
      within(knowledgeBuiltinCard!).getByLabelText('Continue')
    )
    await waitFor(() =>
      expect(setBuiltinMcpServerAssignments).toHaveBeenCalledWith(
        'knowledge-base',
        ['model', 'opencode']
      )
    )
    fireEvent.click(
      screen.getByRole('switch', { name: '启用 知识库 内置 MCP' })
    )
    await waitFor(() =>
      expect(setBuiltinMcpServerEnabled).toHaveBeenCalledWith(
        'knowledge-base',
        false
      )
    )
    fireEvent.click(
      within(mcpTabs).getByRole('tab', { name: '电脑控制' })
    )
    expect(await screen.findByText('电脑控制能力')).toBeInTheDocument()
    expect(
      screen.getByText('仅显示实际操作客户端电脑的能力')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('switch', {
        name: '启用直连模型内置浏览器'
      })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('托管浏览器配置')).not.toBeInTheDocument()
    expect(
      screen.getByRole('switch', {
        name: '启用 Linux 桌面控制'
      })
    ).toBeDisabled()
    fireEvent.click(
      within(mcpTabs).getByRole('tab', { name: '直连模型' })
    )
    expect(await screen.findByText('文件系统操作')).toBeInTheDocument()
    expect(screen.getByText('内置浏览器')).toBeInTheDocument()
    expect(screen.getByText('联网搜索')).toBeInTheDocument()
    expect(
      screen.queryByRole('switch', {
        name: '启用直连模型内置浏览器'
      })
    ).not.toBeInTheDocument()
    const builtinBrowserToggle = screen.getByRole('button', {
      name: '展开工具组 内置浏览器'
    })
    fireEvent.click(builtinBrowserToggle)
    expect(builtinBrowserToggle).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByText(/不会控制客户端已安装的 Chrome、Edge/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/此总开关完全由你控制/)
    ).toHaveTextContent('不再逐次询问')
    fireEvent.click(
      screen.getByRole('switch', {
        name: '启用直连模型内置浏览器'
      })
    )
    await waitFor(() =>
      expect(setComputerCapabilityEnabled).toHaveBeenCalledWith(
        'host-browser-control',
        true
      )
    )
    fireEvent.click(
      screen.getByRole('button', { name: '诊断内置浏览器' })
    )
    expect(
      await screen.findByText('诊断结果：部分可用')
    ).toBeInTheDocument()
    expect(diagnoseComputerCapability).toHaveBeenCalledWith(
      'host-browser-control'
    )
    expect(screen.queryByText('托管浏览器配置')).not.toBeInTheDocument()
    expect(screen.queryByText('内置浏览器配置')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('新配置名称')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('switch', {
        name: '启用 Linux 桌面控制'
      })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('switch', {
        name: '启用直连模型内置浏览器'
      })
    ).toBeInTheDocument()
    fireEvent.click(builtinBrowserToggle)
    expect(builtinBrowserToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('web_search')).not.toBeInTheDocument()
    expect(screen.queryByText('web_fetch')).not.toBeInTheDocument()
    const webSearchToggle = screen.getByRole('button', {
      name: '展开工具组 联网搜索'
    })
    expect(webSearchToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(webSearchToggle)
    expect(webSearchToggle).toHaveAttribute('aria-expanded', 'true')
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
    fireEvent.click(
      within(mcpTabs).getByRole('tab', { name: '内置 MCP' })
    )
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
      'capability-card--disabled'
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
      screen.getByText(/按请求提供，可分别控制启停与 Runtime 分配/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/不公开服务地址或凭据/)
    ).toBeInTheDocument()
    fireEvent.click(
      within(mcpTabs).getByRole('tab', { name: '直连模型' })
    )
    const filesystemToggle = screen.getByRole('button', {
      name: '展开工具组 文件系统操作'
    })
    const browserToggle = screen.getByRole('button', {
      name: '展开工具组 内置浏览器'
    })
    fireEvent.click(filesystemToggle)
    expect(screen.getByText('读取工作区文本')).toBeInTheDocument()
    expect(screen.getByText('列出工作区目录')).toBeInTheDocument()
    expect(screen.getByText('写入工作区文本')).toBeInTheDocument()
    fireEvent.click(browserToggle)
    expect(screen.getByText('浏览器导航')).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: /工具组/u })
    ).toHaveLength(builtinModelToolGroups.length)
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
      ],
      promptsSupported: true,
      promptCount: 1,
      prompts: [
        {
          name: 'prepare_review',
          description: '准备审查 Prompt',
          arguments: [
            {
              name: 'scope',
              description: '审查范围',
              required: true
            }
          ]
        }
      ],
      resourcesSupported: true,
      resourceCount: 1,
      resources: [
        {
          uri: 'mcp://team/review-guide',
          name: 'Review Guide',
          description: '团队审查指南',
          mimeType: 'text/markdown'
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
    expect(screen.getByText('prepare_review')).toBeInTheDocument()
    expect(screen.getByText('参数：scope*（* 必填）')).toBeInTheDocument()
    expect(screen.getByText('Review Guide')).toBeInTheDocument()
    expect(
      screen.getByText('mcp://team/review-guide')
    ).toBeInTheDocument()
    expect(screen.getByText('text/markdown')).toBeInTheDocument()
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
