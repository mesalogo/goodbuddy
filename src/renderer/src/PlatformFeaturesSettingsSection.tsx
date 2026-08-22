import { RotateCcw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ApplicationSettings,
  MagicNoteCommentMode,
  ModelDownloadSource
} from '../../shared/application-settings-contracts'
import type { MagicNoteCommentFormat } from '../../shared/magic-notes-contracts'
import {
  canonicalizeShortcutAccelerator,
  type GlobalShortcutSettings,
  type GlobalShortcutSettingsSnapshot,
  type GlobalShortcutUpdateErrorCode
} from '../../shared/shortcut'
import type { AppNotificationInput } from './notifications'
import {
  PageTabs,
  SegmentedControl
} from './WorkspacePrimitives'
import {
  SettingsCategoryHeader,
  SettingsWarningList
} from './SettingsPrimitives'

type PlatformFeaturesSettingsSectionProps = {
  onMagicNotesEnabledChange: (enabled: boolean) => void
  onMagicNotesShowIncompleteTodoCountChange: (
    enabled: boolean
  ) => void
  onNotify?: (notification: AppNotificationInput) => void
  onDirtyChange?: (dirty: boolean) => void
  onShortcutSettingsChanged?: (
    snapshot: GlobalShortcutSettingsSnapshot
  ) => void
}

