import { CheckCircle2, ChevronDown, ChevronUp, Circle, CircleDashed, XCircle } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Message } from './ChatTimeline'
import { isCancelledMessage } from './message-terminal-status'
import { AnchoredMenu } from './AnchoredMenu'
import './runtime-checklist.css'

const statusIcons = {
  pending: Circle,
  in_progress: CircleDashed,
  completed: CheckCircle2,
  cancelled: XCircle
}

export function RuntimeChecklistStrip({ messages, activeMessageId }: {
  messages: readonly Message[]
  activeMessageId?: string
}): React.JSX.Element | null {
  // Select the request first, never search backwards for a populated checklist.
  const activeMessage = activeMessageId
    ? messages.find(candidate => candidate.id === activeMessageId)
    : undefined
  const message = activeMessageId && (!activeMessage || activeMessage.state === 'streaming')
    ? activeMessage
    : messages.at(-1)
  if (message?.role !== 'assistant' || !message.runtimeChecklist?.items.length) return null
  return <Checklist key={message.id} message={message} />
}

function Checklist({ message }: { message: Message }): React.JSX.Element {
  const { t } = useTranslation('app')
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const items = message.runtimeChecklist!.items
  const completed = items.reduce((count, item) => count + Number(item.status === 'completed'), 0)
  const current = items.find(item => item.status === 'in_progress')
  const result = message.state === 'streaming' ? undefined : message.status || t(
    isCancelledMessage(message) ? 'chat.status.taskCancelled'
      : message.state === 'error' ? 'runtimeChecklist.failed' : 'runtimeChecklist.finished'
  )
  const summary = t('runtimeChecklist.count', { completed, total: items.length })
  return (
    <section className="runtime-checklist" aria-label={t('runtimeChecklist.title')}>
      <button ref={anchorRef} className="runtime-checklist__toggle" type="button"
        aria-expanded={expanded} aria-controls={contentId}
        onClick={() => setExpanded(value => !value)}>
        <strong>{t('runtimeChecklist.title')}</strong>
        <span>{summary}</span>
        {result && <span className="runtime-checklist__result">{result}</span>}
        {current && <span className="runtime-checklist__current" title={current.content}>{current.content}</span>}
        {expanded ? <ChevronUp aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}
      </button>
      <span className="sr-only" role="status" aria-live="polite">{summary}{result ? ` · ${result}` : ''}</span>
      {expanded && <AnchoredMenu anchorRef={anchorRef} id={contentId} label={t('runtimeChecklist.title')}
        role="group" width="anchor" className="runtime-checklist__content" onClose={() => setExpanded(false)}>
        <ol>
          {items.map((item, index) => {
            const Icon = statusIcons[item.status]
            return <li key={index}>
              <span className={`runtime-checklist__status runtime-checklist__status--${item.status}`}>
                <Icon aria-hidden="true" size={14} /><span>{t(`runtimeChecklist.status.${item.status}`)}</span>
              </span>
              <span className="runtime-checklist__text">{item.content}</span>
              {item.priority && <small>{t(`runtimeChecklist.priority.${item.priority}`)}</small>}
            </li>
          })}
        </ol>
      </AnchoredMenu>}
    </section>
  )
}
