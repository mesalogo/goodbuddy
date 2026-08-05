import {
  CheckCircle2,
  ChevronRight,
  FileDiff,
  FileText,
  FolderTree,
  Hourglass,
  Monitor,
  PanelRightClose,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  Upload,
  X,
  XCircle
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AssistantMemory,
  AssistantSchedule,
  AssistantHeartbeatConfig,
  AssistantHeartbeatEntry,
  AssistantExpert,
  HeartbeatCreateInput,
  ScheduleCreateInput,
  AssistantTask,
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
import type { ActivityRecord } from './activity-store'
import { HeartbeatSettings } from './HeartbeatSettings'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'

export type AssistantSidebarTab =
  | 'tasks'
  | 'context'
  | 'artifacts'
  | 'changes'
  | 'browser'
  | 'preview'

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
  activities: ActivityRecord[]
  tasks: AssistantTask[]
  experts?: AssistantExpert[]
  artifacts: SidebarArtifact[]
  attachments: ContextAttachment[]
  enabledLibraries: KnowledgeLibrary[]
  approvals: PendingSidebarApproval[]
  memories: AssistantMemory[]
  schedules: AssistantSchedule[]
  heartbeats: AssistantHeartbeatConfig[]
  heartbeatEntries: AssistantHeartbeatEntry[]
  workspaceChanges?: WorkspaceChanges
  workspaceProjectId?: string
  browserState?: BrowserLiveState
  onClose: () => void
  onStopBrowser: () => Promise<void>
  onOpenHeartbeat: () => void
  onOpenConversation: (conversationId: string) => void
  onImportArtifacts: () => Promise<void>
  onLoadArtifact: (artifactId: string) => Promise<void>
  onRemoveAttachment: (attachmentId: string) => void
  onCreateMemory: (content: string) => Promise<void>
  onCreateSchedule: (input: ScheduleCreateInput) => Promise<void>
  onCreateHeartbeat: (input: HeartbeatCreateInput) => Promise<void>
  onSetHeartbeatPaused: (
    heartbeatId: string,
    paused: boolean
  ) => Promise<void>
  onRemoveHeartbeat: (heartbeatId: string) => Promise<void>
  onRunHeartbeat: (heartbeatId: string) => Promise<void>
  onRemoveSchedule: (scheduleId: string) => Promise<void>
  onRunSchedule: (scheduleId: string) => Promise<void>
  onRefreshChanges: () => Promise<void>
  onListWorkspaceDirectory: (
    path: string
  ) => Promise<WorkspaceDirectoryListing>
  onLoadWorkspaceFile: (path: string) => Promise<WorkspaceFilePreview>
  onRemoveMemory: (memoryId: string) => Promise<void>
  onSetMemoryStatus: (
    memoryId: string,
    status: AssistantMemory['status']
  ) => Promise<void>
  onRespondApproval: (
    approval: PendingSidebarApproval,
    decision: ApprovalDecision
  ) => void
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
    description: '查看运行状态、处理审批并安排自动化'
  },
  {
    id: 'context',
    label: '上下文',
    description: '管理本次对话的附件、知识库与长期记忆'
  },
  {
    id: 'artifacts',
    label: '成果库',
    description: '集中保存和打开对话生成或手动导入的内容'
  },
  {
    id: 'changes',
    label: '工作区',
    description: '浏览项目文件、Git 变更与工具活动'
  },
  {
    id: 'browser',
    label: '浏览器',
    description: '查看 Agent 操作网页时的实时画面'
  },
  {
    id: 'preview',
    label: '预览',
    description: '预览选中的成果或工作区文件'
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

function formatTime(timestamp: number | string): string {
  return sidebarTimeFormatter.format(new Date(timestamp))
}

export function orderTasksWithChildren(
  tasks: readonly AssistantTask[]
): AssistantTask[] {
  const childIds = new Set(
    tasks.flatMap((task) => (task.parentTaskId ? [task.id] : []))
  )
  const childrenByParent = new Map<string, AssistantTask[]>()
  for (const task of tasks) {
    if (!task.parentTaskId) {
      continue
    }
    const children = childrenByParent.get(task.parentTaskId) ?? []
    children.push(task)
    childrenByParent.set(task.parentTaskId, children)
  }
  const ordered: AssistantTask[] = []
  const included = new Set<string>()
  const append = (task: AssistantTask): void => {
    if (included.has(task.id)) {
      return
    }
    included.add(task.id)
    ordered.push(task)
    for (const child of childrenByParent.get(task.id) ?? []) {
      append(child)
    }
  }
  for (const task of tasks) {
    if (!childIds.has(task.id)) {
      append(task)
    }
  }
  for (const task of tasks) {
    append(task)
  }
  return ordered
}

export function RightAssistantSidebar({
  open,
  tab,
  activities,
  tasks,
  experts = [],
  artifacts,
  attachments,
  enabledLibraries,
  approvals,
  memories,
  schedules,
  heartbeats,
  heartbeatEntries,
  workspaceChanges,
  workspaceProjectId,
  browserState,
  onClose,
  onStopBrowser,
  onOpenHeartbeat,
  onOpenConversation,
  onImportArtifacts,
  onLoadArtifact,
  onRemoveAttachment,
  onCreateMemory,
  onCreateSchedule,
  onCreateHeartbeat,
  onSetHeartbeatPaused,
  onRemoveHeartbeat,
  onRunHeartbeat,
  onRemoveSchedule,
  onRunSchedule,
  onRefreshChanges,
  onListWorkspaceDirectory,
  onLoadWorkspaceFile,
  onRemoveMemory,
  onSetMemoryStatus,
  onRespondApproval,
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
  const [memoryDraft, setMemoryDraft] = useState('')
  const [workspaceRefreshVersion, setWorkspaceRefreshVersion] = useState(0)
  const [scheduleTitle, setScheduleTitle] = useState('')
  const [schedulePrompt, setSchedulePrompt] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [scheduleRecurrence, setScheduleRecurrence] = useState<
    ScheduleCreateInput['recurrence']
  >('once')
  const recentTasks = useMemo(
    () =>
      activities
        .filter((activity) => activity.kind === 'request')
        .slice(0, 20),
    [activities]
  )
  const orderedTasks = useMemo(
    () => orderTasksWithChildren(tasks),
    [tasks]
  )
  const expertNames = useMemo(
    () => new Map(experts.map((expert) => [expert.id, expert.name])),
    [experts]
  )
  const changes = useMemo(
    () =>
      activities
        .filter((activity) => activity.kind === 'tool')
        .slice(0, 30),
    [activities]
  )
  const artifactPreview =
    artifacts.find((artifact) => artifact.id === selectedArtifactId) ??
    artifacts[0]
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
    onTabChange('preview')
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
            onClick={() => onTabChange(item.id)}
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
        {tab === 'tasks' && (
          <section className="assistant-sidebar__section">
            <p className="assistant-sidebar__section-description">
              查看当前和最近请求的运行状态、处理待审批操作，并安排定时任务与智能心跳。
            </p>
            {approvals.length > 0 && (
              <>
                <h3>
                  <ShieldAlert size={15} />
                  等待审批
                </h3>
                {approvals.map((approval) => (
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
                ))}
              </>
            )}

            <h3>
              <PlayCircle size={15} />
              最近任务
            </h3>
            {tasks.length === 0 && recentTasks.length === 0 ? (
              <p className="assistant-sidebar__empty">
                发送请求后，任务状态会显示在这里。
              </p>
            ) : (
              (orderedTasks.length > 0 ? orderedTasks : recentTasks).map((task) => (
                <button
                  className={
                    'parentTaskId' in task && task.parentTaskId
                      ? 'assistant-sidebar__row assistant-sidebar__row--subtask'
                      : 'assistant-sidebar__row'
                  }
                  key={task.id}
                  onClick={() => {
                    if (task.conversationId) {
                      onOpenConversation(task.conversationId)
                    }
                  }}
                  type="button"
                >
                  {task.status === 'running' ||
                  task.status === 'pending' ? (
                    <Hourglass size={15} />
                  ) : task.status === 'failed' ||
                    task.status === 'denied' ? (
                    <XCircle size={15} />
                  ) : (
                    <CheckCircle2 size={15} />
                  )}
                  <span>
                    <strong>{task.title}</strong>
                    <small>
                      {formatTime(task.createdAt)} · {task.status}
                    </small>
                    {'parentTaskId' in task && task.parentTaskId && (
                      <small className="assistant-sidebar__subtask-meta">
                        子专家：
                        {task.expertId
                          ? expertNames.get(task.expertId) ??
                            task.title
                          : task.title}
                        {' · '}
                        {task.routingMode === 'smart'
                          ? '智能路由'
                          : '手动指定'}
                      </small>
                    )}
                  </span>
                  <ChevronRight size={14} />
                </button>
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
                  void onCreateSchedule({
                    title: scheduleTitle.trim(),
                    prompt: schedulePrompt.trim(),
                    workMode: 'ask',
                    recurrence: scheduleRecurrence,
                    nextRunAt: new Date(scheduleTime).toISOString()
                  }).then(() => {
                    setScheduleTitle('')
                    setSchedulePrompt('')
                    setScheduleTime('')
                  })
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
                    onClick={() => void onRunSchedule(schedule.id)}
                    type="button"
                  >
                    立即运行
                  </button>
                  <button
                    onClick={() => void onRemoveSchedule(schedule.id)}
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
              长期记忆
            </h3>
            <div className="assistant-sidebar__memory-form">
              <input
                aria-label="新增长期记忆"
                maxLength={8_000}
                onChange={(event) => setMemoryDraft(event.target.value)}
                placeholder="例如：我偏好简洁的中文回复"
                value={memoryDraft}
              />
              <button
                className="primary-button"
                disabled={!memoryDraft.trim()}
                onClick={() => {
                  const content = memoryDraft.trim()
                  setMemoryDraft('')
                  void onCreateMemory(content)
                }}
                type="button"
              >
                记住
              </button>
            </div>
            {memories.length === 0 ? (
              <p className="assistant-sidebar__empty">
                尚无已确认的长期记忆。
              </p>
            ) : (
              memories.map((memory) => (
                <article
                  className="assistant-sidebar__memory"
                  key={memory.id}
                >
                  <span>
                    {memory.content}
                    {memory.status === 'proposed' && (
                      <small>智能心跳建议，等待确认</small>
                    )}
                  </span>
                  <div>
                    {memory.status === 'proposed' && (
                      <>
                        <button
                          onClick={() =>
                            void onSetMemoryStatus(
                              memory.id,
                              'confirmed'
                            )
                          }
                          type="button"
                        >
                          确认
                        </button>
                        <button
                          onClick={() =>
                            void onSetMemoryStatus(
                              memory.id,
                              'rejected'
                            )
                          }
                          type="button"
                        >
                          忽略
                        </button>
                      </>
                    )}
                    <button
                      aria-label={`删除记忆 ${memory.content.slice(0, 24)}`}
                      className="icon-button"
                      onClick={() => void onRemoveMemory(memory.id)}
                      type="button"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </article>
              ))
            )}
            <h3>
              <RefreshCw size={15} />
              智能心跳
              <button
                aria-label="打开智能心跳中心"
                className="icon-button"
                onClick={onOpenHeartbeat}
                type="button"
              >
                <ChevronRight size={14} />
              </button>
            </h3>
            {heartbeatEntries.length === 0 ? (
              <p className="assistant-sidebar__empty">
                完成智能心跳后，最近的成长摘要会显示在这里。
              </p>
            ) : (
              heartbeatEntries.slice(0, 10).map((entry) => (
                <article
                  className="assistant-sidebar__schedule"
                  key={entry.id}
                >
                  <span>
                    <strong>
                      {new Date(entry.createdAt).toLocaleString('zh-CN')}
                    </strong>
                    <small>
                      {entry.proposedMemoryIds.length} 条记忆建议 ·{' '}
                      {entry.followUpTaskIds.length} 个后续任务
                    </small>
                  </span>
                  <p>{entry.summary}</p>
                </article>
              ))
            )}
          </section>
        )}

        {tab === 'artifacts' && (
          <section className="assistant-sidebar__section">
            <p className="assistant-sidebar__section-description">
              保存并预览由对话生成或手动导入的文本、图片、PDF 与网页内容。
            </p>
            <h3>
              <FileText size={15} />
              对话与导入成果
            </h3>
            <button
              className="secondary-button assistant-sidebar__import"
              onClick={() => void onImportArtifacts()}
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
                    workspacePreviewRequest.current += 1
                    setWorkspacePreview(undefined)
                    setSelectedArtifactId(artifact.id)
                    onTabChange('preview')
                    void onLoadArtifact(artifact.id)
                  }}
                  type="button"
                >
                  <FileText size={15} />
                  <span>
                    <strong>{artifact.title}</strong>
                    <small>{formatTime(artifact.createdAt)}</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))
            )}
          </section>
        )}

        {tab === 'changes' && (
          <>
            <section className="assistant-sidebar__section">
              <p className="assistant-sidebar__section-description">
                浏览当前项目文件、检查未提交 Git 变更，并查看 Agent
                的工具活动。
              </p>
              <h3>
                <FolderTree size={15} />
                项目工作区
                <button
                  aria-label="刷新工作区文件"
                  className="icon-button"
                  onClick={() => {
                    setWorkspaceRefreshVersion((current) => current + 1)
                    void onRefreshChanges()
                  }}
                  type="button"
                >
                  <RefreshCw size={14} />
                </button>
              </h3>
              <WorkspaceFilesPanel
                changedFiles={workspaceChanges?.files ?? emptyChangedFiles}
                key={`${workspaceProjectId ?? 'none'}:${workspaceRefreshVersion}`}
                onListDirectory={onListWorkspaceDirectory}
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
            <section className="assistant-sidebar__section">
              <h3>工具活动</h3>
              {changes.length === 0 ? (
                <p className="assistant-sidebar__empty">
                  Agent 调用工具后，相关记录会显示在这里。
                </p>
              ) : (
                changes.map((change) => (
                  <button
                    className="assistant-sidebar__row"
                    key={change.id}
                    onClick={() =>
                      onOpenConversation(change.conversationId)
                    }
                    type="button"
                  >
                    <FileDiff size={15} />
                    <span>
                      <strong>{change.title}</strong>
                      <small>{change.detail || change.status}</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))
              )}
            </section>
          </>
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
                  <button
                    className="secondary-button"
                    onClick={() => void onStopBrowser()}
                    type="button"
                  >
                    停止浏览器
                  </button>
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

        {tab === 'preview' && (
          <section className="assistant-sidebar__preview">
            {currentWorkspacePreview ? (
              <>
                <header>
                  <strong>{currentWorkspacePreview.path}</strong>
                  <small>
                    {currentWorkspacePreview.state === 'ready'
                      ? `${currentWorkspacePreview.file.size.toLocaleString('zh-CN')} 字节`
                      : '项目工作区文件'}
                  </small>
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
              </>
            ) : artifactPreview ? (
              <>
                <header>
                  <strong>{artifactPreview.title}</strong>
                  <small>{formatTime(artifactPreview.createdAt)}</small>
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
              </>
            ) : (
              <p className="assistant-sidebar__empty">
                选择成果后可在这里预览。
              </p>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}
