import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ApplicationSettings,
  MagicNoteCommentMode,
  ModelDownloadSource
} from '../../shared/application-settings-contracts'
import type { MagicNoteCommentFormat } from '../../shared/magic-notes-contracts'
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
  onNotify?: (notification: AppNotificationInput) => void
}

type PlatformFeaturesTab = 'general' | 'magic-notes'

export function PlatformFeaturesSettingsSection({
  onMagicNotesEnabledChange,
  onNotify
}: PlatformFeaturesSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [activeSection, setActiveSection] =
    useState<PlatformFeaturesTab>('general')
  const [settings, setSettings] = useState<ApplicationSettings>()
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
