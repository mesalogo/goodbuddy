import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SupervisionRunRequest } from '../../shared/supervision-contracts'
import type { SupervisionExperience, SupervisionStory, SupervisionStoryAction, SupervisionStoryView } from '../../shared/supervision-story-contracts'

const empty: SupervisionStoryView = { stories: [], experiences: [], unassigned: 0, canUndo: false }

/** Loads the stories of a scope and applies user adjustments. Late responses for an older scope are ignored. */
export function useSupervisionStories(scope: SupervisionRunRequest['scope'] | undefined, active: boolean, revision: unknown) {
  const api = window.goodbuddy?.supervision
  const key = scope ? JSON.stringify(scope) : ''
  const [view, setView] = useState<{ key: string; data: SupervisionStoryView }>({ key: '', data: empty })
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const latest = useRef<{ key: string; revision: unknown } | undefined>(undefined)
  const loaded = useRef<{ key: string; revision: unknown } | undefined>(undefined)
  const generation = useRef(0)
  useLayoutEffect(() => {
    latest.current = { key, revision }
    return () => { latest.current = undefined }
  }, [key, revision])
  const load = useCallback(async () => {
    const owner = latest.current
    // A completed mutation may still hold the previous scope/refresh callback.
    if (!api?.stories || !key || !owner || owner.key !== key || owner.revision !== revision) return
    const request = ++generation.current
    try {
      const data = await api.stories({ scope: JSON.parse(key) as SupervisionRunRequest['scope'] })
      if (latest.current === owner && request === generation.current) {
        loaded.current = { key, revision }
        setView({ key, data }); setError(undefined)
      }
    } catch (reason) { if (latest.current === owner && request === generation.current) setError(reason instanceof Error ? reason.message : String(reason)) }
  }, [api, key, revision])
  useEffect(() => {
    if (!active || (loaded.current?.key === key && loaded.current.revision === revision)) return
    const task = window.setTimeout(() => void load(), 0)
    const invalidate = () => { generation.current++ }
    return () => { window.clearTimeout(task); invalidate() }
  }, [active, key, load, revision])
  const act = async (action: SupervisionStoryAction) => {
    if (!api?.storyAction || pending) return false
    setPending(true)
    setError(undefined)
    try { await api.storyAction(action); await load(); return true }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false }
    finally { setPending(false) }
  }
  return { view: view.key === key ? view.data : empty, error, pending, act, reload: load, available: typeof api?.stories === 'function' }
}

type Props = {
  stories: SupervisionStory[]
  selectedId?: string
  onSelect: (id: string) => void
  date: (value: string) => string
}

/** Stories grouped as project › feature › sub-thread, then cross-project stories. */
export function SupervisionStoryList({ stories, selectedId, onSelect, date }: Props) {
  const { t } = useTranslation('heartbeat')
  const features = stories.filter(story => story.level === 'feature')
  const threads = (id: string) => stories.filter(story => story.parentId === id)
  const projects = [...new Map(features.map(story => [story.projectId ?? '', story.projectName ?? t('settings.scope.unavailableProject')])).entries()]
  const cross = stories.filter(story => story.level === 'cross')
  const item = (story: SupervisionStory, nested = false) => (
    <button key={story.id} className={nested ? 'supervisor-workspace__story-thread' : undefined}
      aria-pressed={selectedId === story.id} onClick={() => onSelect(story.id)}>
      <span className="supervisor-workspace__list-copy">
        {story.name}
        <small>
          {t('supervisor.stories.count', { count: story.events.filter(event => story.level === 'cross' || event.primary).length })}
          {story.startedAt && ` · ${date(story.startedAt)}`}
          {story.state === 'concluded' && ` · ${t('supervisor.stories.concluded')}`}
        </small>
      </span>
    </button>
  )
  return <>
    {projects.map(([projectId, name]) => <section key={projectId} className="supervisor-workspace__story-group" aria-label={name}>
      <h3>{name}</h3>
      {features.filter(story => (story.projectId ?? '') === projectId).map(story => <div key={story.id}>
        {item(story)}
        {threads(story.id).map(thread => item(thread, true))}
      </div>)}
    </section>)}
    {cross.length > 0 && <section className="supervisor-workspace__story-group" aria-label={t('supervisor.stories.cross')}>
      <h3>{t('supervisor.stories.cross')}</h3>
      {cross.map(story => item(story))}
    </section>}
  </>
}

