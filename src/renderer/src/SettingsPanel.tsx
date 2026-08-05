import {
  Check,
  FolderOpen,
  KeyRound,
  LockKeyhole,
  Plus,
  SunMoon,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  AssistantExpert,
  AssistantHeartbeatConfig,
  HeartbeatCreateInput
} from '../../shared/assistant-contracts'
import type {
  AgentRuntimeDetection,
  RuntimeFileSelectionKind,
  RuntimeSettings,
  RuntimeSettingsInput,
  RuntimeModelSource
} from '../../shared/contracts'
import { defaultRuntimeSettings } from '../../shared/contracts'
import { McpSettingsSection } from './McpSettingsSection'
import { RolePromptSettingsSection } from './RolePromptSettingsSection'
import { SkillsSettingsSection } from './SkillsSettingsSection'
import { HeartbeatSettings } from './HeartbeatSettings'
import { SegmentedControl } from './WorkspacePrimitives'
import type { AppearanceTheme } from './theme'

type SettingsTab =
  | 'appearance'
  | 'model'
  | 'runtime'
  | 'security'
  | 'automation'
  | 'roles'
  | 'skills'
  | 'mcp'
type ModelType = 'llm' | 'embedding'
type ModelProfileDraft = RuntimeSettings['modelProfiles'][number] & {
  apiKey: string
  clearApiKey: boolean
}

const settingsTabs: readonly SettingsTab[] = [
  'appearance',
  'model',
  'runtime',
  'security',
  'automation',
  'roles',
  'skills',
  'mcp'
]

type SettingsPanelProps = {
  open: boolean
  presentation?: 'modal' | 'page'
  onClose: () => void
  onSaved: (settings: RuntimeSettings) => void
  onExpertsChanged?: (experts: AssistantExpert[]) => void
  onClearLocalData: () => Promise<void>
  heartbeats: AssistantHeartbeatConfig[]
  onCreateHeartbeat: (input: HeartbeatCreateInput) => Promise<void>
  onSetHeartbeatPaused: (
    heartbeatId: string,
    paused: boolean
  ) => Promise<void>
  onRemoveHeartbeat: (heartbeatId: string) => Promise<void>
  onRunHeartbeat: (heartbeatId: string) => Promise<void>
  appearanceTheme?: AppearanceTheme
  onAppearanceThemeChange?: (theme: AppearanceTheme) => void
}

const credentialLabels: Record<
  RuntimeSettings['credentialSource'],
  string
> = {
  none: '尚未配置',
  encrypted: '已由系统安全存储加密',
  environment: '由环境变量提供'
}

function toModelProfileDrafts(
  settings: RuntimeSettings
): ModelProfileDraft[] {
  return settings.modelProfiles.map((profile) => ({
    ...profile,
    apiKey: '',
    clearApiKey: false
  }))
}

