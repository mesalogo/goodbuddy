import {
  Check,
  FolderOpen,
  KeyRound,
  LockKeyhole,
  Plus,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  AgentRuntimeDetection,
  RuntimeFileSelectionKind,
  RuntimeSettings,
  RuntimeSettingsInput,
  RuntimeModelSource
} from '../../shared/contracts'
import { defaultRuntimeSettings } from '../../shared/contracts'
import { McpSettingsSection } from './McpSettingsSection'
import { SkillsSettingsSection } from './SkillsSettingsSection'

type SettingsTab = 'model' | 'runtime' | 'security' | 'skills' | 'mcp'
type ModelProfileDraft = RuntimeSettings['modelProfiles'][number] & {
  apiKey: string
  clearApiKey: boolean
}

type SettingsPanelProps = {
  open: boolean
  presentation?: 'modal' | 'page'
  onClose: () => void
  onSaved: (settings: RuntimeSettings) => void
  onClearLocalData: () => Promise<void>
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
  onClearLocalData
}: SettingsPanelProps): React.JSX.Element | null {
  const [settings, setSettings] = useState<RuntimeSettings>()
  const [provider, setProvider] =
    useState<RuntimeSettingsInput['provider']>(
      defaultRuntimeSettings.provider
    )
  const [modelProfiles, setModelProfiles] = useState<ModelProfileDraft[]>([])
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
  const [workspacePath, setWorkspacePath] = useState<string>(
    defaultRuntimeSettings.workspacePath
  )
  const [toolApproval, setToolApproval] =
    useState<RuntimeSettingsInput['toolApproval']>(
      defaultRuntimeSettings.toolApproval
    )
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [connectionResult, setConnectionResult] = useState<string>()
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [detection, setDetection] = useState<AgentRuntimeDetection>()
  const [detecting, setDetecting] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('runtime')
  const configurationTab =
    activeTab === 'model' ||
    activeTab === 'runtime' ||
    activeTab === 'security'

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
        setSettings(value)
        setProvider(value.provider)
        setModelProfiles(toModelProfileDrafts(value))
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
        setWorkspacePath(value.workspacePath)
        setToolApproval(
          value.toolApproval === 'policy' ? 'policy' : 'always'
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
        opencodeBaseUrl,
        opencodeEmbedded,
        opencodeBinaryPath,
        opencodeConfigPath,
        continueBinaryPath,
        continueConfigPath,
        continueMode,
        workspacePath,
        apiKey: profileInputs.find(
          (profile) => profile.id === defaultProfile.id
        )!.apiKey,
        modelProfiles: profileInputs,
        defaultModelProfileId: defaultProfile.id,
        opencodeModelSource,
        continueModelSource,
        toolApproval
      })
      setSettings(value)
      setModelProfiles(toModelProfileDrafts(value))
      setDefaultModelProfileId(value.defaultModelProfileId)
      setOpencodeModelSource(value.opencodeModelSource)
      setContinueModelSource(value.continueModelSource)
      setOpencodeBinaryPath(value.opencodeBinaryPath)
      setOpencodeConfigPath(value.opencodeConfigPath)
      setContinueBinaryPath(value.continueBinaryPath)
      setContinueConfigPath(value.continueConfigPath)
      setContinueMode(value.continueMode)
      setToolApproval(
        value.toolApproval === 'policy' ? 'policy' : 'always'
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
      setConnectionResult(`连接成功：${status.label}`)
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
        apiKeyConfigured: false,
        credentialSource: 'none',
        apiKey: '',
        clearApiKey: false
      }
    ])
    if (!defaultModelProfileId) {
      setDefaultModelProfileId(id)
    }
  }

  const removeModelProfile = (id: string): void => {
    if (modelProfiles.length <= 1) {
      setError('请至少保留一个模型连接')
      return
    }
    const remaining = modelProfiles.filter((profile) => profile.id !== id)
    setModelProfiles(remaining)
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
              管理模型连接、Agent Runtime、扩展能力和本地数据。
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
          <nav aria-label="设置分类" className="settings-tabs">
            <button
              aria-label="模型连接"
              aria-selected={activeTab === 'model'}
              onClick={() => setActiveTab('model')}
              role="tab"
              type="button"
            >
              <strong>模型连接</strong>
              <small>接口、模型与凭据</small>
            </button>
            <button
              aria-label="Agent Runtime"
              aria-selected={activeTab === 'runtime'}
              onClick={() => setActiveTab('runtime')}
              role="tab"
              type="button"
            >
              <strong>Agent Runtime</strong>
              <small>OpenCode、Continue 与工作区</small>
            </button>
            <button
              aria-label="安全与数据"
              aria-selected={activeTab === 'security'}
              onClick={() => setActiveTab('security')}
              role="tab"
              type="button"
            >
              <strong>安全与数据</strong>
              <small>工具审批与本地隐私</small>
            </button>
            <button
              aria-label="Skills"
              aria-selected={activeTab === 'skills'}
              onClick={() => setActiveTab('skills')}
              role="tab"
              type="button"
            >
              <strong>Skills</strong>
              <small>内置与自定义能力</small>
            </button>
            <button
              aria-label="MCP"
              aria-selected={activeTab === 'mcp'}
              onClick={() => setActiveTab('mcp')}
              role="tab"
              type="button"
            >
              <strong>MCP</strong>
              <small>工具服务与凭据</small>
            </button>
          </nav>

          <div className="settings-panel__content">
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
                    <option key={profile.id} value={profile.id}>
                      独立配置：{profile.name}
                    </option>
                  ))}
                </select>
                {opencodeModelSource.kind === 'profile' &&
                  opencodeBaseUrl && (
                    <small>
                      独立模型连接仅支持由 GoodBuddy 启动的本机 OpenCode。
                    </small>
                  )}
              </label>
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
                Continue 仅在实际请求高风险工具时暂停，并提供仅此次、此会话或永久允许。
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
                  <option value="platform">使用 Continue 平台默认</option>
                  {modelProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      独立配置：{profile.name}
                    </option>
                  ))}
                </select>
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
                    placeholder="留空使用工具默认配置"
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
          <div className="settings-section">
            <div className="settings-section__title">
              <KeyRound size={17} />
              <div>
                <strong>模型连接</strong>
                <small>可配置多个 Anthropic Messages 兼容接口</small>
              </div>
              <button
                className="secondary-button"
                onClick={addModelProfile}
                type="button"
              >
                <Plus size={14} />
                添加
              </button>
            </div>
            {modelProfiles.map((profile) => {
              const environmentManaged =
                profile.credentialSource === 'environment'
              return (
                <div className="runtime-note" key={profile.id}>
                  <div className="settings-section__title">
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
                </div>
              )
            })}
            {settings && !settings.secureStorageAvailable && (
              <p className="settings-warning">
                当前系统密钥服务不可用。为了避免明文落盘，请使用环境变量提供
                API Key。
              </p>
            )}
          </div>
            </>
          )}

          {activeTab === 'security' && (
            <>
          <label className="field">
            <span>Agent 工具安全策略</span>
            <select
              value={toolApproval}
              onChange={(event) =>
                setToolApproval(
                  event.target.value as RuntimeSettingsInput['toolApproval']
                )
              }
            >
              <option value="always">调用时询问</option>
              <option value="policy">禁止所有工具执行</option>
            </select>
            <small>
              Continue 会在具体高风险工具调用时提供仅此次、此会话和永久允许。
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
