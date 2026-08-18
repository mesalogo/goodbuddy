import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderTree,
  Hourglass,
  Monitor,
  PanelRightClose,
  RefreshCw,
  ShieldAlert,
  Upload,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantMemory,
  AssistantSchedule,
  ScheduleCreateInput,
  WorkspaceChanges,
  WorkspaceDirectoryListing,
  WorkspaceFilePreview
} from '../../shared/assistant-contracts'
import { MarkdownRenderer } from './MarkdownRenderer'
import type {
  ApprovalDecision,
  BrowserLiveState,
  ContextAttachment,
  KnowledgeLibrary
} from '../../shared/contracts'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'

export type AssistantSidebarTab =
  | 'tasks'
  | 'context'
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
  attachments: ContextAttachment[]
  enabledLibraries: KnowledgeLibrary[]
  memories: AssistantMemory[]
  schedules: AssistantSchedule[]
  workspaceChanges?: WorkspaceChanges
  workspaceProjectId?: string
  browserState?: BrowserLiveState
  onClose: () => void
  onInteractBrowser: () => Promise<void>
  onStopBrowser: () => Promise<void>
  onCreateSchedule: (input: ScheduleCreateInput) => Promise<void>
  onImportArtifacts: () => Promise<void>
  onLoadArtifact: (artifactId: string) => Promise<void>
  onRemoveAttachment: (attachmentId: string) => void
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
  onTabChange: (tab: AssistantSidebarTab) => void
}

const tabIds: AssistantSidebarTab[] = [
  'tasks',
  'context',
  'workspace',
  'browser',
  'results'
]
const emptyChangedFiles: WorkspaceChanges['files'] = []
const defaultSidebarWidth = 350
const minimumSidebarWidth = 300
const minimumRemainingAppWidth = 520
const compactSidebarBreakpoint = 720
const keyboardResizeStep = 16
function getSidebarWidthLimits(viewportWidth: number): {
  minimum: number
  maximum: number
} {
  return {
    minimum: minimumSidebarWidth,
    maximum: Math.max(
      minimumSidebarWidth,
      viewportWidth - minimumRemainingAppWidth
    )
  }
}

function clampSidebarWidth(width: number, viewportWidth: number): number {
  const limits = getSidebarWidthLimits(viewportWidth)
  return Math.min(limits.maximum, Math.max(limits.minimum, width))
}