/** Inspector for one story: span, state, events and the adjustments users can make. */
export function SupervisionStoryDetail({ story, stories, pending, canUndo, onAct, onSelectEvent, date }: {
  story: SupervisionStory
  stories: SupervisionStory[]
  pending: boolean
  canUndo: boolean
  onAct: (action: SupervisionStoryAction) => Promise<boolean>
  onSelectEvent: (id: string) => void
  date: (value: string) => string
}) {
  const { t } = useTranslation('heartbeat')
  const [name, setName] = useState<string>()
  const [mergeInto, setMergeInto] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const targets = stories.filter(other => other.id !== story.id && other.level === story.level && other.projectId === story.projectId)
  const shown = story.level === 'cross' ? story.events : story.events.filter(event => event.primary)
  return <>
    <div className="supervisor-workspace__detail-kicker">
      {t(`supervisor.stories.levels.${story.level}`)}{story.projectName && ` · ${story.projectName}`}
    </div>
    <h3>{story.name}</h3>
    {story.description && <p className="supervisor-workspace__detail-copy">{story.description}</p>}
    {story.startedAt && <p>{date(story.startedAt)} – {story.endedAt ? date(story.endedAt) : ''}</p>}
    <p>{story.state === 'concluded' ? t('supervisor.stories.concluded') : t('supervisor.stories.active')}
      {story.userEdited && ` · ${t('supervisor.stories.edited')}`}</p>
    <div className="supervisor-workspace__actions">
      <button className="secondary-button" disabled={pending} onClick={() => setName(story.name)}>{t('supervisor.stories.rename')}</button>
      <button className="danger-ghost" disabled={pending} onClick={() => setConfirmRemove(true)}>{t('supervisor.stories.remove')}</button>
      {canUndo && <button className="secondary-button" disabled={pending} onClick={() => void onAct({ action: 'undo' })}>{t('supervisor.stories.undo')}</button>}
    </div>
    {name !== undefined && <form onSubmit={event => {
      event.preventDefault()
      void onAct({ action: 'rename', storyId: story.id, name: name.trim() }).then(done => { if (done) setName(undefined) })
    }}>
      <label>{t('supervisor.stories.name')}<input value={name} maxLength={60} onChange={event => setName(event.target.value)} /></label>
      <div className="supervisor-workspace__actions">
        <button className="secondary-button" disabled={pending || !name.trim()}>{t('supervisor.save')}</button>
        <button type="button" className="secondary-button" disabled={pending} onClick={() => setName(undefined)}>{t('supervisor.cancel')}</button>
      </div>
    </form>}
    {targets.length > 0 && <div className="supervisor-workspace__story-merge">
      <label>{t('supervisor.stories.mergeInto')}
        <select value={mergeInto} disabled={pending} onChange={event => setMergeInto(event.target.value)}>
          <option value="">{t('supervisor.stories.chooseStory')}</option>
          {targets.map(other => <option key={other.id} value={other.id}>{other.name}</option>)}
        </select>
      </label>
      <button className="secondary-button" disabled={pending || !mergeInto}
        onClick={() => void onAct({ action: 'merge', storyId: story.id, intoId: mergeInto }).then(done => { if (done) setMergeInto('') })}>
        {t('supervisor.stories.merge')}
      </button>
    </div>}
    {confirmRemove && <div role="alert">
      <p>{t('supervisor.stories.removeHint')}</p>
      <div className="supervisor-workspace__actions">
        <button className="secondary-button" disabled={pending} onClick={() => setConfirmRemove(false)}>{t('supervisor.cancel')}</button>
        <button className="danger-solid" disabled={pending} onClick={() => void onAct({ action: 'remove', storyId: story.id })}>{t('supervisor.stories.remove')}</button>
      </div>
    </div>}
    <div className="supervisor-workspace__related">
      <h4>{t('supervisor.stories.events', { count: shown.length })}</h4>
      {shown.map(event => <button key={event.id} className="link-button" onClick={() => onSelectEvent(event.id)}>
        {event.title}<small>{date(event.startedAt)}</small>
      </button>)}
    </div>
  </>
}

