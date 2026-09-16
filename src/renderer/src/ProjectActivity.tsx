import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react'
import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { ConversationActivity } from './conversation-activity'
import type { AssistantProject } from '../../shared/assistant-contracts'
import './project-activity.css'

export type ProjectActivityProps = {
  activities: ConversationActivity[]
  projects?: readonly AssistantProject[]
  visible?: boolean
  onOpenConversation: (id: string) => void
}

export type ProjectActivityCountsProps = { running: number; attention: number; completed?: number }

export function ProjectActivityCounts({
  running,
  attention,
  completed = 0
}: ProjectActivityCountsProps): React.JSX.Element | null {
  const { t } = useTranslation('workspace')
  if (!running && !attention && !completed) return null
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
      {completed > 0 && <>{' '}
        <span className="project-activity__completed">
          <Check aria-hidden="true" size={13} />
          {t('projectActivity.completedCount', { count: completed })}
        </span>
      </>}
    </span>
  )
}

function ActivityMenu({
  activities,
  projects,
  anchorRef,
  id,
  onOpenConversation,
  onClose
}: ProjectActivityProps & { anchorRef: React.RefObject<HTMLButtonElement | null>; id: string; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const menuRef = useRef<HTMLDivElement>(null)
  const projectRef = useRef<HTMLDivElement>(null)
  const sessionsRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const groups = useMemo(() => {
    const priority = { attention: 0, approval: 0, question: 0, running: 1, completed: 2 }
    const rows = new Map<string, { id: string; name: string; rows: ConversationActivity[] }>()
    // Keep source project order within local, SSH Host and channel groups.
    const ordered = new Map<string, AssistantProject[]>()
    for (const project of projects ?? []) {
      const key = project.kind === 'channel' ? 'channel' : project.executionSpace.kind === 'ssh'
        ? `ssh:${project.executionSpace.hostId}` : 'local'
      const group = ordered.get(key) ?? []
      group.push(project)
      ordered.set(key, group)
    }
    const keys = [...ordered.keys()].sort((a, b) =>
      (a === 'local' ? 0 : a === 'channel' ? 2 : 1) - (b === 'local' ? 0 : b === 'channel' ? 2 : 1))
    for (const key of keys) for (const project of ordered.get(key)!) {
      rows.set(project.id, { id: project.id, name: project.name, rows: [] })
    }
    for (const activity of activities) {
      const key = activity.projectId ?? ''
      const group = rows.get(key) ?? { id: key, name: activity.projectName, rows: [] }
      group.rows.push(activity)
      rows.set(key, group)
    }
    return [...rows.values()].filter((group) => group.rows.length).map((group) => ({
      ...group,
      rows: group.rows.sort((a, b) => priority[a.status] - priority[b.status]),
      running: group.rows.filter((row) => row.status === 'running').length,
      completed: group.rows.filter((row) => row.status === 'completed').length
    }))
  }, [activities, projects])
  const active = groups.find((group) => group.id === selected)
  if (selected !== null && !active) setSelected(null)
  const position = useEffectEvent(() => {
    const menu = menuRef.current
    if (!menu || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const panelWidth = Math.min(264, window.innerWidth - 32)
    const baseLeft = Math.max(16, Math.min(rect.left, window.innerWidth - panelWidth - 16))
    const compact = window.innerWidth < 620 || (
      baseLeft + panelWidth * 2 > window.innerWidth - 16 && baseLeft < panelWidth + 16
    )
    const leftward = !compact && baseLeft + panelWidth * 2 > window.innerWidth - 16 && baseLeft >= panelWidth + 16
    menu.dataset.compact = String(compact)
    menu.dataset.left = String(leftward)
    menu.style.width = `${panelWidth}px`
    menu.style.left = `${baseLeft}px`
    menu.style.top = `${Math.max(16, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 16))}px`
    const sessions = sessionsRef.current
    if (sessions) {
      sessions.style.width = `${panelWidth}px`
      if (compact) {
        sessions.style.left = ''
        sessions.style.top = ''
      } else {
        const row = projectRef.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')
        sessions.style.left = `${baseLeft + (leftward ? -panelWidth : panelWidth)}px`
        sessions.style.top = `${Math.max(16, Math.min(row?.getBoundingClientRect().top ?? rect.bottom + 4, window.innerHeight - sessions.offsetHeight - 16))}px`
      }
    }
    if (compact && active && projectRef.current?.contains(document.activeElement)) {
      sessionsRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    }
  })
  useLayoutEffect(() => { position() })
  const back = (): void => {
    const index = groups.findIndex((group) => group.id === selected)
    flushSync(() => setSelected(null))
    projectRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[Math.max(0, index)]?.focus()
  }
  const enter = (key: string): void => {
    flushSync(() => setSelected(key))
    sessionsRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }
  const handleKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (active) back()
      else onClose()
      return
    }
    if (!menuRef.current?.contains(event.target as Node)) return
    if (event.key === 'Tab') { flushSync(onClose); return }
    if (event.key === 'ArrowLeft' && active) {
      event.preventDefault()
      back()
      return
    }
    const projectButtons = projectRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    const projectIndex = Array.from(projectButtons ?? []).indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowRight' && projectIndex >= 0) {
      event.preventDefault()
      enter(groups[projectIndex]!.id)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = Array.from((projectIndex >= 0 ? projectRef : sessionsRef).current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  })
  const dismiss = useEffectEvent(onClose)
  useEffect(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    const initialFocus = projectRef.current?.querySelector<HTMLButtonElement>('button') ?? menu
    initialFocus?.focus()
    const onKeyDown = (event: KeyboardEvent): void => handleKeyDown(event)
    const outside = (event: Event): void => {
      if (!menuRef.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) dismiss()
    }
    const reposition = (): void => position()
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      if (document.activeElement === document.body || menu?.contains(document.activeElement)) {
        anchor?.focus()
      }
    }
  }, [anchorRef])
  useLayoutEffect(() => {
    if (document.activeElement === document.body) {
      const fallback = (active ? sessionsRef : projectRef).current?.querySelector<HTMLButtonElement>('[role="menuitem"]') ?? menuRef.current
      fallback?.focus()
    }
  }, [groups, active])
  return createPortal(
    <div className="project-activity__menu" data-submenu={Boolean(active)} ref={menuRef} id={id}
      role="menu" aria-label={t('projectActivity.title')} tabIndex={-1}>
      <div className="project-activity__projects" ref={projectRef} role="presentation">
        <h3>{t('projectActivity.title')}</h3>
        {!groups.length && <p>{t('projectActivity.empty')}</p>}
        {groups.map((group) => (
          <button key={group.id} type="button" role="menuitem" tabIndex={-1}
            className="project-activity__row" aria-haspopup="menu" aria-expanded={selected === group.id}
            aria-controls={selected === group.id ? `${id}-sessions` : undefined}
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse' && menuRef.current?.dataset.compact !== 'true') setSelected(group.id)
            }}
            onClick={() => enter(group.id)}>
            <span className="project-activity__identity"><span>{group.name}</span>{' '}
              <ProjectActivityCounts running={group.running} completed={group.completed}
                attention={group.rows.length - group.running - group.completed} />
            </span><ChevronRight aria-hidden="true" size={14} />
          </button>
        ))}
      </div>
      {active && <div className="project-activity__sessions" ref={sessionsRef} id={`${id}-sessions`}
        role="menu" aria-label={active.name}>
        <button className="project-activity__back project-activity__row" type="button" onClick={back}>
          <ChevronLeft aria-hidden="true" size={14} />{t('projectActivity.back')}
        </button>
        <h3>{active.name}</h3>
        {active.rows.map((activity) => <button key={activity.conversationId} type="button" role="menuitem" tabIndex={-1}
          className="project-activity__row" onClick={() => {
            flushSync(onClose)
            onOpenConversation(activity.conversationId)
          }}>
          <span className="project-activity__identity"><span>{activity.title}</span>{' '}
            <small className={`project-activity__${activity.status === 'completed' ? 'completed' : activity.status === 'running' ? 'running' : 'attention'}`}>
              {activity.status === 'completed' && <Check aria-hidden="true" size={13} />}
              {t(`projectActivity.status.${activity.status}`)}
            </small>
          </span>
        </button>)}
      </div>}
    </div>,
    document.body
  )
}

