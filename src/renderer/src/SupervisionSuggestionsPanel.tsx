import { Lightbulb } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssistantTask } from '../../shared/assistant-contracts'
import type { SupervisionSuggestion } from '../../shared/supervision-contracts'

/**
 * Suggestions the heartbeat derived from published graph changes. Each keeps
 * its evidence; accepting an open item creates a paused task, accepting a
 * convention makes it long-term background.
 */
export function SupervisionSuggestionsPanel({ tasks, onUseFollowUpTask, onOpenResult, onOpenConversation, reloadKey = 0 }: {
  /** Changes when the page-level refresh runs; the panel has no refresh control of its own. */
  reloadKey?: number
  tasks: AssistantTask[]
  onUseFollowUpTask: (task: AssistantTask) => void
  /** Story and experience suggestions open that story or experience in the graph lists. */
  onOpenResult?: (resultId: string, focus?: { kind: 'story' | 'experience'; id: string }) => void
  onOpenConversation?: (conversationId: string) => void
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation('heartbeat')
  const api = window.goodbuddy?.supervision
  const [items, setItems] = useState<SupervisionSuggestion[]>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [evidence, setEvidence] = useState<{ suggestionId: string; sources: Array<{ id: string; title: string; content: string; conversationId?: string }> }>()
  const generation = useRef(0)
  const load = useCallback(async () => {
    if (!api?.suggestions) return
    const current = ++generation.current
    try {
      const next = await api.suggestions({ status: 'pending', limit: 50 })
      if (current === generation.current) { setItems(next); setError(undefined) }
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : t('common.operationFailed'))
    }
  }, [api, t])
  useEffect(() => {
    const counter = generation
    // Defer the first read so state is only set from an async callback.
    const timer = setTimeout(() => void load(), 0)
    return () => { clearTimeout(timer); counter.current++ }
  }, [load, reloadKey])
  if (!api?.suggestions || (!items?.length && !error)) return null
  const act = async (item: SupervisionSuggestion, action: 'accept' | 'dismiss') => {
    setPending(item.id)
    setError(undefined)
    try {
      const resolved = await api.suggestionAction({ id: item.id, action })
      setItems(current => current?.filter(candidate => candidate.id !== item.id))
      const task = resolved.taskId ? tasks.find(candidate => candidate.id === resolved.taskId) : undefined
      if (task && action === 'accept') onUseFollowUpTask(task)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('common.operationFailed'))
    } finally { setPending(undefined) }
  }
  const showEvidence = async (item: SupervisionSuggestion) => {
    if (evidence?.suggestionId === item.id) { setEvidence(undefined); return }
    setError(undefined)
    try {
      const rows = await Promise.all(item.sourceIds.slice(0, 5).map(id => api.source(id)))
      setEvidence({ suggestionId: item.id, sources: rows.flatMap((row, index) => row ? [{ id: item.sourceIds[index]!, title: String(row.title),
        content: String(row.content), conversationId: row.sourceType === 'conversation' && typeof row.sourceId === 'string' ? row.sourceId : undefined }] : []) })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('common.operationFailed'))
    }
  }
  const date = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage || 'zh-CN',
    { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  return <section aria-labelledby="supervision-suggestions-title" className="heartbeat-center__section supervision-suggestions">
    <div className="heartbeat-center__section-heading">
      <div><h2 id="supervision-suggestions-title"><Lightbulb aria-hidden="true" size={16} />{t('suggestions.title')}</h2></div>
    </div>
    {error && <p className="heartbeat-center__error" role="alert">{error}</p>}
    <ul className="supervision-suggestions__list">
      {items?.map(item => <li key={item.id}>
        <div>
          <span className="supervision-suggestions__kind">{t(`suggestions.kind.${item.kind}`)}</span>
          <time dateTime={item.createdAt}>{date(item.createdAt)}</time>
        </div>
        <strong>{item.title}</strong>
        {item.detail && item.detail !== item.title && <p>{item.detail}</p>}
        <div className="supervision-suggestions__evidence">
          <button type="button" className="link-button" aria-expanded={evidence?.suggestionId === item.id}
            disabled={!item.sourceIds.length} onClick={() => void showEvidence(item)}>{t('suggestions.evidence', { count: item.sourceIds.length })}</button>
          {item.resultId && onOpenResult && <button type="button" className="link-button" onClick={() => onOpenResult(item.resultId!, item.experienceId ? { kind: 'experience', id: item.experienceId }
              : item.storyId ? { kind: 'story', id: item.storyId } : undefined)}>{t('supervisor.viewInGraph')}</button>}
        </div>
        {evidence?.suggestionId === item.id && <ul className="supervision-suggestions__sources">
          {evidence.sources.map(source => <li key={source.id}>
            <strong>{source.title}</strong>
            <p>{source.content}</p>
            {source.conversationId && onOpenConversation && <button type="button" className="link-button"
              onClick={() => onOpenConversation(source.conversationId!)}>{t('supervisor.openConversation')}</button>}
          </li>)}
          {item.sourceIds.length > evidence.sources.length && <li><small>{t('suggestions.moreEvidence', { count: item.sourceIds.length - evidence.sources.length })}</small></li>}
        </ul>}
        <div className="supervision-suggestions__actions">
          <button type="button" className="primary-button" disabled={pending !== undefined}
            onClick={() => void act(item, 'accept')}>{t(`suggestions.accept.${item.kind}`)}</button>
          <button type="button" className="secondary-button" disabled={pending !== undefined}
            onClick={() => void act(item, 'dismiss')}>{t('suggestions.dismiss')}</button>
        </div>
      </li>)}
    </ul>
  </section>
}