export function SettingsPanel({
  open,
  presentation = 'modal',
  onClose,
  onSaved,
  onClearLocalData,
  heartbeats,
  onCreateHeartbeat,
  onSetHeartbeatPaused,
  onRemoveHeartbeat,
  onRunHeartbeat,
  onExpertsChanged = () => {},
  appearanceTheme = 'system',
  onAppearanceThemeChange = () => {}
}: SettingsPanelProps): React.JSX.Element | null {
  const [settings, setSettings] = useState<RuntimeSettings>()
  const [provider, setProvider] =
    useState<RuntimeSettingsInput['provider']>(
      defaultRuntimeSettings.provider
    )
  const [modelProfiles, setModelProfiles] = useState<ModelProfileDraft[]>([])
  const [selectedModelProfileId, setSelectedModelProfileId] =
    useState('')
  const [defaultModelProfileId, setDefaultModelProfileId] = useState('')
  const [opencodeModelSource, setOpencodeModelSource] =
    useState<RuntimeModelSource>({ kind: 'platform' })
  const [continueModelSource, setContinueModelSource] =
    useState<RuntimeModelSource>({ kind: 'platform' })
  const [opencodeBaseUrl, setOpencodeBaseUrl] = useState<string>(
    defaultRuntimeSettings.opencodeBaseUrl
  )
  const [opencodeEmbedded, setOpencodeEmbedded] = useState<boolean>(
    defaultRuntimeSettings.opencodeEmbedded
  )
  const [opencodeBinaryPath, setOpencodeBinaryPath] = useState<string>(
    defaultRuntimeSettings.opencodeBinaryPath
  )
  const [opencodeConfigPath, setOpencodeConfigPath] = useState<string>(
    defaultRuntimeSettings.opencodeConfigPath
  )
  const [continueBinaryPath, setContinueBinaryPath] = useState<string>(
    defaultRuntimeSettings.continueBinaryPath
  )
  const [continueConfigPath, setContinueConfigPath] = useState<string>(
    defaultRuntimeSettings.continueConfigPath
  )
  const [continueMode, setContinueMode] =
    useState<RuntimeSettingsInput['continueMode']>(
      defaultRuntimeSettings.continueMode
    )
  const [runtimeSandboxMode, setRuntimeSandboxMode] =
    useState<RuntimeSettingsInput['runtimeSandboxMode']>(
      defaultRuntimeSettings.runtimeSandboxMode
    )
  const [knowledgeEmbeddingEnabled, setKnowledgeEmbeddingEnabled] =
    useState<boolean>(defaultRuntimeSettings.knowledgeEmbeddingEnabled)
  const [knowledgeEmbeddingBaseUrl, setKnowledgeEmbeddingBaseUrl] =
    useState<string>(defaultRuntimeSettings.knowledgeEmbeddingBaseUrl)
  const [knowledgeEmbeddingModel, setKnowledgeEmbeddingModel] =
    useState<string>(defaultRuntimeSettings.knowledgeEmbeddingModel)
  const [knowledgeEmbeddingApiKey, setKnowledgeEmbeddingApiKey] =
    useState('')
  const [
    clearKnowledgeEmbeddingApiKey,
    setClearKnowledgeEmbeddingApiKey
  ] = useState(false)
  const [workspacePath, setWorkspacePath] = useState<string>(
    defaultRuntimeSettings.workspacePath
  )
  const [toolApproval, setToolApproval] =
    useState<RuntimeSettingsInput['toolApproval']>(
      defaultRuntimeSettings.toolApproval
    )
  const [
    subagentSmartRoutingEnabled,
    setSubagentSmartRoutingEnabled
  ] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [connectionResult, setConnectionResult] = useState<string>()
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [detection, setDetection] = useState<AgentRuntimeDetection>()
  const [detecting, setDetecting] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('runtime')
  const [modelType, setModelType] = useState<ModelType>('llm')
  const configurationTab =
    activeTab === 'model' ||
    activeTab === 'runtime' ||
    activeTab === 'security'

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tab: SettingsTab
  ): void => {
    const currentIndex = settingsTabs.indexOf(tab)
    let nextIndex: number | undefined
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % settingsTabs.length
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      nextIndex =
        (currentIndex - 1 + settingsTabs.length) %
        settingsTabs.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = settingsTabs.length - 1
    }
    if (nextIndex === undefined) {
      return
    }
    event.preventDefault()
    const nextTab = settingsTabs[nextIndex]!
    setActiveTab(nextTab)
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(
        `#settings-tab-${nextTab}`
      )
      ?.focus()
  }

  useEffect(() => {
    if (!open) {
      return
    }
    void window.goodbuddy.settings
      .getRuntime()
      .then((value) => {
        setError(undefined)
        setSaved(false)
        setConnectionResult(undefined)
        setConfirmingClear(false)
        setModelType('llm')
        setSettings(value)
        setProvider(value.provider)
        setModelProfiles(toModelProfileDrafts(value))
        setSelectedModelProfileId(
          value.modelProfiles.some(
            (profile) => profile.id === value.defaultModelProfileId
          )
            ? value.defaultModelProfileId
            : value.modelProfiles[0]?.id ?? ''
        )
        setDefaultModelProfileId(value.defaultModelProfileId)
        setOpencodeModelSource(value.opencodeModelSource)
        setContinueModelSource(value.continueModelSource)
        setOpencodeBaseUrl(value.opencodeBaseUrl)
        setOpencodeEmbedded(value.opencodeEmbedded)
        setOpencodeBinaryPath(value.opencodeBinaryPath)
        setOpencodeConfigPath(value.opencodeConfigPath)
        setContinueBinaryPath(value.continueBinaryPath)
        setContinueConfigPath(value.continueConfigPath)
        setContinueMode(value.continueMode)
        setRuntimeSandboxMode(value.runtimeSandboxMode)
        setKnowledgeEmbeddingEnabled(value.knowledgeEmbeddingEnabled)
        setKnowledgeEmbeddingBaseUrl(value.knowledgeEmbeddingBaseUrl)
        setKnowledgeEmbeddingModel(value.knowledgeEmbeddingModel)
        setKnowledgeEmbeddingApiKey('')
        setClearKnowledgeEmbeddingApiKey(false)
        setWorkspacePath(value.workspacePath)
        setToolApproval(
          value.toolApproval === 'policy' ? 'policy' : 'always'
        )
        setSubagentSmartRoutingEnabled(
          value.subagentSmartRoutingEnabled
        )
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '读取设置失败')
      })
    void window.goodbuddy.settings
      .detectAgentRuntimes()
      .then(setDetection)
      .catch((reason: unknown) => {
        setError(
          reason instanceof Error ? reason.message : 'Runtime 自动检测失败'
        )
      })
  }, [open])

  if (!open) {
    return null
  }

  const close = (): void => {
    setModelProfiles((profiles) =>
      profiles.map((profile) => ({
        ...profile,
        apiKey: '',
        clearApiKey: false
      }))
    )
    setKnowledgeEmbeddingApiKey('')
    setClearKnowledgeEmbeddingApiKey(false)
    setError(undefined)
    onClose()
  }

  const save = async (): Promise<boolean> => {
    setSaving(true)
    setError(undefined)
    setSaved(false)
    try {
      const defaultProfile =
        modelProfiles.find(
          (profile) => profile.id === defaultModelProfileId
        ) ?? modelProfiles[0]
      if (!defaultProfile) {
        throw new Error('请至少配置一个模型连接')
      }
      const profileInputs = modelProfiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        baseUrl: profile.baseUrl,
        modelName: profile.modelName,
        protocol: profile.protocol,
        authentication: profile.authentication,
        imageGenerationQuality: profile.imageGenerationQuality,
        apiKey: profile.clearApiKey
          ? ({ action: 'clear' } as const)
          : profile.apiKey.trim()
            ? ({
                action: 'replace',
                value: profile.apiKey.trim()
              } as const)
            : ({ action: 'keep' } as const)
      }))
      const value = await window.goodbuddy.settings.updateRuntime({
        provider,
        modelBaseUrl: defaultProfile.baseUrl,
        modelName: defaultProfile.modelName,
        modelProtocol: defaultProfile.protocol,
        modelAuthentication: defaultProfile.authentication,
        imageGenerationQuality:
          defaultProfile.imageGenerationQuality,
        opencodeBaseUrl,
        opencodeEmbedded,
        opencodeBinaryPath,
        opencodeConfigPath,
        continueBinaryPath,
        continueConfigPath,
        continueMode,
        runtimeSandboxMode,
        knowledgeEmbeddingEnabled,
        knowledgeEmbeddingBaseUrl,
        knowledgeEmbeddingModel,
        knowledgeEmbeddingApiKey: clearKnowledgeEmbeddingApiKey
          ? { action: 'clear' }
          : knowledgeEmbeddingApiKey.trim()
            ? {
                action: 'replace',
                value: knowledgeEmbeddingApiKey.trim()
              }
            : { action: 'keep' },
        workspacePath,
        apiKey: profileInputs.find(
          (profile) => profile.id === defaultProfile.id
        )!.apiKey,
        modelProfiles: profileInputs,
        defaultModelProfileId: defaultProfile.id,
        opencodeModelSource,
        continueModelSource,
        toolApproval,
        subagentSmartRoutingEnabled
      })
      setSettings(value)
      setModelProfiles(toModelProfileDrafts(value))
      setSelectedModelProfileId((selectedId) =>
        value.modelProfiles.some((profile) => profile.id === selectedId)
          ? selectedId
          : value.defaultModelProfileId
      )
      setDefaultModelProfileId(value.defaultModelProfileId)
      setOpencodeModelSource(value.opencodeModelSource)
      setContinueModelSource(value.continueModelSource)
      setOpencodeBinaryPath(value.opencodeBinaryPath)
      setOpencodeConfigPath(value.opencodeConfigPath)
      setContinueBinaryPath(value.continueBinaryPath)
      setContinueConfigPath(value.continueConfigPath)
      setContinueMode(value.continueMode)
      setRuntimeSandboxMode(value.runtimeSandboxMode)
      setKnowledgeEmbeddingEnabled(value.knowledgeEmbeddingEnabled)
      setKnowledgeEmbeddingBaseUrl(value.knowledgeEmbeddingBaseUrl)
      setKnowledgeEmbeddingModel(value.knowledgeEmbeddingModel)
      setKnowledgeEmbeddingApiKey('')
      setClearKnowledgeEmbeddingApiKey(false)
      setToolApproval(
        value.toolApproval === 'policy' ? 'policy' : 'always'
      )
      setSubagentSmartRoutingEnabled(
        value.subagentSmartRoutingEnabled
      )
      setSaved(true)
      onSaved(value)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存设置失败')
      return false
    } finally {
      setSaving(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    setTesting(true)
    setConnectionResult(undefined)
    const didSave = await save()
    if (!didSave) {
      setTesting(false)
      return
    }
    try {
      const status = await window.goodbuddy.settings.testRuntime()
      if (!status.available) {
        throw new Error(status.detail)
      }
      setConnectionResult(
        status.capability === 'image-generation'
          ? status.detail
          : `连接成功：${status.label}`
      )
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Runtime 连接测试失败'
      )
    } finally {
      setTesting(false)
    }
  }

  const selectRuntimeFile = async (
    kind: RuntimeFileSelectionKind,
    setValue: (value: string) => void
  ): Promise<void> => {
    try {
      const selected =
        await window.goodbuddy.settings.selectRuntimeFile(kind)
      if (selected) {
        setValue(selected)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '选择文件失败')
    }
  }

  const detectRuntimes = async (): Promise<void> => {
    setDetecting(true)
    setError(undefined)
    try {
      setDetection(
        await window.goodbuddy.settings.detectAgentRuntimes()
      )
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Runtime 自动检测失败'
      )
    } finally {
      setDetecting(false)
    }
  }

  const updateModelProfile = (
    id: string,
    update: Partial<ModelProfileDraft>
  ): void => {
    setModelProfiles((profiles) =>
      profiles.map((profile) =>
        profile.id === id ? { ...profile, ...update } : profile
      )
    )
  }

  const addModelProfile = (): void => {
    const id = crypto.randomUUID()
    setModelProfiles((profiles) => [
      ...profiles,
      {
        id,
        name: `模型连接 ${profiles.length + 1}`,
        baseUrl: defaultRuntimeSettings.modelBaseUrl,
        modelName: defaultRuntimeSettings.modelName,
        protocol: defaultRuntimeSettings.modelProtocol,
        authentication: defaultRuntimeSettings.modelAuthentication,
        imageGenerationQuality:
          defaultRuntimeSettings.imageGenerationQuality,
        apiKeyConfigured: false,
        credentialSource: 'none',
        apiKey: '',
        clearApiKey: false
      }
    ])
    if (!defaultModelProfileId) {
      setDefaultModelProfileId(id)
    }
    setSelectedModelProfileId(id)
  }

  const removeModelProfile = (id: string): void => {
    if (modelProfiles.length <= 1) {
      setError('请至少保留一个模型连接')
      return
    }
    const removedIndex = modelProfiles.findIndex(
      (profile) => profile.id === id
    )
    const remaining = modelProfiles.filter((profile) => profile.id !== id)
    setModelProfiles(remaining)
    if (selectedModelProfileId === id) {
      setSelectedModelProfileId(
        remaining[Math.min(removedIndex, remaining.length - 1)]?.id ??
          remaining[0]!.id
      )
    }
    if (defaultModelProfileId === id) {
      setDefaultModelProfileId(remaining[0]!.id)
    }
    if (
      opencodeModelSource.kind === 'profile' &&
      opencodeModelSource.profileId === id
    ) {
      setOpencodeModelSource({ kind: 'platform' })
    }
    if (
      continueModelSource.kind === 'profile' &&
      continueModelSource.profileId === id
    ) {
      setContinueModelSource({ kind: 'platform' })
    }
  }

  const parseModelSource = (value: string): RuntimeModelSource =>
    value === 'platform'
      ? { kind: 'platform' }
      : { kind: 'profile', profileId: value }

  const isOpenCodeCompatible = (
    profile: ModelProfileDraft
  ): boolean =>
    profile.protocol === 'anthropic-messages' &&
    profile.authentication === 'api-key'

  const isContinueCompatible = (
    profile: ModelProfileDraft
  ): boolean =>
    profile.protocol === 'anthropic-messages' ||
    profile.protocol === 'openai-chat-completions'

  const selectedModelProfile =
    modelProfiles.find(
      (profile) => profile.id === selectedModelProfileId
    ) ?? modelProfiles[0]

  const detectionSummary = (
    value: AgentRuntimeDetection['opencode'] | undefined
  ): React.JSX.Element => (
    <div className="credential-state" aria-live="polite">
      <TerminalSquare size={15} />
      <span>
        {value
          ? [
              value.path || '未找到可执行文件',
              value.version,
              value.detail
            ]
              .filter(Boolean)
              .join(' · ')
          : detecting
            ? '正在检测…'
            : '尚未检测'}
      </span>
    </div>
  )

  return (
    <div
      className={
        presentation === 'page'
          ? 'settings-page'
          : 'settings-backdrop'
      }
      role="presentation"
    >
      <section
        aria-labelledby="settings-title"
        aria-modal={presentation === 'modal' ? 'true' : undefined}
        className="settings-panel"
        role={presentation === 'modal' ? 'dialog' : 'region'}
      >
        <header className="settings-panel__header">
          <div>
            <p className="eyebrow">SETTINGS</p>
            <h2 id="settings-title">设置中心</h2>
            <p className="settings-panel__description">
              管理模型连接、Agent Runtime、自动化、扩展能力和本地数据。
            </p>
          </div>
          <button
            aria-label="关闭设置"
            className="icon-button"
            onClick={close}
            type="button"
          >
            <X size={19} />
          </button>
        </header>

        <div className="settings-panel__body">
          <nav
            aria-label="设置分类"
            aria-orientation="vertical"
            className="settings-tabs"
            role="tablist"
          >
            <button
              aria-controls="settings-panel-appearance"
              aria-label="外观"
              aria-selected={activeTab === 'appearance'}
              id="settings-tab-appearance"
              onClick={() => setActiveTab('appearance')}
              onKeyDown={(event) =>
                handleTabKeyDown(event, 'appearance')
              }
              role="tab"
              tabIndex={activeTab === 'appearance' ? 0 : -1}
              type="button"
            >
              <strong>外观</strong>
              <small>亮色、暗色与系统主题</small>
            </button>
            <button
              aria-controls="settings-panel-model"
              aria-label="模型连接"
              aria-selected={activeTab === 'model'}
              id="settings-tab-model"
              onClick={() => setActiveTab('model')}
              onKeyDown={(event) =>
                handleTabKeyDown(event, 'model')
              }
              role="tab"
              tabIndex={activeTab === 'model' ? 0 : -1}
              type="button"
            >
              <strong>模型连接</strong>
              <small>LLM、向量模型与凭据</small>
            </button>
            <button
              aria-controls="settings-panel-runtime"
              aria-label="Agent Runtime"
              aria-selected={activeTab === 'runtime'}
              id="settings-tab-runtime"
              onClick={() => setActiveTab('runtime')}
              onKeyDown={(event) =>
                handleTabKeyDown(event, 'runtime')
              }
              role="tab"
              tabIndex={activeTab === 'runtime' ? 0 : -1}
              type="button"
            >
              <strong>Agent Runtime</strong>
              <small>OpenCode、Continue 与工作区</small>
            </button>
            <button
              aria-controls="settings-panel-security"
              aria-label="安全与数据"
              aria-selected={activeTab === 'security'}
              id="settings-tab-security"
              onClick={() => setActiveTab('security')}
              onKeyDown={(event) =>
                handleTabKeyDown(event, 'security')
              }
              role="tab"
              tabIndex={activeTab === 'security' ? 0 : -1}
              type="button"
            >
              <strong>安全与数据</strong>
              <small>工具策略与本地隐私</small>
            </button>
            <button
              aria-controls="settings-panel-automation"
              aria-label="自动化"
              aria-selected={activeTab === 'automation'}
              id="settings-tab-automation"
              onClick={() => setActiveTab('automation')}
              onKeyDown={(event) =>
                handleTabKeyDown(event, 'automation')
              }
              role="tab"
              tabIndex={activeTab === 'automation' ? 0 : -1}
              type="button"
            >
              <strong>自动化</strong>
              <small>智能心跳与周期回顾</small>
            </button>
            <button
              aria-controls="settings-panel-roles"
              aria-label="角色与提示词"
              aria-selected={activeTab === 'roles'}
              id="settings-tab-roles"
              onClick={() => setActiveTab('roles')}
              onKeyDown={(event) =>
                handleTabKeyDown(event, 'roles')
              }
              role="tab"
              tabIndex={activeTab === 'roles' ? 0 : -1}
              type="button"
            >
              <strong>角色与提示词</strong>
              <small>角色、说明与系统提示词</small>
            </button>
            <button
              aria-controls="settings-panel-skills"
              aria-label="Skills"
              aria-selected={activeTab === 'skills'}
              id="settings-tab-skills"
              onClick={() => setActiveTab('skills')}
              onKeyDown={(event) =>
                handleTabKeyDown(event, 'skills')
              }
              role="tab"
              tabIndex={activeTab === 'skills' ? 0 : -1}
              type="button"
            >
              <strong>Skills</strong>
              <small>内置与自定义能力</small>
            </button>
            <button
              aria-controls="settings-panel-mcp"
              aria-label="MCP"
              aria-selected={activeTab === 'mcp'}
              id="settings-tab-mcp"
              onClick={() => setActiveTab('mcp')}
              onKeyDown={(event) =>
                handleTabKeyDown(event, 'mcp')
              }
              role="tab"
              tabIndex={activeTab === 'mcp' ? 0 : -1}
              type="button"
            >
              <strong>MCP</strong>
              <small>工具服务与凭据</small>
            </button>
          </nav>

          <div
            aria-labelledby={`settings-tab-${activeTab}`}
            className="settings-panel__content"
            id={`settings-panel-${activeTab}`}
            role="tabpanel"
          >
          {activeTab === 'appearance' && (
            <div className="settings-section appearance-settings">
              <div className="settings-section__title">
                <SunMoon size={17} />
                <div>
                  <strong>界面主题</strong>
                  <small>选择后立即应用，并保存在此设备</small>
                </div>
              </div>
              <div
                aria-label="界面主题"
                className="appearance-options"
                role="radiogroup"
              >
                {(
                  [
                    ['system', '跟随系统', '随操作系统自动切换'],
                    ['light', '亮色', '明亮、清晰的工作界面'],
                    ['dark', '暗色', '降低暗光环境下的亮度']
                  ] as const
                ).map(([value, label, description]) => (
                  <label key={value}>
                    <input
                      checked={appearanceTheme === value}
                      name="appearance-theme"
                      onChange={() => onAppearanceThemeChange(value)}
                      type="radio"
                      value={value}
                    />
                    <span
                      aria-hidden="true"
                      className={`appearance-options__preview appearance-options__preview--${value}`}
                    >
                      <i />
                      <i />
                      <i />
                    </span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </label>
                ))}
              </div>
            </div>
          )}
          {activeTab === 'runtime' && (
            <>
              {settings?.warning && (
                <p className="settings-warning">{settings.warning}</p>
              )}
          <label className="field">
            <span>默认 Runtime</span>
            <select
              value={provider}
              onChange={(event) =>
                setProvider(
                  event.target.value as RuntimeSettingsInput['provider']
                )
              }
            >
              <option value="auto">自动选择</option>
              <option value="model">直连模型（模型接口）</option>
              <option value="opencode">OpenCode Agent</option>
              <option value="continue">Continue CLI Agent</option>
            </select>
            <small>
              自动模式优先使用已配置的 OpenCode，其次使用已配置的模型接口。
            </small>
          </label>

          <div className="settings-section">
            <div className="settings-section__title">
              <FolderOpen size={17} />
              <div>
                <strong>工作区</strong>
                <small>Agent 工具只能以此目录作为默认工作位置</small>
              </div>
            </div>
            <label className="field">
              <span>工作区目录</span>
              <div className="workspace-picker">
                <input
                  aria-label="工作区目录"
                  onChange={(event) => setWorkspacePath(event.target.value)}
                  value={workspacePath}
                />
                <button
                  className="secondary-button"
                  onClick={() => {
                    void window.goodbuddy.settings
                      .selectWorkspace()
                      .then((selected) => {
                        if (selected) {
                          setWorkspacePath(selected)
                        }
                      })
                      .catch((reason: unknown) => {
                        setError(
                          reason instanceof Error
                            ? reason.message
                            : '选择工作区目录失败'
                        )
                      })
                  }}
                  type="button"
                >
                  选择
                </button>
              </div>
            </label>
          </div>

          <div className="settings-section">
            <div className="settings-section__title">
              <TerminalSquare size={17} />
              <div>
                <strong>Runtime 自动检测</strong>
                <small>仅检测程序路径和版本，不读取配置文件内容</small>
              </div>
            </div>
            <button
              className="secondary-button"
              disabled={detecting}
              onClick={() => void detectRuntimes()}
              type="button"
            >
              {detecting ? '检测中…' : '重新检测'}
            </button>
          </div>

          {(provider === 'opencode' || provider === 'auto') && (
            <div className="settings-section">
              <div className="settings-section__title">
                <TerminalSquare size={17} />
                <div>
                  <strong>OpenCode Agent</strong>
                  <small>连接现有服务或由 GoodBuddy 启动本机服务</small>
                </div>
              </div>
              <label className="field">
                <span>模型连接</span>
                <select
                  value={
                    opencodeModelSource.kind === 'platform'
                      ? 'platform'
                      : opencodeModelSource.profileId
                  }
                  onChange={(event) =>
                    setOpencodeModelSource(
                      parseModelSource(event.target.value)
                    )
                  }
                >
                  <option value="platform">使用 OpenCode 平台默认</option>
                  {modelProfiles.map((profile) => (
                    <option
                      disabled={!isOpenCodeCompatible(profile)}
                      key={profile.id}
                      value={profile.id}
                    >
                      独立配置：{profile.name}
                      {isOpenCodeCompatible(profile)
                        ? '（兼容）'
                        : '（不兼容）'}
                    </option>
                  ))}
                </select>
                {opencodeModelSource.kind === 'profile' && (
                    <small>
                      OpenCode 独立配置仅支持需要 API Key 的 Anthropic
                      Messages 连接
                      {opencodeBaseUrl
                        ? '，且仅支持由 GoodBuddy 启动的本机 OpenCode。'
                        : '。'}
                    </small>
                  )}
              </label>
              <div className="runtime-note">
                OpenCode 固定以 Execute 运行，不弹出 GoodBuddy 工具审批；工具调用仍记录到活动。
              </div>
              <label className="field">
                <span>Server 地址</span>
                <input
                  inputMode="url"
                  onChange={(event) =>
                    setOpencodeBaseUrl(event.target.value)
                  }
                  placeholder="例如 http://127.0.0.1:4096"
                  value={opencodeBaseUrl}
                />
              </label>
              <label className="check-field">
                <input
                  checked={opencodeEmbedded}
                  onChange={(event) =>
                    setOpencodeEmbedded(event.target.checked)
                  }
                  type="checkbox"
                />
                <span>没有 Server 地址时，自动启动本机 OpenCode</span>
              </label>
              <label className="field">
                <span>OpenCode 可执行文件路径</span>
                <div className="workspace-picker">
                  <input
                    aria-label="OpenCode 可执行文件路径"
                    onChange={(event) =>
                      setOpencodeBinaryPath(event.target.value)
                    }
                    placeholder="留空使用内置版本"
                    value={opencodeBinaryPath}
                  />
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void selectRuntimeFile(
                        'opencodeBinary',
                        setOpencodeBinaryPath
                      )
                    }
                    type="button"
                  >
                    选择
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!opencodeBinaryPath}
                    onClick={() => setOpencodeBinaryPath('')}
                    type="button"
                  >
                    清除
                  </button>
                </div>
              </label>
              <label className="field">
                <span>OpenCode 配置文件路径</span>
                <div className="workspace-picker">
                  <input
                    aria-label="OpenCode 配置文件路径"
                    onChange={(event) =>
                      setOpencodeConfigPath(event.target.value)
                    }
                    placeholder="留空使用工具默认配置"
                    value={opencodeConfigPath}
                  />
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void selectRuntimeFile(
                        'opencodeConfig',
                        setOpencodeConfigPath
                      )
                    }
                    type="button"
                  >
                    选择
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!opencodeConfigPath}
                    onClick={() => setOpencodeConfigPath('')}
                    type="button"
                  >
                    清除
                  </button>
                </div>
              </label>
              {opencodeBinaryPath && (
                <p className="settings-warning">
                  自定义 OpenCode 可执行文件将以当前用户权限运行，请仅选择可信文件。
                </p>
              )}
              {detectionSummary(detection?.opencode)}
            </div>
          )}

          {(provider === 'continue' || provider === 'auto') && (
            <div className="settings-section">
              <div className="settings-section__title">
                <TerminalSquare size={17} />
                <div>
                  <strong>Continue CLI</strong>
                  <small>使用本机已安装的 Continue headless CLI</small>
                </div>
              </div>
              <div className="runtime-note">
                Continue 固定以 Execute 运行，不弹出 GoodBuddy 工具审批；工具调用仍记录到活动。
              </div>
              <label className="field">
                <span>模型连接</span>
                <select
                  value={
                    continueModelSource.kind === 'platform'
                      ? 'platform'
                      : continueModelSource.profileId
                  }
                  onChange={(event) =>
                    setContinueModelSource(
                      parseModelSource(event.target.value)
                    )
                  }
                >
                  <option value="platform">使用指定的 Continue 配置文件</option>
                  {modelProfiles.map((profile) => (
                    <option
                      disabled={!isContinueCompatible(profile)}
                      key={profile.id}
                      value={profile.id}
                    >
                      独立配置：{profile.name}
                      {isContinueCompatible(profile)
                        ? '（兼容）'
                        : '（不兼容）'}
                    </option>
                  ))}
                </select>
                <small>
                  Continue 独立连接支持 Anthropic Messages、OpenAI
                  兼容 Chat Completions 和无认证本机模型。未选择独立连接时，必须在下方指定配置文件。
                </small>
              </label>
              <label className="field">
                <span>Continue 可执行文件路径</span>
                <div className="workspace-picker">
                  <input
                    aria-label="Continue 可执行文件路径"
                    onChange={(event) =>
                      setContinueBinaryPath(event.target.value)
                    }
                    placeholder="留空使用内置版本"
                    value={continueBinaryPath}
                  />
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void selectRuntimeFile(
                        'continueBinary',
                        setContinueBinaryPath
                      )
                    }
                    type="button"
                  >
                    选择
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!continueBinaryPath}
                    onClick={() => setContinueBinaryPath('')}
                    type="button"
                  >
                    清除
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Continue 配置文件路径</span>
                <div className="workspace-picker">
                  <input
                    aria-label="Continue 配置文件路径"
                    onChange={(event) =>
                      setContinueConfigPath(event.target.value)
                    }
                    placeholder="选择可信的本地 Continue 配置文件"
                    value={continueConfigPath}
                  />
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void selectRuntimeFile(
                        'continueConfig',
                        setContinueConfigPath
                      )
                    }
                    type="button"
                  >
                    选择
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!continueConfigPath}
                    onClick={() => setContinueConfigPath('')}
                    type="button"
                  >
                    清除
                  </button>
                </div>
              </label>
              {continueModelSource.kind === 'platform' &&
                !continueConfigPath && (
                  <p className="settings-warning">
                    未指定配置文件时 Continue 将保持不可用，不会匿名加载远程默认模型。
                  </p>
                )}
              {continueBinaryPath && (
                <p className="settings-warning">
                  自定义 Continue 可执行文件将以当前用户权限运行，请仅选择可信文件。
                </p>
              )}
              {detectionSummary(detection?.continue)}
            </div>
          )}
            </>
          )}

          {activeTab === 'model' && (
            <>
          <div className="model-type-navigation">
            <SegmentedControl
              ariaLabel="模型类型"
              onChange={setModelType}
              options={[
                { label: 'LLM 模型', value: 'llm' },
                { label: '向量模型', value: 'embedding' }
              ]}
              value={modelType}
            />
            <small>
              {modelType === 'llm'
                ? '配置对话、推理和图片生成使用的模型连接。'
                : '配置知识库语义检索与 GraphRAG 使用的向量模型。'}
            </small>
          </div>
          {modelType === 'llm' && (
          <div className="settings-section">
            <div className="settings-section__title settings-section__title--actions">
              <KeyRound size={17} />
              <div>
                <strong>LLM 模型连接</strong>
                <small>
                  支持 OpenAI Responses、Anthropic Messages 和
                  OpenAI 兼容 Chat Completions；图片模型使用独立的
                  OpenAI Images Generations 接口类型
                </small>
              </div>
              <button
                className="secondary-button model-connection-add"
                onClick={addModelProfile}
                type="button"
              >
                <Plus size={14} />
                添加自定义
              </button>
            </div>
            <div className="model-connection-manager">
              <aside
                aria-label="模型连接列表"
                className="model-connection-list"
              >
                <div className="model-connection-list__header">
                  <strong>连接列表</strong>
                  <span>{modelProfiles.length}</span>
                </div>
                <div role="list">
                  {modelProfiles.map((profile) => (
                    <div key={profile.id} role="listitem">
                      <button
                        aria-current={
                          selectedModelProfile?.id === profile.id
                            ? 'page'
                            : undefined
                        }
                        aria-label={`编辑模型连接 ${profile.name}`}
                        onClick={() =>
                          setSelectedModelProfileId(profile.id)
                        }
                        type="button"
                      >
                        <span className="model-connection-list__name">
                          <strong>{profile.name}</strong>
                          <small>{profile.modelName}</small>
                        </span>
                        <span className="model-connection-list__badges">
                          {defaultModelProfileId === profile.id && (
                            <span>默认</span>
                          )}
                          {profile.protocol ===
                            'openai-images-generations' && (
                            <span>图像</span>
                          )}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              </aside>
              {selectedModelProfile && (() => {
                const profile = selectedModelProfile
              const environmentManaged =
                profile.credentialSource === 'environment'
              return (
                <div
                  aria-labelledby={`model-connection-${profile.id}`}
                  className="model-connection-detail"
                  key={profile.id}
                >
                  <div className="settings-section__title">
                    <div>
                      <strong id={`model-connection-${profile.id}`}>
                        {profile.name}
                      </strong>
                      <small>连接详情</small>
                    </div>
                    <label className="check-field">
                      <input
                        checked={defaultModelProfileId === profile.id}
                        name="default-model-profile"
                        onChange={() =>
                          setDefaultModelProfileId(profile.id)
                        }
                        type="radio"
                      />
                      <span>默认连接</span>
                    </label>
                    {profile.protocol === 'openai-images-generations' && (
                      <span className="model-capability-badge">
                        图像生成
                      </span>
                    )}
                    <button
                      aria-label={`删除模型连接 ${profile.name}`}
                      className="icon-button"
                      disabled={modelProfiles.length <= 1}
                      onClick={() => removeModelProfile(profile.id)}
                      type="button"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <label className="field">
                    <span>名称</span>
                    <input
                      onChange={(event) =>
                        updateModelProfile(profile.id, {
                          name: event.target.value
                        })
                      }
                      value={profile.name}
                    />
                  </label>
                  <label className="field">
                    <span>模型接口 URL</span>
                    <input
                      disabled={environmentManaged}
                      inputMode="url"
                      onChange={(event) =>
                        updateModelProfile(profile.id, {
                          baseUrl: event.target.value
                        })
                      }
                      value={profile.baseUrl}
                    />
                  </label>
                  <label className="field">
                    <span>模型</span>
                    <input
                      disabled={environmentManaged}
                      onChange={(event) =>
                        updateModelProfile(profile.id, {
                          modelName: event.target.value
                        })
                      }
                      value={profile.modelName}
                    />
                  </label>
                  <label className="field">
                    <span>接口协议</span>
                    <select
                      aria-label={`接口协议 ${profile.name}`}
                      onChange={(event) =>
                        {
                          const protocol = event.target
                            .value as ModelProfileDraft['protocol']
                          updateModelProfile(profile.id, { protocol })
                          if (
                            protocol !== 'anthropic-messages' &&
                            opencodeModelSource.kind === 'profile' &&
                            opencodeModelSource.profileId === profile.id
                          ) {
                            setOpencodeModelSource({ kind: 'platform' })
                          }
                          if (
                            protocol !== 'anthropic-messages' &&
                            protocol !== 'openai-chat-completions' &&
                            continueModelSource.kind === 'profile' &&
                            continueModelSource.profileId === profile.id
                          ) {
                            setContinueModelSource({ kind: 'platform' })
                          }
                        }
                      }
                      value={profile.protocol}
                    >
                      <option value="anthropic-messages">
                        Anthropic Messages
                      </option>
                      <option value="openai-responses">
                        OpenAI Responses
                      </option>
                      <option value="openai-chat-completions">
                        OpenAI 兼容 Chat Completions
                      </option>
                      <option value="openai-images-generations">
                        OpenAI Images Generations（图像生成）
                      </option>
                    </select>
                  </label>
                  <label className="field">
                    <span>认证方式</span>
                    <select
                      aria-label={`认证方式 ${profile.name}`}
                      onChange={(event) => {
                        const authentication = event.target
                          .value as ModelProfileDraft['authentication']
                        updateModelProfile(profile.id, {
                          authentication,
                          apiKey: '',
                          clearApiKey:
                            authentication === 'none' &&
                            profile.apiKeyConfigured
                        })
                        if (
                          authentication !== 'api-key' &&
                          opencodeModelSource.kind === 'profile' &&
                          opencodeModelSource.profileId === profile.id
                        ) {
                          setOpencodeModelSource({ kind: 'platform' })
                        }
                      }}
                      value={profile.authentication}
                    >
                      <option value="api-key">API Key</option>
                      <option value="none">无需认证</option>
                    </select>
                  </label>
                  {profile.protocol ===
                    'openai-images-generations' && (
                      <label className="field">
                        <span>图片质量</span>
                        <select
                          aria-label={`图片质量 ${profile.name}`}
                          onChange={(event) =>
                            updateModelProfile(profile.id, {
                              imageGenerationQuality: event.target
                                .value as ModelProfileDraft['imageGenerationQuality']
                            })
                          }
                          value={profile.imageGenerationQuality}
                        >
                          <option value="auto">自动</option>
                          <option value="low">低</option>
                          <option value="medium">中</option>
                          <option value="high">高</option>
                        </select>
                        <small>
                          仅用于 OpenAI 兼容图像生成请求。
                        </small>
                      </label>
                    )}
                  {profile.authentication === 'api-key' ? (
                    <>
                      <label className="field">
                        <span>API Key</span>
                        <input
                          autoComplete="off"
                          disabled={
                            environmentManaged ||
                            !settings?.secureStorageAvailable
                          }
                          onChange={(event) =>
                            updateModelProfile(profile.id, {
                              apiKey: event.target.value,
                              clearApiKey: false
                            })
                          }
                          placeholder={
                            profile.apiKeyConfigured
                              ? '已配置，留空保持不变'
                              : '输入 API Key'
                          }
                          type="password"
                          value={profile.apiKey}
                        />
                      </label>
                      <div className="credential-state">
                        <LockKeyhole size={15} />
                        <span>
                          {credentialLabels[profile.credentialSource]}
                        </span>
                        {profile.credentialSource === 'encrypted' && (
                          <button
                            onClick={() =>
                              updateModelProfile(profile.id, {
                                apiKey: '',
                                clearApiKey: true
                              })
                            }
                            type="button"
                          >
                            {profile.clearApiKey
                              ? '保存后清除'
                              : '清除凭据'}
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="credential-state">
                      <LockKeyhole size={15} />
                      <span>无需认证，不会发送 API Key</span>
                    </div>
                  )}
                  <small className="model-connection-detail__compatibility">
                    直连模型：
                    {profile.protocol === 'openai-images-generations'
                      ? '图像生成'
                      : '文本对话'}{' '}
                    · Continue：
                    {isContinueCompatible(profile) ? '兼容' : '不兼容'} ·
                    OpenCode：
                    {isOpenCodeCompatible(profile)
                      ? '兼容'
                      : '不兼容（仅支持 Anthropic Messages + API Key）'}
                  </small>
                </div>
              )
              })()}
            </div>
            {settings && !settings.secureStorageAvailable && (
              <p className="settings-warning">
                当前系统密钥服务不可用。为了避免明文落盘，请使用环境变量提供
                API Key。
              </p>
            )}
          </div>
          )}
          {modelType === 'embedding' && (
            <div className="settings-section">
              <div className="settings-section__title">
                <KeyRound size={17} />
                <div>
                  <strong>向量模型连接</strong>
                  <small>
                    使用 OpenAI 兼容 Embeddings 接口，不限定服务提供商
                  </small>
                </div>
              </div>
              <div className="runtime-note">
                <label className="check-field">
                  <input
                    checked={knowledgeEmbeddingEnabled}
                    onChange={(event) =>
                      setKnowledgeEmbeddingEnabled(event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span>启用向量模型</span>
                </label>
                <label className="field">
                  <span>向量接口 URL</span>
                  <input
                    aria-label="向量接口 URL"
                    disabled={!knowledgeEmbeddingEnabled}
                    inputMode="url"
                    onChange={(event) =>
                      setKnowledgeEmbeddingBaseUrl(event.target.value)
                    }
                    placeholder="https://provider.example/v1/embeddings"
                    value={knowledgeEmbeddingBaseUrl}
                  />
                  <small>
                    填写完整的 OpenAI 兼容 Embeddings 端点。
                  </small>
                </label>
                <label className="field">
                  <span>模型名称</span>
                  <input
                    aria-label="模型名称"
                    disabled={!knowledgeEmbeddingEnabled}
                    onChange={(event) =>
                      setKnowledgeEmbeddingModel(event.target.value)
                    }
                    value={knowledgeEmbeddingModel}
                  />
                </label>
                <label className="field">
                  <span>API Key（可选）</span>
                  <input
                    aria-label="API Key（可选）"
                    autoComplete="off"
                    disabled={
                      !knowledgeEmbeddingEnabled ||
                      settings?.knowledgeEmbeddingCredentialSource ===
                        'environment' ||
                      !settings?.secureStorageAvailable
                    }
                    onChange={(event) => {
                      setKnowledgeEmbeddingApiKey(event.target.value)
                      setClearKnowledgeEmbeddingApiKey(false)
                    }}
                    placeholder={
                      settings?.knowledgeEmbeddingApiKeyConfigured
                        ? '已配置，留空保持不变'
                        : '本地无认证服务可留空'
                    }
                    type="password"
                    value={knowledgeEmbeddingApiKey}
                  />
                </label>
                <div className="credential-state">
                  <LockKeyhole size={15} />
                  <span>
                    {settings
                      ? credentialLabels[
                          settings.knowledgeEmbeddingCredentialSource
                        ]
                      : '尚未配置'}
                  </span>
                  {settings?.knowledgeEmbeddingCredentialSource ===
                    'encrypted' && (
                    <button
                      onClick={() => {
                        setKnowledgeEmbeddingApiKey('')
                        setClearKnowledgeEmbeddingApiKey(true)
                      }}
                      type="button"
                    >
                      {clearKnowledgeEmbeddingApiKey
                        ? '保存后清除'
                        : '清除凭据'}
                    </button>
                  )}
                </div>
                <small>
                  仅向所填接口发送已启用知识库的分块文本。API Key
                  由系统安全存储加密；向量服务失败时自动回退到 FTS5
                  与证据图谱。
                </small>
              </div>
            </div>
          )}
            </>
          )}

          {activeTab === 'security' && (
            <>
          <div className="settings-section subagent-routing-settings">
            <div className="settings-section__title">
              <div>
                <strong>Subagent 智能路由</strong>
                <small>按问题内容自动选择最匹配的专家角色</small>
              </div>
            </div>
            <label className="check-field">
              <input
                aria-describedby="subagent-smart-routing-help"
                checked={subagentSmartRoutingEnabled}
                onChange={(event) =>
                  setSubagentSmartRoutingEnabled(event.target.checked)
                }
                type="checkbox"
              />
              <span>启用 Subagent 智能路由</span>
            </label>
            <small id="subagent-smart-routing-help">
              默认关闭。仅在 Ask 或 Plan 模式且未显式选择专家或团队时，
              自动选择 1 位专家；子专家使用默认文本模型，只读运行且不使用工具。
            </small>
          </div>
          <label className="field">
            <span>Runtime OS 沙箱</span>
            <select
              aria-label="Runtime OS 沙箱"
              value={runtimeSandboxMode}
              onChange={(event) =>
                setRuntimeSandboxMode(
                  event.target
                    .value as RuntimeSettingsInput['runtimeSandboxMode']
                )
              }
            >
              <option value="auto">自动（Linux 优先启用）</option>
              <option value="strict">严格（不可用时拒绝运行）</option>
              <option value="off">关闭</option>
            </select>
            <small>
              首期严格隔离适用于安装 bubblewrap 的 Linux 嵌入式
              OpenCode。外部 Runtime 与 Continue 不会被误标为已沙箱。
            </small>
          </label>
          <label className="field">
            <span>直连模型工具安全策略</span>
            <select
              aria-label="直连模型工具安全策略"
              value={toolApproval}
              onChange={(event) =>
                setToolApproval(
                  event.target.value as RuntimeSettingsInput['toolApproval']
                )
              }
            >
              <option value="always">
                Execute 自动授权已启用的工具
              </option>
              <option value="policy">禁止所有工具执行</option>
            </select>
            <small>
              直连模型的 Execute 模式可使用内置工作区工具及已分配的
              MCP 工具；选择 Execute 即授权当前交互运行自动调用这些工具，
              不再逐次询问。禁止策略会拒绝所有工具调用。OpenCode 与
              Continue 继续使用各自的工具系统。
            </small>
          </label>

          <div className="settings-section settings-section--danger">
            <div>
              <strong>本地数据与隐私</strong>
              <p>
                清除本机对话、活动记录和知识库索引。已保存的 Runtime
                凭据和原目录文件不会被删除。
              </p>
            </div>
            {confirmingClear ? (
              <div className="danger-actions">
                <button
                  className="secondary-button"
                  onClick={() => setConfirmingClear(false)}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="danger-button"
                  onClick={() => {
                    void onClearLocalData()
                      .then(() => {
                        setConfirmingClear(false)
                        setConnectionResult('本地数据已清除')
                        setSaved(true)
                      })
                      .catch((reason: unknown) => {
                        setError(
                          reason instanceof Error
                            ? reason.message
                            : '本地数据清除失败'
                        )
                      })
                  }}
                  type="button"
                >
                  确认清除
                </button>
              </div>
            ) : (
              <button
                className="danger-button"
                onClick={() => setConfirmingClear(true)}
                type="button"
              >
                清除本地数据
              </button>
            )}
          </div>
            </>
          )}
          {activeTab === 'automation' && (
            <div className="settings-section">
              <HeartbeatSettings
                heartbeats={heartbeats}
                onCreate={onCreateHeartbeat}
                onRemove={onRemoveHeartbeat}
                onRunNow={onRunHeartbeat}
                onSetPaused={onSetHeartbeatPaused}
              />
            </div>
          )}
          {activeTab === 'roles' && (
            <RolePromptSettingsSection
              onChanged={onExpertsChanged}
            />
          )}
          {activeTab === 'skills' && <SkillsSettingsSection />}
          {activeTab === 'mcp' && <McpSettingsSection />}
          </div>
        </div>

        <footer className="settings-panel__footer">
          <div className="settings-feedback">
            {error && <span className="settings-error">{error}</span>}
            {saved && (
              <span className="settings-success">
                <Check size={14} />
                {connectionResult ?? '已保存并切换 Runtime'}
              </span>
            )}
          </div>
          <button className="secondary-button" onClick={close} type="button">
            {configurationTab ? '取消' : '关闭'}
          </button>
          {configurationTab && (
            <>
              <button
                className="secondary-button"
                disabled={saving || testing}
                onClick={() => void testConnection()}
                type="button"
              >
                {testing ? '测试中…' : '保存并测试'}
              </button>
              <button
                className="primary-button"
                disabled={saving || testing}
                onClick={() => void save()}
                type="button"
              >
                {saving ? '保存中…' : '保存设置'}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  )
}