export function ProjectActivity({
  activities,
  projects,
  visible = true,
  onOpenConversation
}: ProjectActivityProps): React.JSX.Element | null {
  const { t } = useTranslation('workspace')
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  if ((!visible || activities.length === 0) && open) setOpen(false)
  const running = useMemo(() => activities.filter((activity) => activity.status === 'running').length, [activities])
  const completed = useMemo(() => activities.filter((activity) => activity.status === 'completed').length, [activities])
  const attention = activities.length - running - completed
  if (activities.length === 0) return null
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? id : undefined}
        aria-label={`${t('projectActivity.title')}: ${[t('projectActivity.attentionCount', { count: attention }), t('projectActivity.runningCount', { count: running }), ...(completed > 0 ? [t('projectActivity.completedCount', { count: completed })] : [])].join(', ')}`}
        ref={triggerRef}
        className="project-activity__summary"
        onClick={(event) => {
          event.currentTarget.focus()
          setOpen(!open)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        type="button"
      >
        <ProjectActivityCounts attention={attention} running={running} completed={completed} />
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open && visible && (
        <ActivityMenu
          activities={activities}
          projects={projects}
          anchorRef={triggerRef}
          id={id}
          onClose={() => setOpen(false)}
          onOpenConversation={onOpenConversation}
        />
      )}
    </>
  )
}
