import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SupervisionStoryView } from '../../shared/supervision-story-contracts'
import { storyDigest, type StoryDigestEntry } from './supervision-story-digest'

type Focus = { kind: 'story' | 'experience'; id: string }
const shown = 6

/**
 * The work review, organized by story for the selected result's period: which stories moved,
 * started, finished or stayed quiet, and which experiences formed or were used. Reads stored
 * stories only; each item opens the story or experience in the graph.
 */
export function SupervisionStoryDigest({ view, range, date, onOpen }: {
  view: SupervisionStoryView
  range: { from: string; to: string }
  date: (value: string) => string
  onOpen: (focus: Focus) => void
}): React.JSX.Element {
  const { t } = useTranslation('heartbeat')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const digest = storyDigest(view, range)
  const total = digest.advanced.length + digest.started.length + digest.concluded.length + digest.experiences.length
  const limit = <T,>(key: string, items: T[]) => expanded[key] ? items : items.slice(0, shown)
  const more = (key: string, count: number) => count > shown && !expanded[key]
    ? <button type="button" className="link-button" onClick={() => setExpanded({ ...expanded, [key]: true })}>{t('supervisor.digest.more', { count: count - shown })}</button>
    : null
  const storyItem = (entry: StoryDigestEntry) => <li key={entry.story.id}>
    <button type="button" className="supervisor-digest__item" aria-label={t('supervisor.digest.open', { name: entry.story.name })}
      onClick={() => onOpen({ kind: 'story', id: entry.story.id })}>
      <span className="supervisor-digest__name">{entry.story.name}</span>
      <small>{[entry.story.projectName, t('supervisor.digest.events', { count: entry.events.length })].filter(Boolean).join(' · ')}</small>
      <span className="supervisor-digest__latest">{t('supervisor.digest.latest', { title: entry.latest.title })}</span>
    </button>
  </li>
  const section = (key: 'advanced' | 'started' | 'concluded', items: StoryDigestEntry[]) => items.length > 0 && <section key={key} aria-labelledby={`digest-${key}`}>
    <h3 id={`digest-${key}`}>{t(`supervisor.digest.${key}`)} <small>{items.length}</small></h3>
    <ul>{limit(key, items).map(storyItem)}</ul>
    {more(key, items.length)}
  </section>
  return <article className="supervisor-digest" aria-label={t('supervisor.digest.label')}>
    <div className="supervisor-workspace__section-heading"><h2>{t('supervisor.digest.title')}</h2></div>
    {total === 0 && <p className="supervisor-workspace__muted">{t('supervisor.digest.empty')}</p>}
    <div className="supervisor-digest__grid">
      {section('advanced', digest.advanced)}
      {section('started', digest.started)}
      {section('concluded', digest.concluded)}
      {digest.experiences.length > 0 && <section aria-labelledby="digest-experiences">
        <h3 id="digest-experiences">{t('supervisor.digest.experiences')} <small>{digest.experiences.length}</small></h3>
        <ul>{limit('experiences', digest.experiences).map(entry => <li key={entry.experience.id}>
          <button type="button" className="supervisor-digest__item" aria-label={t('supervisor.digest.open', { name: entry.experience.statement })}
            onClick={() => onOpen({ kind: 'experience', id: entry.experience.id })}>
            <span className="supervisor-digest__name">{entry.experience.statement}</span>
            <small>{[t(`supervisor.digest.${entry.role}`), [...new Set(entry.events.map(event => event.storyName).filter(Boolean))].join('、')].filter(Boolean).join(' · ')}</small>
          </button>
        </li>)}</ul>
        {more('experiences', digest.experiences.length)}
      </section>}
    </div>
    {digest.quiet.length > 0 && <section className="supervisor-digest__quiet" aria-labelledby="digest-quiet">
      <h3 id="digest-quiet">{t('supervisor.digest.quiet')} <small>{digest.quiet.length}</small></h3>
      <ul>{limit('quiet', digest.quiet).map(entry => <li key={entry.story.id}>
        <button type="button" className="link-button" aria-label={t('supervisor.digest.open', { name: entry.story.name })}
          onClick={() => onOpen({ kind: 'story', id: entry.story.id })}>{entry.story.name}</button>
        <small>{t('supervisor.digest.lastAt', { date: date(entry.latest.startedAt) })}</small>
      </li>)}</ul>
      {more('quiet', digest.quiet.length)}
    </section>}
    {digest.unassigned > 0 && total > 0 && <p className="supervisor-workspace__muted">{t('supervisor.digest.unassigned', { count: digest.unassigned })}</p>}
  </article>
}
