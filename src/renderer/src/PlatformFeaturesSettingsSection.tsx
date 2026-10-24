import {
  FolderOpen,
  RotateCcw,
  Save
} from 'lucide-react'
import {
  useEffect,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { InlineHelp } from './InlineHelp'
import type {
  ApplicationSettings
} from '../../shared/application-settings-contracts'
import {
  canonicalizeShortcutAccelerator,
  type GlobalShortcutSettings,
  type GlobalShortcutSettingsSnapshot,
  type GlobalShortcutUpdateErrorCode
} from '../../shared/shortcut'
import type { AppNotificationInput } from './notifications'
import {
  SettingsCategoryHeader,
  SettingsWarningList
} from './SettingsPrimitives'
import { displayErrorMessage } from './error-message'

type PlatformFeaturesSettingsSectionProps = {
  onConversationHtmlRenderingEnabledChange: (
    enabled: boolean
  ) => void
  onWorkspacePathChange: (path: string) => void
  workspacePath: string
  workspaceDirty: boolean
  workspaceSaving: boolean
  workspaceError?: string
  onSaveWorkspace: () => void
  onNotify?: (notification: AppNotificationInput) => void
  onDirtyChange?: (dirty: boolean) => void
  onShortcutSettingsChanged?: (
    snapshot: GlobalShortcutSettingsSnapshot
  ) => void
}

const shortcutErrorTranslationKeys: Record<
  GlobalShortcutUpdateErrorCode,
  | 'platformFeatures.shortcut.errors.conflict'
  | 'platformFeatures.shortcut.errors.registrationFailed'
  | 'platformFeatures.shortcut.errors.saveFailed'
> = {
  conflict: 'platformFeatures.shortcut.errors.conflict',
  'registration-failed':
    'platformFeatures.shortcut.errors.registrationFailed',
  'save-failed': 'platformFeatures.shortcut.errors.saveFailed'
}

export function PlatformFeaturesSettingsSection({
  onConversationHtmlRenderingEnabledChange,
  onWorkspacePathChange,
  workspacePath,
  workspaceDirty,
  workspaceSaving,
  workspaceError,
  onSaveWorkspace,
  onNotify,
  onDirtyChange,
  onShortcutSettingsChanged
}: PlatformFeaturesSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const { t: settingsT } = useTranslation('settings')
  const [settings, setSettings] = useState<ApplicationSettings>()
  const [shortcutSnapshot, setShortcutSnapshot] =
    useState<GlobalShortcutSettingsSnapshot>()
  const [shortcutDraft, setShortcutDraft] =
    useState<GlobalShortcutSettings>()
  const [shortcutSaving, setShortcutSaving] = useState(false)
  const [shortcutError, setShortcutError] = useState<string | undefined>(
    () =>
      window.goodbuddy.shortcuts
        ? undefined
        : t('platformFeatures.shortcut.errors.serviceUnavailable')
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(() =>
    window.goodbuddy.updates
      ? undefined
      : t('platformFeatures.errors.serviceUnavailable')
  )

  useEffect(() => {
    const updates = window.goodbuddy.updates
    let active = true
    if (!updates) {
      return () => {
        active = false
      }
    }
    void updates
      .getSettings()
      .then((nextSettings) => {
        if (active) {
          setSettings(nextSettings)
        }
      })
      .catch(() => {
        if (active) {
          setError(t('platformFeatures.errors.readFailed'))
        }
      })
    return () => {
      active = false
    }
  }, [t])

  useEffect(() => {
    const shortcuts = window.goodbuddy.shortcuts
    let active = true
    if (!shortcuts) {
      return () => {
        active = false
      }
    }
    void shortcuts
      .getSettings()
      .then((snapshot) => {
        if (active) {
          setShortcutSnapshot(snapshot)
          setShortcutDraft(snapshot.settings)
        }
      })
      .catch(() => {
        if (active) {
          setShortcutError(
            t('platformFeatures.shortcut.errors.readFailed')
          )
        }
      })
    return () => {
      active = false
    }
  }, [t])

  const shortcutDirty =
    shortcutSnapshot !== undefined &&
    shortcutDraft !== undefined &&
    (shortcutSnapshot.settings.enabled !== shortcutDraft.enabled ||
      shortcutSnapshot.settings.accelerator !==
        shortcutDraft.accelerator)

  useEffect(() => {
    onDirtyChange?.(shortcutDirty)
  }, [onDirtyChange, shortcutDirty])

  const saveShortcut = async (): Promise<void> => {
    const shortcuts = window.goodbuddy.shortcuts
    if (!shortcuts || !shortcutDraft) {
      return
    }
    let input: GlobalShortcutSettings
    try {
      input = {
        ...shortcutDraft,
        accelerator: canonicalizeShortcutAccelerator(
          shortcutDraft.accelerator
        )
      }
    } catch {
      setShortcutError(
        t('platformFeatures.shortcut.errors.invalidAccelerator')
      )
      return
    }
    setShortcutSaving(true)
    setShortcutError(undefined)
    try {
      setShortcutDraft(input)
      const result = await shortcuts.updateSettings(input)
      setShortcutSnapshot(result.snapshot)
      if (!result.ok) {
        setShortcutError(t(shortcutErrorTranslationKeys[result.error]))
        return
      }
      setShortcutDraft(result.snapshot.settings)
      onShortcutSettingsChanged?.(result.snapshot)
      onNotify?.({
        tone: 'success',
        message: t('platformFeatures.shortcut.saved'),
        dedupeKey: 'global-shortcut-saved'
      })
    } catch {
      setShortcutError(
        t('platformFeatures.shortcut.errors.saveFailed')
      )
    } finally {
      setShortcutSaving(false)
    }
  }

  const recordShortcut = (
    event: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (
      ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key) ||
      event.key === 'Escape' ||
      event.key === 'Tab'
    ) {
      return
    }
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      return
    }
    event.preventDefault()
    const isMac = shortcutSnapshot?.platform === 'darwin'
    const parts = [
      event.ctrlKey
        ? isMac
          ? 'Control'
          : 'CommandOrControl'
        : undefined,
      event.metaKey
        ? isMac
          ? 'Command'
          : 'Super'
        : undefined,
      event.altKey ? 'Alt' : undefined,
      event.shiftKey ? 'Shift' : undefined,
      event.key === ' ' ? 'Space' : event.key
    ].filter((part): part is string => Boolean(part))
    try {
      const accelerator = canonicalizeShortcutAccelerator(
        parts.join('+')
      )
      setShortcutDraft((current) =>
        current ? { ...current, accelerator } : current
      )
      setShortcutError(undefined)
    } catch {
      setShortcutError(
        t('platformFeatures.shortcut.errors.invalidAccelerator')
      )
    }
  }

  const changeConversationHtmlRendering = async (
    enabled: boolean
  ): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (!updates || !settings) {
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const nextSettings = await updates.updateSettings({
        conversationHtmlRenderingEnabled: enabled
      })
      setSettings(nextSettings)
      onConversationHtmlRenderingEnabledChange(
        nextSettings.conversationHtmlRenderingEnabled
      )
    } catch {
      setError(
        t(
          'platformFeatures.errors.saveConversationHtmlRenderingFailed'
        )
      )
    } finally {
      setSaving(false)
    }
  }

  const changeDesktopNotifications = async (
    enabled: boolean
  ): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (!updates || !settings || saving) {
      return
    }
    setSaving(true)
    try {
      setSettings(await updates.updateSettings({
        desktopNotificationsEnabled: enabled
      }))
    } catch {
      onNotify?.({
        tone: 'error',
        message: t('platformFeatures.errors.saveDesktopNotificationsFailed'),
        dedupeKey: 'desktop-notifications-save'
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <SettingsCategoryHeader
        actions={(
          <button
            className="primary-button"
            disabled={!workspaceDirty || workspaceSaving}
            onClick={onSaveWorkspace}
            type="button"
          >
            <Save aria-hidden="true" size={13} />
            {settingsT(workspaceSaving ? 'actions.saving' : 'actions.saveSettings')}
          </button>
        )}
        category="platform-features"
        error={workspaceError ?? error}
        headingId="platform-features-heading"
      />
      <SettingsWarningList warnings={settings?.warnings} />

      <section
        aria-labelledby="platform-features-heading"
        className="settings-section"
        id="platform-features-panel-general"
      >
        <article className="capability-card">
          <div className="capability-card__header">
            <span className="inline-help-label">
              <strong>{t('platformFeatures.shortcut.title')}</strong>
              <InlineHelp label={t('platformFeatures.shortcut.title')}>
                {t('platformFeatures.shortcut.description')}
              </InlineHelp>
            </span>
          </div>
          {shortcutDraft && shortcutSnapshot ? (
            <>
              <label className="toggle-row">
                <input
                  checked={shortcutDraft.enabled}
                  disabled={shortcutSaving}
                  onChange={(event) =>
                    setShortcutDraft({
                      ...shortcutDraft,
                      enabled: event.target.checked
                    })
                  }
                  role="switch"
                  type="checkbox"
                />
                <span>{t('platformFeatures.shortcut.enabled')}</span>
              </label>
              <label className="field">
                <span>{t('platformFeatures.shortcut.accelerator')}</span>
                <input
                  aria-label={t(
                    'platformFeatures.shortcut.accelerator'
                  )}
                  aria-describedby="global-shortcut-recorder-help"
                  disabled={!shortcutDraft.enabled || shortcutSaving}
                  onChange={(event) =>
                    setShortcutDraft({
                      ...shortcutDraft,
                      accelerator: event.target.value
                    })
                  }
                  onKeyDown={recordShortcut}
                  value={shortcutDraft.accelerator}
                />
                <small id="global-shortcut-recorder-help">
                  {t('platformFeatures.shortcut.recorderHelp')}
                </small>
              </label>
              <div className="update-settings__actions">
                <button
                  className="secondary-button"
                  disabled={shortcutSaving}
                  onClick={() => {
                    setShortcutDraft({
                      ...shortcutSnapshot.defaultSettings
                    })
                    setShortcutError(undefined)
                  }}
                  type="button"
                >
                  <RotateCcw aria-hidden="true" size={13} />
                  {t('platformFeatures.shortcut.reset')}
                </button>
                <button
                  className="primary-button"
                  disabled={!shortcutDirty || shortcutSaving}
                  onClick={() => void saveShortcut()}
                  type="button"
                >
                  <Save aria-hidden="true" size={13} />
                  {shortcutSaving
                    ? t('platformFeatures.shortcut.saving')
                    : t('platformFeatures.shortcut.save')}
                </button>
              </div>
              <p
                className={
                  shortcutError
                    ? 'settings-warning'
                    : 'settings-notice'
                }
                role={shortcutError ? 'alert' : 'status'}
              >
                {shortcutError ??
                  t(
                    `platformFeatures.shortcut.status.${shortcutSnapshot.status}`,
                    {
                      shortcut:
                        shortcutSnapshot.displayAccelerator
                    }
                  )}
              </p>
            </>
          ) : (
            <p
              className={
                shortcutError
                  ? 'settings-warning'
                  : 'settings-notice'
              }
              role={shortcutError ? 'alert' : 'status'}
            >
              {shortcutError ??
                t('platformFeatures.shortcut.loading')}
            </p>
          )}
        </article>
        {settings && (
          <article
            aria-label={t('platformFeatures.groups.conversation')}
            className="capability-card"
          >
            <div className="capability-card__header">
              <strong>{t('platformFeatures.groups.conversation')}</strong>
            </div>
            <label className="toggle-row">
              <input
                aria-describedby="desktop-notifications-description"
                checked={settings.desktopNotificationsEnabled}
                disabled={saving}
                onChange={(event) =>
                  void changeDesktopNotifications(event.target.checked)
                }
                role="switch"
                type="checkbox"
              />
              <span>{t('platformFeatures.desktopNotifications.enabled')}</span>
            </label>
            <p id="desktop-notifications-description">
              {t('platformFeatures.desktopNotifications.description')}
            </p>
            <div className="inline-help-label">
              <label className="toggle-row">
                <input
                  checked={settings.conversationHtmlRenderingEnabled}
                  disabled={saving}
                  onChange={(event) =>
                    void changeConversationHtmlRendering(
                      event.target.checked
                    )
                  }
                  role="switch"
                  type="checkbox"
                />
                <span>
                  {t('platformFeatures.conversationHtml.enabled')}
                </span>
              </label>
              <InlineHelp label={t('platformFeatures.conversationHtml.title')}>
                {t('platformFeatures.conversationHtml.description')}
              </InlineHelp>
            </div>
          </article>
        )}
        <article
          aria-label={t('platformFeatures.groups.workspace')}
          className="capability-card"
        >
          <div className="capability-card__header">
            <span className="inline-help-label">
              <FolderOpen aria-hidden="true" size={16} />
              <strong>{t('platformFeatures.groups.workspace')}</strong>
              <InlineHelp label={settingsT('runtime.workspace.title')}>
                {settingsT('runtime.workspace.description')}
              </InlineHelp>
            </span>
          </div>
          <label className="field">
            <span>{settingsT('runtime.workspace.directoryLabel')}</span>
            <div className="workspace-picker">
              <input
                aria-label={settingsT('runtime.workspace.directoryLabel')}
                onChange={(event) =>
                  onWorkspacePathChange(event.target.value)
                }
                value={workspacePath}
              />
              <button
                className="secondary-button"
                onClick={() => {
                  void window.goodbuddy.settings
                    .selectWorkspace()
                    .then((selected) => {
                      if (selected) {
                        onWorkspacePathChange(selected)
                      }
                    })
                    .catch((reason: unknown) => {
                      setError(
                        displayErrorMessage(
                          reason,
                          settingsT('errors.selectWorkspace')
                        )
                      )
                    })
                }}
                type="button"
              >
                {settingsT('actions.select')}
              </button>
            </div>
          </label>
        </article>
      </section>
    </>
  )
}