/** Primary-story picker for one event; only stories of the event's project are offered. */
export function SupervisionEventStory({ eventId, projectId, stories, pending, onAct }: {
  eventId: string
  projectId: string | null
  stories: SupervisionStory[]
  pending: boolean
  onAct: (action: SupervisionStoryAction) => Promise<boolean>
}) {
  const { t } = useTranslation('heartbeat')
  const current = stories.find(story => story.events.some(event => event.id === eventId && event.primary))
  const options = stories.filter(story => story.level !== 'cross' && story.projectId === (projectId ?? current?.projectId))
  if (!options.length && !current) return null
  return <label className="supervisor-workspace__event-story">
    {t('supervisor.stories.primary')}
    <select value={current?.id ?? ''} disabled={pending}
      onChange={event => void onAct({ action: 'move', eventId, storyId: event.target.value || null })}>
      <option value="">{t('supervisor.stories.none')}</option>
      {options.map(story => <option key={story.id} value={story.id}>{story.parentId ? `· ${story.name}` : story.name}</option>)}
    </select>
  </label>
}

const storiesOf = (experience: SupervisionExperience) => new Set(experience.events.map(event => event.storyId).filter(Boolean)).size

/** Experiences (W) as a list: statement, origin stories and application count. */
export function SupervisionExperienceList({ experiences, selectedId, onSelect }: {
  experiences: SupervisionExperience[]
  selectedId?: string
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation('heartbeat')
  return <>{experiences.map(experience => <button key={experience.id} aria-pressed={selectedId === experience.id} onClick={() => onSelect(experience.id)}>
    <span className="supervisor-workspace__list-copy">
      {experience.statement}
      <small>
        {t('supervisor.experiences.fromStories', { count: storiesOf(experience) })}
        {` · ${t('supervisor.experiences.applied', { count: experience.events.filter(event => event.role === 'applied').length })}`}
      </small>
    </span>
  </button>)}</>
}

/** Inspector for one experience: conditions, limits, evidence and later applications, with edit, merge, delete. */
export function SupervisionExperienceDetail({ experience, experiences, pending, canUndo, onAct, onSelectEvent, date }: {
  experience: SupervisionExperience
  experiences: SupervisionExperience[]
  pending: boolean
  canUndo: boolean
  onAct: (action: SupervisionStoryAction) => Promise<boolean>
  onSelectEvent: (id: string) => void
  date: (value: string) => string
}) {
  const { t } = useTranslation('heartbeat')
  const [draft, setDraft] = useState<{ statement: string; conditions: string; boundaries: string }>()
  const [mergeInto, setMergeInto] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const formed = experience.events.filter(event => event.role === 'formed')
  const applied = experience.events.filter(event => event.role === 'applied')
  const targets = experiences.filter(other => other.id !== experience.id)
  const eventButton = (event: SupervisionExperience['events'][number]) => <button key={`${event.role}-${event.id}`} className="link-button" onClick={() => onSelectEvent(event.id)}>
    {event.title}<small>{[event.storyName, date(event.at), event.note].filter(Boolean).join(' · ')}</small>
  </button>
  return <>
    <div className="supervisor-workspace__detail-kicker">
      {t('supervisor.experiences.kicker')} · {experience.userEdited ? t('supervisor.experiences.edited') : t('supervisor.experiences.automatic')}
    </div>
    <h3>{experience.statement}</h3>
    {experience.conditions && <p className="supervisor-workspace__detail-copy"><strong>{t('supervisor.experiences.conditions')}</strong> {experience.conditions}</p>}
    {experience.boundaries && <p className="supervisor-workspace__detail-copy"><strong>{t('supervisor.experiences.boundaries')}</strong> {experience.boundaries}</p>}
    <div className="supervisor-workspace__actions">
      <button className="secondary-button" disabled={pending}
        onClick={() => setDraft({ statement: experience.statement, conditions: experience.conditions, boundaries: experience.boundaries })}>{t('supervisor.experiences.edit')}</button>
      <button className="danger-ghost" disabled={pending} onClick={() => setConfirmRemove(true)}>{t('supervisor.experiences.remove')}</button>
      {canUndo && <button className="secondary-button" disabled={pending} onClick={() => void onAct({ action: 'undo' })}>{t('supervisor.stories.undo')}</button>}
    </div>
    {draft && <form onSubmit={event => {
      event.preventDefault()
      void onAct({ action: 'experience-edit', experienceId: experience.id, statement: draft.statement.trim(), conditions: draft.conditions.trim(), boundaries: draft.boundaries.trim() })
        .then(done => { if (done) setDraft(undefined) })
    }}>
      <label>{t('supervisor.experiences.statement')}<input value={draft.statement} maxLength={200} onChange={event => setDraft({ ...draft, statement: event.target.value })} /></label>
      <label>{t('supervisor.experiences.conditions')}<textarea value={draft.conditions} maxLength={400} rows={2} onChange={event => setDraft({ ...draft, conditions: event.target.value })} /></label>
      <label>{t('supervisor.experiences.boundaries')}<textarea value={draft.boundaries} maxLength={400} rows={2} onChange={event => setDraft({ ...draft, boundaries: event.target.value })} /></label>
      <div className="supervisor-workspace__actions">
        <button className="secondary-button" disabled={pending || !draft.statement.trim()}>{t('supervisor.experiences.save')}</button>
        <button type="button" className="secondary-button" disabled={pending} onClick={() => setDraft(undefined)}>{t('supervisor.cancel')}</button>
      </div>
    </form>}
    {targets.length > 0 && <div className="supervisor-workspace__story-merge">
      <label>{t('supervisor.experiences.mergeInto')}
        <select value={mergeInto} disabled={pending} onChange={event => setMergeInto(event.target.value)}>
          <option value="">{t('supervisor.experiences.choose')}</option>
          {targets.map(other => <option key={other.id} value={other.id}>{other.statement}</option>)}
        </select>
      </label>
      <button className="secondary-button" disabled={pending || !mergeInto}
        onClick={() => void onAct({ action: 'experience-merge', experienceId: experience.id, intoId: mergeInto }).then(done => { if (done) setMergeInto('') })}>
        {t('supervisor.experiences.merge')}
      </button>
    </div>}
    {confirmRemove && <div role="alert">
      <p>{t('supervisor.experiences.removeHint')}</p>
      <div className="supervisor-workspace__actions">
        <button className="secondary-button" disabled={pending} onClick={() => setConfirmRemove(false)}>{t('supervisor.cancel')}</button>
        <button className="danger-solid" disabled={pending} onClick={() => void onAct({ action: 'experience-remove', experienceId: experience.id })}>{t('supervisor.experiences.remove')}</button>
      </div>
    </div>}
    <div className="supervisor-workspace__related">
      <h4>{t('supervisor.experiences.formed', { count: formed.length })}</h4>
      {formed.map(eventButton)}
    </div>
    <div className="supervisor-workspace__related">
      <h4>{t('supervisor.experiences.applied', { count: applied.length })}</h4>
      {applied.length ? applied.map(eventButton) : <p className="supervisor-workspace__muted">{t('supervisor.experiences.noApplications')}</p>}
    </div>
  </>
}