type PlatformFeaturesTab = 'general' | 'magic-notes'

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
  onMagicNotesEnabledChange,
  onMagicNotesShowIncompleteTodoCountChange,
  onNotify,
  onDirtyChange,
  onShortcutSettingsChanged
}: PlatformFeaturesSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [activeSection, setActiveSection] =
    useState<PlatformFeaturesTab>('general')
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
  const [sourceError, setSourceError] = useState<string>()
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

  const changeModelDownloadSource = async (
    modelDownloadSource: ModelDownloadSource
  ): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (
      !updates ||
      !settings ||
      settings.modelDownloadSource === modelDownloadSource
    ) {
      return
    }
    setSaving(true)
    setSourceError(undefined)
    try {
      const nextSettings = await updates.updateSettings({
        modelDownloadSource
      })
      setSettings(nextSettings)
      onNotify?.({
        tone: 'success',
        message: t(
          'platformFeatures.modelDownloadSource.notification',
          {
            source: t(
              `modelDownloadSources.${nextSettings.modelDownloadSource}`
            )
          }
        ),
        dedupeKey: 'model-download-source'
      })
    } catch {
      setSourceError(
        t('platformFeatures.errors.saveModelDownloadSourceFailed')
      )
    } finally {
      setSaving(false)
    }
  }

  const changeMagicNotes = async (enabled: boolean): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (!updates || !settings) {
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const nextSettings = await updates.updateSettings({
        magicNotesEnabled: enabled
      })
      setSettings(nextSettings)
      onMagicNotesEnabledChange(nextSettings.magicNotesEnabled)
    } catch {
      setError(t('platformFeatures.errors.saveMagicNotesFailed'))
    } finally {
      setSaving(false)
    }
  }

  const changeCommentMode = async (
    magicNoteCommentMode: MagicNoteCommentMode
  ): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (!updates || !settings) {
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      setSettings(
        await updates.updateSettings({ magicNoteCommentMode })
      )
    } catch {
      setError(t('platformFeatures.errors.saveCommentModeFailed'))
    } finally {
      setSaving(false)
    }
  }

  const changeIncompleteTodoCount = async (
    magicNotesShowIncompleteTodoCount: boolean
  ): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (!updates || !settings) {
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const nextSettings = await updates.updateSettings({
        magicNotesShowIncompleteTodoCount
      })
      setSettings(nextSettings)
      onMagicNotesShowIncompleteTodoCountChange(
        nextSettings.magicNotesShowIncompleteTodoCount
      )
    } catch {
      setError(
        t('platformFeatures.errors.saveIncompleteTodoCountFailed')
      )
    } finally {
      setSaving(false)
    }
  }

  const changeCommentFormat = async (
    magicNoteCommentFormat: MagicNoteCommentFormat
  ): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (!updates || !settings) {
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      setSettings(
        await updates.updateSettings({ magicNoteCommentFormat })
      )
    } catch {
      setError(t('platformFeatures.errors.saveCommentFormatFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <SettingsCategoryHeader
        category="platform-features"
        error={error}
        headingId="platform-features-heading"
      />
      <SettingsWarningList warnings={settings?.warnings} />
      <div className="platform-features-tabs">
        <PageTabs
          ariaLabel={t('platformFeatures.tabs.ariaLabel')}
          idPrefix="platform-features"
          onChange={setActiveSection}
          tabs={[
            {
              id: 'general',
              label: t('platformFeatures.tabs.general')
            },
            {
              id: 'magic-notes',
              label: t('platformFeatures.tabs.magicNotes')
            }
          ]}
          value={activeSection}
          variant="segmented"
        />
      </div>

      <section
        aria-labelledby="platform-features-tab-general"
        className="settings-section"
        hidden={activeSection !== 'general'}
        id="platform-features-panel-general"
        role="tabpanel"
      >
        <article className="capability-card">
          <div className="capability-card__header">
            <div>
              <strong>{t('platformFeatures.shortcut.title')}</strong>
              <small>
                {t('platformFeatures.shortcut.description')}
              </small>
            </div>
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
        {settings ? (
        <article className="capability-card">
          <div className="capability-card__header">
            <div>
              <strong>
                {t('platformFeatures.modelDownloadSource.cardTitle')}
              </strong>
              <small>
                {t(
                  'platformFeatures.modelDownloadSource.cardDescription'
                )}
              </small>
            </div>
          </div>
          <fieldset className="model-download-source">
            <legend>
              {t('platformFeatures.modelDownloadSource.title')}
            </legend>
            <p>
              {t('platformFeatures.modelDownloadSource.description')}
            </p>
            {(
              ['modelscope', 'hugging-face'] as const
            ).map((source) => (
              <label
                className={
                  source === settings.modelDownloadSource
                    ? 'model-download-source__option model-download-source__option--selected'
                    : 'model-download-source__option'
                }
                key={source}
              >
                <input
                  checked={source === settings.modelDownloadSource}
                  disabled={saving}
                  name="model-download-source"
                  onChange={() =>
                    void changeModelDownloadSource(source)
                  }
                  type="radio"
                  value={source}
                />
                <span>
                  <strong>{t(`modelDownloadSources.${source}`)}</strong>
                  <small>
                    {t(
                      `platformFeatures.modelDownloadSource.options.${source}`
                    )}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          {sourceError && (
            <p className="settings-warning" role="alert">
              {sourceError}
            </p>
          )}
          <p className="model-download-source__current">
            {t('platformFeatures.modelDownloadSource.current', {
              source: t(
                `modelDownloadSources.${settings.modelDownloadSource}`
              )
            })}
          </p>
          <p className="settings-notice">
            {t('platformFeatures.modelDownloadSource.activeDownloadNote')}
          </p>
        </article>
        ) : (
          !error && (
            <p className="settings-notice" role="status">
              {t('platformFeatures.loading')}
            </p>
          )
        )}
      </section>

      <section
        aria-labelledby="platform-features-tab-magic-notes"
        className="settings-section"
        hidden={activeSection !== 'magic-notes'}
        id="platform-features-panel-magic-notes"
        role="tabpanel"
      >
        {settings ? (
        <article className="capability-card">
          <div className="capability-card__header">
            <div>
              <strong>{t('platformFeatures.magicNotes.title')}</strong>
              <small>
                {t('platformFeatures.magicNotes.description')}
              </small>
            </div>
          </div>
          <label className="toggle-row">
            <input
              checked={settings.magicNotesEnabled}
              disabled={saving}
              onChange={(event) =>
                void changeMagicNotes(event.target.checked)
              }
              role="switch"
              type="checkbox"
            />
            <span>{t('platformFeatures.magicNotes.showEntry')}</span>
          </label>
          <label className="toggle-row">
            <input
              checked={
                settings.magicNotesShowIncompleteTodoCount
              }
              disabled={saving}
              onChange={(event) =>
                void changeIncompleteTodoCount(
                  event.target.checked
                )
              }
              role="switch"
              type="checkbox"
            />
            <span>
              {t(
                'platformFeatures.magicNotes.showIncompleteTodoCount'
              )}
            </span>
          </label>
          <p className="settings-notice">
            {t(
              'platformFeatures.magicNotes.showIncompleteTodoCountHelp'
            )}
          </p>
          <div className="platform-feature-option">
            <span>
              {t('platformFeatures.magicNotes.commentMode')}
            </span>
            <SegmentedControl
              ariaLabel={t(
                'platformFeatures.magicNotes.commentModeAria'
              )}
              disabled={saving}
              onChange={(value) => void changeCommentMode(value)}
              options={[
                {
                  value: 'immediate',
                  label: t(
                    'platformFeatures.magicNotes.modes.immediate'
                  )
                },
                {
                  value: 'after-save-auto',
                  label: t(
                    'platformFeatures.magicNotes.modes.afterSaveAuto'
                  )
                },
                {
                  value: 'after-save-manual',
                  label: t(
                    'platformFeatures.magicNotes.modes.afterSaveManual'
                  )
                }
              ]}
              value={settings.magicNoteCommentMode}
            />
            <small>
              {t('platformFeatures.magicNotes.commentModeHelp')}
            </small>
          </div>
          <div className="platform-feature-option">
            <span>
              {t('platformFeatures.magicNotes.commentFormat')}
            </span>
            <SegmentedControl
              ariaLabel={t(
                'platformFeatures.magicNotes.commentFormatAria'
              )}
              disabled={saving}
              onChange={(value) => void changeCommentFormat(value)}
              options={[
                {
                  value: 'combined',
                  label: t(
                    'platformFeatures.magicNotes.formats.combined'
                  )
                },
                {
                  value: 'narrative',
                  label: t(
                    'platformFeatures.magicNotes.formats.narrative'
                  )
                },
                {
                  value: 'structured',
                  label: t(
                    'platformFeatures.magicNotes.formats.structured'
                  )
                }
              ]}
              value={settings.magicNoteCommentFormat}
            />
            <small>
              {t('platformFeatures.magicNotes.commentFormatHelp')}
            </small>
          </div>
        </article>
        ) : (
          !error && (
            <p className="settings-notice" role="status">
              {t('platformFeatures.loading')}
            </p>
          )
        )}
      </section>
    </>
  )
}
