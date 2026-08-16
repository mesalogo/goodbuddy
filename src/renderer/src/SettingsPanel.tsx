import {
  FolderOpen,
  KeyRound,
  LockKeyhole,
  Plus,
  Save,
  SunMoon,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantExpert,
  AssistantHeartbeatConfig,
  AssistantProject,
  HeartbeatCreateInput,
  ProjectCreateInput,
  ProjectChannel
} from '../../shared/assistant-contracts'
import type {
  AgentRuntimeDetection,
  ContextCompressionSettings,
  RuntimeConfigActionInput,
  RuntimeFileSelectionKind,
  RuntimeSettings,
  RuntimeSettingsInput,
  RuntimeModelSource
} from '../../shared/contracts'
import {
  defaultContextCompressionSettings,
  defaultModelProfileId as builtInDefaultModelProfileId,
  defaultRuntimeSettings,
  isAgentRuntimeModelProtocol,
  isDeepSeekHarnessModelProfile
} from '../../shared/contracts'
import { McpSettingsSection } from './McpSettingsSection'
import { RolePromptSettingsSection } from './RolePromptSettingsSection'
import { SkillsSettingsSection } from './SkillsSettingsSection'
import { HeartbeatSettings } from './HeartbeatSettings'
import { ChannelSettingsSection } from './ChannelSettingsSection'
import { UpdateSettingsSection } from './UpdateSettingsSection'
import { PlatformFeaturesSettingsSection } from './PlatformFeaturesSettingsSection'
import { SpeechModelSettingsSection } from './SpeechModelSettingsSection'
import { EmbeddingSettingsSection } from './EmbeddingSettingsSection'
import { DocumentParsingSettingsSection } from './DocumentParsingSettingsSection'
import { DshMarketplaceSection } from './DshMarketplaceSection'
import {
  RuntimeCustomizationSection,
  type RuntimeCustomizationSectionHandle
} from './RuntimeCustomizationSection'
import { PageHeader, SegmentedControl } from './WorkspacePrimitives'
import {
  SettingsCategoryHeader,
  SettingsWarningList
} from './SettingsPrimitives'
import {
  settingsCategoryList,
  type SettingsCategoryId
} from './settings-categories'
import type { AppearanceTheme } from './theme'
import type { AppNotificationInput } from './notifications'
import type {
  EmbeddingDiagnosticResult,
  EmbeddingConfigurationSummary
} from '../../shared/embedding-contracts'
import { useUiLocale } from './i18n/UiLocaleProvider'

type ModelType = 'llm' | 'embedding' | 'rerank' | 'speech'
type AgentRuntimeType =
  | RuntimeConfigActionInput['runtime']
  | 'deepseek-harness'
type ModelProfileDraft = RuntimeSettings['modelProfiles'][number] & {
  supportsImageInput: boolean
  apiKey: string
  clearApiKey: boolean
}

const settingsTabs = settingsCategoryList.map(({ id }) => id)
const contextCompressionTokenScale = 1_000
const minimumContextCompressionTriggerThousands = 8
const maximumContextCompressionTriggerThousands = 1_000
const minimumContextCompressionRecentRawThousands = 4
const maximumContextCompressionRecentRawThousands = 256

type ContextCompressionTokenDrafts = {
  trigger: string
  recentRaw: string
}

function contextCompressionTokenDrafts(
  settings: ContextCompressionSettings
): ContextCompressionTokenDrafts {
  return {
    trigger: String(
      settings.triggerTokens / contextCompressionTokenScale
    ),
    recentRaw: String(
      settings.recentRawTokens / contextCompressionTokenScale
    )
  }
}

function parseContextCompressionTokenDraft(
  value: string
): number | undefined {
  if (!value.trim()) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed)
    ? Math.round(parsed * contextCompressionTokenScale)
    : undefined
}

function maximumContextCompressionRecentRawThousandsFor(
  triggerTokens: number
): number {
  return Math.max(
    minimumContextCompressionRecentRawThousands,
    Math.min(
      maximumContextCompressionRecentRawThousands,
      triggerTokens / contextCompressionTokenScale - 1
    )
  )
}

function normalizeContextCompressionTokenDrafts(
  settings: ContextCompressionSettings,
  drafts: ContextCompressionTokenDrafts
): ContextCompressionSettings {
  const triggerTokens = Math.min(
    maximumContextCompressionTriggerThousands *
      contextCompressionTokenScale,
    Math.max(
      minimumContextCompressionTriggerThousands *
        contextCompressionTokenScale,
      parseContextCompressionTokenDraft(drafts.trigger) ??
        settings.triggerTokens
    )
  )
  const maximumRecentRawTokens =
    maximumContextCompressionRecentRawThousandsFor(triggerTokens) *
    contextCompressionTokenScale
  const recentRawTokens = Math.min(
    maximumRecentRawTokens,
    Math.max(
      minimumContextCompressionRecentRawThousands *
        contextCompressionTokenScale,
      parseContextCompressionTokenDraft(drafts.recentRaw) ??
        settings.recentRawTokens
    )
  )
  return {
    ...settings,
    triggerTokens,
    recentRawTokens
  }
}

type SettingsPanelProps = {
  open: boolean
  presentation?: 'modal' | 'page'
  initialCategory?: SettingsCategoryId
  initialChannel?: ProjectChannel
  onClose: () => void
  onSaved: (settings: RuntimeSettings) => void
  onNotify?: (notification: AppNotificationInput) => void
  onUpdateProject: (
    projectId: string,
    input: ProjectCreateInput
  ) => Promise<AssistantProject>
  projects: AssistantProject[]
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
  magicNotesEnabled?: boolean
  onMagicNotesEnabledChange?: (enabled: boolean) => void
}

function settingsErrorMessage(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) {
    return fallback
  }
  const message = reason.message.replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/u,
    ''
  )
  try {
    const issues: unknown = JSON.parse(message)
    if (
      Array.isArray(issues) &&
      typeof issues[0] === 'object' &&
      issues[0] !== null &&
      'message' in issues[0] &&
      typeof issues[0].message === 'string'
    ) {
      return issues[0].message
    }
  } catch {
    // Keep provider and local errors as-is when they are not validation JSON.
  }
  return message
}

function toModelProfileDrafts(
  settings: RuntimeSettings
): ModelProfileDraft[] {
  return settings.modelProfiles.map((profile) => ({
    ...profile,
    supportsImageInput: profile.supportsImageInput ?? false,
    apiKey: '',
    clearApiKey: false
  }))
}

function configuredRuntimeSettings(
  settings: RuntimeSettings
): NonNullable<RuntimeSettings['configured']> {
  return settings.configured ?? {
    modelProfiles: settings.modelProfiles,
    opencodeBaseUrl: settings.opencodeBaseUrl,
    opencodeBinaryPath: settings.opencodeBinaryPath,
    opencodeConfigPath: settings.opencodeConfigPath,
    continueBinaryPath: settings.continueBinaryPath,
    continueConfigPath: settings.continueConfigPath,
    workspacePath: settings.workspacePath,
    opencodeModelSource: settings.opencodeModelSource,
    continueModelSource: settings.continueModelSource,
    deepseekHarnessModelSource:
      settings.deepseekHarnessModelSource
  }
}

type RuntimeDraftSelection =
  | string
  | ((selectedId: string) => string)

function hydrateRuntimeSettings(
  value: RuntimeSettings,
  setters: {
    settings: (value: RuntimeSettings) => void
    provider: (value: RuntimeSettings['provider']) => void
    modelProfiles: (value: ModelProfileDraft[]) => void
    selectedModelProfileId: (value: RuntimeDraftSelection) => void
    defaultModelProfileId: (value: string) => void
    opencodeModelSource: (value: RuntimeModelSource) => void
    continueModelSource: (value: RuntimeModelSource) => void
    deepseekHarnessModelSource: (value: RuntimeModelSource) => void
    opencodeBaseUrl: (value: string) => void
    opencodeBinaryPath: (value: string) => void
    opencodeConfigPath: (value: string) => void
    continueBinaryPath: (value: string) => void
    continueConfigPath: (value: string) => void
    continueMode: (value: RuntimeSettings['continueMode']) => void
    knowledgeEmbeddingEnabled: (value: boolean) => void
    knowledgeEmbeddingBaseUrl: (value: string) => void
    knowledgeEmbeddingModel: (value: string) => void
    knowledgeEmbeddingApiKey: (value: string) => void
    clearKnowledgeEmbeddingApiKey: (value: boolean) => void
    knowledgeRerankEnabled: (value: boolean) => void
    knowledgeRerankEndpoint: (value: string) => void
    knowledgeRerankModel: (value: string) => void
    knowledgeRerankApiKey: (value: string) => void
    clearKnowledgeRerankApiKey: (value: boolean) => void
    workspacePath: (value: string) => void
    toolApproval: (value: RuntimeSettingsInput['toolApproval']) => void
    subagentSmartRoutingEnabled: (value: boolean) => void
    contextCompression: (value: ContextCompressionSettings) => void
  },
  preserveSelectedProfile = false
): void {
  const configured = configuredRuntimeSettings(value)
  setters.settings(value)
  setters.provider(value.provider)
  setters.modelProfiles(toModelProfileDrafts(value))
  const fallbackProfileId = value.modelProfiles.some(
    (profile) => profile.id === value.defaultModelProfileId
  )
    ? value.defaultModelProfileId
    : value.modelProfiles[0]?.id ?? ''
  setters.selectedModelProfileId(
    preserveSelectedProfile
      ? (selectedId) =>
          value.modelProfiles.some(
            (profile) => profile.id === selectedId
          )
            ? selectedId
            : fallbackProfileId
      : fallbackProfileId
  )
  setters.defaultModelProfileId(value.defaultModelProfileId)
  setters.opencodeModelSource(configured.opencodeModelSource)
  setters.continueModelSource(configured.continueModelSource)
  setters.deepseekHarnessModelSource(
    configured.deepseekHarnessModelSource ?? { kind: 'platform' }
  )
  setters.opencodeBaseUrl(configured.opencodeBaseUrl)
  setters.opencodeBinaryPath(configured.opencodeBinaryPath)
  setters.opencodeConfigPath(configured.opencodeConfigPath)
  setters.continueBinaryPath(configured.continueBinaryPath)
  setters.continueConfigPath(configured.continueConfigPath)
  setters.continueMode(value.continueMode)
  setters.knowledgeEmbeddingEnabled(value.knowledgeEmbeddingEnabled)
  setters.knowledgeEmbeddingBaseUrl(value.knowledgeEmbeddingBaseUrl)
  setters.knowledgeEmbeddingModel(value.knowledgeEmbeddingModel)
  setters.knowledgeEmbeddingApiKey('')
  setters.clearKnowledgeEmbeddingApiKey(false)
  setters.knowledgeRerankEnabled(
    value.knowledgeRerankEnabled ??
      defaultRuntimeSettings.knowledgeRerankEnabled
  )
  setters.knowledgeRerankEndpoint(
    value.knowledgeRerankEndpoint ??
      defaultRuntimeSettings.knowledgeRerankEndpoint
  )
  setters.knowledgeRerankModel(
    value.knowledgeRerankModel ??
      defaultRuntimeSettings.knowledgeRerankModel
  )
  setters.knowledgeRerankApiKey('')
  setters.clearKnowledgeRerankApiKey(false)
  setters.workspacePath(configured.workspacePath)
  setters.toolApproval(
    value.toolApproval === 'policy' ? 'policy' : 'always'
  )
  setters.subagentSmartRoutingEnabled(
    value.subagentSmartRoutingEnabled
  )
  setters.contextCompression(
    value.contextCompression ?? defaultContextCompressionSettings
  )
}

