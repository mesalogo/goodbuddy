import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ApplicationSettings, ApplicationSettingsUpdate } from '../../shared/application-settings-contracts'
import { defaultSupervisionReviewSettings, supervisionReviewSettingsSchema } from '../../shared/supervision-review-contracts'

const fields = [
  ['pageSize', 1, 200], ['batchCharacters', 1000, 16000], ['batchMessages', 1, 50], ['executionSeconds', 30, 3600], ['responseKiB', 100, 16384]
] as const

export function SupervisionReviewSettings({ settings, disabled, onSave }: {
  settings?: ApplicationSettings
  disabled?: boolean
  onSave?: (value: ApplicationSettingsUpdate) => void | Promise<unknown>
}) {
  const { t } = useTranslation('heartbeat')
  const current = { ...defaultSupervisionReviewSettings, ...settings?.supervisionReview,
    responseKiB: settings?.supervisionReview?.responseKiB ?? 1024 }
  const [saved, setSaved] = useState(current)
  const [draft, setDraft] = useState(current)
  if (fields.some(([key]) => saved[key] !== current[key])) { setSaved(current); setDraft(current) }
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
    <p>{t('reviewSettings.pauseHelp')}</p>
    {!valid && <p role="alert">{t('reviewSettings.invalid')}</p>}
    <button type="submit" className="primary-button" disabled={locked || !valid || fields.every(([key]) => draft[key] === current[key])}>{t('reviewSettings.save')}</button>
  </form>
}
