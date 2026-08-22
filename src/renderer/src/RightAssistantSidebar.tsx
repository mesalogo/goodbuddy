import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileText,
  FolderTree,
  ClockFading,
  Monitor,
  Plus,
  RefreshCw,
  ShieldAlert,
  Upload
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantSchedule,
  AssistantTask,
  WorkspaceChanges,
  WorkspaceDirectoryListing,
  WorkspaceFilePreview
} from '../../shared/assistant-contracts'
import { MarkdownRenderer } from './MarkdownRenderer'
import type {
  ApprovalDecision,
  BrowserLiveState
} from '../../shared/contracts'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'
import { SegmentedControl } from './WorkspacePrimitives'
import {
  findTaskSchedule,
  TaskScheduleActions
} from './TaskScheduleActions'

export type AssistantSidebarTab =
  | 'tasks'
  | 'workspace'
  | 'browser'
  | 'results'

export type SidebarArtifact = {
  id: string
  title: string
  content: string
  createdAt: number
  mimeType: string
}

export type PendingSidebarApproval = {
  conversationId: string
  messageId: string
  approvalId: string
  title: string
  description: string
  toolName?: string
}

type RightAssistantSidebarProps = {
  open: boolean
  tab: AssistantSidebarTab
  approvals: PendingSidebarApproval[]
  artifacts: SidebarArtifact[]
  schedules: AssistantSchedule[]
  tasks: AssistantTask[]
  conversationTitles: ReadonlyMap<string, string>
  projectNames: ReadonlyMap<string, string>
  selectedTaskId?: string
  workspaceChanges?: WorkspaceChanges
  workspaceProjectId?: string
  browserState?: BrowserLiveState
  restoreFocusRef?: { current: HTMLElement | null }
  onInteractBrowser: () => Promise<void>
  onStopBrowser: () => Promise<void>
  onCreateCustomTask: () => void
  onImportArtifacts: () => Promise<void>
  onLoadArtifact: (artifactId: string) => Promise<void>
  onRefreshChanges: () => Promise<void>
  onListWorkspaceDirectory: (
    path: string
  ) => Promise<WorkspaceDirectoryListing>
  onLoadWorkspaceFile: (path: string) => Promise<WorkspaceFilePreview>
  onOpenWorkspaceEntry: (
    path: string,
    type: 'file' | 'directory'
  ) => Promise<void>
  onRemoveSchedule: (scheduleId: string) => Promise<void>
  onRespondApproval: (
    approval: PendingSidebarApproval,
    decision: ApprovalDecision
  ) => void
  onRunSchedule: (scheduleId: string) => Promise<void>
  onSetScheduleEnabled: (
    scheduleId: string,
    enabled: boolean
  ) => Promise<void>
  onOpenTask: (task: AssistantTask) => void
  onTabChange: (tab: AssistantSidebarTab) => void
}

const tabIds: AssistantSidebarTab[] = [
  'tasks',
  'workspace',
  'browser',
  'results'
]
const emptyChangedFiles: WorkspaceChanges['files'] = []
const defaultSidebarRatio = 0.3
const minimumPaneWidth = 300
const keyboardResizeStep = 16

function getSidebarWidthLimits(layoutWidth: number): {
  minimum: number
  maximum: number
} {
  const boundedLayoutWidth = Math.max(0, Math.floor(layoutWidth))
  const minimum = Math.min(
    minimumPaneWidth,
    Math.floor(boundedLayoutWidth / 2)
  )
  return {
    minimum,
    maximum: Math.max(minimum, boundedLayoutWidth - minimum)
  }
}

function clampSidebarWidth(width: number, layoutWidth: number): number {
  const limits = getSidebarWidthLimits(layoutWidth)
  return Math.min(limits.maximum, Math.max(limits.minimum, width))
}

function findWorkspaceSibling(
  sidebar: HTMLElement | null
): HTMLElement | undefined {
  const parent = sidebar?.parentElement
  if (!parent) {
    return undefined
  }
  return Array.from(parent.children).find(
    (element): element is HTMLElement =>
      element instanceof HTMLElement &&
      element.classList.contains('workspace')
  )
}

