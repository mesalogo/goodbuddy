import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ApplicationSettings, ApplicationSettingsUpdate } from '../../shared/application-settings-contracts'
import { defaultExperienceMinEvents, defaultStalledDays, defaultStoryThreadEvents, defaultSupervisionReviewSettings, supervisionReviewSettingsSchema } from '../../shared/supervision-review-contracts'

const fields = [
  ['pageSize', 1, 200], ['batchCharacters', 1000, 16000], ['batchMessages', 1, 50], ['responseKiB', 100, 16384], ['storyThreadEvents', 4, 500], ['experienceMinEvents', 2, 200], ['stalledDays', 1, 365]
] as const

export function SupervisionReviewSettings({ settings, disabled, onSave }: {
  settings?: ApplicationSettings
  disabled?: boolean
  onSave?: (value: ApplicationSettingsUpdate) => void | Promise<unknown>
}) {
  const { t } = useTranslation('heartbeat')
  const current = { ...defaultSupervisionReviewSettings, ...settings?.supervisionReview,
    responseKiB: settings?.supervisionReview?.responseKiB ?? 1024, crossProject: settings?.supervisionReview?.crossProject ?? false,
    storyThreadEvents: settings?.supervisionReview?.storyThreadEvents ?? defaultStoryThreadEvents,
    experienceMinEvents: settings?.supervisionReview?.experienceMinEvents ?? defaultExperienceMinEvents,
    stalledDays: settings?.supervisionReview?.stalledDays ?? defaultStalledDays }
  const [saved, setSaved] = useState(current)
  const [draft, setDraft] = useState(current)
  if (fields.some(([key]) => saved[key] !== current[key]) || saved.crossProject !== current.crossProject) { setSaved(current); setDraft(current) }
  const unchanged = fields.every(([key]) => draft[key] === current[key]) && draft.crossProject === current.crossProject
  const valid = supervisionReviewSettingsSchema.safeParse(draft).success
  const locked = disabled || !settings || !onSave
  return <form className="heartbeat-settings heartbeat-settings__editor" onSubmit={event => {
    event.preventDefault()
    if (valid && !locked) void onSave?.({ supervisionReview: draft })
  }}>
    <h2>{t('reviewSettings.title')}</h2>
    <p>{t('reviewSettings.help')}</p>
    {fields.map(([key, min, max]) => <label key={key} className="heartbeat-settings__field">
      {t(`reviewSettings.${key}`)} ({min}..{max})
      <input type="number" min={min} max={max} step={1} value={draft[key]} disabled={locked}
        onChange={event => setDraft({ ...draft, [key]: Number(event.target.value) })} />
    </label>)}
    <label className="toggle-row">
      <span>{t('reviewSettings.crossProject')}</span>
      <input type="checkbox" role="switch" checked={draft.crossProject} disabled={locked}
        onChange={event => setDraft({ ...draft, crossProject: event.target.checked })} />
    </label>
    <p>{t('reviewSettings.crossProjectHelp')}</p>
    <p>{t('reviewSettings.pauseHelp')}</p>
    {!valid && <p role="alert">{t('reviewSettings.invalid')}</p>}
    <button type="submit" className="primary-button" disabled={locked || !valid || unchanged}>{t('reviewSettings.save')}</button>
  </form>
}
