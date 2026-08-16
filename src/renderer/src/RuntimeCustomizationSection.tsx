import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Boxes,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  runtimeCustomizationLimits,
  type ContinueConfigurationPreset,
  type CustomizableRuntimeProvider,
  type RuntimeCustomizationSettings,
  type RuntimeNativeSnapshot
} from '../../shared/contracts'
import { EmptyState, PageTabs } from './WorkspacePrimitives'

type RuntimeCustomizationSectionProps = {
  provider: CustomizableRuntimeProvider
  profileId?: string
  onDirtyChange?: (dirty: boolean) => void
}

export type RuntimeCustomizationSectionHandle = {
  save: () => Promise<boolean>
}

type RuntimeCustomizationError = {
  message: string
  retry: 'load' | 'refresh' | 'save'
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 1_000)
  }
  return fallback
}

function replacePreset(
  settings: RuntimeCustomizationSettings,
  preset: ContinueConfigurationPreset
): RuntimeCustomizationSettings {
  return {
    ...settings,
    continue: {
      ...settings.continue,
      presets: settings.continue.presets.map((candidate) =>
        candidate.id === preset.id ? preset : candidate
      )
    }
  }
}

type NativeInventoryTab =
  | 'agents'
  | 'tools'
  | 'commands'
  | 'skills'
  | 'mcp'
  | 'rules'
  | 'prompts'
  | 'resources'
  | 'lsp'
  | 'formatters'
  | 'context'

type NativeInventoryGroup = {
  key: NativeInventoryTab
  label: string
  items: Array<{
    id: string
    title: string
    detail?: string
  }>
  emptyLabel?: string
}