export function RightAssistantSidebar({
  open,
  tab,
  approvals,
  artifacts,
  attachments,
  enabledLibraries,
  memories,
  schedules,
  workspaceChanges,
  workspaceProjectId,
  browserState,
  onClose,
  onInteractBrowser,
  onStopBrowser,
  onCreateSchedule,
  onImportArtifacts,
  onLoadArtifact,
  onRemoveAttachment,
  onRefreshChanges,
  onListWorkspaceDirectory,
  onLoadWorkspaceFile,
  onOpenWorkspaceEntry,
  onRemoveSchedule,
  onRespondApproval,
  onRunSchedule,
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
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
  const [sidebarWidth, setSidebarWidth] = useState(defaultSidebarWidth)
  const [isResizing, setIsResizing] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const liveSidebarWidth = useRef(defaultSidebarWidth)
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
  const [scheduleTitle, setScheduleTitle] = useState('')
  const [schedulePrompt, setSchedulePrompt] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [scheduleRecurrence, setScheduleRecurrence] = useState<
    ScheduleCreateInput['recurrence']
  >('once')
  const [actionError, setActionError] = useState('')
  const activeMemories = memories.filter(
    (memory) => memory.status === 'confirmed'
  )
  const artifactPreview =
    artifacts.find((artifact) => artifact.id === selectedArtifactId)
  const currentWorkspacePreview =
    workspacePreview?.projectId === workspaceProjectId
      ? workspacePreview
      : undefined
  const sidebarWidthLimits = getSidebarWidthLimits(viewportWidth)
  const canResize =
    open && viewportWidth >= compactSidebarBreakpoint

  useEffect(() => {
    const handleViewportResize = (): void => {
      setViewportWidth(window.innerWidth)
      setSidebarWidth((currentWidth) => {
        const width = clampSidebarWidth(
          currentWidth,
          window.innerWidth
        )
        liveSidebarWidth.current = width
        return width
      })
    }

    window.addEventListener('resize', handleViewportResize)
    return () => window.removeEventListener('resize', handleViewportResize)
  }, [])

  const resizeFromClientX = (
    clientX: number,
    commit: boolean
  ): void => {
    const width = clampSidebarWidth(
      window.innerWidth - clientX,
      window.innerWidth
    )
    liveSidebarWidth.current = width
    if (commit) {
      setSidebarWidth(width)
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
    setSidebarWidth(liveSidebarWidth.current)
    setIsResizing(false)
  }

  const resizeWithKeyboard = (
    event: React.KeyboardEvent<HTMLDivElement>
  ): void => {
    if (!canResize) {
      return
    }
    const limits = getSidebarWidthLimits(window.innerWidth)
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
    setSidebarWidth(
      clampSidebarWidth(nextWidth, window.innerWidth)
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
      inert={!open}
      style={
        {
          '--assistant-sidebar-width': `${sidebarWidth}px`
        } as React.CSSProperties
      }
    >
      <div
        aria-controls="assistant-sidebar-panel"
        aria-label={t('sidebar.resizeAriaLabel')}
        aria-orientation="vertical"
        aria-valuemax={sidebarWidthLimits.maximum}
        aria-valuemin={sidebarWidthLimits.minimum}
        aria-valuenow={sidebarWidth}
        aria-valuetext={t('sidebar.resizeValue', {
          width: sidebarWidth
        })}
        aria-disabled={!canResize}
        className="assistant-sidebar__resize-handle"
        onKeyDown={resizeWithKeyboard}
        onLostPointerCapture={(event) => {
          if (resizePointerId.current === event.pointerId) {
            resizePointerId.current = undefined
            setSidebarWidth(liveSidebarWidth.current)
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
      <header className="assistant-sidebar__header">
        <strong>{t('sidebar.title')}</strong>
        <button
          aria-label={t('sidebar.close')}
          className="icon-button"
          onClick={onClose}
          type="button"
        >
          <PanelRightClose size={17} />
        </button>
      </header>

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

            <h3>
              <Hourglass size={15} />
              {t('sidebar.tasks.automationTitle')}
            </h3>
            <div className="assistant-sidebar__schedule-form">
              <input
                aria-label={t(
                  'sidebar.tasks.schedule.titleAriaLabel'
                )}
                maxLength={120}
                onChange={(event) => setScheduleTitle(event.target.value)}
                placeholder={t(
                  'sidebar.tasks.schedule.titlePlaceholder'
                )}
                value={scheduleTitle}
              />
              <textarea
                aria-label={t(
                  'sidebar.tasks.schedule.promptAriaLabel'
                )}
                maxLength={100_000}
                onChange={(event) => setSchedulePrompt(event.target.value)}
                placeholder={t(
                  'sidebar.tasks.schedule.promptPlaceholder'
                )}
                rows={3}
                value={schedulePrompt}
              />
              <input
                aria-label={t(
                  'sidebar.tasks.schedule.timeAriaLabel'
                )}
                onChange={(event) => setScheduleTime(event.target.value)}
                type="datetime-local"
                value={scheduleTime}
              />
              <select
                aria-label={t(
                  'sidebar.tasks.schedule.recurrenceAriaLabel'
                )}
                onChange={(event) =>
                  setScheduleRecurrence(
                    event.target.value as ScheduleCreateInput['recurrence']
                  )
                }
                value={scheduleRecurrence}
              >
                <option value="once">
                  {t('sidebar.tasks.schedule.recurrence.once')}
                </option>
                <option value="daily">
                  {t('sidebar.tasks.schedule.recurrence.daily')}
                </option>
                <option value="weekly">
                  {t('sidebar.tasks.schedule.recurrence.weekly')}
                </option>
              </select>
              <button
                className="primary-button"
                disabled={
                  !scheduleTitle.trim() ||
                  !schedulePrompt.trim() ||
                  !scheduleTime
                }
                onClick={() => {
                  runAction(
                    () =>
                      onCreateSchedule({
                        title: scheduleTitle.trim(),
                        prompt: schedulePrompt.trim(),
                        workMode: 'ask',
                        recurrence: scheduleRecurrence,
                        nextRunAt: new Date(scheduleTime).toISOString()
                      }),
                    t('sidebar.errors.addSchedule'),
                    () => {
                      setScheduleTitle('')
                      setSchedulePrompt('')
                      setScheduleTime('')
                    }
                  )
                }}
                type="button"
              >
                {t('sidebar.tasks.schedule.add')}
              </button>
            </div>
            {schedules.map((schedule) => (
              <article
                className="assistant-sidebar__schedule"
                key={schedule.id}
              >
                <span>
                  <strong>{schedule.title}</strong>
                  <small>
                    {new Date(schedule.nextRunAt).toLocaleString(locale)} ·{' '}
                    {t(
                      `sidebar.tasks.schedule.recurrence.${schedule.recurrence}`
                    )}
                  </small>
                </span>
                <div>
                  <button
                    onClick={() =>
                      runAction(
                        () => onRunSchedule(schedule.id),
                        t('sidebar.errors.runSchedule')
                      )
                    }
                    type="button"
                  >
                    {t('sidebar.tasks.schedule.runNow')}
                  </button>
                  <button
                    onClick={() =>
                      runAction(
                        () => onRemoveSchedule(schedule.id),
                        t('sidebar.errors.deleteSchedule')
                      )
                    }
                    type="button"
                  >
                    {t('sidebar.tasks.schedule.delete')}
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}

        {tab === 'context' && (
          <section className="assistant-sidebar__section">
            <p className="assistant-sidebar__section-description">
              {t('sidebar.context.description')}
            </p>
            <h3>
              <FileText size={15} />
              {t('sidebar.context.attachmentsTitle')}
            </h3>
            {attachments.length === 0 ? (
              <p className="assistant-sidebar__empty">
                {t('sidebar.context.noAttachments')}
              </p>
            ) : (
              attachments.map((attachment) => (
                <article
                  className="assistant-sidebar__context"
                  key={attachment.id}
                >
                  <span>
                    <strong>{attachment.name}</strong>
                    <small>
                      {t('sidebar.context.attachmentDetails', {
                        kind: attachment.kind,
                        formattedSize:
                          attachment.size.toLocaleString(locale)
                      })}
                    </small>
                  </span>
                  <button
                    aria-label={t(
                      'sidebar.context.removeAttachment',
                      { name: attachment.name }
                    )}
                    className="icon-button"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    type="button"
                  >
                    <X size={14} />
                  </button>
                </article>
              ))
            )}
            <h3>
              <FolderTree size={15} />
              {t('sidebar.context.librariesTitle')}
            </h3>
            {enabledLibraries.length === 0 ? (
              <p className="assistant-sidebar__empty">
                {t('sidebar.context.noLibraries')}
              </p>
            ) : (
              enabledLibraries.map((library) => (
                <div className="assistant-sidebar__library" key={library.id}>
                  <strong>{library.name}</strong>
                  <small>
                    {t('sidebar.context.documentCount', {
                      formattedCount:
                        library.documentCount.toLocaleString(locale)
                    })}
                  </small>
                </div>
              ))
            )}
            <h3>
              <CheckCircle2 size={15} />
              {t('sidebar.context.memoriesTitle')}
            </h3>
            {activeMemories.length === 0 ? (
              <p className="assistant-sidebar__empty">
                {t('sidebar.context.noMemories')}
              </p>
            ) : (
              activeMemories.map((memory) => (
                <article
                  className="assistant-sidebar__memory"
                  key={memory.id}
                >
                  <span>{memory.content}</span>
                </article>
              ))
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