type RuntimeConfigCardProps = {
  runtime: RuntimeConfigActionInput['runtime']
  runtimeLabel: string
  description: string
  fileKind: Extract<
    RuntimeFileSelectionKind,
    'opencodeConfig' | 'continueConfig'
  >
  path: string
  savedPath?: string
  onPathChange: (value: string) => void
  onSelect: (
    kind: RuntimeFileSelectionKind,
    setValue: (value: string) => void
  ) => Promise<void>
  onOpen: (
    runtime: RuntimeConfigActionInput['runtime'],
    action: RuntimeConfigActionInput['action']
  ) => Promise<void>
}

function RuntimeConfigCard({
  runtime,
  runtimeLabel,
  description,
  fileKind,
  path,
  savedPath,
  onPathChange,
  onSelect,
  onOpen
}: RuntimeConfigCardProps): React.JSX.Element {
  const { t } = useTranslation('settings')
  const saved = Boolean(path) && savedPath === path
  return (
    <div className="runtime-config-card">
      <div>
        <strong>
          {t('runtime.configCard.title', { runtime: runtimeLabel })}
        </strong>
        <small>{description}</small>
      </div>
      <label className="field">
        <span>{t('runtime.configCard.fileLabel')}</span>
        <div className="workspace-picker">
          <input
            aria-label={t('runtime.configCard.pathAriaLabel', {
              runtime: runtimeLabel
            })}
            onChange={(event) => onPathChange(event.target.value)}
            placeholder={t('runtime.configCard.pathPlaceholder', {
              runtime: runtimeLabel
            })}
            value={path}
          />
          <button
            className="secondary-button"
            onClick={() => void onSelect(fileKind, onPathChange)}
            type="button"
          >
            {t('actions.selectFile')}
          </button>
          <button
            className="secondary-button"
            disabled={!path}
            onClick={() => onPathChange('')}
            type="button"
          >
            {t('actions.clear')}
          </button>
        </div>
      </label>
      <div className="runtime-config-actions">
        {saved ? (
          <>
            <button
              className="secondary-button"
              onClick={() => void onOpen(runtime, 'open-file')}
              type="button"
            >
              {t('actions.openConfigFile')}
            </button>
            <button
              className="secondary-button"
              onClick={() => void onOpen(runtime, 'show-file')}
              type="button"
            >
              {t('actions.revealInFolder')}
            </button>
          </>
        ) : (
          <button
            className="secondary-button"
            onClick={() => void onOpen(runtime, 'open-directory')}
            type="button"
          >
            {t('actions.openConfigDirectory', {
              runtime: runtimeLabel
            })}
          </button>
        )}
      </div>
      {path && !saved && (
        <small className="runtime-config-card__hint">
          {t('runtime.configCard.unsavedHint')}
        </small>
      )}
    </div>
  )
}

