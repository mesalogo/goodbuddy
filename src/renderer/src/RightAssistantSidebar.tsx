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
import { useEffect, useRef, useState } from 'react'
import type {
  AssistantHeartbeatConfig,
  AssistantMemory,
  AssistantSchedule,
  HeartbeatCreateInput,
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
import { HeartbeatSettings } from './HeartbeatSettings'
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
  heartbeats: AssistantHeartbeatConfig[]
  memories: AssistantMemory[]
  schedules: AssistantSchedule[]
  workspaceChanges?: WorkspaceChanges
  workspaceProjectId?: string
  browserState?: BrowserLiveState
  onClose: () => void
  onInteractBrowser: () => Promise<void>
  onStopBrowser: () => Promise<void>
  onCreateHeartbeat: (input: HeartbeatCreateInput) => Promise<void>
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
  onRemoveHeartbeat: (heartbeatId: string) => Promise<void>
  onRemoveSchedule: (scheduleId: string) => Promise<void>
  onRespondApproval: (
    approval: PendingSidebarApproval,
    decision: ApprovalDecision
  ) => void
  onRunHeartbeat: (heartbeatId: string) => Promise<void>
  onRunSchedule: (scheduleId: string) => Promise<void>
  onSetHeartbeatPaused: (
    heartbeatId: string,
    paused: boolean
  ) => Promise<void>
  onTabChange: (tab: AssistantSidebarTab) => void
}

const tabs: Array<{
  id: AssistantSidebarTab
  label: string
  description: string
}> = [
  {
    id: 'tasks',
    label: '任务中心',
    description: '处理待审批操作并管理自动化'
  },
  {
    id: 'context',
    label: '上下文',
    description: '查看本次对话使用的附件、知识库与记忆'
  },
  {
    id: 'workspace',
    label: '工作区',
    description: '浏览项目文件、Git 变更与文件内容'
  },
  {
    id: 'browser',
    label: '浏览器',
    description: '查看 Agent 操作网页时的实时画面'
  },
  {
    id: 'results',
    label: '成果',
    description: '查看对话生成或手动导入的内容'
  }
]
const emptyChangedFiles: WorkspaceChanges['files'] = []
const defaultSidebarWidth = 350
const minimumSidebarWidth = 300
const maximumSidebarWidth = 640
const minimumRemainingAppWidth = 520
const compactSidebarBreakpoint = 720
const keyboardResizeStep = 16
const sidebarTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit'
})

