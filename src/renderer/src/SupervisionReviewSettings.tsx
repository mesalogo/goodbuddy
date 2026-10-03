import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ApplicationSettings, ApplicationSettingsUpdate } from '../../shared/application-settings-contracts'
import { defaultExperienceMinEvents, defaultStalledDays, defaultStoryThreadEvents, defaultSupervisionReviewSettings, supervisionReviewSettingsSchema } from '../../shared/supervision-review-contracts'
import { useWorkspaceUnsavedChanges } from './workspace-unsaved-changes'

export type SupervisionSettingsSection = 'review' | 'stories' | 'suggestions'

type NumericKey = 'pageSize' | 'batchCharacters' | 'batchMessages' | 'responseKiB' | 'storyThreadEvents' | 'experienceMinEvents' | 'stalledDays'

const sections: Record<SupervisionSettingsSection, { fields: readonly (readonly [NumericKey, number, number])[]; crossProject?: boolean }> = {
  review: { fields: [['pageSize', 1, 200], ['batchCharacters', 1000, 16000], ['batchMessages', 1, 50], ['responseKiB', 100, 16384]] },
  stories: { fields: [['storyThreadEvents', 4, 500], ['experienceMinEvents', 2, 200]], crossProject: true },
  suggestions: { fields: [['stalledDays', 1, 365]] }
}

const titles = { review: 'reviewSettings.title', stories: 'reviewSettings.storiesTitle', suggestions: 'reviewSettings.suggestionsTitle' } as const
const saves = { review: 'reviewSettings.save', stories: 'reviewSettings.saveStories', suggestions: 'reviewSettings.saveSuggestions' } as const

/**
 * One settings section of the supervisor's review configuration. Each section edits only its own
 * fields and saves them over the current stored values, so another section's unsaved draft is not
 * overwritten or reset when this one saves.
 */
export function SupervisionReviewSettings({ settings, disabled, onSave, section = 'review' }: {
  settings?: ApplicationSettings
  disabled?: boolean
  onSave?: (value: ApplicationSettingsUpdate) => void | Promise<unknown>
  section?: SupervisionSettingsSection
}) {
  const { t } = useTranslation('heartbeat')
  const { fields, crossProject } = sections[section]
  const current = { ...defaultSupervisionReviewSettings, ...settings?.supervisionReview,
    responseKiB: settings?.supervisionReview?.responseKiB ?? 1024, crossProject: settings?.supervisionReview?.crossProject ?? false,
    storyThreadEvents: settings?.supervisionReview?.storyThreadEvents ?? defaultStoryThreadEvents,
    experienceMinEvents: settings?.supervisionReview?.experienceMinEvents ?? defaultExperienceMinEvents,
    stalledDays: settings?.supervisionReview?.stalledDays ?? defaultStalledDays }
  const same = (left: typeof current, right: typeof current) =>
    fields.every(([key]) => left[key] === right[key]) && (!crossProject || left.crossProject === right.crossProject)
  const [saved, setSaved] = useState(current)
  const [draft, setDraft] = useState(current)
  if (!same(saved, current)) { setSaved(current); setDraft(current) }
  const unchanged = same(draft, current)
  useWorkspaceUnsavedChanges(!unchanged)
  const next = { ...current, ...Object.fromEntries(fields.map(([key]) => [key, draft[key]])), ...(crossProject ? { crossProject: draft.crossProject } : {}) }
  const valid = supervisionReviewSettingsSchema.safeParse(next).success
  const locked = disabled || !settings || !onSave
  return <form className="heartbeat-settings heartbeat-settings__editor" onSubmit={event => {
    event.preventDefault()
    if (valid && !locked) void onSave?.({ supervisionReview: next })
  }}>
    <h2>{t(titles[section])}</h2>
    {section === 'review' && <p>{t('reviewSettings.help')}</p>}
    {section === 'suggestions' && <p>{t('reviewSettings.suggestionsHelp')}</p>}
    {fields.map(([key, min, max]) => <label key={key} className="heartbeat-settings__field">
      {t(`reviewSettings.${key}`)} ({min}..{max})
      <input type="number" min={min} max={max} step={1} value={draft[key]} disabled={locked}
        onChange={event => setDraft({ ...draft, [key]: Number(event.target.value) })} />
    </label>)}
    {crossProject && <>
      <label className="toggle-row">
        <span>{t('reviewSettings.crossProject')}</span>
        <input type="checkbox" role="switch" checked={draft.crossProject} disabled={locked}
          onChange={event => setDraft({ ...draft, crossProject: event.target.checked })} />
      </label>
      <p>{t('reviewSettings.crossProjectHelp')}</p>
    </>}
    {section === 'review' && <p>{t('reviewSettings.pauseHelp')}</p>}
    {!valid && <p role="alert">{t('reviewSettings.invalid')}</p>}
    <button type="submit" className="primary-button" disabled={locked || !valid || unchanged}>{t(saves[section])}</button>
  </form>
}
