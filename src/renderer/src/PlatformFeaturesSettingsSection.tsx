import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ApplicationSettings,
  MagicNoteCommentMode
} from '../../shared/application-settings-contracts'
import type { MagicNoteCommentFormat } from '../../shared/magic-notes-contracts'
import { SegmentedControl } from './WorkspacePrimitives'
import {
  SettingsCategoryHeader,
  SettingsWarningList
} from './SettingsPrimitives'

type PlatformFeaturesSettingsSectionProps = {
  onMagicNotesEnabledChange: (enabled: boolean) => void
}

export function PlatformFeaturesSettingsSection({
  onMagicNotesEnabledChange
}: PlatformFeaturesSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [settings, setSettings] = useState<ApplicationSettings>()
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
      <section
        aria-label={t('platformFeatures.label')}
        className="settings-section"
      >
      <article className="capability-card">
        <div className="capability-card__header">
          <div>
            <strong>{t('platformFeatures.magicNotes.title')}</strong>
            <small>{t('platformFeatures.magicNotes.description')}</small>
          </div>
        </div>
        <label className="toggle-row">
          <input
            checked={settings?.magicNotesEnabled ?? false}
            disabled={!settings || saving}
            onChange={(event) =>
              void changeMagicNotes(event.target.checked)
            }
            role="switch"
            type="checkbox"
          />
          <span>{t('platformFeatures.magicNotes.showEntry')}</span>
        </label>
        <div className="platform-feature-option">
          <span>{t('platformFeatures.magicNotes.commentMode')}</span>
          <SegmentedControl
            ariaLabel={t('platformFeatures.magicNotes.commentModeAria')}
            disabled={!settings || saving}
            onChange={(value) => void changeCommentMode(value)}
            options={[
              {
                value: 'immediate',
                label: t('platformFeatures.magicNotes.modes.immediate')
              },
              {
                value: 'after-save-auto',
                label: t('platformFeatures.magicNotes.modes.afterSaveAuto')
              },
              {
                value: 'after-save-manual',
                label: t(
                  'platformFeatures.magicNotes.modes.afterSaveManual'
                )
              }
            ]}
            value={settings?.magicNoteCommentMode ?? 'immediate'}
          />
          <small>
            {t('platformFeatures.magicNotes.commentModeHelp')}
          </small>
        </div>
        <div className="platform-feature-option">
          <span>{t('platformFeatures.magicNotes.commentFormat')}</span>
          <SegmentedControl
            ariaLabel={t('platformFeatures.magicNotes.commentFormatAria')}
            disabled={!settings || saving}
            onChange={(value) => void changeCommentFormat(value)}
            options={[
              {
                value: 'combined',
                label: t('platformFeatures.magicNotes.formats.combined')
              },
              {
                value: 'narrative',
                label: t('platformFeatures.magicNotes.formats.narrative')
              },
              {
                value: 'structured',
                label: t('platformFeatures.magicNotes.formats.structured')
              }
            ]}
            value={settings?.magicNoteCommentFormat ?? 'combined'}
          />
          <small>
            {t('platformFeatures.magicNotes.commentFormatHelp')}
          </small>
        </div>
      </article>
      </section>
    </>
  )
}
