import { useEffect, useState } from 'react'
import { History, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AssistantProject } from '../../shared/assistant-contracts'
import type { SupervisionActivity } from '../../shared/supervision-contracts'
import { EmptyState, ScopeBadge } from './WorkspacePrimitives'

export function SupervisorActivity({ active, projects, onOpenResult }: {
  active: boolean
  projects: AssistantProject[]
  onOpenResult: (resultId: string, tab: 'overview' | 'graph') => void
}) {
  const { t, i18n } = useTranslation('heartbeat')
  const [rows, setRows] = useState<SupervisionActivity[]>([])
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string>()
  const api = window.goodbuddy?.supervision
  useEffect(() => {
    if (!active) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      setReading(true)
      try {
        if (!api?.activity) throw new Error(t('supervisor.unavailable'))
        const result = await api.activity({ limit: 50, offset })
        if (disposed) return
        setRows(result)
        setError(undefined)
        // One request at a time, only while this page is active.
        timer = setTimeout(() => void load(), result.some((row) => row.status === 'running') ? 2000 : 10000)
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : t('common.operationFailed'))
      } finally {
        if (!disposed) {
          setLoading(false)
          setReading(false)
        }
      }
    }
    timer = setTimeout(() => void load(), 0)
    return () => { disposed = true; clearTimeout(timer) }
  }, [active, api, offset, refresh, t])
  const reload = (nextOffset = offset) => {
    setLoading(true)
    setError(undefined)
    setOffset(nextOffset)
    setRefresh((value) => value + 1)
  }
  const date = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage)
  return <section className="supervisor-activity" aria-label={t('activity.title')} aria-busy={loading}>
    <div className="supervisor-workspace__action-bar">
      <ScopeBadge scope={{ kind: 'mixed' }} />
      <button className="secondary-button" type="button" disabled={loading || reading || !active} onClick={() => reload()}>
        <RefreshCw size={14} aria-hidden="true" />{t('center.actions.refresh')}
      </button>
    </div>
    <p className="supervisor-activity__note">{t('activity.description')}</p>
    {error && <div role="alert" className="heartbeat-center__error"><p>{error}</p>
      <button className="secondary-button" type="button" onClick={() => reload()}>{t('center.actions.retry')}</button>
    </div>}
    {loading ? <EmptyState icon={<RefreshCw size={24} />} variant="loading" title={t('activity.loading')} description={t('activity.loadingHint')} />
      : !error && rows.length === 0 ? <EmptyState icon={<History size={24} />} title={t('activity.empty')} description={t('activity.emptyHint')} />
      : <ol className="supervisor-activity__list">{rows.map((row) => <li key={`${row.kind}:${row.id}`}>
        <article className="supervisor-activity__item">
          <header><strong>{t(`activity.kind.${row.kind}`)}</strong>
            <span className={`supervisor-activity__status supervisor-activity__status--${row.status}`}>{t(`activity.status.${row.status}`)}</span>
          </header>
          <dl>
            <div><dt>{t('activity.trigger')}</dt><dd>{t(`activity.triggers.${row.trigger}`)}</dd></div>
            <div><dt>{t('supervisor.scope')}</dt><dd>{!row.scope ? t('activity.unknownScope') : row.scope.kind === 'global' ? t('center.scope.global') : t('supervisor.projectScope', { names: row.scope.projectIds.map((id) => projects.find((project) => project.id === id)?.name ?? t('settings.scope.unavailableProject')).join(', ') })}</dd></div>
            <div><dt>{t('activity.started')}</dt><dd><time dateTime={row.startedAt} title={row.startedAt}>{date(row.startedAt)}</time></dd></div>
            <div><dt>{t('activity.finished')}</dt><dd>{row.completedAt ? <time dateTime={row.completedAt} title={row.completedAt}>{date(row.completedAt)}</time> : t('common.unavailable')}</dd></div>
            {row.timeRange && <div><dt>{t('supervisor.period')}</dt><dd>{date(row.timeRange.from)} / {date(row.timeRange.to)}</dd></div>}
          </dl>
          <p className="supervisor-activity__stages">
            {row.heartbeatStatus && <span>{t('activity.heartbeatStage')}: {t(`statuses.run.${row.heartbeatStatus}`)}</span>}
            <span>{t('activity.supervisionStage')}: {row.supervisionStatus ? t(`activity.status.${row.supervisionStatus}`) : t('activity.notRecorded')}</span>
          </p>
          {row.error && <p className="heartbeat-center__error">{row.error}</p>}
          {row.summary && <p className="supervisor-activity__summary">{row.summary}</p>}
          {row.resultId && <div className="supervisor-workspace__actions">
            <button className="secondary-button" type="button" onClick={() => onOpenResult(row.resultId!, 'overview')}>{t('activity.openReview')}</button>
            <button className="secondary-button" type="button" onClick={() => onOpenResult(row.resultId!, 'graph')}>{t('supervisor.viewInGraph')}</button>
          </div>}
        </article>
      </li>)}</ol>}
    <nav className="supervisor-workspace__actions" aria-label={t('activity.pagination')}>
      <button className="secondary-button" type="button" disabled={loading || reading || !active || offset === 0} onClick={() => reload(Math.max(0, offset - 50))}>{t('activity.previous')}</button>
      <span>{t('activity.page', { page: offset / 50 + 1 })}</span>
      <button className="secondary-button" type="button" disabled={loading || reading || !active || rows.length < 50 || offset >= 100000} onClick={() => reload(offset + 50)}>{t('activity.next')}</button>
    </nav>
  </section>
}
