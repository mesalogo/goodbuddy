import { ChevronRight, CircleAlert, LoaderCircle, X } from 'lucide-react'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { ConversationActivity } from './conversation-activity'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import './project-activity.css'

export type ProjectActivityProps = {
  activities: ConversationActivity[]
  onOpenConversation: (id: string) => void
}

export type ProjectActivityCountsProps = { running: number; attention: number }

export function ProjectActivityCounts({
  running,
  attention
}: ProjectActivityCountsProps): React.JSX.Element | null {
  const { t } = useTranslation('workspace')
  if (!running && !attention) return null
  return (
    <span className="project-activity__counts">
      {attention > 0 && (
        <span className="project-activity__attention">
          <CircleAlert aria-hidden="true" size={13} />
          {t('projectActivity.attentionCount', { count: attention })}
        </span>
      )}
      {' '}
      {running > 0 && (
        <span className="project-activity__running">
          <LoaderCircle aria-hidden="true" size={13} />
          {t('projectActivity.runningCount', { count: running })}
        </span>
      )}
    </span>
  )
}

function ActivityDialog({
  activities,
  onOpenConversation,
  onClose
}: ProjectActivityProps & { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const handleKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else {
      trapTabFocus(event, dialogRef.current)
    }
  })
  useEffect(() => {
    const releaseFocus = activateModalFocus(
      () => dialogRef.current?.querySelector<HTMLButtonElement>('button') ?? null
    )
    const onKeyDown = (event: KeyboardEvent): void => handleKeyDown(event)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      releaseFocus()
    }
  }, [])

  return createPortal(
    <div
      className="project-activity__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="project-activity__dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header className="project-activity__header">
          <h2 id={titleId}>{t('projectActivity.title')}</h2>
          <button
            aria-label={t('projectActivity.close')}
            className="icon-button"
            onClick={onClose}
            title={t('projectActivity.close')}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <div className="project-activity__content">
          {(['attention', 'running'] as const).map((group) => {
            const rows = activities.filter((activity) =>
              group === 'running' ? activity.status === 'running' : activity.status !== 'running'
            )
            if (!rows.length) return null
            return (
              <section aria-labelledby={`${titleId}-${group}`} key={group}>
                <h3 id={`${titleId}-${group}`}>{t(`projectActivity.groups.${group}`)}</h3>
                <ul>
                  {rows.map((activity) => (
                    <li key={activity.conversationId}>
                      <button
                        className="project-activity__row"
                        onClick={() => {
                          // Release modal isolation and restore focus before navigation owns it.
                          flushSync(onClose)
                          onOpenConversation(activity.conversationId)
                        }}
                        type="button"
                      >
                        <span className="project-activity__identity">
                          <small>{activity.projectName}</small>{' '}
                          <span>{activity.title}</span>
                        </span>{' '}
                        <span className={`project-activity__${group}`}>
                          {t(`projectActivity.status.${activity.status}`)}
                        </span>
                        <ChevronRight aria-hidden="true" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </section>
    </div>,
    document.body
  )
}

export function ProjectActivity({
  activities,
  onOpenConversation
}: ProjectActivityProps): React.JSX.Element | null {
  const { t } = useTranslation('workspace')
  const [open, setOpen] = useState(false)
  if (!activities.length) {
    if (open) setOpen(false)
    return null
  }
  const running = activities.filter((activity) => activity.status === 'running').length
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="project-activity__summary"
        onClick={(event) => {
          event.currentTarget.focus()
          setOpen(true)
        }}
        type="button"
      >
        <span>{t('projectActivity.title')}</span>{' '}
        <ProjectActivityCounts attention={activities.length - running} running={running} />
        <ChevronRight aria-hidden="true" size={14} />
      </button>
      {open && (
        <ActivityDialog
          activities={activities}
          onClose={() => setOpen(false)}
          onOpenConversation={onOpenConversation}
        />
      )}
    </>
  )
}
