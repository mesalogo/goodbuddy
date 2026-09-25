import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SupervisionReviewBatch } from '../../shared/supervision-review-contracts'
import type { AssistantProject } from '../../shared/assistant-contracts'

export function SupervisionBatchDetails({ runId, projects = [], revision }: { runId: string; projects?: AssistantProject[]; revision?: number }) {
  const { t } = useTranslation('heartbeat')
  const [offset, setOffset] = useState(0)
  const [rows, setRows] = useState<SupervisionReviewBatch[]>([])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let disposed = false
    void window.goodbuddy.supervision.batches({ runId, offset, limit: 10 }).then(result => {
      if (!disposed) { setRows(result); setError(undefined); setLoading(false) }
    }, reason => { if (!disposed) { setError(String(reason)); setLoading(false) } })
    return () => { disposed = true }
  }, [runId, offset, revision, retry])
  const groups = useMemo(() => {
    const result = new Map<string, Map<string, SupervisionReviewBatch[]>>()
    for (const batch of rows) {
      if (!result.has(batch.projectId)) result.set(batch.projectId, new Map())
      const conversations = result.get(batch.projectId)!
      if (!conversations.has(batch.conversationId)) conversations.set(batch.conversationId, [])
      conversations.get(batch.conversationId)!.push(batch)
    }
    return [...result].map(([projectId, conversations]) => ({ projectId, conversations: [...conversations] }))
  }, [rows])
  return <section className="supervisor-activity__tree" aria-label={t('reviewSettings.facts')} aria-busy={loading}>
    <p>{t('reviewSettings.factsHelp')}</p>
    <p className="supervisor-activity__note">{t('activity.treePageHint')}</p>
    {error && <div role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => { setLoading(true); setRetry(value => value + 1) }}>{t('center.actions.retry')}</button></div>}
    {loading && <p role="status">{t('activity.loading')}</p>}
    {!loading && !error && !rows.length && <p>{t('activity.noSavedBatches')}</p>}
    {!loading && !error && groups.map(({ projectId, conversations }) => <details key={projectId} className="supervisor-activity__project" open>
      <summary>{projectId ? t('supervisor.projectScope', { names: projects.find(project => project.id === projectId)?.name ?? projectId }) : t('activity.unassigned')}</summary>
      {conversations.map(([conversationId, batches]) => <details key={conversationId} className="supervisor-activity__conversation">
        <summary>{conversationId ? batches[0]!.evidence.find(source => source.sourceType === 'conversation')?.title || conversationId : t('activity.projectSources')} <span>{t('activity.pageBatches', { count: batches.length })}</span></summary>
        {batches.map(batch => <details key={batch.id} className="supervisor-activity__batch">
      <summary><span className="supervisor-activity__batch-label"><span className="supervisor-activity__status--completed">{t('activity.batchSaved')}</span> · {batch.output.summary}</span></summary>
      <p>{batch.output.summary}</p>
      <p>{batch.output.changeDigest}</p>
      <ul>{batch.output.openItems.map((item, index) => <li key={index}>{item}</li>)}</ul>
      {[...batch.output.events, ...batch.output.entities, ...batch.output.entityChanges, ...batch.output.relations].map((fact, index) =>
        <article key={index}>
          <p>{'title' in fact ? fact.title : 'label' in fact ? fact.label : 'changeType' in fact ? fact.changeType : fact.relationType}</p>
          <p>{'description' in fact ? fact.description : fact.reason}</p>
          {fact.sourceReferenceIds.map(id => {
            const source = batch.evidence.find(item => item.id === id)
            return source && <details key={id}><summary>{source.title} / {String(source.locator?.messageId ?? source.sourceId)} [{String(source.locator?.start)}, {String(source.locator?.end)})</summary>
              <p>{t('reviewSettings.revision')}: {String(source.locator?.revision)}</p>
              <pre tabIndex={0} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{source.content}</pre>
            </details>
          })}
        </article>)}
      <details><summary>{t('reviewSettings.sources')}</summary>{batch.evidence.map(source => <article key={source.id}>
        <p>{source.title}: {String(source.locator?.messageId ?? source.sourceId)} [{String(source.locator?.start)}, {String(source.locator?.end)})</p>
        <pre tabIndex={0} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{source.content}</pre>
      </article>)}</details>
    </details>)}
      </details>)}
    </details>)}
    <nav className="supervisor-workspace__actions" aria-label={t('activity.pagination')}>
      <button type="button" className="secondary-button" disabled={loading || offset === 0} onClick={() => { setLoading(true); setOffset(offset - 10) }}>{t('reviewSettings.previousPage')}</button>
      <span>{t('activity.page', { page: offset / 10 + 1 })}</span>
      <button type="button" className="secondary-button" disabled={loading || Boolean(error) || rows.length < 10} onClick={() => { setLoading(true); setOffset(offset + 10) }}>{t('reviewSettings.nextPage')}</button>
    </nav>
  </section>
}