const NativeInventoryTabs = memo(function NativeInventoryTabs({
  groups,
  provider
}: {
  groups: NativeInventoryGroup[]
  provider: RuntimeNativeSnapshot['provider']
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [activeTab, setActiveTab] = useState<NativeInventoryTab>(
    () =>
      groups.find(
        (group) =>
          group.key !== 'context' && group.items.length > 0
      )?.key ?? 'context'
  )
  const activeGroup =
    groups.find((group) => group.key === activeTab) ?? groups.at(-1)!

  return (
    <>
      <PageTabs
        ariaLabel={t(
          'runtime.customization.inventory.tabsAriaLabel'
        )}
        idPrefix={`runtime-native-${provider}`}
        onChange={setActiveTab}
        tabs={groups.map((group) => ({
          id: group.key,
          label: group.label,
          ...(group.key === 'context'
            ? {}
            : { count: group.items.length })
        }))}
        value={activeTab}
      />
      <section
        aria-labelledby={`runtime-native-${provider}-tab-${activeTab}`}
        className="runtime-native-inventory__panel"
        id={`runtime-native-${provider}-panel-${activeTab}`}
        role="tabpanel"
      >
        {activeGroup.items.length > 0 ? (
          <ul>
            {activeGroup.items.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                {item.detail ? <small>{item.detail}</small> : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            description={t(
              'runtime.customization.inventory.emptyDescription'
            )}
            icon={<Boxes size={22} />}
            level="table"
            title={
              activeGroup.emptyLabel ??
              t('runtime.customization.inventory.empty')
            }
          />
        )}
      </section>
    </>
  )
})

const NativeInventoryStatus = memo(function NativeInventoryStatus({
  snapshot
}: {
  snapshot: RuntimeNativeSnapshot
}): React.JSX.Element {
  return (
    <div
      className={`runtime-native-inventory__status runtime-native-inventory__status--${snapshot.inventoryStatus}`}
      role={
        snapshot.inventoryStatus === 'unavailable'
          ? 'alert'
          : 'status'
      }
    >
      <span>{snapshot.detail}</span>
    </div>
  )
})

const NativeInventory = memo(function NativeInventory({
  snapshot
}: {
  snapshot: RuntimeNativeSnapshot
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const groups: NativeInventoryGroup[] = [
    {
      key: 'agents',
      label: t('runtime.customization.inventory.agents'),
      items: snapshot.agents.map((agent) => ({
        id: agent.id,
        title: agent.name,
        detail: [
          t(
            `runtime.customization.agentMode.${agent.mode}`,
            agent.mode
          ),
          agent.description
        ]
          .filter(Boolean)
          .join(' · ')
      }))
    },
    {
      key: 'tools',
      label: t('runtime.customization.inventory.tools'),
      items: snapshot.tools.map((tool) => ({
        id: tool.id,
        title: tool.name,
        detail: [
          tool.description,
          t(
            `runtime.customization.inventory.toolKind.${tool.kind}`,
            tool.kind
          ),
          t(
            `runtime.customization.inventory.toolSource.${tool.source}`,
            tool.source
          ),
          t('runtime.customization.inventory.toolModes', {
            ask: t(
              `runtime.customization.inventory.toolAccess.${tool.ask}`,
              tool.ask
            ),
            execute: t(
              `runtime.customization.inventory.toolAccess.${tool.execute}`,
              tool.execute
            )
          })
        ]
          .filter(Boolean)
          .join(' · ')
      })),
      emptyLabel: snapshot.toolsSupported
        ? undefined
        : t('runtime.customization.inventory.toolsUnsupported')
    },
    {
      key: 'commands',
      label: t('runtime.customization.inventory.commands'),
      items: snapshot.commands.map((command) => ({
        id: command.id,
        title: command.name,
        detail: [
          t(
            `runtime.customization.commandSource.${command.source}`,
            command.source
          ),
          command.description
        ]
          .filter(Boolean)
          .join(' · ')
      }))
    },
    {
      key: 'skills',
      label: t('runtime.customization.inventory.skills'),
      items: snapshot.skills.map((skill) => ({
        id: skill.id,
        title: skill.name,
        detail: skill.description
      }))
    },
    {
      key: 'mcp',
      label: t('runtime.customization.inventory.mcp'),
      items: snapshot.mcpServers.map((server) => ({
        id: server.id,
        title: server.name,
        detail: [
          t(
            `runtime.customization.status.${server.status}`,
            server.status
          ),
          server.detail
        ]
          .filter(Boolean)
          .join(' · ')
      }))
    },
    {
      key: 'rules',
      label: t('runtime.customization.inventory.rules'),
      items: snapshot.rules.map((rule) => ({
        id: rule.id,
        title: rule.name,
        detail: rule.description
      }))
    },
    {
      key: 'prompts',
      label: t('runtime.customization.inventory.prompts'),
      items: snapshot.prompts.map((prompt) => ({
        id: prompt.id,
        title: prompt.name,
        detail: prompt.description
      }))
    },
    {
      key: 'resources',
      label: t('runtime.customization.inventory.resources'),
      items: snapshot.resources.map((resource) => ({
        id: resource.id,
        title: resource.name,
        detail: [resource.server, resource.mimeType, resource.description]
          .filter(Boolean)
          .join(' · ')
      })),
      emptyLabel: snapshot.resourcesSupported
        ? undefined
        : t('runtime.customization.inventory.unsupported')
    },
    {
      key: 'lsp',
      label: t('runtime.customization.inventory.lsp'),
      items: snapshot.lsp.map((server) => ({
        id: server.id,
        title: server.name,
        detail: [
          t(
            `runtime.customization.status.${server.status}`,
            server.status
          ),
          server.detail
        ]
          .filter(Boolean)
          .join(' · ')
      }))
    },
    {
      key: 'formatters',
      label: t('runtime.customization.inventory.formatters'),
      items: snapshot.formatters.map((formatter) => ({
        id: formatter.id,
        title: formatter.name,
        detail: [
          formatter.enabled
            ? t('runtime.customization.enabled')
            : t('runtime.customization.disabled'),
          formatter.extensions.join(', ')
        ]
          .filter(Boolean)
          .join(' · ')
      }))
    },
    {
      key: 'context',
      label: t('runtime.customization.context.title'),
      items: [
        {
          id: 'context',
          title: t('runtime.customization.context.title'),
          detail: snapshot.context.detail
        }
      ]
    }
  ]
  return (
    <div className="runtime-native-inventory">
      <NativeInventoryTabs
        groups={groups}
        provider={snapshot.provider}
      />
    </div>
  )
})

export const RuntimeCustomizationSection = forwardRef<
  RuntimeCustomizationSectionHandle,
  RuntimeCustomizationSectionProps
>(function RuntimeCustomizationSection(
  { provider, profileId, onDirtyChange },
  ref
): React.JSX.Element {
  const { t } = useTranslation('settings')
  const loadGeneration = useRef(0)
  const [settings, setSettings] =
    useState<RuntimeCustomizationSettings>()
  const [persistedSettings, setPersistedSettings] =
    useState<RuntimeCustomizationSettings>()
  const [snapshot, setSnapshot] = useState<RuntimeNativeSnapshot>()
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<RuntimeCustomizationError>()
  const [mergedRulesOpen, setMergedRulesOpen] = useState(false)
  const settingsDirty = useMemo(
    () =>
      Boolean(
        settings &&
          persistedSettings &&
          JSON.stringify(settings) !== JSON.stringify(persistedSettings)
      ),
    [persistedSettings, settings]
  )
  const settingsRef = useRef(settings)
  const settingsDirtyRef = useRef(settingsDirty)

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    settingsDirtyRef.current = settingsDirty
    onDirtyChange?.(settingsDirty)
  }, [onDirtyChange, settingsDirty])

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current
    setLoading(true)
    setRefreshing(false)
    setSnapshot(undefined)
    setError(undefined)
    try {
      const [nextSettings, nextSnapshot] = await Promise.all([
        window.goodbuddy.runtimeCustomization.getSettings(),
        window.goodbuddy.runtimeCustomization.getNativeSnapshot({
          provider,
          ...(profileId ? { profileId } : {})
        })
      ])
      if (generation !== loadGeneration.current) {
        return
      }
      if (!settingsDirtyRef.current) {
        setSettings(nextSettings)
        setPersistedSettings(nextSettings)
      }
      setSnapshot(nextSnapshot)
      const draftSettings = settingsDirtyRef.current
        ? settingsRef.current
        : nextSettings
      setSelectedPresetId((current) =>
        draftSettings?.continue.presets.some(
          (preset) => preset.id === current
        )
          ? current
          : draftSettings?.continue.defaultPresetId ??
            draftSettings?.continue.presets[0]?.id ??
            ''
      )
    } catch (reason) {
      if (generation === loadGeneration.current) {
        setError({
          message: errorMessage(
            reason,
            t('runtime.customization.errors.load')
          ),
          retry: 'load'
        })
      }
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false)
      }
    }
  }, [profileId, provider, t])

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current
    setRefreshing(true)
    setError(undefined)
    try {
      const nextSnapshot =
        await window.goodbuddy.runtimeCustomization.getNativeSnapshot({
          provider,
          ...(profileId ? { profileId } : {})
        })
      if (generation === loadGeneration.current) {
        setSnapshot(nextSnapshot)
      }
    } catch (reason) {
      if (generation === loadGeneration.current) {
        setError({
          message: errorMessage(
            reason,
            t('runtime.customization.errors.load')
          ),
          retry: 'refresh'
        })
      }
    } finally {
      if (generation === loadGeneration.current) {
        setRefreshing(false)
      }
    }
  }, [profileId, provider, t])

  useEffect(() => {
    const generation = loadGeneration.current
    queueMicrotask(() => {
      if (generation === loadGeneration.current) {
        void load()
      }
    })
    return () => {
      loadGeneration.current += 1
    }
  }, [load])

  const selectedPreset = useMemo(
    () =>
      settings?.continue.presets.find(
        (preset) => preset.id === selectedPresetId
      ),
    [selectedPresetId, settings]
  )

  const save = useCallback(async (): Promise<boolean> => {
    if (!settings) {
      return true
    }
    if (!settingsDirty) {
      return true
    }
    setSaving(true)
    setError(undefined)
    try {
      const saved =
        await window.goodbuddy.runtimeCustomization.updateSettings(
          settings
        )
      setSettings(saved)
      setPersistedSettings(saved)
      return true
    } catch (reason) {
      setError({
        message: errorMessage(
          reason,
          t('runtime.customization.errors.save')
        ),
        retry: 'save'
      })
      return false
    } finally {
      setSaving(false)
    }
  }, [settings, settingsDirty, t])

  useImperativeHandle(ref, () => ({ save }), [save])

  const discardChanges = (): void => {
    if (!persistedSettings) {
      return
    }
    setSettings(persistedSettings)
    setSelectedPresetId(
      persistedSettings.continue.defaultPresetId ??
        persistedSettings.continue.presets[0]?.id ??
        ''
    )
    setError(undefined)
  }

  const addPreset = (): void => {
    if (
      !settings ||
      settings.continue.presets.length >=
        runtimeCustomizationLimits.presets
    ) {
      return
    }
    const id = crypto.randomUUID()
    const preset: ContinueConfigurationPreset = {
      id,
      name: t('runtime.customization.continue.newPreset'),
      rules: [],
      prompts: []
    }
    setSettings({
      ...settings,
      continue: {
        ...settings.continue,
        presets: [...settings.continue.presets, preset]
      }
    })
    setSelectedPresetId(id)
  }

  const removePreset = (): void => {
    if (!settings || !selectedPreset) {
      return
    }
    const presets = settings.continue.presets.filter(
      (preset) => preset.id !== selectedPreset.id
    )
    setSettings({
      ...settings,
      continue: {
        defaultPresetId:
          settings.continue.defaultPresetId === selectedPreset.id
            ? undefined
            : settings.continue.defaultPresetId,
        presets
      }
    })
    setSelectedPresetId(presets[0]?.id ?? '')
  }

  const updateSelectedPreset = (
    update: (
      current: ContinueConfigurationPreset
    ) => ContinueConfigurationPreset
  ): void => {
    if (!settings || !selectedPreset) {
      return
    }
    setSettings(replacePreset(settings, update(selectedPreset)))
  }

  return (
    <section
      aria-labelledby={`runtime-customization-${provider}`}
      className="settings-section runtime-customization-section"
    >
      <div className="settings-section__title runtime-customization-section__header">
        <div>
          <strong id={`runtime-customization-${provider}`}>
            {t('runtime.customization.title')}
          </strong>
          <small>{t('runtime.customization.description')}</small>
        </div>
        <button
          aria-label={t('runtime.customization.refresh')}
          className="icon-button"
          disabled={!snapshot || refreshing || saving}
          onClick={() => void refreshSnapshot()}
          title={t('runtime.customization.refresh')}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={16} />
        </button>
      </div>

      {error ? (
        <div
          className="inline-error runtime-customization-section__error"
          role="alert"
        >
          <span>{error.message}</span>
          <button
            className="secondary-button"
            onClick={() => {
              if (error.retry === 'save') {
                void save()
              } else if (error.retry === 'refresh') {
                void refreshSnapshot()
              } else {
                void load()
              }
            }}
            type="button"
          >
            {t('runtime.customization.retry')}
          </button>
        </div>
      ) : null}

      {loading && !snapshot ? (
        <p aria-live="polite">
          {t('runtime.customization.loading')}
        </p>
      ) : null}

      {snapshot ? (
        <NativeInventoryStatus snapshot={snapshot} />
      ) : null}

      {provider === 'opencode' && settings && snapshot ? (
        <label
          aria-busy={saving}
          className="field runtime-customization-editor"
        >
          <span>{t('runtime.customization.opencode.defaultAgent')}</span>
          <select
            aria-label={t(
              'runtime.customization.opencode.defaultAgent'
            )}
            disabled={saving}
            onChange={(event) =>
              setSettings({
                ...settings,
                opencode: event.target.value
                  ? { defaultAgent: event.target.value }
                  : {}
              })
            }
            value={settings.opencode.defaultAgent ?? ''}
          >
            <option value="">
              {t('runtime.customization.opencode.runtimeDefault')}
            </option>
            {snapshot.agents
              .filter(
                (agent) =>
                  !agent.hidden &&
                  (agent.mode === 'primary' ||
                    agent.mode === 'all')
              )
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
          </select>
          <small>
            {t('runtime.customization.opencode.agentDescription')}
          </small>
        </label>
      ) : null}

      {provider === 'continue' && settings && snapshot ? (
        <fieldset
          aria-busy={saving}
          className="runtime-customization-editor"
          disabled={saving}
        >
          <legend className="sr-only">
            {t('runtime.customization.continue.editorTitle')}
          </legend>
          <div className="runtime-preset-toolbar">
            <label className="field">
              <span>
                {t('runtime.customization.continue.editPreset')}
              </span>
              <select
                onChange={(event) =>
                  setSelectedPresetId(event.target.value)
                }
                value={selectedPresetId}
              >
                <option value="">
                  {t('runtime.customization.continue.noPresets')}
                </option>
                {settings.continue.presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-button"
              disabled={
                settings.continue.presets.length >=
                runtimeCustomizationLimits.presets
              }
              onClick={addPreset}
              type="button"
            >
              <Plus aria-hidden="true" size={15} />
              {t('runtime.customization.continue.addPreset')}
            </button>
            <button
              aria-label={t(
                'runtime.customization.continue.removePreset'
              )}
              className="danger-ghost"
              disabled={!selectedPreset}
              onClick={removePreset}
              type="button"
            >
              <Trash2 aria-hidden="true" size={15} />
              {t('runtime.customization.continue.removePreset')}
            </button>
          </div>

          <label className="field">
            <span>
              {t('runtime.customization.continue.defaultPreset')}
            </span>
            <select
              onChange={(event) =>
                setSettings({
                  ...settings,
                  continue: {
                    ...settings.continue,
                    defaultPresetId:
                      event.target.value || undefined
                  }
                })
              }
              value={settings.continue.defaultPresetId ?? ''}
            >
              <option value="">
                {t('runtime.customization.continue.noDefaultPreset')}
              </option>
              {settings.continue.presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>

          {selectedPreset ? (
            <div className="runtime-preset-editor">
              <label className="field">
                <span>
                  {t('runtime.customization.continue.presetName')}
                </span>
                <input
                  maxLength={runtimeCustomizationLimits.nameCharacters}
                  onChange={(event) =>
                    updateSelectedPreset((current) => ({
                      ...current,
                      name: event.target.value
                    }))
                  }
                  value={selectedPreset.name}
                />
              </label>
              <label className="field">
                <span>
                  {t(
                    'runtime.customization.continue.presetDescription'
                  )}
                </span>
                <input
                  maxLength={
                    runtimeCustomizationLimits.descriptionCharacters
                  }
                  onChange={(event) =>
                    updateSelectedPreset((current) => ({
                      ...current,
                      description: event.target.value || undefined
                    }))
                  }
                  value={selectedPreset.description ?? ''}
                />
              </label>

              <div className="runtime-preset-editor__section">
                <div>
                  <strong>
                    {t('runtime.customization.continue.rules')}
                  </strong>
                  <button
                    className="secondary-button"
                    disabled={
                      selectedPreset.rules.length >=
                      runtimeCustomizationLimits.rulesPerPreset
                    }
                    onClick={() =>
                      updateSelectedPreset((current) => ({
                        ...current,
                        rules: [
                          ...current.rules,
                          {
                            id: crypto.randomUUID(),
                            name: t(
                              'runtime.customization.continue.newRule'
                            ),
                            content: t(
                              'runtime.customization.continue.newRuleContent'
                            ),
                            enabled: true
                          }
                        ]
                      }))
                    }
                    type="button"
                  >
                    <Plus aria-hidden="true" size={14} />
                    {t('runtime.customization.continue.addRule')}
                  </button>
                </div>
                {selectedPreset.rules.map((rule) => (
                  <div
                    className="runtime-customization-item"
                    key={rule.id}
                  >
                    <div className="runtime-customization-item__header">
                      <input
                        aria-label={t(
                          'runtime.customization.continue.ruleName'
                        )}
                        maxLength={
                          runtimeCustomizationLimits.nameCharacters
                        }
                        onChange={(event) =>
                          updateSelectedPreset((current) => ({
                            ...current,
                            rules: current.rules.map((candidate) =>
                              candidate.id === rule.id
                                ? {
                                    ...candidate,
                                    name: event.target.value
                                  }
                                : candidate
                            )
                          }))
                        }
                        value={rule.name}
                      />
                      <label className="toggle-row toggle-row--compact">
                        <input
                          checked={rule.enabled}
                          onChange={(event) =>
                            updateSelectedPreset((current) => ({
                              ...current,
                              rules: current.rules.map((candidate) =>
                                candidate.id === rule.id
                                  ? {
                                      ...candidate,
                                      enabled: event.target.checked
                                    }
                                  : candidate
                              )
                            }))
                          }
                          role="switch"
                          type="checkbox"
                        />
                        <span>
                          {t('runtime.customization.enabled')}
                        </span>
                      </label>
                      <button
                        aria-label={t(
                          'runtime.customization.continue.removeRule',
                          { name: rule.name }
                        )}
                        className="danger-ghost icon-button"
                        onClick={() =>
                          updateSelectedPreset((current) => ({
                            ...current,
                            rules: current.rules.filter(
                              (candidate) => candidate.id !== rule.id
                            )
                          }))
                        }
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={14} />
                      </button>
                    </div>
                    <textarea
                      aria-label={t(
                        'runtime.customization.continue.ruleContent',
                        { name: rule.name }
                      )}
                      maxLength={
                        runtimeCustomizationLimits.contentCharacters
                      }
                      onChange={(event) =>
                        updateSelectedPreset((current) => ({
                          ...current,
                          rules: current.rules.map((candidate) =>
                            candidate.id === rule.id
                              ? {
                                  ...candidate,
                                  content: event.target.value
                                }
                              : candidate
                          )
                        }))
                      }
                      rows={4}
                      value={rule.content}
                    />
                  </div>
                ))}
              </div>

              <div className="runtime-preset-editor__section">
                <div>
                  <strong>
                    {t('runtime.customization.continue.prompts')}
                  </strong>
                  <button
                    className="secondary-button"
                    disabled={
                      selectedPreset.prompts.length >=
                      runtimeCustomizationLimits.promptsPerPreset
                    }
                    onClick={() =>
                      updateSelectedPreset((current) => ({
                        ...current,
                        prompts: [
                          ...current.prompts,
                          {
                            id: crypto.randomUUID(),
                            name: t(
                              'runtime.customization.continue.newPrompt'
                            ),
                            prompt: t(
                              'runtime.customization.continue.newPromptContent'
                            )
                          }
                        ]
                      }))
                    }
                    type="button"
                  >
                    <Plus aria-hidden="true" size={14} />
                    {t('runtime.customization.continue.addPrompt')}
                  </button>
                </div>
                {selectedPreset.prompts.map((prompt) => (
                  <div
                    className="runtime-customization-item"
                    key={prompt.id}
                  >
                    <div className="runtime-customization-item__header">
                      <input
                        aria-label={t(
                          'runtime.customization.continue.promptName'
                        )}
                        maxLength={
                          runtimeCustomizationLimits.nameCharacters
                        }
                        onChange={(event) =>
                          updateSelectedPreset((current) => ({
                            ...current,
                            prompts: current.prompts.map((candidate) =>
                              candidate.id === prompt.id
                                ? {
                                    ...candidate,
                                    name: event.target.value
                                  }
                                : candidate
                            )
                          }))
                        }
                        value={prompt.name}
                      />
                      <button
                        aria-label={t(
                          'runtime.customization.continue.removePrompt',
                          { name: prompt.name }
                        )}
                        className="danger-ghost icon-button"
                        onClick={() =>
                          updateSelectedPreset((current) => ({
                            ...current,
                            prompts: current.prompts.filter(
                              (candidate) =>
                                candidate.id !== prompt.id
                            )
                          }))
                        }
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={14} />
                      </button>
                    </div>
                    <input
                      aria-label={t(
                        'runtime.customization.continue.promptDescription',
                        { name: prompt.name }
                      )}
                      maxLength={
                        runtimeCustomizationLimits.descriptionCharacters
                      }
                      onChange={(event) =>
                        updateSelectedPreset((current) => ({
                          ...current,
                          prompts: current.prompts.map((candidate) =>
                            candidate.id === prompt.id
                              ? {
                                  ...candidate,
                                  description:
                                    event.target.value || undefined
                                }
                              : candidate
                          )
                        }))
                      }
                      placeholder={t(
                        'runtime.customization.continue.promptDescriptionPlaceholder'
                      )}
                      value={prompt.description ?? ''}
                    />
                    <textarea
                      aria-label={t(
                        'runtime.customization.continue.promptContent',
                        { name: prompt.name }
                      )}
                      maxLength={
                        runtimeCustomizationLimits.contentCharacters
                      }
                      onChange={(event) =>
                        updateSelectedPreset((current) => ({
                          ...current,
                          prompts: current.prompts.map((candidate) =>
                            candidate.id === prompt.id
                              ? {
                                  ...candidate,
                                  prompt: event.target.value
                                }
                              : candidate
                          )
                        }))
                      }
                      rows={4}
                      value={prompt.prompt}
                    />
                  </div>
                ))}
              </div>

              <details
                className="runtime-merged-rules"
                onToggle={(event) =>
                  setMergedRulesOpen(event.currentTarget.open)
                }
              >
                <summary>
                  {t(
                    'runtime.customization.continue.mergedRules',
                    {
                      count:
                        (snapshot?.rules.length ?? 0) +
                        selectedPreset.rules.filter(
                          (rule) => rule.enabled
                        ).length
                    }
                  )}
                </summary>
                {mergedRulesOpen ? (
                  <ol>
                    {snapshot?.rules.map((rule) => (
                      <li key={`native:${rule.id}`}>
                        <strong>{rule.name}</strong>
                        <pre>{rule.content}</pre>
                      </li>
                    ))}
                    {selectedPreset.rules
                      .filter((rule) => rule.enabled)
                      .map((rule) => (
                        <li key={`preset:${rule.id}`}>
                          <strong>{rule.name}</strong>
                          <pre>{rule.content}</pre>
                        </li>
                      ))}
                  </ol>
                ) : null}
              </details>
            </div>
          ) : (
            <EmptyState
              description={t(
                'runtime.customization.continue.emptyPreset'
              )}
              icon={<Boxes size={22} />}
              level="table"
              title={t(
                'runtime.customization.continue.emptyPresetTitle'
              )}
            />
          )}
        </fieldset>
      ) : null}

      {settingsDirty && provider !== 'deepseek-harness' ? (
        <div
          className="runtime-customization-section__dirty"
          role="status"
        >
          <span>{t('runtime.customization.unsaved')}</span>
          <button
            className="secondary-button"
            disabled={saving}
            onClick={discardChanges}
            type="button"
          >
            <RotateCcw aria-hidden="true" size={14} />
            {t('runtime.customization.discard')}
          </button>
        </div>
      ) : null}

      {snapshot ? <NativeInventory snapshot={snapshot} /> : null}
    </section>
  )
})