function RuntimeOverviewCard({
  detection,
  detectionLabel,
  detecting,
  modelConfiguration,
  recommendation,
  runtime
}: {
  detection: AgentRuntimeDetection['opencode'] | undefined
  detectionLabel: string
  detecting: boolean
  modelConfiguration: string
  recommendation: string
  runtime: string
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const localizedDetail =
    detection?.available && detection.source
      ? t(`runtime.detection.details.${detection.source}`, {
          runtime: detectionLabel,
          versionSuffix: detection.version ? ` ${detection.version}` : ''
        })
      : detection?.detail
  const status = detecting
    ? t('runtime.detection.detecting')
    : detection?.available
      ? t('runtime.detection.ready')
      : detection
        ? t('runtime.detection.unavailable')
        : t('runtime.detection.notDetected')

  return (
    <div className="runtime-note runtime-overview">
      <dl className="runtime-overview__details">
        <dt>{t('runtime.runtimeLabel')}</dt>
        <dd>{runtime}</dd>
        <dt>{t('runtime.modelConfigurationLabel')}</dt>
        <dd>{modelConfiguration}</dd>
        <dt>{t('runtime.detection.statusLabel')}</dt>
        <dd aria-atomic="true" aria-live="polite">
          {status}
        </dd>
        {!detecting && detection?.available && (
          <>
            <dt>{t('runtime.detection.pathLabel')}</dt>
            <dd className="runtime-overview__path">
              {detection.path}
            </dd>
            {detection.version && (
              <>
                <dt>{t('runtime.detection.versionLabel')}</dt>
                <dd>{detection.version}</dd>
              </>
            )}
          </>
        )}
        {!detecting && localizedDetail && (
          <>
            <dt>{t('runtime.detection.detailLabel')}</dt>
            <dd>{localizedDetail}</dd>
          </>
        )}
      </dl>
      <p>{recommendation}</p>
    </div>
  )
}

export function SettingsPanel({
  open,
  presentation = 'modal',
  initialCategory,
  initialChannel,
  onClose,
  onSaved,
  onNotify = () => {},
  onUpdateProject,
  projects,
  onClearLocalData,
  heartbeats,
  onCreateHeartbeat,
  onSetHeartbeatPaused,
  onRemoveHeartbeat,
  onRunHeartbeat,
  onExpertsChanged = () => {},
  appearanceTheme = 'system',
  onAppearanceThemeChange = () => {},
  magicNotesEnabled = false,
  onMagicNotesEnabledChange = () => {}
}: SettingsPanelProps): React.JSX.Element | null {
  const { i18n, t } = useTranslation('settings')
  const {
    preference: uiLocalePreference,
    setPreference: setUiLocalePreference
  } = useUiLocale()
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
  const [deepseekHarnessModelSource, setDeepseekHarnessModelSource] =
    useState<RuntimeModelSource>({ kind: 'platform' })
  const [opencodeBaseUrl, setOpencodeBaseUrl] = useState<string>(
    defaultRuntimeSettings.opencodeBaseUrl
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
  const [knowledgeRerankEnabled, setKnowledgeRerankEnabled] =
    useState<boolean>(defaultRuntimeSettings.knowledgeRerankEnabled)
  const [knowledgeRerankEndpoint, setKnowledgeRerankEndpoint] =
    useState<string>(defaultRuntimeSettings.knowledgeRerankEndpoint)
  const [knowledgeRerankModel, setKnowledgeRerankModel] =
    useState<string>(defaultRuntimeSettings.knowledgeRerankModel)
  const [knowledgeRerankApiKey, setKnowledgeRerankApiKey] =
    useState('')
  const [clearKnowledgeRerankApiKey, setClearKnowledgeRerankApiKey] =
    useState(false)
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
  const [contextCompression, setContextCompression] =
    useState<ContextCompressionSettings>(
      defaultContextCompressionSettings
    )
  const [
    contextCompressionTokenInput,
    setContextCompressionTokenInput
  ] = useState<ContextCompressionTokenDrafts>(() =>
    contextCompressionTokenDrafts(
      defaultContextCompressionSettings
    )
  )
  const modelProfileDisplayName = (
    profile: Pick<ModelProfileDraft, 'id' | 'name'>
  ): string =>
    profile.id === builtInDefaultModelProfileId &&
    profile.name === '默认模型'
      ? t('model.profile.seededDefaultName')
      : profile.name
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [embeddingConfiguration, setEmbeddingConfiguration] =
    useState<EmbeddingConfigurationSummary>()
  const [embeddingDiagnostic, setEmbeddingDiagnostic] =
    useState<EmbeddingDiagnosticResult>()
  const [embeddingDiagnosticRunning, setEmbeddingDiagnosticRunning] =
    useState(false)
  const [error, setError] = useState<string>()
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearingLocalData, setClearingLocalData] = useState(false)
  const [detection, setDetection] = useState<AgentRuntimeDetection>()
  const [detecting, setDetecting] = useState(false)
  const [activeTab, setActiveTab] =
    useState<SettingsCategoryId>(initialCategory ?? 'runtime')
  const [modelType, setModelType] = useState<ModelType>('llm')
  const [speechModelDraftId, setSpeechModelDraftId] = useState<
    string | null | undefined
  >()
  const [
    persistedSpeechModelId,
    setPersistedSpeechModelId
  ] = useState<string | null | undefined>()
  const [speechModelSelectionDirty, setSpeechModelSelectionDirty] =
    useState(false)
  const [agentRuntimeType, setAgentRuntimeType] =
    useState<AgentRuntimeType>('opencode')
  const [runtimeCustomizationDirty, setRuntimeCustomizationDirty] =
    useState(false)
  const runtimeCustomizationRef =
    useRef<RuntimeCustomizationSectionHandle>(null)
  const handleRuntimeCustomizationDirtyChange = useCallback(
    (dirty: boolean): void => {
      setRuntimeCustomizationDirty(dirty)
      if (!dirty) {
        setError((current) =>
          current === t('runtime.customization.unsavedClose')
            ? undefined
            : current
        )
      }
    },
    [t]
  )
  const settingsBodyRef = useRef<HTMLDivElement>(null)
  const hydrateSettings = useCallback(
    (
      value: RuntimeSettings,
      preserveSelectedProfile = false
    ): void => {
      hydrateRuntimeSettings(
        value,
        {
        settings: setSettings,
        provider: setProvider,
        modelProfiles: setModelProfiles,
        selectedModelProfileId: setSelectedModelProfileId,
        defaultModelProfileId: setDefaultModelProfileId,
        opencodeModelSource: setOpencodeModelSource,
        continueModelSource: setContinueModelSource,
        deepseekHarnessModelSource: setDeepseekHarnessModelSource,
        opencodeBaseUrl: setOpencodeBaseUrl,
        opencodeBinaryPath: setOpencodeBinaryPath,
        opencodeConfigPath: setOpencodeConfigPath,
        continueBinaryPath: setContinueBinaryPath,
        continueConfigPath: setContinueConfigPath,
        continueMode: setContinueMode,
        knowledgeEmbeddingEnabled: setKnowledgeEmbeddingEnabled,
        knowledgeEmbeddingBaseUrl: setKnowledgeEmbeddingBaseUrl,
        knowledgeEmbeddingModel: setKnowledgeEmbeddingModel,
        knowledgeEmbeddingApiKey: setKnowledgeEmbeddingApiKey,
        clearKnowledgeEmbeddingApiKey: setClearKnowledgeEmbeddingApiKey,
        knowledgeRerankEnabled: setKnowledgeRerankEnabled,
        knowledgeRerankEndpoint: setKnowledgeRerankEndpoint,
        knowledgeRerankModel: setKnowledgeRerankModel,
        knowledgeRerankApiKey: setKnowledgeRerankApiKey,
        clearKnowledgeRerankApiKey: setClearKnowledgeRerankApiKey,
        workspacePath: setWorkspacePath,
        toolApproval: setToolApproval,
        subagentSmartRoutingEnabled: setSubagentSmartRoutingEnabled,
        contextCompression: setContextCompression
        },
        preserveSelectedProfile
      )
      setContextCompressionTokenInput(
        contextCompressionTokenDrafts(
          value.contextCompression ??
            defaultContextCompressionSettings
        )
      )
    },
    []
  )
  const configurationTab =
    activeTab === 'model' ||
    activeTab === 'context-control' ||
    activeTab === 'runtime' ||
    activeTab === 'security' ||
    activeTab === 'roles'
  const categoryRendersOwnHeader =
    activeTab === 'platform-features' ||
    activeTab === 'document-parsing' ||
    activeTab === 'channels' ||
    activeTab === 'skills' ||
    activeTab === 'mcp' ||
    activeTab === 'about'

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tab: SettingsCategoryId
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
    setError(undefined)
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
        setConfirmingClear(false)
        setClearingLocalData(false)
        setModelType('llm')
        setSpeechModelDraftId(undefined)
        setPersistedSpeechModelId(undefined)
        setSpeechModelSelectionDirty(false)
        setAgentRuntimeType('opencode')
        hydrateSettings(value)
      })
      .catch((reason: unknown) => {
        setError(
          settingsErrorMessage(
            reason,
            i18n.t('errors.readSettings', { ns: 'settings' })
          )
        )
      })
    void window.goodbuddy.settings
      .detectAgentRuntimes()
      .then(setDetection)
      .catch((reason: unknown) => {
        setError(
          settingsErrorMessage(
            reason,
            i18n.t('errors.detectRuntimes', { ns: 'settings' })
          )
        )
      })
  }, [hydrateSettings, i18n, open])

  useEffect(() => {
    if (open && settingsBodyRef.current) {
      settingsBodyRef.current.scrollTop = 0
    }
  }, [activeTab, open])

  useEffect(() => {
    const embeddings = window.goodbuddy.embeddings
    if (!open || !embeddings) {
      return
    }
    let active = true
    void embeddings
      .getSnapshot()
      .then((snapshot) => {
        if (active) {
          setEmbeddingDiagnostic(undefined)
          setEmbeddingConfiguration(snapshot.configuration)
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            settingsErrorMessage(
              reason,
              i18n.t('errors.readEmbeddingStatus', {
                ns: 'settings'
              })
            )
          )
        }
      })
    return () => {
      active = false
    }
  }, [i18n, open])

  if (!open) {
    return null
  }

  const normalizedContextCompression =
    normalizeContextCompressionTokenDrafts(
      contextCompression,
      contextCompressionTokenInput
    )
  const commitContextCompressionTokenInput =
    (): ContextCompressionSettings => {
      setContextCompression(normalizedContextCompression)
      setContextCompressionTokenInput(
        contextCompressionTokenDrafts(
          normalizedContextCompression
        )
      )
      return normalizedContextCompression
    }

  const close = (): void => {
    if (runtimeCustomizationDirty) {
      setActiveTab('runtime')
      setError(t('runtime.customization.unsavedClose'))
      return
    }
    setModelProfiles((profiles) =>
      profiles.map((profile) => ({
        ...profile,
        apiKey: '',
        clearApiKey: false
      }))
    )
    setKnowledgeEmbeddingApiKey('')
    setClearKnowledgeEmbeddingApiKey(false)
    setKnowledgeRerankApiKey('')
    setClearKnowledgeRerankApiKey(false)
    setSpeechModelDraftId(undefined)
    setPersistedSpeechModelId(undefined)
    setSpeechModelSelectionDirty(false)
    setError(undefined)
    onClose()
  }

  const save = async (
    notifySuccess = true
  ): Promise<RuntimeSettings | undefined> => {
    setSaving(true)
    setError(undefined)
    try {
      const contextCompressionInput =
        commitContextCompressionTokenInput()
      const defaultProfile =
        modelProfiles.find(
          (profile) => profile.id === defaultModelProfileId
        ) ?? modelProfiles[0]
      if (!defaultProfile) {
        throw new Error(t('errors.requireModelConnection'))
      }
      const configuredProfiles = new Map(
        settings?.configured?.modelProfiles.map((profile) => [
          profile.id,
          profile
        ])
      )
      const profileInputs = modelProfiles.map((profile) => {
        const configured = configuredProfiles.get(profile.id)
        const environmentManaged =
          profile.credentialSource === 'environment' &&
          configured !== undefined
        return {
          id: profile.id,
          name: profile.name,
          baseUrl: environmentManaged
            ? configured.baseUrl
            : profile.baseUrl,
          modelName: environmentManaged
            ? configured.modelName
            : profile.modelName,
          protocol: profile.protocol,
          authentication: profile.authentication,
          supportsImageInput: profile.supportsImageInput,
          contextWindowTokens: profile.contextWindowTokens,
          imageGenerationQuality: profile.imageGenerationQuality,
          apiKey: profile.clearApiKey
            ? ({ action: 'clear' } as const)
            : profile.apiKey.trim()
              ? ({
                  action: 'replace',
                  value: profile.apiKey.trim()
                } as const)
              : ({ action: 'keep' } as const)
        }
      })
      const defaultProfileInput =
        profileInputs.find(
          (profile) => profile.id === defaultProfile.id
        ) ?? profileInputs[0]!
      const normalizedDeepseekHarnessModelSource =
        deepseekHarnessModelSource.kind === 'profile' &&
        deepseekHarnessModelSource.profileId === defaultProfile.id &&
        defaultProfile.credentialSource === 'environment'
          ? { kind: 'platform' as const }
          : deepseekHarnessModelSource
      const value = await window.goodbuddy.settings.updateRuntime({
        provider,
        modelBaseUrl: defaultProfileInput.baseUrl,
        modelName: defaultProfileInput.modelName,
        modelProtocol: defaultProfileInput.protocol,
        modelAuthentication: defaultProfileInput.authentication,
        imageGenerationQuality:
          defaultProfileInput.imageGenerationQuality,
        opencodeBaseUrl,
        opencodeEmbedded: !opencodeBaseUrl,
        opencodeBinaryPath,
        opencodeConfigPath,
        continueBinaryPath,
        continueConfigPath,
        continueMode,
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
        knowledgeRerankEnabled,
        knowledgeRerankEndpoint,
        knowledgeRerankModel,
        knowledgeRerankApiKey: clearKnowledgeRerankApiKey
          ? { action: 'clear' }
          : knowledgeRerankApiKey.trim()
            ? {
                action: 'replace',
                value: knowledgeRerankApiKey.trim()
              }
            : { action: 'keep' },
        workspacePath,
        apiKey: defaultProfileInput.apiKey,
        modelProfiles: profileInputs,
        defaultModelProfileId: defaultProfile.id,
        opencodeModelSource,
        continueModelSource,
        deepseekHarnessModelSource:
          normalizedDeepseekHarnessModelSource,
        contextCompression: contextCompressionInput,
        toolApproval,
        subagentSmartRoutingEnabled
      })
      let selectedSpeechModelId = speechModelDraftId
      if (speechModelSelectionDirty) {
        const speechModels = window.goodbuddy.speechModels
        if (!speechModels) {
          throw new Error(t('errors.speechModelsUnavailable'))
        }
        const speechSnapshot = await speechModels.select(
          speechModelDraftId ?? null
        )
        selectedSpeechModelId = speechSnapshot.selectedModelId
      }
      hydrateSettings(value, true)
      if (speechModelSelectionDirty) {
        setSpeechModelDraftId(selectedSpeechModelId)
        setPersistedSpeechModelId(selectedSpeechModelId)
        setSpeechModelSelectionDirty(false)
      }
      const embeddings = window.goodbuddy.embeddings
      if (embeddings) {
        try {
          setEmbeddingConfiguration(
            (await embeddings.getSnapshot()).configuration
          )
        } catch (reason) {
          setError(
            settingsErrorMessage(
              reason,
              t('errors.refreshEmbeddingAfterSave')
            )
          )
        }
      }
      onSaved(value)
      if (activeTab === 'runtime') {
        const customizationSaved =
          (await runtimeCustomizationRef.current?.save()) ?? true
        if (!customizationSaved) {
          return undefined
        }
      }
      if (notifySuccess) {
        onNotify({
          tone: 'success',
          message: t('notifications.settingsSaved'),
          dedupeKey: 'runtime-settings-saved'
        })
      }
      return value
    } catch (reason) {
      setError(settingsErrorMessage(reason, t('errors.saveSettings')))
      return undefined
    } finally {
      setSaving(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    const testingModel = activeTab === 'model' && modelType === 'llm'
    const profileId = selectedModelProfileId
    setTesting(true)
    const savedSettings = await save(false)
    if (!savedSettings) {
      setTesting(false)
      return
    }
    try {
      const runtimeSource =
        agentRuntimeType === 'opencode'
          ? savedSettings.opencodeModelSource
          : agentRuntimeType === 'continue'
            ? savedSettings.continueModelSource
            : savedSettings.deepseekHarnessModelSource ?? {
                kind: 'platform'
              }
      const runtimeSelection =
        runtimeSource.kind === 'profile'
          ? {
              provider: agentRuntimeType,
              profileId: runtimeSource.profileId
            }
          : { provider: agentRuntimeType }
      const status = testingModel
        ? await window.goodbuddy.settings.testModelConnection(profileId)
        : await window.goodbuddy.settings.testRuntime(runtimeSelection)
      if (!status.available) {
        throw new Error(status.detail)
      }
      onNotify({
        tone: 'success',
        message:
          status.capability === 'image-generation'
            ? status.detail
            : t('notifications.connectionSucceeded', {
                label: status.label
              }),
        dedupeKey: testingModel
          ? 'model-connection-tested'
          : `runtime-connection-tested-${agentRuntimeType}`
      })
    } catch (reason) {
      setError(
        settingsErrorMessage(
          reason,
          testingModel
            ? t('errors.testModel')
            : t('errors.testRuntime')
        )
      )
    } finally {
      setTesting(false)
    }
  }

  const runEmbeddingDiagnostic = async (): Promise<void> => {
    const embeddings = window.goodbuddy.embeddings
    if (!embeddings) {
      setError(t('errors.embeddingDiagnosticUnavailable'))
      return
    }
    setEmbeddingDiagnosticRunning(true)
    setEmbeddingDiagnostic(undefined)
    setError(undefined)
    try {
      if (!(await save(false))) {
        return
      }
      const diagnostic = await embeddings.diagnose()
      setEmbeddingDiagnostic(diagnostic)
      setEmbeddingConfiguration(
        (await embeddings.getSnapshot()).configuration
      )
    } catch (reason) {
      setError(settingsErrorMessage(reason, t('errors.testEmbedding')))
    } finally {
      setEmbeddingDiagnosticRunning(false)
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
      setError(settingsErrorMessage(reason, t('errors.selectFile')))
    }
  }

  const openRuntimeConfig = async (
    runtime: RuntimeConfigActionInput['runtime'],
    action: RuntimeConfigActionInput['action']
  ): Promise<void> => {
    try {
      await window.goodbuddy.settings.openRuntimeConfig({
        runtime,
        action
      })
    } catch (reason) {
      setError(
        settingsErrorMessage(reason, t('errors.openRuntimeConfig'))
      )
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
      setError(settingsErrorMessage(reason, t('errors.detectRuntimes')))
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
        name: t('model.profile.generatedName', {
          count: profiles.length + 1
        }),
        baseUrl: '',
        modelName: '',
        protocol: 'openai-chat-completions',
        authentication: defaultRuntimeSettings.modelAuthentication,
        supportsImageInput: defaultRuntimeSettings.supportsImageInput,
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
      setError(t('errors.retainModelConnection'))
      return
    }
    const removedIndex = modelProfiles.findIndex(
      (profile) => profile.id === id
    )
    const remaining = modelProfiles.filter((profile) => profile.id !== id)
    const compatibleFallback =
      remaining.find(
        (profile) =>
          profile.id === defaultModelProfileId &&
          isAgentRuntimeModelProtocol(profile.protocol)
      ) ??
      remaining.find((profile) =>
        isAgentRuntimeModelProtocol(profile.protocol)
      )
    const runtimeFallback: RuntimeModelSource = compatibleFallback
      ? { kind: 'profile', profileId: compatibleFallback.id }
      : { kind: 'platform' }
    setModelProfiles(remaining)
    if (selectedModelProfileId === id) {
      setSelectedModelProfileId(
        remaining[Math.min(removedIndex, remaining.length - 1)]?.id ??
          remaining[0]!.id
      )
    }
    if (defaultModelProfileId === id) {
      setDefaultModelProfileId(
        compatibleFallback?.id ?? remaining[0]!.id
      )
    }
    if (
      opencodeModelSource.kind === 'profile' &&
      opencodeModelSource.profileId === id
    ) {
      setOpencodeModelSource(runtimeFallback)
    }
    if (
      continueModelSource.kind === 'profile' &&
      continueModelSource.profileId === id
    ) {
      setContinueModelSource(runtimeFallback)
    }
    if (
      deepseekHarnessModelSource.kind === 'profile' &&
      deepseekHarnessModelSource.profileId === id
    ) {
      const harnessFallback = remaining.find(
        (profile) =>
          profile.id === defaultModelProfileId &&
          profile.protocol === 'openai-chat-completions'
      ) ?? remaining.find(
        (profile) =>
          profile.protocol === 'openai-chat-completions'
      )
      setDeepseekHarnessModelSource(
        harnessFallback
          ? { kind: 'profile', profileId: harnessFallback.id }
          : { kind: 'platform' }
      )
    }
    if (
      contextCompression.modelSource.kind === 'profile' &&
      contextCompression.modelSource.profileId === id
    ) {
      setContextCompression((current) => ({
        ...current,
        modelSource: { kind: 'current' }
      }))
    }
  }

  const selectDefaultModelProfile = (
    profile: ModelProfileDraft
  ): void => {
    const previousDefaultProfileId = defaultModelProfileId
    const compatibleProfile = isAgentRuntimeModelProtocol(
      profile.protocol
    )
      ? profile
      : modelProfiles.find((candidate) =>
          isAgentRuntimeModelProtocol(candidate.protocol)
        )
    const nextRuntimeSource: RuntimeModelSource = compatibleProfile
      ? { kind: 'profile', profileId: compatibleProfile.id }
      : { kind: 'platform' }
    setDefaultModelProfileId(profile.id)
    if (
      opencodeModelSource.kind === 'profile' &&
      opencodeModelSource.profileId === previousDefaultProfileId
    ) {
      setOpencodeModelSource(nextRuntimeSource)
    }
    if (
      continueModelSource.kind === 'profile' &&
      continueModelSource.profileId === previousDefaultProfileId
    ) {
      setContinueModelSource(nextRuntimeSource)
    }
    if (
      deepseekHarnessModelSource.kind === 'profile' &&
      deepseekHarnessModelSource.profileId === previousDefaultProfileId &&
      profile.protocol === 'openai-chat-completions'
    ) {
      setDeepseekHarnessModelSource({
        kind: 'profile',
        profileId: profile.id
      })
    }
  }

  const parseModelSource = (value: string): RuntimeModelSource =>
    value === 'platform'
      ? { kind: 'platform' }
      : { kind: 'profile', profileId: value }

  const isOpenCodeCompatible = (
    profile: ModelProfileDraft
  ): boolean => isAgentRuntimeModelProtocol(profile.protocol)

  const isContinueCompatible = (
    profile: ModelProfileDraft
  ): boolean => isAgentRuntimeModelProtocol(profile.protocol)

  const isDeepseekHarnessCompatible = (
    profile: ModelProfileDraft
  ): boolean => isDeepSeekHarnessModelProfile(profile)

  const selectedModelProfile =
    modelProfiles.find(
      (profile) => profile.id === selectedModelProfileId
    ) ?? modelProfiles[0]
  const defaultTextModelProfile =
    modelProfiles.find(
      (profile) =>
        profile.id === defaultModelProfileId &&
        isAgentRuntimeModelProtocol(profile.protocol)
    ) ??
    modelProfiles.find((profile) =>
      isAgentRuntimeModelProtocol(profile.protocol)
    )
  const defaultDeepseekHarnessModelProfile =
    modelProfiles.find(
      (profile) =>
        profile.id === defaultModelProfileId &&
        isDeepseekHarnessCompatible(profile)
    ) ??
    modelProfiles.find(isDeepseekHarnessCompatible)
  const activeRuntimeModelSource =
    agentRuntimeType === 'opencode'
      ? opencodeModelSource
      : agentRuntimeType === 'continue'
        ? continueModelSource
        : deepseekHarnessModelSource
  const activeRuntimeModelProfile =
    activeRuntimeModelSource.kind === 'profile'
      ? modelProfiles.find(
          (profile) =>
            profile.id === activeRuntimeModelSource.profileId &&
            (agentRuntimeType === 'deepseek-harness'
              ? isDeepseekHarnessCompatible(profile)
              : isAgentRuntimeModelProtocol(profile.protocol))
        )
      : undefined
  const savedRoleModelProfiles = (settings?.modelProfiles ?? [])
    .filter((profile) =>
      isAgentRuntimeModelProtocol(profile.protocol)
    )
    .map(({ id, name }) => ({
      id,
      name: modelProfileDisplayName({ id, name })
    }))
  const savedRoleDefaultModelProfileId =
    savedRoleModelProfiles.some(
      (profile) => profile.id === settings?.defaultModelProfileId
    )
      ? settings?.defaultModelProfileId
      : undefined

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
        <div className="settings-panel__header">
          <div>
            <PageHeader
              actions={
                <button
                  aria-label={t('center.close')}
                  className="icon-button"
                  onClick={close}
                  type="button"
                >
                  <X aria-hidden="true" size={19} />
                </button>
              }
              description={t('center.description')}
              eyebrow={t('center.eyebrow')}
              headingId="settings-title"
              title={t('center.title')}
            />
          </div>
        </div>

        <div className="settings-panel__body">
          <nav
            aria-label={t('center.categoriesAriaLabel')}
            aria-orientation="vertical"
            className="settings-tabs"
            role="tablist"
          >
            {settingsCategoryList.map((category) => (
              <button
                aria-controls={`settings-panel-${category.id}`}
                aria-label={t(
                  `categories.${category.translationKey}.label`
                )}
                aria-selected={activeTab === category.id}
                id={`settings-tab-${category.id}`}
                key={category.id}
                onClick={() => {
                  setError(undefined)
                  setActiveTab(category.id)
                }}
                onKeyDown={(event) =>
                  handleTabKeyDown(event, category.id)
                }
                role="tab"
                tabIndex={activeTab === category.id ? 0 : -1}
                type="button"
              >
                <strong>
                  {t(`categories.${category.translationKey}.label`)}
                </strong>
                <small>
                  {t(
                    `categories.${category.translationKey}.navigationDescription`
                  )}
                </small>
              </button>
            ))}
          </nav>

          <div
            aria-labelledby={`settings-tab-${activeTab}`}
            className="settings-panel__content"
            id={`settings-panel-${activeTab}`}
            ref={settingsBodyRef}
            role="tabpanel"
          >
          {!categoryRendersOwnHeader && (
            <SettingsCategoryHeader
              actions={
                configurationTab ? (
                  <>
                    {(activeTab === 'runtime' ||
                      (activeTab === 'model' && modelType === 'llm')) && (
                      <button
                        className="secondary-button"
                        disabled={saving || testing}
                        onClick={() => void testConnection()}
                        type="button"
                      >
                        {testing
                          ? t('actions.testing')
                          : activeTab === 'model'
                            ? t('actions.saveAndTestModel')
                            : t('actions.saveAndTestRuntime', {
                                runtime:
                                  agentRuntimeType === 'opencode'
                                    ? 'OpenCode'
                                    : agentRuntimeType === 'continue'
                                      ? 'Continue'
                                      : 'DeepSeek Harness'
                              })}
                      </button>
                    )}
                    <button
                      className="primary-button"
                      disabled={saving || testing}
                      onClick={() => void save()}
                      type="button"
                    >
                      <Save aria-hidden="true" size={13} />
                      {saving
                        ? t('actions.saving')
                        : t('actions.saveSettings')}
                    </button>
                  </>
                ) : undefined
              }
              category={activeTab}
              error={error}
            />
          )}
          {activeTab === 'appearance' && (
            <>
              <div className="settings-section appearance-settings">
                <div className="settings-section__title">
                  <SunMoon size={17} />
                  <div>
                    <strong>{t('appearance.theme.title')}</strong>
                    <small>{t('appearance.theme.description')}</small>
                  </div>
                </div>
                <div
                  aria-label={t('appearance.theme.ariaLabel')}
                  className="appearance-options"
                  role="radiogroup"
                >
                  {(['system', 'light', 'dark'] as const).map(
                    (value) => (
                      <label key={value}>
                        <input
                          checked={appearanceTheme === value}
                          name="appearance-theme"
                          onChange={() =>
                            onAppearanceThemeChange(value)
                          }
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
                        <strong>
                          {t(
                            `appearance.theme.options.${value}.label`
                          )}
                        </strong>
                        <small>
                          {t(
                            `appearance.theme.options.${value}.description`
                          )}
                        </small>
                      </label>
                    )
                  )}
                </div>
              </div>
              <div className="settings-section appearance-settings">
                <div className="settings-section__title">
                  <div>
                    <strong>{t('appearance.language.title')}</strong>
                    <small>{t('appearance.language.description')}</small>
                  </div>
                </div>
                <div
                  aria-label={t('appearance.language.ariaLabel')}
                  className="appearance-options"
                  role="radiogroup"
                >
                  {(
                    [
                      ['system', 'system'],
                      ['zh-CN', 'chinese'],
                      ['en-US', 'english']
                    ] as const
                  ).map(([value, translationKey]) => (
                    <label key={value}>
                      <input
                        checked={uiLocalePreference === value}
                        name="interface-language"
                        onChange={() => setUiLocalePreference(value)}
                        type="radio"
                        value={value}
                      />
                      <strong>
                        {t(
                          `appearance.language.options.${translationKey}.label`
                        )}
                      </strong>
                      <small>
                        {t(
                          `appearance.language.options.${translationKey}.description`
                        )}
                      </small>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
          {activeTab === 'platform-features' && (
            <PlatformFeaturesSettingsSection
              onMagicNotesEnabledChange={onMagicNotesEnabledChange}
            />
          )}
          {activeTab === 'runtime' && (
            <>
              <SettingsWarningList warnings={settings?.warnings} />
          <div className="settings-section">
            <div className="settings-section__title">
              <FolderOpen size={17} />
              <div>
                <strong>{t('runtime.workspace.title')}</strong>
                <small>{t('runtime.workspace.description')}</small>
              </div>
            </div>
            <label className="field">
              <span>{t('runtime.workspace.directoryLabel')}</span>
              <div className="workspace-picker">
                <input
                  aria-label={t('runtime.workspace.directoryLabel')}
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
                          settingsErrorMessage(
                            reason,
                            t('errors.selectWorkspace')
                          )
                        )
                      })
                  }}
                  type="button"
                >
                  {t('actions.select')}
                </button>
              </div>
            </label>
          </div>

          <div className="model-type-navigation agent-runtime-navigation">
            <SegmentedControl
              ariaLabel="Agent Runtime"
              onChange={setAgentRuntimeType}
              options={[
                { label: 'OpenCode', value: 'opencode' },
                { label: 'Continue', value: 'continue' },
                {
                  label: t('runtime.deepseekHarness.selectorLabel'),
                  value: 'deepseek-harness'
                }
              ]}
              value={agentRuntimeType}
            />
          </div>

          {agentRuntimeType === 'opencode' && (
            <div className="settings-section">
              <div className="settings-section__title">
                <TerminalSquare size={17} />
                <div>
                  <strong>{t('runtime.opencode.title')}</strong>
                  <small>{t('runtime.bundledDescription')}</small>
                </div>
              </div>
              <RuntimeOverviewCard
                detection={detection?.opencode}
                detectionLabel="OpenCode"
                detecting={detecting}
                modelConfiguration={
                  activeRuntimeModelSource.kind === 'platform'
                    ? t('runtime.ownConfiguration', {
                        runtime: 'OpenCode'
                      })
                    : activeRuntimeModelProfile
                      ? t('runtime.followGoodBuddy', {
                          name: modelProfileDisplayName(
                            activeRuntimeModelProfile
                          ),
                          model: activeRuntimeModelProfile.modelName
                        })
                      : defaultTextModelProfile
                        ? t('runtime.followGoodBuddy', {
                            name: modelProfileDisplayName(
                              defaultTextModelProfile
                            ),
                            model: defaultTextModelProfile.modelName
                          })
                        : t('runtime.noCompatibleModel')
                }
                recommendation={t('runtime.opencode.recommendation')}
                runtime={t('runtime.bundledRuntime', {
                  runtime: 'OpenCode'
                })}
              />
              <div className="runtime-note">
                {t('runtime.permissions')}
              </div>
              <details className="settings-section">
                <summary>{t('runtime.advanced')}</summary>
                <p className="settings-panel__description">
                  {t('runtime.opencode.advancedDescription')}
                </p>
                <fieldset className="runtime-source-options">
                  <legend>{t('runtime.sourceLegend')}</legend>
                  <label>
                    <input
                      checked={opencodeModelSource.kind === 'profile'}
                      disabled={!defaultTextModelProfile}
                      name="opencode-model-source"
                      onChange={() => {
                        if (defaultTextModelProfile) {
                          setOpencodeModelSource({
                            kind: 'profile',
                            profileId: defaultTextModelProfile.id
                          })
                          setOpencodeBaseUrl('')
                        }
                      }}
                      type="radio"
                    />
                    <span>
                      <strong>{t('runtime.followRecommended')}</strong>
                      <small>
                        {t('runtime.opencode.followDescription')}
                      </small>
                    </span>
                  </label>
                  <label>
                    <input
                      checked={opencodeModelSource.kind === 'platform'}
                      name="opencode-model-source"
                      onChange={() =>
                        setOpencodeModelSource({ kind: 'platform' })
                      }
                      type="radio"
                    />
                    <span>
                      <strong>
                        {t('runtime.ownConfiguration', {
                          runtime: 'OpenCode'
                        })}
                      </strong>
                      <small>
                        {t('runtime.opencode.ownDescription')}
                      </small>
                    </span>
                  </label>
                </fieldset>
                {opencodeModelSource.kind === 'profile' && (
                  <label className="field">
                    <span>{t('runtime.goodBuddyConnection')}</span>
                    <select
                      aria-label={`OpenCode ${t(
                        'runtime.goodBuddyConnection'
                      )}`}
                      value={opencodeModelSource.profileId}
                      onChange={(event) => {
                        setOpencodeModelSource(
                          parseModelSource(event.target.value)
                        )
                        setOpencodeBaseUrl('')
                      }}
                    >
                      {modelProfiles.map((profile) => (
                        <option
                          disabled={!isOpenCodeCompatible(profile)}
                          key={profile.id}
                          value={profile.id}
                        >
                          {modelProfileDisplayName(profile)}
                          {isOpenCodeCompatible(profile)
                            ? ''
                            : t('runtime.incompatibleSuffix')}
                        </option>
                      ))}
                    </select>
                    <small>
                      {t('runtime.pinConnectionDescription')}
                    </small>
                  </label>
                )}
                {opencodeModelSource.kind === 'platform' &&
                  !opencodeBaseUrl.trim() && (
                  <RuntimeConfigCard
                    description={t(
                      'runtime.opencode.configDescription'
                    )}
                    fileKind="opencodeConfig"
                    onOpen={openRuntimeConfig}
                    onPathChange={setOpencodeConfigPath}
                    onSelect={selectRuntimeFile}
                    path={opencodeConfigPath}
                    runtime="opencode"
                    runtimeLabel="OpenCode"
                    savedPath={
                      settings
                        ? configuredRuntimeSettings(settings)
                            .opencodeConfigPath
                        : undefined
                    }
                  />
                )}
                {opencodeModelSource.kind === 'platform' &&
                  Boolean(opencodeBaseUrl.trim()) && (
                    <p className="settings-warning">
                      {t('runtime.opencode.externalServerWarning')}
                    </p>
                  )}
                <label className="field">
                  <span>{t('runtime.serverAddress')}</span>
                  <input
                    aria-label={t('runtime.opencode.serverAriaLabel')}
                    inputMode="url"
                    onChange={(event) => {
                      const value = event.target.value
                      setOpencodeBaseUrl(value)
                      if (value.trim()) {
                        setOpencodeModelSource({ kind: 'platform' })
                      }
                    }}
                    placeholder={t(
                      'runtime.opencode.serverPlaceholder'
                    )}
                    value={opencodeBaseUrl}
                  />
                  <small>
                    {t('runtime.opencode.serverDescription')}
                  </small>
                </label>
                <label className="field">
                  <span>{t('runtime.opencode.binaryPath')}</span>
                  <div className="workspace-picker">
                    <input
                      aria-label={t('runtime.opencode.binaryPath')}
                      onChange={(event) =>
                        setOpencodeBinaryPath(event.target.value)
                      }
                      placeholder={t(
                        'runtime.bundledProgramPlaceholder'
                      )}
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
                      {t('actions.select')}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!opencodeBinaryPath}
                      onClick={() => setOpencodeBinaryPath('')}
                      type="button"
                    >
                      {t('actions.clear')}
                    </button>
                  </div>
                </label>
                {opencodeBinaryPath && (
                  <p className="settings-warning">
                    {t('runtime.customBinaryWarning', {
                      runtime: 'OpenCode'
                    })}
                  </p>
                )}
                <button
                  className="secondary-button"
                  disabled={detecting}
                  onClick={() => void detectRuntimes()}
                  type="button"
                >
                  {detecting
                    ? t('actions.detecting')
                    : t('actions.redetectRuntime', {
                        runtime: 'OpenCode'
                      })}
                </button>
              </details>
            </div>
          )}
          {agentRuntimeType === 'continue' && (
            <div className="settings-section">
              <div className="settings-section__title">
                <TerminalSquare size={17} />
                <div>
                  <strong>{t('runtime.continue.title')}</strong>
                  <small>{t('runtime.bundledDescription')}</small>
                </div>
              </div>
              <RuntimeOverviewCard
                detection={detection?.continue}
                detectionLabel="Continue"
                detecting={detecting}
                modelConfiguration={
                  activeRuntimeModelSource.kind === 'platform'
                    ? t('runtime.ownConfiguration', {
                        runtime: 'Continue'
                      })
                    : activeRuntimeModelProfile
                      ? t('runtime.followGoodBuddy', {
                          name: modelProfileDisplayName(
                            activeRuntimeModelProfile
                          ),
                          model: activeRuntimeModelProfile.modelName
                        })
                      : defaultTextModelProfile
                        ? t('runtime.followGoodBuddy', {
                            name: modelProfileDisplayName(
                              defaultTextModelProfile
                            ),
                            model: defaultTextModelProfile.modelName
                          })
                        : t('runtime.noCompatibleModel')
                }
                recommendation={t('runtime.continue.recommendation')}
                runtime={t('runtime.bundledRuntime', {
                  runtime: 'Continue'
                })}
              />
              <div className="runtime-note">
                {t('runtime.permissions')}
              </div>
              <details className="settings-section">
                <summary>{t('runtime.advanced')}</summary>
                <p className="settings-panel__description">
                  {t('runtime.continue.advancedDescription')}
                </p>
                <fieldset className="runtime-source-options">
                  <legend>{t('runtime.sourceLegend')}</legend>
                  <label>
                    <input
                      checked={continueModelSource.kind === 'profile'}
                      disabled={!defaultTextModelProfile}
                      name="continue-model-source"
                      onChange={() => {
                        if (defaultTextModelProfile) {
                          setContinueModelSource({
                            kind: 'profile',
                            profileId: defaultTextModelProfile.id
                          })
                        }
                      }}
                      type="radio"
                    />
                    <span>
                      <strong>{t('runtime.followRecommended')}</strong>
                      <small>
                        {t('runtime.continue.followDescription')}
                      </small>
                    </span>
                  </label>
                  <label>
                    <input
                      checked={continueModelSource.kind === 'platform'}
                      name="continue-model-source"
                      onChange={() =>
                        setContinueModelSource({ kind: 'platform' })
                      }
                      type="radio"
                    />
                    <span>
                      <strong>
                        {t('runtime.ownConfiguration', {
                          runtime: 'Continue'
                        })}
                      </strong>
                      <small>
                        {t('runtime.continue.ownDescription')}
                      </small>
                    </span>
                  </label>
                </fieldset>
                {continueModelSource.kind === 'profile' && (
                  <label className="field">
                    <span>{t('runtime.goodBuddyConnection')}</span>
                    <select
                      aria-label={`Continue ${t(
                        'runtime.goodBuddyConnection'
                      )}`}
                      value={continueModelSource.profileId}
                      onChange={(event) =>
                        setContinueModelSource(
                          parseModelSource(event.target.value)
                        )
                      }
                    >
                      {modelProfiles.map((profile) => (
                        <option
                          disabled={!isContinueCompatible(profile)}
                          key={profile.id}
                          value={profile.id}
                        >
                          {modelProfileDisplayName(profile)}
                          {isContinueCompatible(profile)
                            ? ''
                            : t('runtime.incompatibleSuffix')}
                        </option>
                      ))}
                    </select>
                    <small>
                      {t('runtime.pinConnectionDescription')}
                    </small>
                  </label>
                )}
                {continueModelSource.kind === 'platform' && (
                  <RuntimeConfigCard
                    description={t(
                      'runtime.continue.configDescription'
                    )}
                    fileKind="continueConfig"
                    onOpen={openRuntimeConfig}
                    onPathChange={setContinueConfigPath}
                    onSelect={selectRuntimeFile}
                    path={continueConfigPath}
                    runtime="continue"
                    runtimeLabel="Continue"
                    savedPath={
                      settings
                        ? configuredRuntimeSettings(settings)
                            .continueConfigPath
                        : undefined
                    }
                  />
                )}
                <label className="field">
                  <span>{t('runtime.continue.binaryPath')}</span>
                  <div className="workspace-picker">
                    <input
                      aria-label={t('runtime.continue.binaryPath')}
                      onChange={(event) =>
                        setContinueBinaryPath(event.target.value)
                      }
                      placeholder={t(
                        'runtime.bundledProgramPlaceholder'
                      )}
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
                      {t('actions.select')}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!continueBinaryPath}
                      onClick={() => setContinueBinaryPath('')}
                      type="button"
                    >
                      {t('actions.clear')}
                    </button>
                  </div>
                </label>
                {continueModelSource.kind === 'platform' &&
                  !continueConfigPath && (
                  <p className="settings-warning">
                    {t('runtime.continue.missingConfigWarning')}
                  </p>
                  )}
                {continueBinaryPath && (
                  <p className="settings-warning">
                    {t('runtime.customBinaryWarning', {
                      runtime: 'Continue'
                    })}
                  </p>
                )}
                <button
                  className="secondary-button"
                  disabled={detecting}
                  onClick={() => void detectRuntimes()}
                  type="button"
                >
                  {detecting
                    ? t('actions.detecting')
                    : t('actions.redetectRuntime', {
                        runtime: 'Continue'
                      })}
                </button>
              </details>
            </div>
          )}
          {agentRuntimeType === 'deepseek-harness' && (
            <div className="settings-section">
              <div className="settings-section__title">
                <TerminalSquare size={17} />
                <div>
                  <strong>{t('runtime.deepseekHarness.title')}</strong>
                  <small>
                    {t('runtime.deepseekHarness.previewDescription')}
                  </small>
                </div>
              </div>
              <RuntimeOverviewCard
                detection={detection?.deepseekHarness}
                detectionLabel="DeepSeek Harness"
                detecting={detecting}
                modelConfiguration={
                  activeRuntimeModelSource.kind === 'platform'
                    ? t('runtime.deepseekHarness.managedSource')
                    : activeRuntimeModelProfile
                      ? t('runtime.followGoodBuddy', {
                          name: modelProfileDisplayName(
                            activeRuntimeModelProfile
                          ),
                          model: activeRuntimeModelProfile.modelName
                        })
                      : t('runtime.noCompatibleModel')
                }
                recommendation={t(
                  'runtime.deepseekHarness.description'
                )}
                runtime={t('runtime.bundledRuntime', {
                  runtime: 'DeepSeek Harness'
                })}
              />
              <label className="field">
                <span>{t('runtime.deepseekHarness.connection')}</span>
                <select
                  aria-label={`DeepSeek Harness ${t(
                    'runtime.deepseekHarness.connection'
                  )}`}
                  disabled={!defaultDeepseekHarnessModelProfile}
                  onChange={(event) =>
                    setDeepseekHarnessModelSource(
                      parseModelSource(event.target.value)
                    )
                  }
                  value={
                    deepseekHarnessModelSource.kind === 'profile'
                      ? deepseekHarnessModelSource.profileId
                      : ''
                  }
                >
                  <option disabled value="">
                    {t(
                      'runtime.deepseekHarness.connectionPlaceholder'
                    )}
                  </option>
                  {modelProfiles.map((profile) => (
                    <option
                      disabled={!isDeepseekHarnessCompatible(profile)}
                      key={profile.id}
                      value={profile.id}
                    >
                      {modelProfileDisplayName(profile)}
                      {isDeepseekHarnessCompatible(profile)
                        ? ''
                        : t('runtime.incompatibleSuffix')}
                    </option>
                  ))}
                </select>
                <small>
                  {t(
                    'runtime.deepseekHarness.connectionDescription'
                  )}
                </small>
              </label>
              <details className="settings-section">
                <summary>{t('runtime.advanced')}</summary>
                <p className="settings-panel__description">
                  {t(
                    'runtime.deepseekHarness.advancedDescription'
                  )}
                </p>
                <button
                  className="secondary-button"
                  disabled={detecting}
                  onClick={() => void detectRuntimes()}
                  type="button"
                >
                  {detecting
                    ? t('actions.detecting')
                    : t('actions.redetectRuntime', {
                        runtime: 'DeepSeek Harness'
                      })}
                </button>
              </details>
            </div>
          )}
            </>
          )}
          <div hidden={activeTab !== 'runtime'}>
            <RuntimeCustomizationSection
              onDirtyChange={handleRuntimeCustomizationDirtyChange}
              profileId={
                activeRuntimeModelSource.kind === 'profile'
                  ? activeRuntimeModelSource.profileId
                  : undefined
              }
              provider={agentRuntimeType}
              ref={runtimeCustomizationRef}
            />
          </div>
          {activeTab === 'runtime' &&
            agentRuntimeType === 'deepseek-harness' && (
              <DshMarketplaceSection onNotify={onNotify} />
            )}

          {activeTab === 'model' && (
            <>
          <div className="model-type-navigation">
            <SegmentedControl
              ariaLabel={t('model.typeAriaLabel')}
              onChange={setModelType}
              options={[
                { label: t('model.types.llm.label'), value: 'llm' },
                {
                  label: t('model.types.embedding.label'),
                  value: 'embedding'
                },
                {
                  label: t('model.types.rerank.label'),
                  value: 'rerank'
                },
                {
                  label: t('model.types.speech.label'),
                  value: 'speech'
                }
              ]}
              value={modelType}
            />
            <small>
              {modelType === 'llm'
                ? t('model.types.llm.description')
                : modelType === 'embedding'
                  ? t('model.types.embedding.description')
                  : modelType === 'rerank'
                    ? t('model.types.rerank.description')
                    : t('model.types.speech.description')}
            </small>
          </div>
          {modelType === 'llm' && (
          <div className="settings-section">
            <div className="settings-section__title settings-section__title--actions">
              <KeyRound size={17} />
              <div>
                <strong>{t('model.profile.title')}</strong>
                <small>
                  {t('model.profile.description')}
                </small>
              </div>
              <button
                className="secondary-button model-connection-add"
                onClick={addModelProfile}
                type="button"
              >
                <Plus size={14} />
                {t('actions.addCustom')}
              </button>
            </div>
            <div className="model-connection-manager">
              <aside
                aria-label={t('model.profile.listAriaLabel')}
                className="model-connection-list"
              >
                <div className="model-connection-list__header">
                  <strong>{t('model.profile.listTitle')}</strong>
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
                        aria-label={t('model.profile.editAriaLabel', {
                          name: modelProfileDisplayName(profile)
                        })}
                        onClick={() =>
                          setSelectedModelProfileId(profile.id)
                        }
                        type="button"
                      >
                        <span className="model-connection-list__name">
                          <strong>{modelProfileDisplayName(profile)}</strong>
                          <small>{profile.modelName}</small>
                        </span>
                        <span className="model-connection-list__badges">
                          {defaultModelProfileId === profile.id && (
                            <span>{t('model.profile.defaultBadge')}</span>
                          )}
                          {profile.protocol ===
                            'openai-images-generations' && (
                            <span>{t('model.profile.imageBadge')}</span>
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
                        {modelProfileDisplayName(profile)}
                      </strong>
                      <small>{t('model.profile.detail')}</small>
                    </div>
                    <label className="check-field">
                      <input
                        checked={defaultModelProfileId === profile.id}
                        name="default-model-profile"
                        onChange={() =>
                          selectDefaultModelProfile(profile)
                        }
                        type="radio"
                      />
                      <span>{t('model.profile.defaultConnection')}</span>
                    </label>
                    {profile.protocol === 'openai-images-generations' && (
                      <span className="model-capability-badge">
                        {t('model.profile.imageGeneration')}
                      </span>
                    )}
                    <button
                      aria-label={t('model.profile.deleteAriaLabel', {
                        name: modelProfileDisplayName(profile)
                      })}
                      className="danger-button danger-button--quiet"
                      disabled={modelProfiles.length <= 1}
                      onClick={() => removeModelProfile(profile.id)}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      {t('actions.deleteConnection')}
                    </button>
                  </div>
                  <label className="field">
                    <span>{t('model.profile.name')}</span>
                    <input
                      onChange={(event) =>
                        updateModelProfile(profile.id, {
                          name: event.target.value
                        })
                      }
                      value={modelProfileDisplayName(profile)}
                    />
                  </label>
                  <label className="field">
                    <span>{t('model.profile.endpoint')}</span>
                    <input
                      disabled={environmentManaged}
                      inputMode="url"
                      onChange={(event) =>
                        updateModelProfile(profile.id, {
                          baseUrl: event.target.value
                        })
                      }
                      placeholder="https://api.example.com/v1"
                      value={profile.baseUrl}
                    />
                  </label>
                  <label className="field">
                    <span>{t('model.profile.model')}</span>
                    <input
                      disabled={environmentManaged}
                      onChange={(event) =>
                        updateModelProfile(profile.id, {
                          modelName: event.target.value
                        })
                      }
                      placeholder="model-name"
                      value={profile.modelName}
                    />
                  </label>
                  <label className="field">
                    <span>{t('model.profile.protocol')}</span>
                    <select
                      aria-label={t(
                        'model.profile.protocolAriaLabel',
                        { name: modelProfileDisplayName(profile) }
                      )}
                      onChange={(event) =>
                        {
                          const protocol = event.target
                            .value as ModelProfileDraft['protocol']
                          updateModelProfile(profile.id, { protocol })
                          const compatibleFallback =
                            modelProfiles.find(
                              (candidate) =>
                                candidate.id !== profile.id &&
                                candidate.id === defaultModelProfileId &&
                                isAgentRuntimeModelProtocol(
                                  candidate.protocol
                                )
                            ) ??
                            modelProfiles.find(
                              (candidate) =>
                                candidate.id !== profile.id &&
                                isAgentRuntimeModelProtocol(
                                  candidate.protocol
                                )
                            )
                          const runtimeFallback: RuntimeModelSource =
                            compatibleFallback
                              ? {
                                  kind: 'profile',
                                  profileId: compatibleFallback.id
                                }
                              : { kind: 'platform' }
                          if (
                            !isAgentRuntimeModelProtocol(protocol) &&
                            opencodeModelSource.kind === 'profile' &&
                            opencodeModelSource.profileId === profile.id
                          ) {
                            setOpencodeModelSource(runtimeFallback)
                          }
                          if (
                            !isAgentRuntimeModelProtocol(protocol) &&
                            continueModelSource.kind === 'profile' &&
                            continueModelSource.profileId === profile.id
                          ) {
                            setContinueModelSource(runtimeFallback)
                          }
                          if (
                            protocol !== 'openai-chat-completions' &&
                            deepseekHarnessModelSource.kind ===
                              'profile' &&
                            deepseekHarnessModelSource.profileId ===
                              profile.id
                          ) {
                            const harnessFallback =
                              modelProfiles.find(
                                (candidate) =>
                                  candidate.id !== profile.id &&
                                  candidate.protocol ===
                                    'openai-chat-completions'
                              )
                            setDeepseekHarnessModelSource(
                              harnessFallback
                                ? {
                                    kind: 'profile',
                                    profileId: harnessFallback.id
                                  }
                                : { kind: 'platform' }
                            )
                          }
                          if (
                            !isAgentRuntimeModelProtocol(protocol) &&
                            contextCompression.modelSource.kind ===
                              'profile' &&
                            contextCompression.modelSource.profileId ===
                              profile.id
                          ) {
                            setContextCompression((current) => ({
                              ...current,
                              modelSource: { kind: 'current' }
                            }))
                          }
                        }
                      }
                      value={profile.protocol}
                    >
                      <option value="openai-chat-completions">
                        {t('model.profile.openAiCompatibleProtocol')}
                      </option>
                      <option value="openai-responses">
                        OpenAI Responses
                      </option>
                      <option value="anthropic-messages">
                        Anthropic Messages
                      </option>
                      <option value="openai-images-generations">
                        {t('model.profile.imageProtocol')}
                      </option>
                    </select>
                  </label>
                  <label className="field">
                    <span>{t('model.profile.authentication')}</span>
                    <select
                      aria-label={t(
                        'model.profile.authenticationAriaLabel',
                        { name: modelProfileDisplayName(profile) }
                      )}
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
                      }}
                      value={profile.authentication}
                    >
                      <option value="api-key">API Key</option>
                      <option value="none">
                        {t('credentials.noAuthentication')}
                      </option>
                    </select>
                  </label>
                  {isAgentRuntimeModelProtocol(profile.protocol) && (
                    <>
                      <div className="field">
                        <label className="toggle-row">
                          <input
                            checked={profile.supportsImageInput}
                            onChange={(event) =>
                              updateModelProfile(profile.id, {
                                supportsImageInput: event.target.checked
                              })
                            }
                            role="switch"
                            type="checkbox"
                          />
                          <span>{t('model.profile.supportsImageInput')}</span>
                        </label>
                        <small>
                          {t('model.profile.supportsImageInputDescription')}
                        </small>
                      </div>
                      <label className="field">
                        <span>{t('model.profile.contextWindow')}</span>
                        <input
                          aria-label={t('model.profile.contextWindow')}
                          inputMode="numeric"
                          max={10_000}
                          min={32}
                          onChange={(event) => {
                            const value = event.target.valueAsNumber
                            updateModelProfile(profile.id, {
                              contextWindowTokens: Number.isFinite(value)
                                ? Math.round(value * 1_000)
                                : undefined
                            })
                          }}
                          placeholder="200"
                          type="number"
                          value={
                            profile.contextWindowTokens === undefined
                              ? ''
                              : profile.contextWindowTokens / 1_000
                          }
                        />
                        <small>
                          {t('model.profile.contextWindowDescription')}
                        </small>
                      </label>
                    </>
                  )}
                  {profile.protocol ===
                    'openai-images-generations' && (
                      <label className="field">
                        <span>{t('model.profile.imageQuality')}</span>
                        <select
                          aria-label={t(
                            'model.profile.imageQualityAriaLabel',
                            { name: modelProfileDisplayName(profile) }
                          )}
                          onChange={(event) =>
                            updateModelProfile(profile.id, {
                              imageGenerationQuality: event.target
                                .value as ModelProfileDraft['imageGenerationQuality']
                            })
                          }
                          value={profile.imageGenerationQuality}
                        >
                          <option value="auto">
                            {t('model.profile.quality.auto')}
                          </option>
                          <option value="low">
                            {t('model.profile.quality.low')}
                          </option>
                          <option value="medium">
                            {t('model.profile.quality.medium')}
                          </option>
                          <option value="high">
                            {t('model.profile.quality.high')}
                          </option>
                        </select>
                        <small>
                          {t('model.profile.imageQualityDescription')}
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
                              ? t('credentials.configuredPlaceholder')
                              : t('credentials.enterApiKey')
                          }
                          type="password"
                          value={profile.apiKey}
                        />
                      </label>
                      <div className="credential-state">
                        <LockKeyhole size={15} />
                        <span>
                          {t(
                            `credentials.${profile.credentialSource}`
                          )}
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
                              ? t('actions.clearAfterSave')
                              : t('actions.clearCredential')}
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="credential-state">
                      <LockKeyhole size={15} />
                      <span>
                        {t('credentials.noAuthenticationDescription')}
                      </span>
                    </div>
                  )}
                  <small className="model-connection-detail__compatibility">
                    {t('model.profile.compatibilitySummary', {
                      directCapability:
                        profile.protocol ===
                        'openai-images-generations'
                          ? t('model.profile.imageGeneration')
                          : t('model.profile.textChat'),
                      continueCompatibility: isContinueCompatible(profile)
                        ? t('model.profile.compatible')
                        : t('model.profile.incompatible'),
                      openCodeCompatibility: isOpenCodeCompatible(profile)
                        ? t('model.profile.compatible')
                        : t('model.profile.incompatibleImageProtocol'),
                      deepseekHarnessCompatibility:
                        isDeepseekHarnessCompatible(profile)
                          ? t('model.profile.compatible')
                          : t(
                              'model.profile.incompatibleHarnessProtocol'
                            )
                    })}
                  </small>
                </div>
              )
              })()}
            </div>
            {settings && !settings.secureStorageAvailable && (
              <p className="settings-warning">
                {t('model.profile.secureStorageWarning')}
              </p>
            )}
          </div>
          )}
          {modelType === 'embedding' && (
            <div className="settings-section">
              <div className="settings-section__title">
                <KeyRound size={17} />
                <div>
                  <strong>{t('model.embedding.title')}</strong>
                  <small>{t('model.embedding.description')}</small>
                </div>
              </div>
              <div className="runtime-note model-service-form">
                <label className="toggle-row">
                  <input
                    checked={knowledgeEmbeddingEnabled}
                    onChange={(event) =>
                      setKnowledgeEmbeddingEnabled(event.target.checked)
                    }
                    role="switch"
                    type="checkbox"
                  />
                  <span>{t('model.embedding.enabled')}</span>
                </label>
                <label className="field">
                  <span>{t('model.embedding.endpoint')}</span>
                  <input
                    aria-label={t('model.embedding.endpoint')}
                    disabled={!knowledgeEmbeddingEnabled}
                    inputMode="url"
                    onChange={(event) =>
                      setKnowledgeEmbeddingBaseUrl(event.target.value)
                    }
                    placeholder="https://provider.example/v1/embeddings"
                    value={knowledgeEmbeddingBaseUrl}
                  />
                  <small>
                    {t('model.embedding.endpointDescription')}
                  </small>
                </label>
                <label className="field">
                  <span>{t('model.embedding.modelName')}</span>
                  <input
                    aria-label={t('model.embedding.modelName')}
                    disabled={!knowledgeEmbeddingEnabled}
                    onChange={(event) =>
                      setKnowledgeEmbeddingModel(event.target.value)
                    }
                    value={knowledgeEmbeddingModel}
                  />
                </label>
                <label className="field">
                  <span>{t('model.embedding.optionalApiKey')}</span>
                  <input
                    aria-label={t('model.embedding.optionalApiKey')}
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
                        ? t('credentials.configuredPlaceholder')
                        : t('model.embedding.optionalApiKeyPlaceholder')
                    }
                    type="password"
                    value={knowledgeEmbeddingApiKey}
                  />
                </label>
                <div className="credential-state">
                  <LockKeyhole size={15} />
                  <span>
                    {settings
                      ? t(
                          `credentials.${settings.knowledgeEmbeddingCredentialSource}`
                        )
                      : t('credentials.none')}
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
                        ? t('actions.clearAfterSave')
                        : t('actions.clearCredential')}
                    </button>
                  )}
                </div>
                <small>
                  {t('model.embedding.privacyDescription')}
                </small>
              </div>
            </div>
          )}
          {modelType === 'embedding' && embeddingConfiguration && (
            <EmbeddingSettingsSection
              configuration={embeddingConfiguration}
              diagnostic={embeddingDiagnostic}
              diagnosticRunning={embeddingDiagnosticRunning}
              disabled={saving || !knowledgeEmbeddingEnabled}
              onTest={() => {
                void runEmbeddingDiagnostic()
              }}
            />
          )}
          {modelType === 'rerank' && (
            <div className="settings-section">
              <div className="settings-section__title">
                <KeyRound size={17} />
                <div>
                  <strong>{t('model.rerank.title')}</strong>
                  <small>{t('model.rerank.description')}</small>
                </div>
              </div>
              <div className="runtime-note model-service-form">
                <label className="toggle-row">
                  <input
                    checked={knowledgeRerankEnabled}
                    onChange={(event) =>
                      setKnowledgeRerankEnabled(event.target.checked)
                    }
                    role="switch"
                    type="checkbox"
                  />
                  <span>{t('model.rerank.enabled')}</span>
                </label>
                <label className="field">
                  <span>{t('model.rerank.endpoint')}</span>
                  <input
                    aria-label={t('model.rerank.endpoint')}
                    disabled={!knowledgeRerankEnabled}
                    inputMode="url"
                    onChange={(event) =>
                      setKnowledgeRerankEndpoint(event.target.value)
                    }
                    placeholder="https://api.cohere.com/v1/rerank"
                    value={knowledgeRerankEndpoint}
                  />
                  <small>{t('model.rerank.endpointDescription')}</small>
                </label>
                <label className="field">
                  <span>{t('model.rerank.modelName')}</span>
                  <input
                    aria-label={t('model.rerank.modelName')}
                    disabled={!knowledgeRerankEnabled}
                    onChange={(event) =>
                      setKnowledgeRerankModel(event.target.value)
                    }
                    value={knowledgeRerankModel}
                  />
                </label>
                <label className="field">
                  <span>{t('model.rerank.optionalApiKey')}</span>
                  <input
                    aria-label={t('model.rerank.optionalApiKey')}
                    autoComplete="off"
                    disabled={
                      !knowledgeRerankEnabled ||
                      settings?.knowledgeRerankCredentialSource ===
                        'environment' ||
                      !settings?.secureStorageAvailable
                    }
                    onChange={(event) => {
                      setKnowledgeRerankApiKey(event.target.value)
                      setClearKnowledgeRerankApiKey(false)
                    }}
                    placeholder={
                      settings?.knowledgeRerankApiKeyConfigured
                        ? t('credentials.configuredPlaceholder')
                        : t('model.rerank.optionalApiKeyPlaceholder')
                    }
                    type="password"
                    value={knowledgeRerankApiKey}
                  />
                </label>
                <div className="credential-state" aria-live="polite">
                  <LockKeyhole size={15} />
                  <span>
                    {settings
                      ? t(
                          `credentials.${settings.knowledgeRerankCredentialSource ?? 'none'}`
                        )
                      : t('credentials.none')}
                  </span>
                  {settings?.knowledgeRerankCredentialSource ===
                    'encrypted' && (
                    <button
                      onClick={() => {
                        setKnowledgeRerankApiKey('')
                        setClearKnowledgeRerankApiKey(true)
                      }}
                      type="button"
                    >
                      {clearKnowledgeRerankApiKey
                        ? t('actions.clearAfterSave')
                        : t('actions.clearCredential')}
                    </button>
                  )}
                </div>
                <small>{t('model.rerank.privacyDescription')}</small>
              </div>
            </div>
          )}
          {modelType === 'speech' && (
            <SpeechModelSettingsSection
              onNotify={onNotify}
              onSelectedModelIdChange={(modelId, changed) => {
                setSpeechModelDraftId(modelId)
                setSpeechModelSelectionDirty(changed)
              }}
              onSelectionInvalidated={(modelId) => {
                setSpeechModelDraftId(modelId)
                setPersistedSpeechModelId(modelId)
                setSpeechModelSelectionDirty(false)
              }}
              persistedSelectedModelId={persistedSpeechModelId}
              selectedModelId={speechModelDraftId}
            />
          )}
            </>
          )}

          {activeTab === 'context-control' && (
            <>
              <div className="settings-section">
                <div className="field">
                  <label className="toggle-row">
                    <input
                      checked={contextCompression.enabled}
                      onChange={(event) =>
                        setContextCompression((current) => ({
                          ...current,
                          enabled: event.target.checked
                        }))
                      }
                      role="switch"
                      type="checkbox"
                    />
                    <span>{t('contextControl.enabled')}</span>
                  </label>
                  <small>{t('contextControl.enabledDescription')}</small>
                  <small>{t('contextControl.usageNotice')}</small>
                </div>
              </div>
              <div className="settings-section">
                <label className="field">
                  <span>{t('contextControl.triggerTokens')}</span>
                  <input
                    aria-label={t('contextControl.triggerTokens')}
                    disabled={!contextCompression.enabled}
                    inputMode="numeric"
                    max={maximumContextCompressionTriggerThousands}
                    min={minimumContextCompressionTriggerThousands}
                    onBlur={commitContextCompressionTokenInput}
                    onChange={(event) =>
                      setContextCompressionTokenInput((current) => ({
                        ...current,
                        trigger: event.target.value
                      }))
                    }
                    required
                    step={1}
                    type="number"
                    value={contextCompressionTokenInput.trigger}
                  />
                  <small>
                    {t('contextControl.triggerTokensDescription', {
                      tokens:
                        normalizedContextCompression.triggerTokens
                          .toLocaleString(i18n.language)
                    })}
                  </small>
                </label>
                <label className="field">
                  <span>{t('contextControl.recentRawTokens')}</span>
                  <input
                    aria-label={t('contextControl.recentRawTokens')}
                    disabled={!contextCompression.enabled}
                    inputMode="numeric"
                    max={maximumContextCompressionRecentRawThousandsFor(
                      normalizedContextCompression.triggerTokens
                    )}
                    min={minimumContextCompressionRecentRawThousands}
                    onBlur={commitContextCompressionTokenInput}
                    onChange={(event) =>
                      setContextCompressionTokenInput((current) => ({
                        ...current,
                        recentRaw: event.target.value
                      }))
                    }
                    required
                    step={1}
                    type="number"
                    value={contextCompressionTokenInput.recentRaw}
                  />
                  <small>
                    {t('contextControl.recentRawTokensDescription', {
                      tokens:
                        normalizedContextCompression.recentRawTokens
                          .toLocaleString(i18n.language)
                    })}
                  </small>
                </label>
                <label className="field">
                  <span>{t('contextControl.summaryModel')}</span>
                  <select
                    aria-label={t('contextControl.summaryModel')}
                    disabled={!contextCompression.enabled}
                    onChange={(event) =>
                      setContextCompression((current) => ({
                        ...current,
                        modelSource:
                          event.target.value === 'current'
                            ? { kind: 'current' }
                            : {
                                kind: 'profile',
                                profileId: event.target.value
                              }
                      }))
                    }
                    value={
                      contextCompression.modelSource.kind === 'current'
                        ? 'current'
                        : contextCompression.modelSource.profileId
                    }
                  >
                    <option value="current">
                      {t('contextControl.currentModel')}
                    </option>
                    {modelProfiles
                      .filter((profile) =>
                        isAgentRuntimeModelProtocol(profile.protocol)
                      )
                      .map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {modelProfileDisplayName(profile)} ·{' '}
                          {profile.modelName}
                        </option>
                      ))}
                  </select>
                  <small>{t('contextControl.summaryModelDescription')}</small>
                </label>
                <p className="settings-panel__description">
                  {t('contextControl.fixedTarget')}
                </p>
              </div>
              <div className="runtime-note">
                <p>{t('contextControl.modelLimits')}</p>
                <button
                  className="secondary-button"
                  onClick={() => {
                    setModelType('llm')
                    setActiveTab('model')
                  }}
                  type="button"
                >
                  {t('contextControl.manageModelLimits')}
                </button>
              </div>
              <details className="settings-section">
                <summary>{t('contextControl.advanced')}</summary>
                <label className="field">
                  <span>{t('contextControl.summaryPrompt')}</span>
                  <textarea
                    disabled={!contextCompression.enabled}
                    onChange={(event) =>
                      setContextCompression((current) => ({
                        ...current,
                        summaryPrompt: event.target.value
                      }))
                    }
                    rows={7}
                    value={contextCompression.summaryPrompt}
                  />
                  <small>
                    {t('contextControl.summaryPromptDescription')}
                  </small>
                </label>
                <button
                  className="secondary-button"
                  disabled={
                    !contextCompression.enabled ||
                    contextCompression.summaryPrompt ===
                      defaultContextCompressionSettings.summaryPrompt
                  }
                  onClick={() =>
                    setContextCompression((current) => ({
                      ...current,
                      summaryPrompt:
                        defaultContextCompressionSettings.summaryPrompt
                    }))
                  }
                  type="button"
                >
                  {t('contextControl.restoreDefaultPrompt')}
                </button>
              </details>
            </>
          )}

          {activeTab === 'document-parsing' && (
            <DocumentParsingSettingsSection onNotify={onNotify} />
          )}

          {activeTab === 'security' && (
            <>
          <div className="settings-section">
            <label className="field">
            <span>{t('security.toolPolicy.label')}</span>
            <select
              aria-label={t('security.toolPolicy.label')}
              value={toolApproval}
              onChange={(event) =>
                setToolApproval(
                  event.target.value as RuntimeSettingsInput['toolApproval']
                )
              }
            >
              <option value="always">
                {t('security.toolPolicy.always')}
              </option>
              <option value="policy">
                {t('security.toolPolicy.deny')}
              </option>
            </select>
            <small>
              {t('security.toolPolicy.description')}
            </small>
            </label>
          </div>

          <div className="settings-section settings-section--danger">
            <div>
              <strong>{t('security.localData.title')}</strong>
              <p>
                {t('security.localData.description')}
              </p>
            </div>
            {confirmingClear ? (
              <div className="danger-actions">
                <button
                  className="secondary-button"
                  disabled={clearingLocalData}
                  onClick={() => setConfirmingClear(false)}
                  type="button"
                >
                  {t('actions.cancel')}
                </button>
                <button
                  className="danger-button"
                  disabled={clearingLocalData}
                  onClick={() => {
                    setClearingLocalData(true)
                    setError(undefined)
                    void onClearLocalData()
                      .then(() => {
                        setConfirmingClear(false)
                      })
                      .catch((reason: unknown) => {
                        setError(
                          settingsErrorMessage(
                            reason,
                            t('errors.clearLocalData')
                          )
                        )
                      })
                      .finally(() => setClearingLocalData(false))
                  }}
                  type="button"
                >
                  {clearingLocalData
                    ? t('actions.clearing')
                    : t('actions.clearLocalData')}
                </button>
              </div>
            ) : (
              <button
                className="danger-button"
                onClick={() => setConfirmingClear(true)}
                type="button"
              >
                {t('actions.clearLocalData')}
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
          {activeTab === 'channels' && (
            <ChannelSettingsSection
              initialChannel={initialChannel}
              onNotify={onNotify}
              onUpdateProject={onUpdateProject}
              projectList={projects}
            />
          )}
          {activeTab === 'roles' && (
            <>
              <div className="settings-section subagent-routing-settings">
                <div className="settings-section__title">
                  <div>
                    <strong>{t('roles.smartRouting.title')}</strong>
                    <small>
                      {t('roles.smartRouting.description')}
                    </small>
                  </div>
                </div>
                <label className="toggle-row">
                  <input
                    aria-describedby="subagent-smart-routing-help"
                    checked={subagentSmartRoutingEnabled}
                    onChange={(event) =>
                      setSubagentSmartRoutingEnabled(event.target.checked)
                    }
                    role="switch"
                    type="checkbox"
                  />
                  <span>{t('roles.smartRouting.enabled')}</span>
                </label>
                <small id="subagent-smart-routing-help">
                  {t('roles.smartRouting.help')}
                </small>
              </div>
              <RolePromptSettingsSection
                defaultModelProfileId={savedRoleDefaultModelProfileId}
                modelProfiles={savedRoleModelProfiles}
                onChanged={onExpertsChanged}
              />
            </>
          )}
          {activeTab === 'skills' && <SkillsSettingsSection />}
          {activeTab === 'mcp' && (
            <McpSettingsSection
              magicNotesEnabled={magicNotesEnabled}
            />
          )}
          {activeTab === 'about' && <UpdateSettingsSection />}
          </div>
        </div>
      </section>
    </div>
  )
}
