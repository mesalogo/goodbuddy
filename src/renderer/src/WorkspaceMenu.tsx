import { Archive, ArrowRight, ChevronDown, Plus, Server, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { AssistantProject } from '../../shared/assistant-contracts'
import type { SshHost, SshHostAgentConnectionState } from '../../shared/ssh-host-contracts'
import type { ConversationActivity } from './conversation-activity'
import type { ConversationStore } from './conversation-store'
import { FloatingPortal } from './FloatingPortal'
import { displayErrorMessage } from './error-message'
import type { AppNotificationInput } from './notifications'
import { getProjectDisplayText } from './project-display'
import { useListWindow } from './use-list-window'
import { PageTabs, SegmentedControl } from './WorkspacePrimitives'
import { useWorkspaceConversations, useWorkspaceConversationTime, workspaceConversationRows, type WorkspaceFilter } from './workspace-menu-selectors'
import './workspace-menu.css'

type ProjectCategory = 'allProjects' | 'local' | 'remote' | 'channels'
type ProjectRow =
  | { id: string; kind: 'host'; hostId: string; label: string; state: SshHostAgentConnectionState }
  | { id: string; kind: 'project'; project: AssistantProject }

function WorkspaceConversationTime({ store, id }: { store: ConversationStore; id: string }): React.JSX.Element | null {
  const { i18n } = useTranslation()
  const time = useWorkspaceConversationTime(store, id, i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN')
  return time ? <time dateTime={time.dateTime} title={time.title}>{time.label}</time> : null
}

export type WorkspaceMenuProps = {
  projects: AssistantProject[]
  activeProjectId: string
  activities: ConversationActivity[]
  conversationStore: ConversationStore
  remoteProjectsEnabled: boolean
  hosts: readonly SshHost[]
  connectionStates: Record<string, SshHostAgentConnectionState>
  anchorRef: React.RefObject<HTMLButtonElement | null>
  controlsRef: React.RefObject<HTMLDivElement | null>
  id: string
  renderProject: (project: AssistantProject) => ReactNode
  onClose: () => void
  onCreateProject: () => void
  onEnterProject: (projectId: string) => void
  onRestore: (projectId: string) => Promise<void>
  notify: (input: AppNotificationInput) => void
  onNewConversation: (projectId: string) => void
  onOpenConversation: (conversationId: string) => void
}

export function WorkspaceMenu({
  projects, activeProjectId, activities, conversationStore, remoteProjectsEnabled,
  hosts, connectionStates, anchorRef, controlsRef, id, renderProject,
  onClose, onCreateProject, onEnterProject, onRestore, notify, onNewConversation, onOpenConversation
}: WorkspaceMenuProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const { t: tApp } = useTranslation('app')
  const titleId = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const projectListRef = useRef<HTMLDivElement>(null)
  const conversationListRef = useRef<HTMLDivElement>(null)
  const categoriesRef = useRef<HTMLDivElement>(null)
  const archiveButtonRef = useRef<HTMLButtonElement>(null)
  const [category, setCategory] = useState<ProjectCategory>('allProjects')
  if (category === 'remote' && !remoteProjectsEnabled) setCategory('allProjects')
  const [scope, setScope] = useState<string | null>(null)
  const [filter, setFilter] = useState<WorkspaceFilter>('all')
  const [query, setQuery] = useState('')
  const [archivedView, setArchivedView] = useState(false)
  const [archivedProjects, setArchivedProjects] = useState<AssistantProject[]>()
  const [loadingArchives, setLoadingArchives] = useState(false)
  const [restoringId, setRestoringId] = useState<string>()
  const archivePending = useRef(false)
  const restorePending = useRef(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [keyboardProject, setKeyboardProject] = useState<string>()
  const [keyboardConversation, setKeyboardConversation] = useState<string>()
  const activityTimes = useSyncExternalStore(conversationStore.subscribeActivityTimes, conversationStore.getActivityTimes)
  const conversations = useWorkspaceConversations(conversationStore, tApp('conversation.defaultTitle'), activityTimes)
  const visibleProjects = useMemo(() => projects.filter((project) => project.status === 'active' && (
    project.kind === 'channel' || project.executionSpace.kind !== 'ssh' || remoteProjectsEnabled)
  ), [projects, remoteProjectsEnabled])
  const projectById = useMemo(() => new Map(visibleProjects.map((project) => [project.id, project])), [visibleProjects])
  const availableActivities = useMemo(() => activities.filter((activity) => !activity.projectId || projectById.has(activity.projectId)), [activities, projectById])
  const availableConversations = useMemo(() => conversations.filter((conversation) => {
    const project = projectById.get(conversation.projectId ?? '')
    return (!conversation.projectId || project) && (project?.kind !== 'channel' || conversation.channel)
  }), [conversations, projectById])
  const categoryTabs = useMemo(() => {
    const categories: ProjectCategory[] = ['allProjects', 'local', ...(remoteProjectsEnabled ? ['remote' as const] : []), 'channels']
    return categories.map((id) => ({ id, label: t(`workspaceMenu.${id}`) }))
  }, [remoteProjectsEnabled, t])
  const projectRows = useMemo(() => {
    const hostById = new Map(hosts.map((host) => [host.id, host]))
    const search = query.trim().toLocaleLowerCase()
    const candidates = archivedView ? (archivedProjects ?? []).filter(project => project.kind === 'user' &&
      (project.executionSpace.kind === 'local' || remoteProjectsEnabled)) : visibleProjects
    const matching = candidates.filter((project) => {
      const host = project.executionSpace.kind === 'ssh' ? hostById.get(project.executionSpace.hostId) : undefined
      if (search) return `${getProjectDisplayText(project, t).name} ${project.rootPath} ${host?.name ?? ''} ${host?.hostname ?? ''} ${project.channel ?? ''}`.toLocaleLowerCase().includes(search)
      const kind = project.kind === 'channel' ? 'channels' : project.executionSpace.kind === 'ssh' ? 'remote' : 'local'
      return archivedView || category === 'allProjects' || category === kind
    })
    const rows: ProjectRow[] = []
    const addProjects = (items: AssistantProject[]): void => {
      for (const project of items) rows.push({ id: project.id, kind: 'project', project })
    }
    addProjects(matching.filter((project) => project.kind !== 'channel' && project.executionSpace.kind === 'local'))
    if (remoteProjectsEnabled) {
      const groups = new Map<string, AssistantProject[]>()
      for (const project of matching) {
        if (project.kind === 'channel' || project.executionSpace.kind !== 'ssh') continue
        const hostId = project.executionSpace.hostId
        const group = groups.get(hostId) ?? []
        group.push(project)
        groups.set(hostId, group)
      }
      for (const [hostId, group] of groups) {
        rows.push({ id: `host:${hostId}`, kind: 'host', hostId,
          label: hostById.get(hostId)?.name ?? t('projectSwitcher.selector.unavailableHost'),
          state: connectionStates[hostId] ?? 'disconnected' })
        if (search || !collapsed.has(hostId)) addProjects(group)
      }
    }
    addProjects(matching.filter((project) => project.kind === 'channel'))
    return rows
  }, [visibleProjects, archivedView, archivedProjects, hosts, query, category, t, remoteProjectsEnabled, connectionStates, collapsed])
  const rows = useMemo(() => workspaceConversationRows(availableConversations, availableActivities, scope, filter, activityTimes), [availableConversations, availableActivities, scope, filter, activityTimes])
  const projectIds = useMemo(() => projectRows.map((row) => row.id), [projectRows])
  const conversationIds = useMemo(() => rows.map((row) => row.id), [rows])
  const projectWindow = useListWindow({ ids: projectIds, scope: `${archivedView}:${category}:${query}`, scrollRef: projectListRef,
    keepIds: [keyboardProject], enabled: true, resetScrollOnScopeChange: true, estimatedRowHeight: 64 })
  const conversationWindow = useListWindow({ ids: conversationIds, scope: `${scope}:${filter}`, scrollRef: conversationListRef,
    keepIds: [keyboardConversation], enabled: true, resetScrollOnScopeChange: true, estimatedRowHeight: 56 })
  const newProject = projectById.get(scope ?? activeProjectId)
  const scopeName = scope === null ? t('workspaceMenu.allProjects')
    : projectById.has(scope) ? getProjectDisplayText(projectById.get(scope)!, t).name : t('projectActivity.unassigned')

  async function loadArchives(): Promise<void> {
    if (archivePending.current) return
    archivePending.current = true
    setLoadingArchives(true)
    try {
      setArchivedProjects((await window.goodbuddy.projects.list(true)).filter(project => project.status === 'archived'))
    } catch (reason) {
      notify({ tone: 'error', message: displayErrorMessage(reason, t('workspaceMenu.loadArchivesFailed')) })
    } finally {
      archivePending.current = false
      setLoadingArchives(false)
    }
  }

  async function restore(project: AssistantProject): Promise<void> {
    if (restorePending.current) return
    restorePending.current = true
    setRestoringId(project.id)
    try {
      await onRestore(project.id)
      if (document.activeElement?.closest('[data-list-window-row]')?.getAttribute('data-list-window-row') === project.id) archiveButtonRef.current?.focus()
      setArchivedProjects(current => current?.filter(item => item.id !== project.id))
      notify({ tone: 'success', message: t('workspaceMenu.restored', { name: getProjectDisplayText(project, t).name }) })
    } catch (reason) {
      notify({ tone: 'error', message: displayErrorMessage(reason, t('workspaceMenu.restoreFailed')) })
    } finally {
      restorePending.current = false
      setRestoringId(undefined)
    }
  }

  useLayoutEffect(() => {
    const menu = menuRef.current
    const anchor = anchorRef.current
    if (!menu || !anchor) return
    const position = (): void => {
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(920, window.innerWidth - 32)
      menu.style.width = `${width}px`
      menu.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`
      const top = Math.max(16, rect.bottom + 8)
      menu.style.top = `${top}px`
      menu.style.maxHeight = `${Math.max(0, window.innerHeight - top - 16)}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(anchor)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [anchorRef])

  useEffect(() => {
    const menu = menuRef.current
    const anchor = anchorRef.current
    categoriesRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
    const outside = (event: Event): void => {
      if (!menu?.contains(event.target as Node) && !controlsRef.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      if (document.activeElement === document.body || menu?.contains(document.activeElement)) {
        anchor?.focus()
      }
    }
  }, [anchorRef, controlsRef, onClose])

  function moveFocus(event: React.KeyboardEvent, list: 'projects' | 'conversations'): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const ids = list === 'projects' ? projectIds : conversationIds
    if (!ids.length) return
    const current = (event.target as HTMLElement).closest<HTMLElement>('[data-list-window-row]')?.dataset.listWindowRow
    const index = current ? ids.indexOf(current) : -1
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length
    event.preventDefault()
    event.stopPropagation()
    flushSync(() => (list === 'projects' ? setKeyboardProject : setKeyboardConversation)(ids[next]))
    const element = (list === 'projects' ? projectListRef : conversationListRef).current
    const row = Array.from(element?.querySelectorAll<HTMLElement>('[data-list-window-row]') ?? [])
      .find((item) => item.dataset.listWindowRow === ids[next])
    row?.querySelector<HTMLButtonElement>('button')?.focus()
    row?.scrollIntoView?.({ block: 'nearest' })
  }

  return <FloatingPortal anchorRef={anchorRef}>
    <div className="project-switcher__menu workspace-menu" ref={menuRef} id={id} role="dialog" aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
        if (event.key === 'ArrowRight' && projectListRef.current?.contains(event.target as Node) && rows.length) {
          event.preventDefault()
          flushSync(() => setKeyboardConversation(rows[0]!.id))
          conversationListRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
        }
        if (event.key === 'ArrowLeft' && conversationListRef.current?.contains(event.target as Node)) {
          event.preventDefault()
          flushSync(() => setKeyboardProject(scope ?? undefined))
          const row = Array.from(projectListRef.current?.querySelectorAll<HTMLElement>('[data-list-window-row]') ?? [])
            .find((item) => item.dataset.listWindowRow === scope)
           const target = row?.querySelector<HTMLButtonElement>('button') ?? (archivedView ? archiveButtonRef.current : categoriesRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]'))
          target?.focus()
        }
      }}>
      <header className="workspace-menu__header">
        <strong id={titleId}>{t('workspaceMenu.title')}</strong>
        <button type="button" className="icon-button" aria-label={t('workspaceMenu.close')} onClick={onClose}><X size={16} /></button>
      </header>
      <div className="workspace-menu__layout">
        <section className="workspace-menu__projects">
          <input className="field-control workspace-menu__search" type="search" aria-label={t('workspaceMenu.search')}
            placeholder={t('workspaceMenu.search')} value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="workspace-menu__categories" ref={categoriesRef} hidden={archivedView}>
            <PageTabs ariaLabel={t('workspaceMenu.categories')} idPrefix={`${id}-categories`} variant="segmented"
              tabs={categoryTabs} value={category} onChange={(next) => {
                setCategory(next)
                if (next === 'allProjects') setScope(null)
              }} />
          </div>
          {archivedView && <div className="workspace-menu__archive-heading">
            <strong>{t('workspaceMenu.archived')}</strong>
            <button type="button" className="secondary-button" onClick={() => {
              flushSync(() => setArchivedView(false))
              categoriesRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
            }}>{t('workspaceMenu.back')}</button>
          </div>}
          <div className="workspace-menu__project-panel" role={archivedView ? 'region' : 'tabpanel'} id={`${id}-categories-panel-${category}`}
            aria-labelledby={archivedView || query.trim() ? undefined : `${id}-categories-tab-${category}`}
            aria-label={archivedView ? t('workspaceMenu.archived') : query.trim() ? t('workspaceMenu.search') : undefined}>
          <div className="workspace-menu__project-list" ref={projectListRef} role="menu" aria-label={t('projectSwitcher.selector.ariaLabel')}
            onScroll={projectWindow.onScroll} onFocus={projectWindow.onFocus} onBlur={projectWindow.onBlur}
            onKeyDown={(event) => moveFocus(event, 'projects')}>
            {projectWindow.segments.map((segment) => {
              if (segment.kind === 'spacer') return <div key={segment.key} data-list-window-spacer aria-hidden="true" style={{ height: segment.height }} />
               const row = projectRows[segment.index]!
               const previous = projectRows[segment.index - 1]
               const rowCategory = row.kind === 'host' ? 'remote' : row.project.kind === 'channel' ? 'channels' : row.project.executionSpace.kind === 'ssh' ? 'remote' : 'local'
               const previousCategory = !previous ? undefined : previous.kind === 'host' ? 'remote' : previous.project.kind === 'channel' ? 'channels' : previous.project.executionSpace.kind === 'ssh' ? 'remote' : 'local'
               return <div key={row.id} data-list-window-row={row.id} ref={projectWindow.rowRef(row.id)} role="presentation"
                data-preview={row.kind === 'project' && scope === row.project.id ? 'true' : undefined}
                onPointerOver={(event) => {
                  if (row.kind === 'project' && event.pointerType !== 'touch' && (event.target as HTMLElement).closest('[role="menuitemradio"]')) setScope(row.project.id)
                }} onFocus={(event) => {
                  if (row.kind === 'project' && (event.target as HTMLElement).matches('[role="menuitemradio"]')) setScope(row.project.id)
                 }}>
                  {(archivedView || category === 'allProjects' || query.trim()) && rowCategory !== previousCategory &&
                   <h3 className="workspace-menu__project-category">{t(`workspaceMenu.${rowCategory}`)}</h3>}
                  {row.kind === 'project' ? archivedView ? <div className="workspace-menu__archived-project">
                    <span><strong>{getProjectDisplayText(row.project, t).name}</strong><small>{row.project.rootPath}</small></span>
                    <button type="button" role="menuitem" className="secondary-button" disabled={Boolean(restoringId)}
                      aria-label={t('workspaceMenu.restoreNamed', { name: getProjectDisplayText(row.project, t).name })}
                      onClick={() => void restore(row.project)}>{t(restoringId === row.project.id ? 'workspaceMenu.restoring' : 'workspaceMenu.restore')}</button>
                  </div> : renderProject(row.project)
                    : <button type="button" role="menuitem" className="project-switcher__host-heading workspace-menu__host"
                      aria-expanded={Boolean(query.trim()) || !collapsed.has(row.hostId)} onClick={() => setCollapsed((current) => {
                        const next = new Set(current)
                        if (next.has(row.hostId)) next.delete(row.hostId); else next.add(row.hostId)
                        return next
                      })}>
                      <span><ChevronDown size={12} aria-hidden="true" /><Server size={14} aria-hidden="true" /><b>{row.label}</b></span>
                      <span className={`status-badge project-switcher__host-status project-switcher__host-status--${row.state}`}>
                        {t(`projectSwitcher.selector.connectionStates.${row.state}`)}
                      </span>
                    </button>}
              </div>
            })}
            {archivedView && loadingArchives ? <p className="workspace-menu__empty" role="status">{t('workspaceMenu.loadingArchives')}</p>
              : archivedView && !archivedProjects ? <div className="workspace-menu__empty"><button type="button" className="secondary-button" onClick={() => void loadArchives()}>{t('workspaceMenu.retryArchives')}</button></div>
              : !projectRows.length && <p className="workspace-menu__empty">{t(archivedView && !query.trim() ? 'workspaceMenu.noArchives' : 'workspaceMenu.noProjects')}</p>}
          </div>
          </div>
          <footer className="workspace-menu__footer"><button type="button" className="secondary-button" onClick={onCreateProject}>
            <Plus size={15} aria-hidden="true" />{t('projectSwitcher.selector.create')}
          </button><button type="button" className="workspace-menu__archived" ref={archiveButtonRef} aria-pressed={archivedView}
            onClick={() => { setArchivedView(!archivedView); if (!archivedView && !archivedProjects) void loadArchives() }}>
            <Archive size={14} aria-hidden="true" />{t('workspaceMenu.archived')}
          </button></footer>
        </section>
        <section className="workspace-menu__activity" aria-label={scopeName}>
          <div className="workspace-menu__toolbar">
            <SegmentedControl ariaLabel={t('workspaceMenu.filter')} value={filter} onChange={setFilter}
              options={(['all', 'attention', 'running', 'completed'] as const).map((value) => ({ value, label: t(`workspaceMenu.filters.${value}`) }))} />
            <button type="button" className="workspace-menu__new" disabled={!newProject || newProject.kind === 'channel'}
              title={newProject?.kind === 'channel' ? tApp('notices.channelConversationAutomatic') : t('workspaceMenu.newIn', { name: newProject ? getProjectDisplayText(newProject, t).name : '' })}
              onClick={() => { if (newProject) { onClose(); onNewConversation(newProject.id) } }}>
              <Plus size={14} aria-hidden="true" />{t('workspaceMenu.newConversation')}
            </button>
          </div>
          {newProject?.kind === 'channel' && <small className="workspace-menu__channel-note">{tApp('notices.channelConversationAutomatic')}</small>}
          <div className="workspace-menu__conversations" ref={conversationListRef} role="list" aria-label={t('workspaceMenu.conversations')}
            onScroll={conversationWindow.onScroll} onFocus={conversationWindow.onFocus} onBlur={conversationWindow.onBlur}
            onKeyDown={(event) => moveFocus(event, 'conversations')}>
            {conversationWindow.segments.map((segment) => {
              if (segment.kind === 'spacer') return <div key={segment.key} data-list-window-spacer aria-hidden="true" style={{ height: segment.height }} />
              const row = rows[segment.index]!
              const project = projectById.get(row.projectId ?? '')
              return <div key={row.id} data-list-window-row={row.id} ref={conversationWindow.rowRef(row.id)} role="listitem"
                aria-posinset={segment.index + 1} aria-setsize={rows.length}>
                {(segment.index === 0 || rows[segment.index - 1]?.group !== row.group) &&
                  <h3 className="workspace-menu__category">{t(`workspaceMenu.groups.${row.group}`)}</h3>}
                <button type="button" className="workspace-menu__conversation" onClick={() => { onClose(); onOpenConversation(row.id) }}>
                  <span><strong>{row.title}</strong>{scope === null && <>{' '}<small>{project ? getProjectDisplayText(project, t).name : t('projectActivity.unassigned')}</small></>}</span>{' '}
                  <span className="workspace-menu__metadata">
                    <WorkspaceConversationTime store={conversationStore} id={row.id} />{' '}
                    {row.status && <small className={`project-activity__${row.status === 'running' || row.status === 'completed' ? row.status : 'attention'}`}>{t(`projectActivity.status.${row.status}`)}</small>}
                  </span>
                </button>
              </div>
            })}
            {!rows.length && <p className="workspace-menu__empty">{t('workspaceMenu.noConversations')}</p>}
          </div>
          <footer className="workspace-menu__footer workspace-menu__enter">
            <button type="button" className="primary-button" disabled={!newProject}
              title={t('workspaceMenu.enterNamed', { name: newProject ? getProjectDisplayText(newProject, t).name : '' })}
              aria-label={t('workspaceMenu.enterNamed', { name: newProject ? getProjectDisplayText(newProject, t).name : '' })}
              onClick={() => { if (newProject) { onEnterProject(newProject.id); onClose() } }}>
              {t('workspaceMenu.enter')}<ArrowRight size={15} aria-hidden="true" />
            </button>
          </footer>
        </section>
      </div>
    </div>
  </FloatingPortal>
}