function measureSplitLayoutWidth(
  sidebar: HTMLElement | null,
  fallbackWidth: number
): number {
  const workspace = findWorkspaceSibling(sidebar)
  if (!sidebar || !workspace) {
    return fallbackWidth
  }
  const measuredWidth =
    workspace.getBoundingClientRect().width +
    sidebar.getBoundingClientRect().width
  return measuredWidth > 0 ? measuredWidth : fallbackWidth
}

export function RightAssistantSidebar({
  open,
  tab,
  approvals,
  artifacts,
  schedules,
  tasks,
  conversationTitles,
  projectNames,
  selectedTaskId,
  workspaceChanges,
  workspaceProjectId,
  browserState,
  restoreFocusRef,
  onInteractBrowser,
  onStopBrowser,
  onCreateCustomTask,
  onImportArtifacts,
  onLoadArtifact,
  onRefreshChanges,
  onListWorkspaceDirectory,
  onLoadWorkspaceFile,
  onOpenWorkspaceEntry,
  onRemoveSchedule,
  onRespondApproval,
  onRunSchedule,
  onSetScheduleEnabled,
  onOpenTask,
  onTabChange
}: RightAssistantSidebarProps): React.JSX.Element {
  const { i18n, t } = useTranslation('workspace')
  const locale = i18n.resolvedLanguage || 'zh-CN'
  const sidebarTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit'
      }),
    [locale]
  )
  const tabs = useMemo(
    () =>
      tabIds.map((id) => ({
        id,
        label: t(`sidebar.tabs.${id}.label`),
        description: t(`sidebar.tabs.${id}.description`)
      })),
    [t]
  )
  const [splitLayoutWidth, setSplitLayoutWidth] = useState(
    window.innerWidth
  )
  const [sidebarRatio, setSidebarRatio] = useState(defaultSidebarRatio)
  const [isResizing, setIsResizing] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const wasOpen = useRef(false)
  const sidebarWidth = clampSidebarWidth(
    splitLayoutWidth * sidebarRatio,
    splitLayoutWidth
  )
  const liveSidebarWidth = useRef(sidebarWidth)
  const resizePointerId = useRef<number | undefined>(undefined)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>()
  const [workspacePreview, setWorkspacePreview] = useState<
    | {
        projectId?: string
        path: string
        state: 'loading'
        error?: undefined
        file?: undefined
      }
    | {
        projectId?: string
        path: string
        state: 'error'
        error: string
        file?: undefined
      }
    | {
        projectId?: string
        path: string
        state: 'ready'
        error?: undefined
        file: WorkspaceFilePreview
      }
  >()
  const workspacePreviewRequest = useRef(0)
  const [workspaceRefreshVersion, setWorkspaceRefreshVersion] = useState(0)
  const [taskFilter, setTaskFilter] = useState<
    'attention' | 'active' | 'paused' | 'finished'
  >('active')
  const [actionError, setActionError] = useState('')
  const artifactPreview =
    artifacts.find((artifact) => artifact.id === selectedArtifactId)
  const currentWorkspacePreview =
    workspacePreview?.projectId === workspaceProjectId
      ? workspacePreview
      : undefined
  const sidebarWidthLimits = getSidebarWidthLimits(splitLayoutWidth)
  const canResize =
    open &&
    sidebarWidthLimits.maximum > sidebarWidthLimits.minimum
  const topLevelTasks = useMemo(
    () => tasks.filter((task) => !task.parentTaskId),
    [tasks]
  )
  const filteredTasks = useMemo(
    () =>
      topLevelTasks.filter((task) => {
        if (taskFilter === 'attention') {
          return (
            task.status === 'waiting_approval' ||
            task.status === 'failed' ||
            task.status === 'interrupted'
          )
        }
        if (taskFilter === 'active') {
          return (
            task.status === 'idle' ||
            task.status === 'queued' ||
            task.status === 'running'
          )
        }
        if (taskFilter === 'paused') {
          return task.status === 'paused'
        }
        return task.status === 'completed' || task.status === 'cancelled'
      }),
    [taskFilter, topLevelTasks]
  )

  useEffect(() => {
    const sidebar = sidebarRef.current
    const workspace = findWorkspaceSibling(sidebar)
    const handleLayoutResize = (): void => {
      const width = measureSplitLayoutWidth(
        sidebar,
        window.innerWidth
      )
      setSplitLayoutWidth((currentWidth) =>
        Math.abs(currentWidth - width) >= 0.5
          ? width
          : currentWidth
      )
    }

    handleLayoutResize()
    window.addEventListener('resize', handleLayoutResize)
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(handleLayoutResize)
    if (resizeObserver && workspace && sidebar) {
      resizeObserver.observe(workspace)
      resizeObserver.observe(sidebar)
    }
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', handleLayoutResize)
    }
  }, [])

  useEffect(() => {
    if (!isResizing) {
      liveSidebarWidth.current = sidebarWidth
    }
  }, [isResizing, sidebarWidth])

  useEffect(() => {
    if (!open && wasOpen.current) {
      requestAnimationFrame(() => restoreFocusRef?.current?.focus())
    }
    wasOpen.current = open
  }, [open, restoreFocusRef])

  const resizeFromClientX = (
    clientX: number,
    commit: boolean
  ): void => {
    const layoutWidth = measureSplitLayoutWidth(
      sidebarRef.current,
      splitLayoutWidth
    )
    if (Math.abs(splitLayoutWidth - layoutWidth) >= 0.5) {
      setSplitLayoutWidth(layoutWidth)
    }
    const sidebarBounds = sidebarRef.current?.getBoundingClientRect()
    const layoutRight =
      sidebarBounds && sidebarBounds.width > 0
        ? sidebarBounds.right
        : window.innerWidth
    const width = clampSidebarWidth(
      layoutRight - clientX,
      layoutWidth
    )
    liveSidebarWidth.current = width
    if (commit) {
      setSidebarRatio(
        layoutWidth > 0 ? width / layoutWidth : defaultSidebarRatio
      )
      return
    }
    sidebarRef.current?.style.setProperty(
      '--assistant-sidebar-width',
      `${width}px`
    )
  }

  const finishResize = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (resizePointerId.current !== event.pointerId) {
      return
    }
    resizePointerId.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const layoutWidth = measureSplitLayoutWidth(
      sidebarRef.current,
      splitLayoutWidth
    )
    setSidebarRatio(
      layoutWidth > 0
        ? liveSidebarWidth.current / layoutWidth
        : defaultSidebarRatio
    )
    setIsResizing(false)
  }

  const resizeWithKeyboard = (
    event: React.KeyboardEvent<HTMLDivElement>
  ): void => {
    if (!canResize) {
      return
    }
    const layoutWidth = measureSplitLayoutWidth(
      sidebarRef.current,
      splitLayoutWidth
    )
    if (Math.abs(splitLayoutWidth - layoutWidth) >= 0.5) {
      setSplitLayoutWidth(layoutWidth)
    }
    const limits = getSidebarWidthLimits(layoutWidth)
    const nextWidth =
      event.key === 'Home'
        ? limits.minimum
        : event.key === 'End'
          ? limits.maximum
          : event.key === 'ArrowLeft'
            ? sidebarWidth + keyboardResizeStep
            : event.key === 'ArrowRight'
              ? sidebarWidth - keyboardResizeStep
              : undefined

    if (nextWidth === undefined) {
      return
    }
    event.preventDefault()
    const width = clampSidebarWidth(nextWidth, layoutWidth)
    setSidebarRatio(
      layoutWidth > 0 ? width / layoutWidth : defaultSidebarRatio
    )
  }

  const openWorkspaceFile = (path: string): void => {
    const requestId = workspacePreviewRequest.current + 1
    workspacePreviewRequest.current = requestId
    const projectId = workspaceProjectId
    setWorkspacePreview({ projectId, path, state: 'loading' })
    setActionError('')
    void onLoadWorkspaceFile(path)
      .then((file) => {
        if (workspacePreviewRequest.current === requestId) {
          setWorkspacePreview({
            projectId,
            path,
            state: 'ready',
            file
          })
          setSelectedArtifactId(undefined)
        }
      })
      .catch((reason: unknown) => {
        if (workspacePreviewRequest.current === requestId) {
          setWorkspacePreview({
            path,
            projectId,
            state: 'error',
            error:
              reason instanceof Error
                ? reason.message
                : t('sidebar.errors.workspacePreview')
          })
        }
      })
  }

  const runAction = (
    action: () => Promise<void>,
    fallback: string,
    onSuccess?: () => void
  ): void => {
    setActionError('')
    void action()
      .then(onSuccess)
      .catch((reason: unknown) => {
        setActionError(
          reason instanceof Error ? reason.message : fallback
        )
      })
  }

  const moveTabFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tabId: AssistantSidebarTab
  ): void => {
    const index = tabs.findIndex((item) => item.id === tabId)
    const targetIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowLeft'
            ? (index - 1 + tabs.length) % tabs.length
            : event.key === 'ArrowRight'
              ? (index + 1) % tabs.length
              : -1
    if (targetIndex < 0) {
      return
    }
    event.preventDefault()
    const target = tabs[targetIndex]
    if (!target) {
      return
    }
    setActionError('')
    onTabChange(target.id)
    requestAnimationFrame(() => {
      document.getElementById(`assistant-sidebar-tab-${target.id}`)?.focus()
    })
  }

  return (
    <aside
      ref={sidebarRef}
      aria-label={t('sidebar.ariaLabel')}
      aria-hidden={!open}
      className={
        open
          ? `assistant-sidebar assistant-sidebar--open${isResizing && canResize ? ' assistant-sidebar--resizing' : ''}`
          : 'assistant-sidebar'
      }
      id="assistant-sidebar"
      inert={!open}
      role="complementary"
      style={
        {
          '--assistant-sidebar-width': `${Math.round(sidebarWidth)}px`
        } as React.CSSProperties
      }
    >
      <div
        aria-controls="assistant-sidebar-panel"
        aria-label={t('sidebar.resizeAriaLabel')}
        aria-orientation="vertical"
        aria-valuemax={Math.round(sidebarWidthLimits.maximum)}
        aria-valuemin={Math.round(sidebarWidthLimits.minimum)}
        aria-valuenow={Math.round(sidebarWidth)}
        aria-valuetext={t('sidebar.resizeValue', {
          width: Math.round(sidebarWidth)
        })}
        aria-disabled={!canResize}
        className="assistant-sidebar__resize-handle"
        onKeyDown={resizeWithKeyboard}
        onLostPointerCapture={(event) => {
          if (resizePointerId.current === event.pointerId) {
            resizePointerId.current = undefined
            const layoutWidth = measureSplitLayoutWidth(
              sidebarRef.current,
              splitLayoutWidth
            )
            setSidebarRatio(
              layoutWidth > 0
                ? liveSidebarWidth.current / layoutWidth
                : defaultSidebarRatio
            )
            setIsResizing(false)
          }
        }}
        onPointerCancel={finishResize}
        onPointerDown={(event) => {
          if (event.button !== 0 || !canResize) {
            return
          }
          event.preventDefault()
          resizePointerId.current = event.pointerId
          event.currentTarget.setPointerCapture(event.pointerId)
          resizeFromClientX(event.clientX, true)
          setIsResizing(true)
        }}
        onPointerMove={(event) => {
          if (resizePointerId.current !== event.pointerId) {
            return
          }
          if (!canResize) {
            finishResize(event)
            return
          }
          event.preventDefault()
          resizeFromClientX(event.clientX, false)
        }}
        onPointerUp={finishResize}
        role="separator"
        tabIndex={canResize ? 0 : -1}
      />
      <nav
        aria-label={t('sidebar.categoriesAriaLabel')}
        className="assistant-sidebar__tabs"
        role="tablist"
      >
        {tabs.map((item) => (
          <button
            aria-controls="assistant-sidebar-panel"
            aria-selected={tab === item.id}
            className={
              tab === item.id
                ? 'assistant-sidebar__tab assistant-sidebar__tab--active'
                : 'assistant-sidebar__tab'
            }
            id={`assistant-sidebar-tab-${item.id}`}
            key={item.id}
            onClick={() => {
              setActionError('')
              onTabChange(item.id)
            }}
            onKeyDown={(event) => moveTabFocus(event, item.id)}
            role="tab"
            tabIndex={tab === item.id ? 0 : -1}
            title={item.description}
            type="button"
          >
            {item.label}
            {item.id === 'tasks' && approvals.length > 0 && (
              <span className="assistant-sidebar__badge">
                {approvals.length}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div
        aria-labelledby={`assistant-sidebar-tab-${tab}`}
        className="assistant-sidebar__body"
        id="assistant-sidebar-panel"
        role="tabpanel"
      >
        {actionError ? (
          <p className="settings-error" role="alert">
            {actionError}
          </p>
        ) : null}
        {tab === 'tasks' && (
          <section className="assistant-sidebar__section">
            <p className="assistant-sidebar__section-description">
              {t('sidebar.tasks.description')}
            </p>
            <h3>
              <ShieldAlert size={15} />
              {t('sidebar.tasks.approvalsTitle')}
            </h3>
            {approvals.length === 0 ? (
              <p className="assistant-sidebar__empty">
                {t('sidebar.tasks.noApprovals')}
              </p>
            ) : (
              approvals.map((approval) => (
                <article
                  className="assistant-sidebar__approval"
                  key={approval.approvalId}
                >
                  <strong>{approval.title}</strong>
                  <p>{approval.description}</p>
                  {approval.toolName && <code>{approval.toolName}</code>}
                  <div className="assistant-sidebar__approval-actions">
                    <button
                      className="secondary-button"
                      onClick={() =>
                        onRespondApproval(approval, 'deny')
                      }
                      type="button"
                    >
                      {t('sidebar.tasks.deny')}
                    </button>
                    <button
                      className="primary-button"
                      onClick={() =>
                        onRespondApproval(approval, 'once')
                      }
                      type="button"
                    >
                      {t('sidebar.tasks.allowOnce')}
                    </button>
                  </div>
                </article>
              ))
            )}

            <div className="task-center__index-heading">
              <h3>
                <ClockFading size={15} />
                {t('sidebar.tasks.taskIndexTitle')}
              </h3>
              <button
                className="secondary-button task-center__create"
                onClick={onCreateCustomTask}
                type="button"
              >
                <Plus aria-hidden="true" size={13} />
                {t('taskStrip.create')}
              </button>
            </div>
            <div className="task-center__filters">
              <SegmentedControl
                ariaLabel={t('sidebar.tasks.filters.ariaLabel')}
                onChange={setTaskFilter}
                options={[
                  {
                    value: 'attention',
                    label: t('sidebar.tasks.filters.attention')
                  },
                  {
                    value: 'active',
                    label: t('sidebar.tasks.filters.active')
                  },
                  {
                    value: 'paused',
                    label: t('sidebar.tasks.filters.paused')
                  },
                  {
                    value: 'finished',
                    label: t('sidebar.tasks.filters.finished')
                  }
                ]}
                value={taskFilter}
              />
            </div>
            {filteredTasks.length === 0 ? (
              <p className="assistant-sidebar__empty">
                {topLevelTasks.length === 0
                  ? t('sidebar.tasks.empty')
                  : t('sidebar.tasks.noFilterResults')}
              </p>
            ) : (
              filteredTasks.map((task) => {
                const schedule = findTaskSchedule(task, schedules)
                const conversationTitle = task.conversationId
                  ? conversationTitles.get(task.conversationId)
                  : undefined
                const projectName = task.projectId
                  ? projectNames.get(task.projectId)
                  : undefined
                return (
                  <article
                    className={
                      selectedTaskId === task.id
                        ? 'task-center__item task-center__item--selected'
                        : 'task-center__item'
                    }
                    key={task.id}
                  >
                    <button
                      className="task-center__item-main"
                      onClick={() => onOpenTask(task)}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className={`task-status-dot task-status-dot--${task.status}`}
                      />
                      <span>
                        <strong>{task.title}</strong>
                        <small>
                          {conversationTitle ??
                            t('sidebar.tasks.conversationUnavailable')}
                        </small>
                      </span>
                      {task.status === 'failed' ? (
                        <CircleAlert aria-hidden="true" size={14} />
                      ) : (
                        <ChevronRight aria-hidden="true" size={14} />
                      )}
                    </button>
                    <div className="task-center__metadata">
                      <span>
                        {projectName
                          ? t('sidebar.tasks.projectScope', {
                              project: projectName
                            })
                          : t('sidebar.tasks.globalScope')}
                      </span>
                      <span>
                        {schedule
                          ? t(`task.mode.${schedule.workMode}`)
                          : task.workMode
                            ? t(`task.mode.${task.workMode}`)
                            : t('task.mode.unavailable')}
                      </span>
                      <span>{t(`task.status.${task.status}`)}</span>
                    </div>
                    <p>
                      {task.error ??
                        (task.completedAt
                          ? t('task.completedAt', {
                              time: new Date(
                                task.completedAt
                              ).toLocaleString(locale)
                            })
                          : task.startedAt
                            ? t('sidebar.tasks.startedAt', {
                                time: new Date(
                                  task.startedAt
                                ).toLocaleString(locale)
                              })
                            : schedule
                              ? t('sidebar.tasks.nextRunAt', {
                                  time: new Date(
                                    schedule.nextRunAt
                                  ).toLocaleString(locale)
                                })
                              : t('sidebar.tasks.notStarted'))}
                    </p>
                    {schedule && (
                      <div className="task-center__actions">
                        <TaskScheduleActions
                          onError={setActionError}
                          onRemoveSchedule={onRemoveSchedule}
                          onRunSchedule={onRunSchedule}
                          onSetScheduleEnabled={onSetScheduleEnabled}
                          schedule={schedule}
                          taskTitle={task.title}
                        />
                      </div>
                    )}
                  </article>
                )
              })
            )}
          </section>
        )}

        {tab === 'workspace' && (
          currentWorkspacePreview ? (
            <section className="assistant-sidebar__preview">
              <header>
                <button
                  aria-label={t('sidebar.workspace.back')}
                  className="assistant-sidebar__back"
                  onClick={() => {
                    workspacePreviewRequest.current += 1
                    setWorkspacePreview(undefined)
                    setActionError('')
                  }}
                  type="button"
                >
                  <ChevronLeft size={14} />
                  {t('sidebar.workspace.title')}
                </button>
                <span>
                  <strong>{currentWorkspacePreview.path}</strong>
                  <small>
                    {currentWorkspacePreview.state === 'ready'
                      ? t('sidebar.workspace.fileSize', {
                          formattedSize:
                            currentWorkspacePreview.file.size.toLocaleString(
                              locale
                            )
                        })
                      : t('sidebar.workspace.fileFallback')}
                  </small>
                </span>
              </header>
              {currentWorkspacePreview.state === 'loading' ? (
                <p className="assistant-sidebar__empty">
                  {t('sidebar.workspace.reading')}
                </p>
              ) : currentWorkspacePreview.state === 'error' ? (
                <p className="assistant-sidebar__empty" role="alert">
                  {currentWorkspacePreview.error}
                </p>
              ) : (
                <div className="markdown-body markdown-content">
                  {currentWorkspacePreview.file.mimeType ===
                  'text/markdown' ? (
                    <MarkdownRenderer>
                      {currentWorkspacePreview.file.content}
                    </MarkdownRenderer>
                  ) : (
                    <pre>{currentWorkspacePreview.file.content}</pre>
                  )}
                </div>
              )}
            </section>
          ) : (
            <section className="assistant-sidebar__section">
              <p className="assistant-sidebar__section-description">
                {t('sidebar.workspace.description')}
              </p>
              <h3>
                <FolderTree size={15} />
                {t('sidebar.workspace.projectTitle')}
                <button
                  aria-label={t('sidebar.workspace.refreshAriaLabel')}
                  className="icon-button"
                  disabled={!workspaceProjectId}
                  onClick={() => {
                    setWorkspaceRefreshVersion((current) => current + 1)
                    runAction(
                      onRefreshChanges,
                      t('sidebar.errors.refreshWorkspace')
                    )
                  }}
                  title={t('sidebar.workspace.refresh')}
                  type="button"
                >
                  <RefreshCw size={14} />
                </button>
              </h3>
              <WorkspaceFilesPanel
                changedFiles={workspaceChanges?.files ?? emptyChangedFiles}
                key={`${workspaceProjectId ?? 'none'}:${workspaceRefreshVersion}`}
                onListDirectory={onListWorkspaceDirectory}
                onOpenEntry={onOpenWorkspaceEntry}
                onOpenFile={openWorkspaceFile}
                projectId={workspaceProjectId}
              />
              {workspaceChanges?.error && (
                <p className="workspace-files__status">
                  {t('sidebar.workspace.gitUnavailable', {
                    error: workspaceChanges.error
                  })}
                </p>
              )}
              {workspaceChanges?.patch && (
                <details className="assistant-sidebar__diff-details">
                  <summary>{t('sidebar.workspace.fullDiff')}</summary>
                  <pre className="assistant-sidebar__diff">
                    {workspaceChanges.patch}
                    {workspaceChanges.truncated
                      ? t('sidebar.workspace.truncatedDiff')
                      : ''}
                  </pre>
                </details>
              )}
            </section>
          )
        )}

        {tab === 'results' && (
          artifactPreview ? (
            <section className="assistant-sidebar__preview">
              <header>
                <button
                  aria-label={t('sidebar.results.back')}
                  className="assistant-sidebar__back"
                  onClick={() => {
                    setSelectedArtifactId(undefined)
                    setActionError('')
                  }}
                  type="button"
                >
                  <ChevronLeft size={14} />
                  {t('sidebar.results.title')}
                </button>
                <span>
                  <strong>{artifactPreview.title}</strong>
                  <small>
                    {sidebarTimeFormatter.format(
                      new Date(artifactPreview.createdAt)
                    )}
                  </small>
                </span>
              </header>
              <div className="markdown-body markdown-content">
                {artifactPreview.mimeType.startsWith('image/') ? (
                  artifactPreview.content ? (
                    <img
                      alt={artifactPreview.title}
                      className="assistant-sidebar__image-preview"
                      src={artifactPreview.content}
                    />
                  ) : (
                    <p className="assistant-sidebar__empty">
                      {t('sidebar.results.loadingImage')}
                    </p>
                  )
                ) : artifactPreview.mimeType === 'text/html' ? (
                  <iframe
                    className="assistant-sidebar__web-preview"
                    sandbox=""
                    srcDoc={artifactPreview.content}
                    title={artifactPreview.title}
                  />
                ) : artifactPreview.mimeType === 'application/json' ? (
                  <pre>{artifactPreview.content}</pre>
                ) : (
                  <MarkdownRenderer>
                    {artifactPreview.content}
                  </MarkdownRenderer>
                )}
              </div>
            </section>
          ) : (
            <section className="assistant-sidebar__section">
              <p className="assistant-sidebar__section-description">
                {t('sidebar.results.description')}
              </p>
              <h3>
                <FileText size={15} />
                {t('sidebar.results.sectionTitle')}
              </h3>
              <button
                className="secondary-button assistant-sidebar__import"
                onClick={() =>
                  runAction(
                    onImportArtifacts,
                    t('sidebar.errors.importResult')
                  )
                }
                type="button"
              >
                <Upload size={13} />
                {t('sidebar.results.import')}
              </button>
              {artifacts.length === 0 ? (
                <p className="assistant-sidebar__empty">
                  {t('sidebar.results.empty')}
                </p>
              ) : (
                artifacts.map((artifact) => (
                  <button
                    className="assistant-sidebar__row"
                    key={artifact.id}
                    onClick={() => {
                      setSelectedArtifactId(artifact.id)
                      setActionError('')
                      runAction(
                        () => onLoadArtifact(artifact.id),
                        t('sidebar.errors.loadResult')
                      )
                    }}
                    type="button"
                  >
                    <FileText size={15} />
                    <span>
                      <strong>{artifact.title}</strong>
                      <small>
                        {sidebarTimeFormatter.format(
                          new Date(artifact.createdAt)
                        )}
                      </small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))
              )}
            </section>
          )
        )}

        {tab === 'browser' && (
          <section className="assistant-sidebar__browser">
            <header>
              <span>
                <Monitor size={15} />
                <strong>{t('sidebar.browser.title')}</strong>
              </span>
              {browserState &&
                browserState.status !== 'stopped' && (
                  <div className="assistant-sidebar__browser-actions">
                    <button
                      className="secondary-button"
                      disabled={
                        browserState.status === 'creating' ||
                        browserState.status === 'interactive'
                      }
                      onClick={() =>
                        runAction(
                          onInteractBrowser,
                          t('sidebar.errors.interactBrowser')
                        )
                      }
                      type="button"
                    >
                      <ExternalLink aria-hidden="true" size={12} />
                      {browserState.status === 'interactive'
                        ? t('sidebar.browser.interacting')
                        : t('sidebar.browser.interact')}
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        runAction(
                          onStopBrowser,
                          t('sidebar.errors.stopBrowser')
                        )
                      }
                      type="button"
                    >
                      {t('sidebar.browser.stop')}
                    </button>
                  </div>
                )}
            </header>
            {!browserState ? (
              <p className="assistant-sidebar__empty">
                {t('sidebar.browser.empty')}
              </p>
            ) : (
              <>
                <div
                  aria-live="polite"
                  className={`assistant-sidebar__browser-status assistant-sidebar__browser-status--${browserState.status}`}
                  role="status"
                >
                  {browserState.status === 'creating'
                    ? t('sidebar.browser.statuses.creating')
                    : browserState.status === 'loading'
                      ? t('sidebar.browser.statuses.loading')
                      : browserState.status === 'acting'
                        ? t('sidebar.browser.statuses.acting')
                        : browserState.status === 'interactive'
                          ? t(
                              'sidebar.browser.statuses.interactive'
                            )
                        : browserState.status === 'ready'
                          ? t('sidebar.browser.statuses.ready')
                          : browserState.status === 'failed'
                            ? browserState.error ??
                              t('sidebar.browser.statuses.failed')
                            : t('sidebar.browser.statuses.stopped')}
                </div>
                {browserState.url && (
                  <div
                    className="assistant-sidebar__browser-url"
                    title={browserState.url}
                  >
                    {browserState.url}
                  </div>
                )}
                {browserState.frameDataUrl ? (
                  <img
                    alt={t('sidebar.browser.frameAlt')}
                    className="assistant-sidebar__browser-frame"
                    src={browserState.frameDataUrl}
                  />
                ) : (
                  <div className="assistant-sidebar__browser-placeholder">
                    <Monitor size={28} />
                    <span>
                      {browserState.status === 'failed'
                        ? t('sidebar.browser.noFrame')
                        : t('sidebar.browser.waitingFrame')}
                    </span>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}