function getSidebarWidthLimits(viewportWidth: number): {
  minimum: number
  maximum: number
} {
  return {
    minimum: minimumSidebarWidth,
    maximum: Math.max(
      minimumSidebarWidth,
      Math.min(
        maximumSidebarWidth,
        viewportWidth - minimumRemainingAppWidth
      )
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
  heartbeats,
  memories,
  schedules,
  workspaceChanges,
  workspaceProjectId,
  browserState,
  onClose,
  onInteractBrowser,
  onStopBrowser,
  onCreateHeartbeat,
  onCreateSchedule,
  onImportArtifacts,
  onLoadArtifact,
  onRemoveAttachment,
  onRefreshChanges,
  onListWorkspaceDirectory,
  onLoadWorkspaceFile,
  onOpenWorkspaceEntry,
  onRemoveHeartbeat,
  onRemoveSchedule,
  onRespondApproval,
  onRunHeartbeat,
  onRunSchedule,
  onSetHeartbeatPaused,
  onTabChange
}: RightAssistantSidebarProps): React.JSX.Element {
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
                : '工作区文件预览失败'
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
      aria-label="助手工作栏"
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
        aria-label="调整助手工作栏宽度"
        aria-orientation="vertical"
        aria-valuemax={sidebarWidthLimits.maximum}
        aria-valuemin={sidebarWidthLimits.minimum}
        aria-valuenow={sidebarWidth}
        aria-valuetext={`${sidebarWidth} 像素`}
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
        <strong>工作栏</strong>
        <button
          aria-label="关闭助手工作栏"
          className="icon-button"
          onClick={onClose}
          type="button"
        >
          <PanelRightClose size={17} />
        </button>
      </header>

      <nav
        aria-label="工作栏分类"
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
              处理当前待审批操作，并创建和管理自动化任务。
            </p>
            <h3>
              <ShieldAlert size={15} />
              等待审批
            </h3>
            {approvals.length === 0 ? (
              <p className="assistant-sidebar__empty">
                当前没有等待审批的操作。
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
                      拒绝
                    </button>
                    <button
                      className="primary-button"
                      onClick={() =>
                        onRespondApproval(approval, 'once')
                      }
                      type="button"
                    >
                      仅此次允许
                    </button>
                  </div>
                </article>
              ))
            )}

            <h3>
              <Hourglass size={15} />
              自动化
            </h3>
            <div className="assistant-sidebar__schedule-form">
              <input
                aria-label="定时任务标题"
                maxLength={120}
                onChange={(event) => setScheduleTitle(event.target.value)}
                placeholder="任务标题"
                value={scheduleTitle}
              />
              <textarea
                aria-label="定时任务内容"
                maxLength={100_000}
                onChange={(event) => setSchedulePrompt(event.target.value)}
                placeholder="要定时完成的只读任务"
                rows={3}
                value={schedulePrompt}
              />
              <input
                aria-label="定时任务时间"
                onChange={(event) => setScheduleTime(event.target.value)}
                type="datetime-local"
                value={scheduleTime}
              />
              <select
                aria-label="定时任务重复规则"
                onChange={(event) =>
                  setScheduleRecurrence(
                    event.target.value as ScheduleCreateInput['recurrence']
                  )
                }
                value={scheduleRecurrence}
              >
                <option value="once">仅一次</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
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
                    '添加定时任务失败',
                    () => {
                      setScheduleTitle('')
                      setSchedulePrompt('')
                      setScheduleTime('')
                    }
                  )
                }}
                type="button"
              >
                添加定时任务
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
                    {new Date(schedule.nextRunAt).toLocaleString('zh-CN')} ·{' '}
                    {schedule.recurrence}
                  </small>
                </span>
                <div>
                  <button
                    onClick={() =>
                      runAction(
                        () => onRunSchedule(schedule.id),
                        '运行定时任务失败'
                      )
                    }
                    type="button"
                  >
                    立即运行
                  </button>
                  <button
                    onClick={() =>
                      runAction(
                        () => onRemoveSchedule(schedule.id),
                        '删除定时任务失败'
                      )
                    }
                    type="button"
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
            <HeartbeatSettings
              heartbeats={heartbeats}
              onCreate={onCreateHeartbeat}
              onRemove={onRemoveHeartbeat}
              onRunNow={onRunHeartbeat}
              onSetPaused={onSetHeartbeatPaused}
              variant="sidebar"
            />
          </section>
        )}

        {tab === 'context' && (
          <section className="assistant-sidebar__section">
            <p className="assistant-sidebar__section-description">
              查看当前对话实际使用的附件、知识库与已确认记忆。
            </p>
            <h3>
              <FileText size={15} />
              本次附件
            </h3>
            {attachments.length === 0 ? (
              <p className="assistant-sidebar__empty">
                尚未添加文件、截图或剪贴板内容。
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
                      {attachment.kind} · {attachment.size} 字节
                    </small>
                  </span>
                  <button
                    aria-label={`移除上下文 ${attachment.name}`}
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
              已启用知识库
            </h3>
            {enabledLibraries.length === 0 ? (
              <p className="assistant-sidebar__empty">
                当前对话未启用知识库。
              </p>
            ) : (
              enabledLibraries.map((library) => (
                <div className="assistant-sidebar__library" key={library.id}>
                  <strong>{library.name}</strong>
                  <small>{library.documentCount} 个文档</small>
                </div>
              ))
            )}
            <h3>
              <CheckCircle2 size={15} />
              已确认记忆
            </h3>
            {activeMemories.length === 0 ? (
              <p className="assistant-sidebar__empty">
                当前范围没有已确认的长期记忆。
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
                  aria-label="返回工作区"
                  className="assistant-sidebar__back"
                  onClick={() => {
                    workspacePreviewRequest.current += 1
                    setWorkspacePreview(undefined)
                    setActionError('')
                  }}
                  type="button"
                >
                  <ChevronLeft size={14} />
                  工作区
                </button>
                <span>
                  <strong>{currentWorkspacePreview.path}</strong>
                  <small>
                    {currentWorkspacePreview.state === 'ready'
                      ? `${currentWorkspacePreview.file.size.toLocaleString('zh-CN')} 字节`
                      : '项目工作区文件'}
                  </small>
                </span>
              </header>
              {currentWorkspacePreview.state === 'loading' ? (
                <p className="assistant-sidebar__empty">
                  正在读取文件…
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
                浏览当前项目文件与 Git 变更；选择文件后在当前工作区内预览。
              </p>
              <h3>
                <FolderTree size={15} />
                项目工作区
                <button
                  aria-label="刷新工作区文件"
                  className="icon-button"
                  disabled={!workspaceProjectId}
                  onClick={() => {
                    setWorkspaceRefreshVersion((current) => current + 1)
                    runAction(
                      onRefreshChanges,
                      '刷新工作区文件失败'
                    )
                  }}
                  title="刷新"
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
                  Git 状态不可用：{workspaceChanges.error}
                </p>
              )}
              {workspaceChanges?.patch && (
                <details className="assistant-sidebar__diff-details">
                  <summary>查看完整 Git diff</summary>
                  <pre className="assistant-sidebar__diff">
                    {workspaceChanges.patch}
                    {workspaceChanges.truncated
                      ? '\n\n[输出超过安全限制，已截断]'
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
                  aria-label="返回成果列表"
                  className="assistant-sidebar__back"
                  onClick={() => {
                    setSelectedArtifactId(undefined)
                    setActionError('')
                  }}
                  type="button"
                >
                  <ChevronLeft size={14} />
                  成果
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
                      正在加载图片…
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
                查看并预览由对话生成或手动导入的文本、图片、PDF 与网页内容。
              </p>
              <h3>
                <FileText size={15} />
                对话与导入成果
              </h3>
              <button
                className="secondary-button assistant-sidebar__import"
                onClick={() =>
                  runAction(
                    onImportArtifacts,
                    '导入成果失败'
                  )
                }
                type="button"
              >
                <Upload size={13} />
                导入 PDF、图片或网页
              </button>
              {artifacts.length === 0 ? (
                <p className="assistant-sidebar__empty">
                  完成的回复会作为可预览成果显示在这里。
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
                        '加载成果失败'
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
                <strong>实时浏览器</strong>
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
                          '打开浏览器交互窗口失败'
                        )
                      }
                      type="button"
                    >
                      <ExternalLink aria-hidden="true" size={12} />
                      {browserState.status === 'interactive'
                        ? '交互中'
                        : '交互'}
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        runAction(
                          onStopBrowser,
                          '停止浏览器失败'
                        )
                      }
                      type="button"
                    >
                      停止浏览器
                    </button>
                  </div>
                )}
            </header>
            {!browserState ? (
              <p className="assistant-sidebar__empty">
                Agent 打开网页后，实时画面会显示在这里。
              </p>
            ) : (
              <>
                <div
                  aria-live="polite"
                  className={`assistant-sidebar__browser-status assistant-sidebar__browser-status--${browserState.status}`}
                  role="status"
                >
                  {browserState.status === 'creating'
                    ? '正在启动浏览器…'
                    : browserState.status === 'loading'
                      ? '正在加载页面…'
                      : browserState.status === 'acting'
                        ? 'Agent 正在操作页面…'
                        : browserState.status === 'interactive'
                          ? '用户正在辅助操作页面…'
                        : browserState.status === 'ready'
                          ? '浏览器已就绪'
                          : browserState.status === 'failed'
                            ? browserState.error ?? '浏览器操作失败'
                            : '浏览器已停止'}
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
                    alt="Agent 实时浏览器画面"
                    className="assistant-sidebar__browser-frame"
                    src={browserState.frameDataUrl}
                  />
                ) : (
                  <div className="assistant-sidebar__browser-placeholder">
                    <Monitor size={28} />
                    <span>
                      {browserState.status === 'failed'
                        ? '未能获取页面画面'
                        : '等待首个页面画面…'}
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
