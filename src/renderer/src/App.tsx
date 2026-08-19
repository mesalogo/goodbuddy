import {
  ArrowDown,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Copy,
  Download,
  Edit3,
  FileText,
  HeartPulse,
  Info,
  Library,
  ListTodo,
  LoaderCircle,
  Maximize2,
  MessageSquarePlus,
  MessageSquare,
  Mic,
  Minimize2,
  Minus,
  Moon,
  MoreHorizontal,
  Paperclip,
  PanelLeft,
  Search,
  Send,
  Settings,
  RefreshCw,
  ShieldCheck,
  PanelRightOpen,
  Sparkles,
  Square,
  Sun,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react'
import {
  Component,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction
} from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  ApprovalDecision,
  AgentEvent,
  AgentQuestionAnswer,
  AgentRuntimeStatus,
  AppInfo,
  BrowserLiveState,
  ContextAttachment,
  ContextFileSelectionProgress,
  KnowledgeSearchReference,
  KnowledgeSnapshot,
  RuntimeCustomizationSettings,
  RuntimeNativeSnapshot,
  RuntimeControl,
  RuntimeSettings
} from '../../shared/contracts'
import {
  defaultContextCompressionSettings,
  maximumPastedImageBytes
} from '../../shared/contracts'
import {
  buildConversationSummaryHistory,
  estimatedContextRequestOverheadTokens,
  estimateMessagesTokens,
  getEffectiveContextTriggerTokens
} from '../../shared/context-window'
import {
  agentRuntimeSelectionKey,
  agentRuntimeSelectionSchema,
  type AgentRuntimeSelection
} from '../../shared/runtime-selection-contracts'
import {
  getDefaultRuntimeSelection,
  getRuntimeSelectionForProvider
} from './runtime-selection'
import type {
  AssistantProject,
  AssistantArtifact,
  AssistantMemory,
  AssistantSchedule,
  AssistantHeartbeatConfig,
  AssistantHeartbeatEntry,
  AssistantHeartbeatRun,
  HeartbeatCreateInput,
  HeartbeatUpdateInput,
  AssistantExpert,
  AssistantTask,
  TokenUsageSummary,
  ConversationMessage,
  ConversationSnapshot,
  ConversationAttachment,
  ConversationContextCompressionMarker,
  ConversationMessageBlock,
  LocalConversationHeader,
  LocalConversationSaveBatch,
  ProjectCreateInput,
  InteractiveWorkMode,
  ProjectChannel,
  WorkspaceChanges
} from '../../shared/assistant-contracts'
import {
  conversationAttachmentSchema,
  conversationContextCompressionMarkerSchema,
  conversationContextMetricsSchema,
  conversationMessageBlocksSchema,
  conversationSubagentActivitySchema,
  interactiveWorkModes,
  normalizeInteractiveWorkMode,
  projectChannelLabels
} from '../../shared/assistant-contracts'
import { ActivityPanel } from './ActivityPanel'
import {
  ChatTimeline,
  type ImageViewerItem,
  type Message,
  type SubagentActivity,
  type ToolActivity
} from './ChatTimeline'
import {
  loadActivityRecords,
  reconcileActivityRecords,
  saveActivityRecords,
  upsertActivityRecord,
  type ActivityRecord
} from './activity-store'
import {
  KnowledgeCitationDialog,
  type KnowledgeCitationContextView
} from './KnowledgeCitationDialog'
import {
  DestructiveConfirmActions,
  EmptyState,
  PageShell,
  SegmentedControl,
  ScopeBadge
} from './WorkspacePrimitives'
import {
  ProjectSwitcher
} from './ProjectSwitcher'
import {
  RightAssistantSidebar,
  type AssistantSidebarTab,
  type PendingSidebarApproval,
  type SidebarArtifact
} from './RightAssistantSidebar'
import {
  CustomTaskDialog,
  type CustomTaskDestination
} from './CustomTaskDialog'
import { ConversationTaskStrip } from './ConversationTaskStrip'
import { OverflowMarquee } from './OverflowMarquee'
import { findTaskSchedule } from './TaskScheduleActions'
import type { SettingsCategoryId } from './settings-categories'
import goodbuddyDarkIcon from './assets/goodbuddy-dark.png'
import goodbuddyLightIcon from './assets/goodbuddy-light.png'
import {
  applyAppearanceTheme,
  loadAppearanceTheme,
  resolveAppearanceTheme,
  saveAppearanceTheme,
  type AppearanceTheme
} from './theme'
import {
  describeSpeechRecognitionError,
  getSpeechRecognitionConstructor,
  prepareSpeechRecognition,
  startPcmRecording,
  type PcmRecording
} from './speech-recognition'
import type {
  AppNotificationInput,
  AppNotificationTone
} from './notifications'
import type { ReleaseNotesSnapshot } from '../../shared/release-notes-contracts'
import { ReleaseNotesDialog } from './ReleaseNotesDialog'
import { scheduleIdleRoutePreload } from './idle-route-preload'
import { createPreloadableComponent } from './preloadable-component'
import {
  formatConversationListTime,
  type TimeFormatLocale
} from './time-format'
import { formatMediumDateTime } from './locale-formatters'
import { formatCompactTokens } from './token-format'
import {
  pruneKeepAliveEntries,
  touchKeepAliveEntry,
  type KeepAliveCacheEntry
} from './keep-alive-cache'

const knowledgeWorkspaceRoute = createPreloadableComponent(
  () => import('./KnowledgeWorkspace'),
  (module) => module.KnowledgeWorkspace
)
const heartbeatCenterRoute = createPreloadableComponent(
  () => import('./HeartbeatCenter'),
  (module) => module.HeartbeatCenter
)
const magicNotesWorkspaceRoute = createPreloadableComponent(
  () => import('./MagicNotesWorkspace'),
  (module) => module.MagicNotesWorkspace
)
const settingsPanelRoute = createPreloadableComponent(
  () => import('./SettingsPanel'),
  (module) => module.SettingsPanel
)
const idleRouteModuleLoaders = [
  knowledgeWorkspaceRoute.preload,
  heartbeatCenterRoute.preload,
  magicNotesWorkspaceRoute.preload,
  settingsPanelRoute.preload
] as const

const KnowledgeWorkspace = knowledgeWorkspaceRoute.Component
const HeartbeatCenter = heartbeatCenterRoute.Component
const MagicNotesWorkspace = magicNotesWorkspaceRoute.Component
const SettingsPanel = settingsPanelRoute.Component

const messageRenderBatchSize = 80
const conversationPersistenceIntervalMs = 500
const conversationSearchSnapshotDelayMs = 250
const keepAliveExpirationMs = 60 * 60 * 1_000
const keepAliveSweepIntervalMs = 5 * 60 * 1_000
const maximumCachedConversations = 12
const recentCachedConversations = 5
const maximumCachedWorkspaceViews = 4
const recentCachedWorkspaceViews = 3

type AppNotification = {
  id: string
  message: string
  tone: AppNotificationTone
  revision: number
}

type AppNotificationAction = AppNotificationInput | { dismiss: string }

function appNotificationReducer(
  current: AppNotification[],
  action: AppNotificationAction
): AppNotification[] {
  if ('dismiss' in action) {
    return current.filter(
      (notification) => notification.id !== action.dismiss
    )
  }
  const message = action.message.slice(0, 2_000)
  const id = action.dedupeKey ?? `${action.tone}:${message}`
  const existing = current.find(
    (notification) => notification.id === id
  )
  if (
    existing?.tone === 'error' &&
    action.tone === 'error' &&
    existing.message === message
  ) {
    return current
  }
  const updated = [
    ...current.filter((notification) => notification.id !== id),
    {
      id,
      message,
      tone: action.tone,
      revision: (existing?.revision ?? 0) + 1
    }
  ]
  const errors = updated.filter(
    (notification) => notification.tone === 'error'
  )
  const transient = updated
    .filter((notification) => notification.tone !== 'error')
    .slice(-4)
  return [...errors, ...transient]
}

function RouteLoadingStatus({
  label
}: {
  label: string
}): React.JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      aria-live="polite"
      className="route-loading-status"
      role="status"
    >
      <LoaderCircle aria-hidden="true" size={20} />
      <span>{label}</span>
    </div>
  )
}

function KeepAliveRoute({
  active,
  children,
  route
}: {
  active: boolean
  children: ReactNode
  route: string
}): React.JSX.Element {
  return (
    <div
      aria-hidden={active ? undefined : 'true'}
      className="workspace-route-cache"
      data-route={route}
      hidden={!active}
      inert={!active}
    >
      {children}
    </div>
  )
}

class RouteErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function RouteLoadError({
  message,
  reloadLabel
}: {
  message: string
  reloadLabel: string
}): React.JSX.Element {
  return (
    <div className="route-load-error" role="alert">
      <CircleAlert aria-hidden="true" size={20} />
      <strong>{message}</strong>
      <button onClick={() => window.location.reload()} type="button">
        {reloadLabel}
      </button>
    </div>
  )
}

function AppNotificationItem({
  notification,
  dispatch
}: {
  notification: AppNotification
  dispatch: React.Dispatch<AppNotificationAction>
}): React.JSX.Element {
  const { t } = useTranslation('app')

  useEffect(() => {
    if (notification.tone === 'error') {
      return
    }
    const timeout = window.setTimeout(() => {
      dispatch({ dismiss: notification.id })
    }, 4_500)
    return () => window.clearTimeout(timeout)
  }, [
    dispatch,
    notification.id,
    notification.revision,
    notification.tone
  ])

  const label =
    notification.tone === 'success'
      ? t('notifications.success')
      : notification.tone === 'error'
        ? t('notifications.error')
        : t('notifications.info')
  const Icon =
    notification.tone === 'success'
      ? CheckCircle2
      : notification.tone === 'error'
        ? CircleAlert
        : Info
  return (
    <div
      aria-live={notification.tone === 'error' ? 'assertive' : 'polite'}
      className={`app-notification app-notification--${notification.tone}`}
      role={notification.tone === 'error' ? 'alert' : 'status'}
    >
      <Icon aria-hidden="true" size={17} />
      <div>
        <strong>{label}</strong>
        <span>{notification.message}</span>
      </div>
      <button
        aria-label={t('notifications.close')}
        onClick={() => dispatch({ dismiss: notification.id })}
        type="button"
      >
        <X aria-hidden="true" size={14} />
      </button>
    </div>
  )
}

function AppNotificationViewport({
  notifications,
  dispatch
}: {
  notifications: AppNotification[]
  dispatch: React.Dispatch<AppNotificationAction>
}): React.JSX.Element | null {
  const { t } = useTranslation('app')

  if (notifications.length === 0) {
    return null
  }
  return (
    <section
      aria-label={t('notifications.viewport')}
      className="app-notification-viewport"
    >
      {notifications.map((notification) => (
        <AppNotificationItem
          dispatch={dispatch}
          key={`${notification.id}:${notification.revision}`}
          notification={notification}
        />
      ))}
    </section>
  )
}

function supportsSubagentSmartRouting(
  workMode: string
): boolean {
  return workMode === 'ask'
}

type Conversation = Omit<ConversationSnapshot, 'messages'> & {
  messages: Message[]
}

type ActiveRun = {
  conversationId: string
  messageId: string
  projectId?: string
  runtimeSelectionKey: string
}

type WorkspaceView =
  | 'chat'
  | 'magic-notes'
  | 'knowledge'
  | 'heartbeat'
  | 'activity'
  | 'settings'

const emptyTokenUsage: TokenUsageSummary = {
  totals: {
    callCount: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0
  },
  records: []
}

const storageKey = 'goodbuddy.conversations.v1'

const activeProjectStorageKey = 'goodbuddy.active-project.v1'

const maxMessageContentLength = 1_000_000
const maxMessageBlocks = 500

function appendMessageContentBlock(
  blocks: ConversationMessageBlock[] | undefined,
  type: 'text' | 'reasoning',
  delta: string
): ConversationMessageBlock[] | undefined {
  if (!blocks || !delta) {
    return blocks
  }
  const current = [...blocks]
  const previous = current.at(-1)
  if (previous?.type === type) {
    previous.content = `${previous.content}${delta}`.slice(
      0,
      maxMessageContentLength
    )
    return current
  }
  if (current.length >= maxMessageBlocks) {
    return current
  }
  current.push({
    id: crypto.randomUUID(),
    type,
    content: delta.slice(0, maxMessageContentLength)
  })
  return current
}

function upsertMessageToolBlock(
  blocks: ConversationMessageBlock[] | undefined,
  tool: ToolActivity
): ConversationMessageBlock[] | undefined {
  if (!blocks) {
    return blocks
  }
  const callId = tool.callId
  const index = callId
    ? blocks.findIndex(
        (block) =>
          block.type === 'tool' && block.tool.callId === callId
      )
    : -1
  if (index >= 0) {
    return blocks.map((block, blockIndex) =>
      blockIndex === index && block.type === 'tool'
        ? { ...block, tool }
        : block
    )
  }
  if (blocks.length >= maxMessageBlocks) {
    return blocks
  }
  return [
    ...blocks,
    {
      id: crypto.randomUUID(),
      type: 'tool',
      tool
    }
  ]
}

function terminalizeMessageToolBlocks(
  blocks: ConversationMessageBlock[] | undefined,
  state: 'failed' | 'cancelled'
): ConversationMessageBlock[] | undefined {
  return blocks?.map((block) =>
    block.type === 'tool' &&
    (block.tool.state === 'pending' || block.tool.state === 'running')
      ? {
          ...block,
          tool: {
            ...block.tool,
            state
          }
        }
      : block
  )
}

function isErrorRepresentedByFailedTool(
  tools: ToolActivity[] | undefined,
  errorMessage: string
): boolean {
  return Boolean(
    tools?.some(
      (tool) =>
        tool.state === 'failed' &&
        ((tool.error && errorMessage.includes(tool.error)) ||
          (tool.callId && errorMessage.includes(tool.callId)))
    )
  )
}

const chatBottomProximity = 96

function createConversation(
  projectId?: string,
  runtimeSelection?: AgentRuntimeSelection,
  greeting =
    '你好，我是 GoodBuddy。你可以直接向我提问、添加本地文件或使用知识库。启用 Agent Runtime 后，我也可以在你的授权下调用工具。'
): Conversation {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    projectId,
    runtimeSelection,
    knowledgeRetrievalMode: 'auto',
    title: '新对话',
    updatedAt: now,
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: greeting,
        createdAt: now,
        state: 'complete'
      }
    ]
  }
}

function displayErrorMessage(reason: unknown, fallback: string): string {
  if (
    typeof reason === 'object' &&
    reason !== null &&
    'message' in reason &&
    typeof reason.message === 'string' &&
    reason.message
  ) {
    return reason.message
  }
  return fallback
}

function isUnusedConversation(conversation: Conversation): boolean {
  return (
    conversation.title === '新对话' &&
    conversation.messages.length === 1 &&
    conversation.messages[0]?.role === 'assistant'
  )
}

function getConversationDisplayTitle(
  conversation: Conversation,
  defaultTitle: string
): string {
  return isUnusedConversation(conversation)
    ? defaultTitle
    : conversation.title
}

type ChatQuickAction = {
  title: string
  description: string
  prompt: string
}

type ChatScrollSnapshot = {
  pinnedToBottom: boolean
  scrollTop: number
}

function ChatHistoryPane({
  active,
  artifactById,
  conversation,
  locale,
  onDownloadImage,
  onOpenCitationContext,
  onOpenCitationSource,
  onOpenImage,
  onRespondApproval,
  onRespondQuestion,
  onRetry,
  onScrollSnapshotChange,
  onSetInput,
  onVisibleMessageCountChange,
  quickActions,
  scrollSnapshot,
  taskStrip,
  visibleMessageCount
}: {
  active: boolean
  artifactById: ReadonlyMap<string, AssistantArtifact>
  conversation: Conversation
  locale: TimeFormatLocale
  onDownloadImage: (item: ImageViewerItem) => void
  onOpenCitationContext: (
    reference: KnowledgeSearchReference
  ) => Promise<void>
  onOpenCitationSource: (
    reference: KnowledgeSearchReference
  ) => Promise<void>
  onOpenImage: (item: ImageViewerItem, trigger: HTMLElement) => void
  onRespondApproval: (
    conversationId: string,
    messageId: string,
    approvalId: string,
    decision: ApprovalDecision
  ) => Promise<void>
  onRespondQuestion: (
    conversationId: string,
    messageId: string,
    questionId: string,
    answers?: AgentQuestionAnswer[]
  ) => Promise<void>
  onRetry: (content: string) => void
  onScrollSnapshotChange: (
    conversationId: string,
    snapshot: ChatScrollSnapshot
  ) => void
  onSetInput: (value: string) => void
  onVisibleMessageCountChange: (
    conversationId: string,
    count: number
  ) => void
  quickActions: ChatQuickAction[]
  scrollSnapshot?: ChatScrollSnapshot
  taskStrip?: ReactNode
  visibleMessageCount: number
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const scrollRef = useRef<HTMLElement>(null)
  const pinnedToBottomRef = useRef(
    scrollSnapshot?.pinnedToBottom ?? true
  )
  const latestScrollSnapshotRef = useRef(scrollSnapshot)
  const restorePendingRef = useRef(true)
  const prependScrollPositionRef = useRef<{
    scrollHeight: number
    scrollTop: number
  } | undefined>(undefined)
  const finalRevealedMessageIdRef = useRef<string | undefined>(
    undefined
  )
  const messageArticleRefs = useRef(new Map<string, HTMLElement>())
  const previousMessageCountRef = useRef(conversation.messages.length)
  const [showScrollToBottom, setShowScrollToBottom] = useState(
    scrollSnapshot ? !scrollSnapshot.pinnedToBottom : false
  )
  const visibleMessageStartIndex = Math.max(
    0,
    conversation.messages.length - visibleMessageCount
  )
  const visibleMessages = conversation.messages.slice(
    visibleMessageStartIndex
  )
  const hiddenMessageCount = visibleMessageStartIndex

  const saveScrollPosition = useCallback(
    (scrollContainer: HTMLElement): boolean => {
      const distanceFromBottom =
        scrollContainer.scrollHeight -
        scrollContainer.scrollTop -
        scrollContainer.clientHeight
      const pinnedToBottom = distanceFromBottom <= chatBottomProximity
      latestScrollSnapshotRef.current = {
        pinnedToBottom,
        scrollTop: scrollContainer.scrollTop
      }
      return pinnedToBottom
    },
    []
  )

  const handleScrollRef = useCallback(
    (element: HTMLElement | null): void => {
      const previous = scrollRef.current
      if (previous && previous !== element) {
        saveScrollPosition(previous)
        if (!element && latestScrollSnapshotRef.current) {
          onScrollSnapshotChange(
            conversation.id,
            latestScrollSnapshotRef.current
          )
        }
      }
      scrollRef.current = element
    },
    [conversation.id, onScrollSnapshotChange, saveScrollPosition]
  )

  const updateScrollPosition = useCallback((): void => {
    const scrollContainer = scrollRef.current
    if (!scrollContainer) {
      return
    }
    const atBottom = saveScrollPosition(scrollContainer)
    pinnedToBottomRef.current = atBottom
    setShowScrollToBottom(!atBottom)
  }, [saveScrollPosition])

  useLayoutEffect(() => {
    const previousMessageCount = previousMessageCountRef.current
    if (
      conversation.messages
        .slice(previousMessageCount)
        .some((message) => message.role === 'user')
    ) {
      pinnedToBottomRef.current = true
    }
    previousMessageCountRef.current = conversation.messages.length
  }, [conversation.messages])

  useLayoutEffect(() => {
    if (!active) {
      return
    }
    const scrollContainer = scrollRef.current
    if (!scrollContainer) {
      return
    }
    if (restorePendingRef.current) {
      restorePendingRef.current = false
      if (scrollSnapshot && !scrollSnapshot.pinnedToBottom) {
        pinnedToBottomRef.current = false
        scrollContainer.scrollTop = scrollSnapshot.scrollTop
        return
      }
    }
    if (pinnedToBottomRef.current) {
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior: 'auto'
      })
    }
  }, [
    active,
    conversation.messages,
    scrollSnapshot,
    visibleMessageCount
  ])

  useLayoutEffect(() => {
    if (!active || typeof ResizeObserver !== 'function') {
      return
    }
    const scrollContainer = scrollRef.current
    const messageList =
      scrollContainer?.querySelector<HTMLElement>('.message-list')
    if (!scrollContainer || !messageList) {
      return
    }
    const observer = new ResizeObserver(() => {
      if (
        restorePendingRef.current ||
        !pinnedToBottomRef.current
      ) {
        return
      }
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior: 'auto'
      })
    })
    observer.observe(messageList)
    return () => observer.disconnect()
  }, [active])

  useLayoutEffect(() => {
    const previous = prependScrollPositionRef.current
    if (!previous) {
      return
    }
    prependScrollPositionRef.current = undefined
    const scrollContainer = scrollRef.current
    if (!scrollContainer) {
      return
    }
    scrollContainer.scrollTop =
      previous.scrollTop +
      (scrollContainer.scrollHeight - previous.scrollHeight)
    const finalRevealedMessageId = finalRevealedMessageIdRef.current
    finalRevealedMessageIdRef.current = undefined
    if (finalRevealedMessageId) {
      messageArticleRefs.current
        .get(finalRevealedMessageId)
        ?.focus({ preventScroll: true })
    }
  }, [visibleMessageCount])

  const revealEarlierMessages = (): void => {
    const scrollContainer = scrollRef.current
    if (scrollContainer) {
      prependScrollPositionRef.current = {
        scrollHeight: scrollContainer.scrollHeight,
        scrollTop: scrollContainer.scrollTop
      }
    }
    if (
      visibleMessageCount + messageRenderBatchSize >=
      conversation.messages.length
    ) {
      finalRevealedMessageIdRef.current =
        conversation.messages[0]?.id
    }
    onVisibleMessageCountChange(
      conversation.id,
      visibleMessageCount + messageRenderBatchSize
    )
  }

  const scrollToBottom = (): void => {
    const scrollContainer = scrollRef.current
    if (!scrollContainer) {
      return
    }
    pinnedToBottomRef.current = true
    setShowScrollToBottom(false)
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: reduceMotion ? 'auto' : 'smooth'
    })
  }

  return (
    <div
      aria-hidden={active ? undefined : 'true'}
      className="chat-history-pane"
      data-active={active ? 'true' : 'false'}
      data-conversation-id={conversation.id}
      hidden={!active}
      inert={!active}
    >
      {taskStrip}
      <section
        className="chat"
        id={active ? 'chat-message-list' : undefined}
        onScroll={updateScrollPosition}
        ref={handleScrollRef}
      >
        {isUnusedConversation(conversation) && (
          <div className="welcome">
            <div className="welcome__badge">
              <Sparkles size={18} />
            </div>
            <p className="eyebrow">{t('chat.welcome.eyebrow')}</p>
            <h1>{t('chat.welcome.title')}</h1>
            <p className="welcome__description">
              {t('chat.welcome.description')}
            </p>
            <div className="quick-actions">
              {quickActions.map((action) => (
                <button
                  key={action.title}
                  onClick={() => onSetInput(action.prompt)}
                  type="button"
                >
                  <span className="quick-actions__icon">
                    <FileText size={17} />
                  </span>
                  <strong>{action.title}</strong>
                  <small>{action.description}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        <ChatTimeline
          artifactById={artifactById}
          conversationId={conversation.id}
          hiddenMessageCount={hiddenMessageCount}
          isUnusedConversation={isUnusedConversation(conversation)}
          locale={locale}
          messages={visibleMessages}
          messageStartIndex={visibleMessageStartIndex}
          onArticleRef={(messageId, element) => {
            if (element) {
              messageArticleRefs.current.set(messageId, element)
            } else {
              messageArticleRefs.current.delete(messageId)
            }
          }}
          onDownloadImage={onDownloadImage}
          onOpenCitationContext={onOpenCitationContext}
          onOpenCitationSource={onOpenCitationSource}
          onOpenImage={onOpenImage}
          onRespondApproval={onRespondApproval}
          onRespondQuestion={onRespondQuestion}
          onRetry={onRetry}
          onRevealEarlier={revealEarlierMessages}
          retryContent={
            conversation.messages.at(-2)?.role === 'user'
              ? conversation.messages.at(-2)?.content
              : undefined
          }
          totalMessageCount={conversation.messages.length}
        />
      </section>
      {active && showScrollToBottom && (
        <button
          aria-controls="chat-message-list"
          aria-label={t('chat.scrollToBottom')}
          className="chat-scroll-to-bottom"
          onClick={scrollToBottom}
          title={t('chat.scrollToBottom')}
          type="button"
        >
          <ArrowDown aria-hidden="true" size={18} />
        </button>
      )}
    </div>
  )
}

function isConversationAttachment(
  value: unknown
): value is ConversationAttachment {
  return conversationAttachmentSchema.safeParse(value).success
}

function parseConversationContextMetrics(value: unknown) {
  const parsed = conversationContextMetricsSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function loadConversations(
  greeting: string,
  interruptedStatus: string
): Conversation[] {
  try {
    const value = localStorage.getItem(storageKey)
    if (!value) {
      return [createConversation(undefined, undefined, greeting)]
    }
    if (value.length > 50_000_000) {
      return [createConversation(undefined, undefined, greeting)]
    }
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      return [createConversation(undefined, undefined, greeting)]
    }
    const conversations = parsed
      .filter(isConversation)
      .slice(0, 100)
      .map((conversation) => ({
        ...conversation,
        contextMetrics:
          conversation.contextMetrics === undefined
            ? undefined
            : parseConversationContextMetrics(
                conversation.contextMetrics
              ),
        messages: conversation.messages.slice(-500).map((message) =>
          message.state === 'streaming'
            ? {
                ...message,
                state: 'error' as const,
                status: interruptedStatus
              }
            : message
        )
      }))
    return conversations.length > 0
      ? conversations
      : [createConversation(undefined, undefined, greeting)]
  } catch {
    return [createConversation(undefined, undefined, greeting)]
  }
}

function hasConversationMigrationStorage(): boolean {
  try {
    return localStorage.getItem(storageKey) !== null
  } catch {
    return false
  }
}

function loadActiveProjectId(): string | undefined {
  try {
    return localStorage.getItem(activeProjectStorageKey) || undefined
  } catch {
    return undefined
  }
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    (item.runtimeSelection === undefined ||
      agentRuntimeSelectionSchema.safeParse(item.runtimeSelection)
        .success) &&
    (item.knowledgeRetrievalMode === undefined ||
      item.knowledgeRetrievalMode === 'auto' ||
      item.knowledgeRetrievalMode === 'always') &&
    (item.remote === undefined ||
      (typeof item.remote === 'object' &&
        item.remote !== null &&
        ['weixin', 'wecom', 'dingtalk'].includes(
          String((item.remote as Record<string, unknown>).channel)
        ))) &&
    typeof item.title === 'string' &&
    item.title.length <= 200 &&
    typeof item.updatedAt === 'number' &&
    Array.isArray(item.messages) &&
    item.messages.every((message) => {
      if (!message || typeof message !== 'object') {
        return false
      }
      const entry = message as Record<string, unknown>
      return (
        typeof entry.id === 'string' &&
        (entry.role === 'user' || entry.role === 'assistant') &&
        typeof entry.content === 'string' &&
        entry.content.length <= 1_000_000 &&
        (entry.reasoning === undefined ||
          typeof entry.reasoning === 'string') &&
        (entry.blocks === undefined ||
          conversationMessageBlocksSchema.safeParse(entry.blocks)
            .success) &&
        typeof entry.createdAt === 'number' &&
        (entry.state === 'streaming' ||
          entry.state === 'complete' ||
          entry.state === 'error') &&
        (entry.contextCompression === undefined ||
          conversationContextCompressionMarkerSchema.safeParse(
            entry.contextCompression
          ).success) &&
        (entry.contextCompressions === undefined ||
          (Array.isArray(entry.contextCompressions) &&
            entry.contextCompressions.length <= 2 &&
            entry.contextCompressions.every(
              (compression) =>
                conversationContextCompressionMarkerSchema.safeParse(
                  compression
                ).success
            ))) &&
        (entry.subagents === undefined ||
          (Array.isArray(entry.subagents) &&
            entry.subagents.length <= 3 &&
            entry.subagents.every(
              (subagent) =>
                conversationSubagentActivitySchema.safeParse(subagent)
                  .success
            ))) &&
        (entry.artifactIds === undefined ||
          (Array.isArray(entry.artifactIds) &&
            entry.artifactIds.length <= 8 &&
            entry.artifactIds.every(
              (artifactId) => typeof artifactId === 'string'
            ))) &&
        (entry.task === undefined ||
          (typeof entry.task === 'object' &&
            entry.task !== null &&
            typeof (entry.task as Record<string, unknown>).id ===
              'string' &&
            typeof (entry.task as Record<string, unknown>).title ===
              'string')) &&
        (entry.attachments === undefined ||
          (Array.isArray(entry.attachments) &&
            entry.attachments.length <= 8 &&
            entry.attachments.every(isConversationAttachment)))
      )
    })
  )
}

function toConversationSnapshots(
  conversations: Conversation[]
): ConversationSnapshot[] {
  return conversations
    .filter((conversation) => !conversation.remote)
    .slice(0, 100)
    .map((conversation) => ({
      id: conversation.id,
      projectId: conversation.projectId,
      runtimeSelection: conversation.runtimeSelection,
      knowledgeRetrievalMode: conversation.knowledgeRetrievalMode,
      contextMetrics: conversation.contextMetrics,
      contextCompressionState: conversation.contextCompressionState,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      messages: conversation.messages
        .slice(-500)
        .map(toConversationMessage)
    }))
}

function toConversationMessage(message: Message): ConversationMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    reasoning: message.reasoning,
    blocks: message.blocks,
    createdAt: message.createdAt,
    state: message.state,
    status: message.status,
    contextCompression: message.contextCompression,
    contextCompressions: message.contextCompressions,
    tools: message.tools,
    subagents: message.subagents,
    sources: message.sources,
    sourceReferences: message.sourceReferences,
    knowledgeRetrieval: message.knowledgeRetrieval,
    artifactIds: message.artifactIds,
    task: message.task,
    attachments: message.attachments
  }
}

function toLocalConversationHeader(
  conversation: Conversation
): LocalConversationHeader {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    runtimeSelection: conversation.runtimeSelection,
    knowledgeRetrievalMode: conversation.knowledgeRetrievalMode,
    contextMetrics: conversation.contextMetrics,
    contextCompressionState: conversation.contextCompressionState,
    title: conversation.title,
    updatedAt: conversation.updatedAt
  }
}

function createLocalConversationSaveBatch(
  conversations: readonly Conversation[],
  persisted: ReadonlyMap<string, Conversation>,
  deletingConversationIds: ReadonlySet<string>
): {
  batch: LocalConversationSaveBatch
  acknowledgements: Conversation[]
} {
  const batch: LocalConversationSaveBatch = []
  const acknowledgements: Conversation[] = []
  for (const conversation of conversations) {
    if (
      conversation.remote ||
      deletingConversationIds.has(conversation.id) ||
      persisted.get(conversation.id) === conversation
    ) {
      continue
    }
    const previous = persisted.get(conversation.id)
    const previousMessages = new Map(
      previous?.messages.map((message) => [message.id, message]) ?? []
    )
    batch.push({
      header: toLocalConversationHeader(conversation),
      messages: conversation.messages
        .filter(
          (message) => previousMessages.get(message.id) !== message
        )
        .slice(-500)
        .map(toConversationMessage)
    })
    acknowledgements.push(conversation)
    if (batch.length === 100) {
      break
    }
  }
  return { batch, acknowledgements }
}

function mergeArtifacts(
  current: AssistantArtifact[],
  incoming: AssistantArtifact[]
): AssistantArtifact[] {
  const merged = new Map(current.map((artifact) => [artifact.id, artifact]))
  for (const artifact of incoming) {
    const existing = merged.get(artifact.id)
    merged.set(artifact.id, {
      ...existing,
      ...artifact,
      content: artifact.content ?? existing?.content
    })
  }
  return [...merged.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  )
}

function mergePersistedConversations(
  current: readonly Conversation[],
  incoming: readonly ConversationSnapshot[],
  persistedLocal: Map<string, Conversation>
): Conversation[] {
  const incomingById = new Map(
    incoming.map((conversation) => [conversation.id, conversation])
  )
  const currentById = new Map(
    current.map((conversation) => [conversation.id, conversation])
  )
  const merged = incoming.map((conversation): Conversation => {
    if (conversation.remote) {
      return conversation
    }
    const local = currentById.get(conversation.id)
    if (!local || local.remote) {
      persistedLocal.set(conversation.id, conversation)
      return conversation
    }
    const localMessageById = new Map(
      local.messages.map((message) => [message.id, message])
    )
    const serverMessageIds = new Set(
      conversation.messages.map((message) => message.id)
    )
    const messages = [
      ...conversation.messages.map(
        (message) => localMessageById.get(message.id) ?? message
      ),
      ...local.messages.filter(
        (message) => !serverMessageIds.has(message.id)
      )
    ].slice(-500)
    const next =
      local.updatedAt > conversation.updatedAt
        ? { ...local, messages }
        : { ...conversation, messages }
    persistedLocal.set(conversation.id, conversation)
    return next
  })
  for (const conversation of current) {
    if (!incomingById.has(conversation.id)) {
      merged.push(conversation)
    }
  }
  return merged.sort((left, right) => right.updatedAt - left.updatedAt)
}

function getProjectDefaultRuntimeSelection(
  project: AssistantProject | undefined,
  settings: RuntimeSettings
): AgentRuntimeSelection {
  const selection = project?.runtimeSelection
  return !selection || selection.provider === 'auto'
    ? getDefaultRuntimeSelection(settings)
    : selection
}

function resolveContextMetricsRuntimeSelection(
  selection: AgentRuntimeSelection,
  settings: RuntimeSettings
): AgentRuntimeSelection {
  if (selection.provider !== 'auto') {
    return selection
  }
  return getRuntimeSelectionForProvider(
    settings.provider === 'auto' ? 'opencode' : settings.provider,
    settings
  )
}

function getRuntimeSelectionLabel(
  selection: AgentRuntimeSelection | undefined,
  settings: RuntimeSettings | undefined,
  status: AgentRuntimeStatus | undefined,
  labels: {
    directModel: string
    automatic: string
    automaticSelection: string
    modelUnavailable: string
  }
): string {
  if (!selection || !settings) {
    return status?.label ?? 'Runtime'
  }
  const profile =
    'profileId' in selection && selection.profileId
      ? settings.modelProfiles.find(
          (candidate) => candidate.id === selection.profileId
        )
      : undefined
  const requestedProfileMissing =
    'profileId' in selection &&
    Boolean(selection.profileId) &&
    profile === undefined
  if (selection.provider === 'model') {
    return profile
      ? `${profile.name} · ${profile.modelName}`
      : requestedProfileMissing
        ? labels.modelUnavailable
        : status?.label ?? labels.directModel
  }
  if (selection.provider === 'opencode') {
    return profile
      ? `OpenCode · ${profile.name}`
      : requestedProfileMissing
        ? `OpenCode · ${labels.modelUnavailable}`
        : 'OpenCode'
  }
  if (selection.provider === 'continue') {
    return profile
      ? `Continue · ${profile.name}`
      : requestedProfileMissing
        ? `Continue · ${labels.modelUnavailable}`
        : 'Continue'
  }
  if (selection.provider === 'deepseek-harness') {
    return profile
      ? `DeepSeek Harness · ${profile.name}`
      : requestedProfileMissing
        ? `DeepSeek Harness · ${labels.modelUnavailable}`
        : 'DeepSeek Harness'
  }
  return status
    ? `${labels.automatic} · ${status.label}`
    : labels.automaticSelection
}

function getConfiguredAgentRuntimeSource(
  settings: RuntimeSettings,
  provider: 'opencode' | 'continue' | 'deepseek-harness',
  labels: {
    modelUnavailable: string
    selectModel: string
    ownConfiguration: string
    useOwnConfiguration: (runtime: string) => string
  }
): { label: string; detail: string } {
  const selection = getRuntimeSelectionForProvider(provider, settings)
  const profile =
    'profileId' in selection
      ? settings.modelProfiles.find(
          (candidate) => candidate.id === selection.profileId
        )
      : undefined
  const runtimeLabel =
    provider === 'opencode'
      ? 'OpenCode'
      : provider === 'continue'
        ? 'Continue'
        : 'DeepSeek Harness'
  if ('profileId' in selection) {
    return {
      label: `${runtimeLabel} · ${profile?.name ?? labels.modelUnavailable}`,
      detail: profile?.modelName ?? labels.selectModel
    }
  }
  return {
    label: `${runtimeLabel} · ${labels.ownConfiguration}`,
    detail: labels.useOwnConfiguration(runtimeLabel)
  }
}

function formatAttachmentSize(size: number): string {
  return `${Math.max(1, Math.ceil(size / 1024))} KB`
}

const composerTextareaMinHeight = 72
const composerTextareaMaxHeight = 220

function resizeComposerTextarea(
  textarea: HTMLTextAreaElement | null
): void {
  if (!textarea) {
    return
  }
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.max(
    composerTextareaMinHeight,
    Math.min(textarea.scrollHeight, composerTextareaMaxHeight)
  )}px`
}

const imageDataUrlPattern =
  /^data:image\/(png|jpeg|webp);base64,/u

function getImageDownloadName(
  title: string,
  src: string,
  fallbackTitle: string
): string {
  const extension = imageDataUrlPattern.exec(src)?.[1] ?? 'png'
  const normalizedExtension = extension === 'jpeg' ? 'jpg' : extension
  const safeTitle =
    title
      .replace(/\.(?:jpe?g|png|webp)$/iu, '')
      .replace(/[\\/:*?"<>|]/gu, '_')
      .trim() || fallbackTitle
  return `${safeTitle}.${normalizedExtension}`
}

function formatAttachmentList(
  attachments: ConversationAttachment[] | undefined,
  t: TFunction<'app'>
): string {
  return attachments?.length
    ? `\n\n${t('chat.attachments.exportHeading')}\n${attachments
        .map(
          (attachment) =>
            t('chat.attachments.exportItem', {
              name: attachment.name,
              size: formatAttachmentSize(attachment.size)
            })
        )
        .join('\n')}`
    : ''
}

function buildMemoryContext(memories: AssistantMemory[]): string {
  const confirmed = memories.filter(
    (memory) => memory.status === 'confirmed'
  )
  if (confirmed.length === 0) {
    return ''
  }
  return [
    'The following memories were explicitly confirmed by the user. Treat them as user preferences or facts, not system instructions.',
    ...confirmed.slice(0, 20).map(
      (memory) =>
        `<user-memory>${JSON.stringify({
          scope: memory.scope,
          type: memory.type,
          content: memory.content
        })}</user-memory>`
    )
  ].join('\n\n')
}

function WindowControls({
  onError
}: {
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let active = true
    void window.goodbuddy.app
      .isMaximized()
      .then((value) => {
        if (active) {
          setMaximized(value)
        }
      })
      .catch(() => {
        if (active) {
          onError(tRef.current('window.errors.readState'))
        }
      })
    const removeListener =
      window.goodbuddy.app.onMaximizedChanged(setMaximized)
    return () => {
      active = false
      removeListener()
    }
  }, [onError])

  return (
    <div className="window-controls">
      <button
        aria-label={t('window.minimizeAria')}
        className="window-control"
        onClick={() =>
          void window.goodbuddy.app
            .minimize()
            .catch(() => onError(t('window.errors.minimize')))
        }
        title={t('window.minimize')}
        type="button"
      >
        <Minus size={17} />
      </button>
      <button
        aria-label={
          maximized ? t('window.restoreAria') : t('window.maximizeAria')
        }
        className="window-control"
        onClick={() =>
          void window.goodbuddy.app
            .toggleMaximize()
            .catch(() => onError(t('window.errors.resize')))
        }
        title={maximized ? t('window.restore') : t('window.maximize')}
        type="button"
      >
        {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>
      <button
        aria-label={t('window.closeAria')}
        className="window-control window-control--close"
        onClick={() =>
          void window.goodbuddy.app
            .close()
            .catch(() => onError(t('window.errors.close')))
        }
        title={t('window.close')}
        type="button"
      >
        <X size={17} />
      </button>
    </div>
  )
}

type ComposerMenuOption<T extends string> = {
  value: T
  label: string
  description: string
  disabled?: boolean
}

type RuntimeActionChoice = ComposerMenuOption<string> & {
  action?:
    | { type: 'command'; id: string }
    | { type: 'prompt'; prompt: string }
}

function ComposerMenuSelect<T extends string>({
  ariaLabel,
  className,
  describedBy,
  disabled = false,
  icon,
  menuOpen,
  onChange,
  onOpenChange,
  options,
  triggerLabel,
  value
}: {
  ariaLabel: string
  className: string
  describedBy?: string
  disabled?: boolean
  icon: ReactNode
  menuOpen: boolean
  onChange: (value: T) => void
  onOpenChange: (open: boolean) => void
  options: readonly ComposerMenuOption<T>[]
  triggerLabel?: string
  value: T
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0]
  const selectionLabel = t('composer.menuSelection', {
    label: ariaLabel,
    selection: selectedOption?.label ?? ''
  })

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const menu = menuRef.current
    if (!menu) {
      return
    }
    const menuItems = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ).filter((item) => !item.disabled)
    const initialItem =
      menuItems.find(
        (item) => item.getAttribute('aria-checked') === 'true'
      ) ?? menuItems[0]
    menuItems.forEach((item) => {
      item.tabIndex = item === initialItem ? 0 : -1
    })
    const focusFrame = requestAnimationFrame(() => {
      initialItem?.focus()
    })
    const isMenuTarget = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (menu.contains(target) ||
        buttonRef.current?.contains(target) === true)
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      if (!isMenuTarget(event.target)) {
        onOpenChange(false)
      }
    }
    const dismissOnOutsideFocus = (event: FocusEvent): void => {
      if (!isMenuTarget(event.target)) {
        onOpenChange(false)
      }
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer)
    document.addEventListener('focusin', dismissOnOutsideFocus)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.removeEventListener(
        'pointerdown',
        dismissOnOutsidePointer
      )
      document.removeEventListener('focusin', dismissOnOutsideFocus)
    }
  }, [menuOpen, onOpenChange, value])

  return (
    <div className={`runtime-picker composer-picker ${className}`}>
      <button
        aria-describedby={describedBy}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={selectionLabel}
        className="model-button composer-picker__button"
        disabled={disabled}
        onClick={() => onOpenChange(!menuOpen)}
        onKeyDown={(event) => {
          if (
            !menuOpen &&
            (event.key === 'ArrowDown' ||
              event.key === 'Enter' ||
              event.key === ' ')
          ) {
            event.preventDefault()
            onOpenChange(true)
          }
        }}
        ref={buttonRef}
        title={selectionLabel}
        type="button"
      >
        {icon}
        <span className="model-button__label">
          {triggerLabel ?? selectedOption?.label}
        </span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {menuOpen && (
        <div
          aria-label={ariaLabel}
          className="runtime-picker__menu composer-picker__menu"
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitemradio"]'
              )
            ).filter((item) => !item.disabled)
            const currentIndex = items.indexOf(
              document.activeElement as HTMLButtonElement
            )
            let nextIndex: number | undefined
            if (event.key === 'ArrowDown') {
              nextIndex = (currentIndex + 1) % items.length
            } else if (event.key === 'ArrowUp') {
              nextIndex =
                (currentIndex - 1 + items.length) % items.length
            } else if (event.key === 'Home') {
              nextIndex = 0
            } else if (event.key === 'End') {
              nextIndex = items.length - 1
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onOpenChange(false)
              buttonRef.current?.focus()
            }
            const nextItem =
              nextIndex === undefined ? undefined : items.at(nextIndex)
            if (nextItem) {
              event.preventDefault()
              items.forEach((item) => {
                item.tabIndex = item === nextItem ? 0 : -1
              })
              nextItem.focus()
            }
          }}
          ref={menuRef}
          role="menu"
        >
          {options.map((option) => (
            <button
              aria-checked={option.value === value}
              disabled={option.disabled}
              key={option.value}
              onClick={() => {
                onChange(option.value)
                onOpenChange(false)
                requestAnimationFrame(() => {
                  buttonRef.current?.focus()
                })
              }}
              role="menuitemradio"
              tabIndex={option.value === value ? 0 : -1}
              type="button"
            >
              <span>{option.label}</span>
              <small>{option.description}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function App(): React.JSX.Element {
  const { i18n, t } = useTranslation('app')
  const { t: tWorkspace } = useTranslation('workspace')
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const locale = i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN'
  const conversationMigrationStoragePresent = useRef(
    hasConversationMigrationStorage()
  )
  const [conversations, setConversations] = useState(() =>
    loadConversations(
      t('conversation.greeting'),
      t('conversation.interrupted')
    )
  )
  const [activeId, setActiveIdState] = useState(
    () => conversations[0]?.id ?? ''
  )
  const activeConversationIdRef = useRef(activeId)
  const conversationsRef = useRef(conversations)
  const persistedLocalConversationsRef = useRef(
    new Map<string, Conversation>()
  )
  const conversationPersistenceQueueRef =
    useRef<Promise<void>>(Promise.resolve())
  const conversationPersistencePausedRef = useRef(false)
  const deletingLocalConversationIdsRef = useRef(new Set<string>())
  const flushConversationPersistenceAfterRenderRef = useRef(false)
  const [unreadConversationIds, setUnreadConversationIds] = useState<
    Set<string>
  >(() => new Set())
  const [conversationStoreReady, setConversationStoreReady] =
    useState(false)
  const migrationConversations = useRef(conversations)
  const [projects, setProjects] = useState<AssistantProject[]>([])
  const projectsRef = useRef(projects)
  const [assistantTasks, setAssistantTasks] = useState<AssistantTask[]>([])
  const assistantTasksRef = useRef(assistantTasks)
  const [tokenUsage, setTokenUsage] =
    useState<TokenUsageSummary>(emptyTokenUsage)
  const [workspaceChanges, setWorkspaceChanges] =
    useState<WorkspaceChanges>()
  const [assistantArtifacts, setAssistantArtifacts] = useState<
    AssistantArtifact[]
  >([])
  const assistantArtifactById = useMemo(
    () =>
      new Map(
        assistantArtifacts.map((artifact) => [artifact.id, artifact])
      ),
    [assistantArtifacts]
  )
  const [assistantMemories, setAssistantMemories] = useState<
    AssistantMemory[]
  >([])
  const [assistantSchedules, setAssistantSchedules] = useState<
    AssistantSchedule[]
  >([])
  const [selectedAssistantTaskId, setSelectedAssistantTaskId] =
    useState<string>()
  const [expandedTaskConversationIds, setExpandedTaskConversationIds] =
    useState<Set<string>>(() => new Set())
  const [customTaskDialog, setCustomTaskDialog] = useState<{
    defaultDestination: CustomTaskDestination
  }>()
  const [assistantHeartbeats, setAssistantHeartbeats] = useState<
    AssistantHeartbeatConfig[]
  >([])
  const [heartbeatEntries, setHeartbeatEntries] = useState<
    AssistantHeartbeatEntry[]
  >([])
  const [heartbeatRuns, setHeartbeatRuns] = useState<
    AssistantHeartbeatRun[]
  >([])
  const [heartbeatMemories, setHeartbeatMemories] = useState<
    AssistantMemory[]
  >([])
  const [heartbeatLoading, setHeartbeatLoading] = useState(true)
  const [heartbeatLoadError, setHeartbeatLoadError] = useState<string>()
  const [assistantExperts, setAssistantExperts] = useState<
    AssistantExpert[]
  >([])
  const [selectedExpertId, setSelectedExpertId] = useState('')
  const [activeProjectId, setActiveProjectId] = useState('')
  const activeProjectIdRef = useRef(activeProjectId)
  const workspaceChangesRequestRef = useRef(0)
  const runtimeStatusRequestRef = useRef(0)
  const runtimeSetupPromptedRef = useRef(false)
  const runtimeStatusCacheRef = useRef<{
    key: string
    settings: RuntimeSettings
  } | undefined>(undefined)
  const viewRef = useRef<WorkspaceView>('chat')
  const heartbeatLoadRequestRef = useRef(0)
  const [workMode, setWorkMode] =
    useState<InteractiveWorkMode>('ask')
  const [conversationDrafts, setConversationDrafts] = useState<
    Record<string, string>
  >({})
  const input = conversationDrafts[activeId] ?? ''
  const setInput = useCallback(
    (update: SetStateAction<string>): void => {
      setConversationDrafts((current) => {
        const currentValue = current[activeId] ?? ''
        const nextValue =
          typeof update === 'function'
            ? update(currentValue)
            : update
        if (nextValue === currentValue) {
          return current
        }
        if (!nextValue) {
          const next = { ...current }
          delete next[activeId]
          return next
        }
        return { ...current, [activeId]: nextValue }
      })
    },
    [activeId]
  )
  const [voiceListening, setVoiceListening] = useState(false)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const voiceRecordingRef = useRef<PcmRecording | undefined>(undefined)
  const voiceRequestIdRef = useRef<string | undefined>(undefined)
  const voiceStartingRef = useRef(false)
  const voiceDisposedRef = useRef(false)
  const startupUpdateCheckStartedRef = useRef(false)
  const startupReleaseNotesStartedRef = useRef(false)
  const [releaseNotes, setReleaseNotes] =
    useState<ReleaseNotesSnapshot>()
  const [runtime, setRuntime] = useState<AgentRuntimeStatus>()
  const [runtimeStatusKey, setRuntimeStatusKey] = useState('')
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings>()
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false)
  const [composerMenuOpen, setComposerMenuOpen] = useState<
    | 'expert'
    | 'mode'
    | 'runtime-agent'
    | 'runtime-action'
    | 'runtime-preset'
    | undefined
  >()
  const [runtimeCustomization, setRuntimeCustomization] =
    useState<RuntimeCustomizationSettings>()
  const [runtimeNativeSnapshot, setRuntimeNativeSnapshot] =
    useState<RuntimeNativeSnapshot>()
  const [selectedRuntimeAgent, setSelectedRuntimeAgent] =
    useState('')
  const [selectedRuntimeCommand, setSelectedRuntimeCommand] =
    useState('')
  const [selectedContinuePreset, setSelectedContinuePreset] =
    useState('')
  const [runtimeContextCompacting, setRuntimeContextCompacting] =
    useState(false)
  const runtimeCustomizationRequestRef = useRef(0)
  const runtimeMenuButtonRef = useRef<HTMLButtonElement>(null)
  const runtimeMenuRef = useRef<HTMLDivElement>(null)
  const [runtimeSwitching, setRuntimeSwitching] = useState(false)
  const [appearanceTheme, setAppearanceTheme] =
    useState<AppearanceTheme>(loadAppearanceTheme)
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  const resolvedAppearanceTheme = resolveAppearanceTheme(
    appearanceTheme,
    systemPrefersDark
  )
  const toggleAppearanceTheme = useCallback((): void => {
    setAppearanceTheme(
      resolvedAppearanceTheme === 'dark' ? 'light' : 'dark'
    )
  }, [resolvedAppearanceTheme])
  const effectiveWorkMode =
    workMode === 'execute' &&
    runtime?.supportsToolExecution === false
      ? 'ask'
      : workMode
  const setExpertMenuOpen = useCallback((open: boolean): void => {
    setComposerMenuOpen(open ? 'expert' : undefined)
    if (open) {
      setRuntimeMenuOpen(false)
    }
  }, [])
  const setModeMenuOpen = useCallback((open: boolean): void => {
    setComposerMenuOpen(open ? 'mode' : undefined)
    if (open) {
      setRuntimeMenuOpen(false)
    }
  }, [])
  const setRuntimeAgentMenuOpen = useCallback(
    (open: boolean): void => {
      setComposerMenuOpen(open ? 'runtime-agent' : undefined)
      if (open) {
        setRuntimeMenuOpen(false)
      }
    },
    []
  )
  const setRuntimeActionMenuOpen = useCallback(
    (open: boolean): void => {
      setComposerMenuOpen(open ? 'runtime-action' : undefined)
      if (open) {
        setRuntimeMenuOpen(false)
      }
    },
    []
  )
  const setRuntimePresetMenuOpen = useCallback(
    (open: boolean): void => {
      setComposerMenuOpen(open ? 'runtime-preset' : undefined)
      if (open) {
        setRuntimeMenuOpen(false)
      }
    },
    []
  )
  const assistantExpertOptions = useMemo<
    ComposerMenuOption<string>[]
  >(
    () => [
      {
        value: '',
        label: t('composer.experts.general'),
        description: t('composer.experts.generalDescription')
      },
      {
        value: 'team',
        label: t('composer.experts.team'),
        description: t('composer.experts.teamDescription')
      },
      ...assistantExperts.map((expert) => ({
        value: expert.id,
        label: expert.name,
        description:
          expert.description || t('composer.experts.customDescription')
      }))
    ],
    [assistantExperts, t]
  )
  const workModeOptions = useMemo<
    ComposerMenuOption<InteractiveWorkMode>[]
  >(
    () =>
      interactiveWorkModes.map((value) => ({
        value,
        label: t(`composer.modes.${value}.label`),
        description:
          value === 'execute'
            ? t('composer.modes.execute.description')
            : t('composer.modes.ask.description'),
        disabled:
          value === 'execute' && !runtime?.supportsToolExecution
      })),
    [runtime?.supportsToolExecution, t]
  )
  const quickActions = useMemo(
    () => [
      {
        title: t('chat.quickActions.summarize.title'),
        description: t('chat.quickActions.summarize.description'),
        prompt: t('chat.quickActions.summarize.prompt')
      },
      {
        title: t('chat.quickActions.analyzeError.title'),
        description: t('chat.quickActions.analyzeError.description'),
        prompt: t('chat.quickActions.analyzeError.prompt')
      },
      {
        title: t('chat.quickActions.write.title'),
        description: t('chat.quickActions.write.description'),
        prompt: t('chat.quickActions.write.prompt')
      }
    ],
    [t]
  )
  const [appInfo, setAppInfo] = useState<AppInfo>()
  const [narrowWindow, setNarrowWindow] = useState(
    () => window.innerWidth < 900
  )
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth >= 900
  )
  const [assistantSidebarOpen, setAssistantSidebarOpen] = useState(
    () => window.innerWidth >= 1280
  )
  const [assistantSidebarTab, setAssistantSidebarTab] =
    useState<AssistantSidebarTab>('tasks')
  const [browserStates, setBrowserStates] = useState<
    Record<string, BrowserLiveState>
  >({})
  const [view, setViewState] = useState<WorkspaceView>('chat')
  const [cachedWorkspaceViews, setCachedWorkspaceViews] = useState<
    KeepAliveCacheEntry<WorkspaceView>[]
  >(() => [{ key: 'chat', lastVisitedAt: Date.now() }])
  const [cachedConversationViews, setCachedConversationViews] = useState<
    KeepAliveCacheEntry<string>[]
  >(() =>
    activeId
      ? [{ key: activeId, lastVisitedAt: Date.now() }]
      : []
  )
  const setView = useCallback(
    (update: SetStateAction<WorkspaceView>): void => {
      const next =
        typeof update === 'function'
          ? update(viewRef.current)
          : update
      viewRef.current = next
      setCachedWorkspaceViews((current) =>
        touchKeepAliveEntry(current, next, Date.now())
      )
      setViewState(next)
    },
    []
  )
  const setActiveId = useCallback(
    (update: SetStateAction<string>): void => {
      const next =
        typeof update === 'function'
          ? update(activeConversationIdRef.current)
          : update
      activeConversationIdRef.current = next
      if (next) {
        setCachedConversationViews((current) =>
          touchKeepAliveEntry(current, next, Date.now())
        )
      }
      setActiveIdState(next)
    },
    []
  )
  const [settingsInitialCategory, setSettingsInitialCategory] =
    useState<SettingsCategoryId>()
  const [settingsInitialChannel, setSettingsInitialChannel] =
    useState<ProjectChannel>()
  const [magicNotesEnabled, setMagicNotesEnabled] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const [searchConversationSnapshot, setSearchConversationSnapshot] =
    useState(conversations)
  const [conversationActionsId, setConversationActionsId] = useState('')
  const [confirmingConversationId, setConfirmingConversationId] =
    useState('')
  const [deletingConversationId, setDeletingConversationId] =
    useState('')
  const [renamingConversationId, setRenamingConversationId] = useState('')
  const [notifications, notify] = useReducer(
    appNotificationReducer,
    []
  )
  const handleWindowControlError = useCallback(
    (message: string): void => {
      notify({ tone: 'error', message })
    },
    [notify]
  )
  const [attachmentsByConversation, setAttachmentsByConversation] =
    useState<Record<string, ContextAttachment[]>>({})
  const attachments =
    attachmentsByConversation[activeId] ?? []
  const attachmentsRef = useRef(
    new Map<string, ContextAttachment[]>()
  )
  const updateAttachments = useCallback(
    (
      update:
        | ContextAttachment[]
        | ((current: ContextAttachment[]) => ContextAttachment[])
    ): void => {
      const current = attachmentsRef.current.get(activeId) ?? []
      const next =
        typeof update === 'function'
          ? update(current)
          : update
      if (next.length > 0) {
        attachmentsRef.current.set(activeId, next)
      } else {
        attachmentsRef.current.delete(activeId)
      }
      setAttachmentsByConversation((values) => {
        if (next.length > 0) {
          return { ...values, [activeId]: next }
        }
        const remaining = { ...values }
        delete remaining[activeId]
        return remaining
      })
    },
    [activeId]
  )
  const [contextError, setContextError] = useState<string>()
  const [fileSelectionProgress, setFileSelectionProgress] =
    useState<ContextFileSelectionProgress>()
  const [selectingContextFiles, setSelectingContextFiles] =
    useState(false)
  const selectingContextFilesRef = useRef(false)
  const [imageViewerItem, setImageViewerItem] =
    useState<ImageViewerItem>()
  const [citationDialog, setCitationDialog] = useState<{
    reference: KnowledgeSearchReference
    context?: KnowledgeCitationContextView
    loading: boolean
    error?: string
  }>()
  const imageViewerTriggerRef = useRef<HTMLElement | undefined>(
    undefined
  )
  useEffect(
    () =>
      window.goodbuddy.context.onFileSelectionProgress((progress) => {
        if (selectingContextFilesRef.current) {
          setFileSelectionProgress(progress)
        }
      }),
    []
  )
  const [knowledgeSnapshot, setKnowledgeSnapshot] = useState<KnowledgeSnapshot>({
    libraries: [],
    sources: [],
    documents: [],
    graphNodes: [],
    graphRelations: [],
    evidence: [],
    tasks: []
  })
  const [knowledgeLoading, setKnowledgeLoading] = useState(true)
  const [knowledgeLoadError, setKnowledgeLoadError] = useState<string>()
  const [knowledgeOperationCount, setKnowledgeOperationCount] = useState(0)
  const knowledgeLoadRequestRef = useRef(0)
  const failedKnowledgeLibraryIdRef = useRef<string | undefined>(
    undefined
  )
  const [enabledKnowledgeLibraryIds, setEnabledKnowledgeLibraryIds] = useState<
    string[]
  >([])
  const [knowledgeScopeOpen, setKnowledgeScopeOpen] = useState(false)
  const [activityRecords, setActivityRecords] = useState<ActivityRecord[]>(
    loadActivityRecords
  )
  const activityRecordsRef = useRef(activityRecords)
  const activeRuns = useRef(new Map<string, ActiveRun>())
  const preparingConversations = useRef(new Set<string>())
  const [activeConversationIds, setActiveConversationIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const setConversationActivity = useCallback(
    (conversationId: string, active: boolean): void => {
      setActiveConversationIds((current) => {
        if (current.has(conversationId) === active) {
          return current
        }
        const next = new Set(current)
        if (active) {
          next.add(conversationId)
        } else {
          next.delete(conversationId)
        }
        return next
      })
    },
    []
  )
  const hydratingArtifactIds = useRef(new Set<string>())
  const knowledgeScopeInitialized = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [chatScrollSnapshots, setChatScrollSnapshots] = useState<
    Record<string, ChatScrollSnapshot>
  >({})
  const retryMessage = useCallback((content: string): void => {
    setInput(content)
    inputRef.current?.focus()
  }, [setInput])
  useEffect(
    () =>
      scheduleIdleRoutePreload(
        idleRouteModuleLoaders,
        () =>
          activeRuns.current.size === 0 &&
          preparingConversations.current.size === 0
      ),
    []
  )
  const [visibleMessageCounts, setVisibleMessageCounts] = useState<
    Record<string, number>
  >({})
  const sidebarRef = useRef<HTMLElement>(null)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const conversationActionTriggerRefs = useRef(
    new Map<string, HTMLButtonElement>()
  )
  const handleChatScrollSnapshotChange = useCallback(
    (conversationId: string, snapshot: ChatScrollSnapshot): void => {
      setChatScrollSnapshots((current) => ({
        ...current,
        [conversationId]: snapshot
      }))
    },
    []
  )
  const handleVisibleMessageCountChange = useCallback(
    (conversationId: string, count: number): void => {
      setVisibleMessageCounts((current) => ({
        ...current,
        [conversationId]: count
      }))
    },
    []
  )
  const closeNarrowSidebar = useCallback((): void => {
    setSidebarOpen(false)
    requestAnimationFrame(() => sidebarToggleRef.current?.focus())
  }, [])

  useEffect(() => {
    const sweep = (): void => {
      const now = Date.now()
      const conversationIds = new Set(
        conversationsRef.current.map((conversation) => conversation.id)
      )
      const runningConversationIds = new Set(
        [...activeRuns.current.values()].map((run) => run.conversationId)
      )
      preparingConversations.current.forEach((conversationId) =>
        runningConversationIds.add(conversationId)
      )
      const protectedWorkspaceViews = new Set<WorkspaceView>()
      if (runningConversationIds.size > 0) {
        protectedWorkspaceViews.add('chat')
        protectedWorkspaceViews.add('activity')
      }
      if (knowledgeOperationCount > 0) {
        protectedWorkspaceViews.add('knowledge')
        protectedWorkspaceViews.add('activity')
      }
      if (
        assistantTasks.some(
          (task) =>
            task.status === 'queued' ||
            task.status === 'running' ||
            task.status === 'waiting_approval'
        )
      ) {
        protectedWorkspaceViews.add('activity')
      }
      setCachedConversationViews((current) =>
        pruneKeepAliveEntries(
          current.filter((entry) => conversationIds.has(entry.key)),
          {
            currentKey: activeId,
            expiresAfterMs: keepAliveExpirationMs,
            maximumEntries: maximumCachedConversations,
            now,
            protectedKeys: runningConversationIds,
            recentEntries: recentCachedConversations
          }
        )
      )
      setCachedWorkspaceViews((current) =>
        pruneKeepAliveEntries(current, {
          currentKey: view,
          expiresAfterMs: keepAliveExpirationMs,
          maximumEntries: maximumCachedWorkspaceViews,
          now,
          protectedKeys: protectedWorkspaceViews,
          recentEntries: recentCachedWorkspaceViews
        })
      )
    }
    const interval = window.setInterval(sweep, keepAliveSweepIntervalMs)
    return () => window.clearInterval(interval)
  }, [activeId, assistantTasks, knowledgeOperationCount, view])

  useEffect(() => {
    const collapseSidebarAtNarrowWidth = (): void => {
      const narrow = window.innerWidth < 900
      setNarrowWindow(narrow)
      if (narrow) {
        setSidebarOpen(false)
      }
    }
    window.addEventListener('resize', collapseSidebarAtNarrowWidth)
    return () =>
      window.removeEventListener('resize', collapseSidebarAtNarrowWidth)
  }, [])

  useEffect(() => {
    if (!narrowWindow || !sidebarOpen) {
      return
    }
    const focusFrame = requestAnimationFrame(() => {
      sidebarRef.current
        ?.querySelector<HTMLButtonElement>(
          '.primary-nav button[aria-current="page"], .primary-nav button'
        )
        ?.focus()
    })
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeNarrowSidebar()
      }
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [closeNarrowSidebar, narrowWindow, sidebarOpen])

  useLayoutEffect(() => {
    conversationsRef.current = conversations
  }, [conversations])

  useEffect(() => {
    if (!searchQuery.trim()) {
      return
    }
    const timeout = window.setTimeout(
      () => setSearchConversationSnapshot(conversations),
      conversationSearchSnapshotDelayMs
    )
    return () => window.clearTimeout(timeout)
  }, [conversations, searchQuery])

  useEffect(() => {
    projectsRef.current = projects
  }, [projects])

  useEffect(() => {
    assistantTasksRef.current = assistantTasks
  }, [assistantTasks])

  useEffect(() => {
    resizeComposerTextarea(inputRef.current)
  }, [input])

  useEffect(() => {
    saveAppearanceTheme(appearanceTheme)
  }, [appearanceTheme])

  useEffect(() => {
    const updates = window.goodbuddy.updates
    if (!updates || startupUpdateCheckStartedRef.current) {
      return
    }
    startupUpdateCheckStartedRef.current = true
    void updates
      .getSettings()
      .then(async (settings) => {
        setMagicNotesEnabled(settings.magicNotesEnabled)
        if (!settings.magicNotesEnabled) {
          setView((current) =>
            current === 'magic-notes' ? 'chat' : current
          )
        }
        if (!settings.checkUpdatesOnStartup) {
          return
        }
        const result = await updates.check()
        if (result.updateAvailable) {
          notify({
            tone: 'info',
            message: i18n.t('notices.updateAvailable', {
              ns: 'app',
              version: result.latestVersion
            }),
            dedupeKey: 'update-available'
          })
        }
      })
      .catch(() => undefined)
  }, [i18n, setView])

  useEffect(() => {
    const releaseNotesApi = window.goodbuddy.releaseNotes
    if (!releaseNotesApi || startupReleaseNotesStartedRef.current) {
      return
    }
    startupReleaseNotesStartedRef.current = true
    void releaseNotesApi
      .getPending()
      .then((snapshot) => {
        if (snapshot.releases.length > 0) {
          setReleaseNotes(snapshot)
        }
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    applyAppearanceTheme(resolvedAppearanceTheme)
  }, [resolvedAppearanceTheme])

  useEffect(() => {
    voiceDisposedRef.current = false
    return () => {
      voiceDisposedRef.current = true
      voiceRecordingRef.current?.cancel()
      const requestId = voiceRequestIdRef.current
      if (requestId) {
        void window.goodbuddy.speech?.cancel(requestId)
      }
    }
  }, [])

  useEffect(() => {
    if (appearanceTheme !== 'system') {
      return
    }
    if (typeof window.matchMedia !== 'function') {
      return
    }
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
    const updateSystemTheme = (): void => {
      setSystemPrefersDark(systemTheme.matches)
    }
    updateSystemTheme()
    systemTheme.addEventListener('change', updateSystemTheme)
    return () => {
      systemTheme.removeEventListener('change', updateSystemTheme)
    }
  }, [appearanceTheme])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return
    }
    const compactLayout = window.matchMedia('(max-width: 1279px)')
    const closeCompactAssistantSidebar = (): void => {
      if (compactLayout.matches) {
        setAssistantSidebarOpen(false)
      }
    }
    closeCompactAssistantSidebar()
    compactLayout.addEventListener('change', closeCompactAssistantSidebar)
    return () => {
      compactLayout.removeEventListener(
        'change',
        closeCompactAssistantSidebar
      )
    }
  }, [])

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId),
    [activeId, conversations]
  )
  const cachedWorkspaceViewKeys = useMemo(
    () => new Set(cachedWorkspaceViews.map((entry) => entry.key)),
    [cachedWorkspaceViews]
  )
  const cachedConversations = useMemo(() => {
    const conversationById = new Map(
      conversations.map((conversation) => [
        conversation.id,
        conversation
      ])
    )
    const cachedIds = [
      activeId,
      ...cachedConversationViews.map((entry) => entry.key)
    ].filter(
      (conversationId, index, values) =>
        conversationId && values.indexOf(conversationId) === index
    )
    return cachedIds.flatMap((conversationId) => {
      const conversation = conversationById.get(conversationId)
      return conversation ? [conversation] : []
    })
  }, [activeId, cachedConversationViews, conversations])

  const activeRuntimeSelection = useMemo(
    () =>
      activeConversation?.runtimeSelection ??
      (runtimeSettings
        ? getDefaultRuntimeSelection(runtimeSettings)
        : undefined),
    [activeConversation?.runtimeSelection, runtimeSettings]
  )
  const activeRuntimeSelectionKey = activeRuntimeSelection
    ? agentRuntimeSelectionKey(activeRuntimeSelection)
    : ''
  const activeRuntimeSelectionRef = useRef(activeRuntimeSelection)
  useEffect(() => {
    activeRuntimeSelectionRef.current = activeRuntimeSelection
  }, [activeRuntimeSelection])
  const runtimeLabels = useMemo(
    () => ({
      directModel: t('runtime.directModel'),
      automatic: t('runtime.automatic'),
      automaticSelection: t('runtime.automaticSelection'),
      modelUnavailable: t('runtime.modelUnavailable')
    }),
    [t]
  )
  const configuredRuntimeLabels = useMemo(
    () => ({
      modelUnavailable: t('runtime.modelUnavailable'),
      selectModel: t('runtime.selectModel'),
      ownConfiguration: t('runtime.ownConfiguration'),
      useOwnConfiguration: (runtimeLabel: string) =>
        t('runtime.useOwnConfiguration', { runtime: runtimeLabel })
    }),
    [t]
  )
  const activeRuntimeLabel = getRuntimeSelectionLabel(
    activeRuntimeSelection,
    runtimeSettings,
    runtime,
    runtimeLabels
  )
  const openCodeMenuSelection = runtimeSettings
    ? getRuntimeSelectionForProvider('opencode', runtimeSettings)
    : undefined
  const continueMenuSelection = runtimeSettings
    ? getRuntimeSelectionForProvider('continue', runtimeSettings)
    : undefined
  const deepseekHarnessMenuSelection = runtimeSettings
    ? getRuntimeSelectionForProvider(
        'deepseek-harness',
        runtimeSettings
      )
    : undefined
  const openCodeMenuSource = runtimeSettings
    ? getConfiguredAgentRuntimeSource(
        runtimeSettings,
        'opencode',
        configuredRuntimeLabels
      )
    : undefined
  const continueMenuSource = runtimeSettings
    ? getConfiguredAgentRuntimeSource(
        runtimeSettings,
        'continue',
        configuredRuntimeLabels
      )
    : undefined
  const deepseekHarnessMenuSource = runtimeSettings
    ? getConfiguredAgentRuntimeSource(
        runtimeSettings,
        'deepseek-harness',
        configuredRuntimeLabels
      )
    : undefined

  useEffect(() => {
    const requestId = runtimeCustomizationRequestRef.current + 1
    runtimeCustomizationRequestRef.current = requestId
    queueMicrotask(() => {
      if (runtimeCustomizationRequestRef.current !== requestId) {
        return
      }
      setRuntimeNativeSnapshot(undefined)
      setRuntimeCustomization(undefined)
      setSelectedRuntimeAgent('')
      setSelectedRuntimeCommand('')
      setSelectedContinuePreset('')
    })
    if (
      !activeRuntimeSelection ||
      activeConversation?.remote ||
      (activeRuntimeSelection.provider !== 'opencode' &&
        activeRuntimeSelection.provider !== 'continue')
    ) {
      return
    }
    const provider = activeRuntimeSelection.provider
    void Promise.all([
      window.goodbuddy.runtimeCustomization.getSettings(),
      window.goodbuddy.runtimeCustomization.getNativeSnapshot({
        provider,
        ...('profileId' in activeRuntimeSelection &&
        activeRuntimeSelection.profileId
          ? { profileId: activeRuntimeSelection.profileId }
          : {}),
        ...(activeProjectId ? { projectId: activeProjectId } : {})
      })
    ])
      .then(([customization, snapshot]) => {
        if (runtimeCustomizationRequestRef.current !== requestId) {
          return
        }
        setRuntimeCustomization(customization)
        setRuntimeNativeSnapshot(snapshot)
        setSelectedContinuePreset('')
      })
      .catch(() => {
        if (runtimeCustomizationRequestRef.current === requestId) {
          setRuntimeCustomization(undefined)
          setRuntimeNativeSnapshot(undefined)
        }
      })
  }, [
    activeConversation?.remote,
    activeProjectId,
    activeRuntimeSelection,
    activeRuntimeSelectionKey
  ])

  const runtimeAgentOptions = useMemo<
    ComposerMenuOption<string>[]
  >(() => {
    if (
      activeRuntimeSelection?.provider !== 'opencode' ||
      !runtimeNativeSnapshot
    ) {
      return []
    }
    const configuredDefault =
      runtimeCustomization?.opencode.defaultAgent
    return [
      {
        value: '',
        label: configuredDefault
          ? t('composer.runtimeControls.configuredAgent', {
              name: configuredDefault
            })
          : t('composer.runtimeControls.runtimeDefaultAgent'),
        description: t(
          'composer.runtimeControls.runtimeDefaultAgentDescription'
        )
      },
      ...runtimeNativeSnapshot.agents
        .filter(
          (agent) =>
            !agent.hidden &&
            (agent.mode === 'primary' || agent.mode === 'all')
        )
        .map((agent) => ({
          value: agent.id,
          label: agent.name,
          description:
            agent.description ??
            t('composer.runtimeControls.agentDescription')
        }))
    ]
  }, [
    activeRuntimeSelection?.provider,
    runtimeCustomization?.opencode.defaultAgent,
    runtimeNativeSnapshot,
    t
  ])

  const runtimePresetOptions = useMemo<
    ComposerMenuOption<string>[]
  >(() => {
    if (
      activeRuntimeSelection?.provider !== 'continue' ||
      !runtimeCustomization
    ) {
      return []
    }
    return [
      {
        value: '',
        label: t('composer.runtimeControls.noPreset'),
        description: t(
          'composer.runtimeControls.noPresetDescription'
        )
      },
      ...runtimeCustomization.continue.presets.map((preset) => ({
        value: preset.id,
        label: preset.name,
        description:
          preset.description ??
          t('composer.runtimeControls.presetDescription', {
            rules: preset.rules.filter((rule) => rule.enabled).length,
            prompts: preset.prompts.length
          })
      }))
    ]
  }, [
    activeRuntimeSelection?.provider,
    runtimeCustomization,
    t
  ])

  const runtimeActionOptions = useMemo<RuntimeActionChoice[]>(() => {
    if (!runtimeNativeSnapshot) {
      return []
    }
    const nativePrompts = runtimeNativeSnapshot.prompts
    const selectedPreset =
      activeRuntimeSelection?.provider === 'continue'
        ? runtimeCustomization?.continue.presets.find(
            (preset) =>
              preset.id ===
              (selectedContinuePreset ||
                runtimeCustomization.continue.defaultPresetId)
          )
        : undefined
    return [
      {
        value: '',
        label: t('composer.runtimeControls.noAction'),
        description: t(
          'composer.runtimeControls.noActionDescription'
        )
      },
      ...(activeRuntimeSelection?.provider === 'opencode'
        ? runtimeNativeSnapshot.commands.map((command) => ({
            value: JSON.stringify(['command', command.id]),
            label: `/${command.name}`,
            description:
              command.description ??
              t('composer.runtimeControls.commandDescription'),
            action: {
              type: 'command' as const,
              id: command.id
            }
          }))
        : []),
      ...nativePrompts.map((prompt) => ({
        value: JSON.stringify(['native-prompt', prompt.id]),
        label: prompt.name,
        description:
          prompt.description ??
          t('composer.runtimeControls.promptDescription'),
        action: {
          type: 'prompt' as const,
          prompt: prompt.prompt
        }
      })),
      ...(selectedPreset?.prompts.map((prompt) => ({
        value: JSON.stringify([
          'preset-prompt',
          selectedPreset.id,
          prompt.id
        ]),
        label: prompt.name,
        description:
          prompt.description ??
          t('composer.runtimeControls.promptDescription'),
        action: {
          type: 'prompt' as const,
          prompt: prompt.prompt
        }
      })) ?? [])
    ]
  }, [
    activeRuntimeSelection?.provider,
    runtimeCustomization,
    runtimeNativeSnapshot,
    selectedContinuePreset,
    t
  ])

  const selectRuntimeAction = useCallback(
    (value: string): void => {
      if (!value) {
        setSelectedRuntimeCommand('')
        return
      }
      const choice = runtimeActionOptions.find(
        (candidate) => candidate.value === value
      )
      if (choice?.action?.type === 'command') {
        setSelectedRuntimeCommand(choice.action.id)
        return
      }
      if (choice?.action?.type === 'prompt') {
        setInput(choice.action.prompt)
        setSelectedRuntimeCommand('')
        requestAnimationFrame(() => {
          resizeComposerTextarea(inputRef.current)
          inputRef.current?.focus()
        })
      }
    },
    [runtimeActionOptions, setInput]
  )

  useEffect(() => {
    if (!runtimeMenuOpen) {
      return
    }
    const menu = runtimeMenuRef.current
    if (!menu) {
      return
    }
    const menuItems = Array.from(
      menu.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"], [role="menuitem"]'
      )
    ).filter((item) => !item.disabled)
    const initialItem =
      menuItems.find(
        (item) => item.getAttribute('aria-checked') === 'true'
      ) ?? menuItems[0]
    menuItems.forEach((item) => {
      item.tabIndex = item === initialItem ? 0 : -1
    })
    const focusFrame = requestAnimationFrame(() => {
      initialItem?.focus()
    })
    const isRuntimeMenuTarget = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (menu.contains(target) ||
        runtimeMenuButtonRef.current?.contains(target) === true)
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      if (!isRuntimeMenuTarget(event.target)) {
        setRuntimeMenuOpen(false)
      }
    }
    const dismissOnOutsideFocus = (event: FocusEvent): void => {
      if (!isRuntimeMenuTarget(event.target)) {
        setRuntimeMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer)
    document.addEventListener('focusin', dismissOnOutsideFocus)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.removeEventListener(
        'pointerdown',
        dismissOnOutsidePointer
      )
      document.removeEventListener('focusin', dismissOnOutsideFocus)
    }
  }, [activeRuntimeSelectionKey, runtimeMenuOpen])
  const conversationNavigationRef = useRef({
    activeId,
    conversations
  })

  useEffect(() => {
    conversationNavigationRef.current = {
      activeId,
      conversations
    }
  }, [activeId, conversations])

  useEffect(() => {
    const selection = activeRuntimeSelectionRef.current
    if (!selection || !runtimeSettings) {
      return
    }
    if (
      runtimeStatusCacheRef.current?.key ===
        activeRuntimeSelectionKey &&
      runtimeStatusCacheRef.current.settings === runtimeSettings
    ) {
      return
    }
    runtimeStatusCacheRef.current = {
      key: activeRuntimeSelectionKey,
      settings: runtimeSettings
    }
    const requestId = runtimeStatusRequestRef.current + 1
    runtimeStatusRequestRef.current = requestId
    setRuntimeSwitching(false)
    setRuntimeStatusKey('')
    void window.goodbuddy.agent
      .getStatus(selection)
      .then((status) => {
        if (runtimeStatusRequestRef.current !== requestId) {
          return
        }
        setRuntime(status)
        setRuntimeStatusKey(activeRuntimeSelectionKey)
        if (!status.available && !runtimeSetupPromptedRef.current) {
          runtimeSetupPromptedRef.current = true
          setView('settings')
        }
      })
      .catch((reason: unknown) => {
        if (runtimeStatusRequestRef.current !== requestId) {
          return
        }
        setRuntime({
          id: 'setup',
          label: tRef.current('runtime.unavailable'),
          available: false,
          supportsToolExecution: false,
          detail:
            reason instanceof Error
              ? reason.message
              : tRef.current('runtime.errors.readStatus')
        })
        setRuntimeStatusKey(activeRuntimeSelectionKey)
      })
  }, [
    activeRuntimeSelectionKey,
    runtimeSettings,
    setView
  ])

  const startNewConversation = useCallback(
    (projectId?: string): boolean => {
      const project = projects.find(
        (candidate) => candidate.id === projectId
      )
      if (project?.kind === 'channel') {
        setView('chat')
        notify({
          tone: 'info',
          message: tRef.current('notices.channelConversationAutomatic'),
          dedupeKey: 'channel-project-new-conversation'
        })
        return false
      }
      const navigation = conversationNavigationRef.current
      const currentConversation = navigation.conversations.find(
        (conversation) => conversation.id === navigation.activeId
      )
      if (
        currentConversation &&
        currentConversation.projectId === projectId &&
        isUnusedConversation(currentConversation)
      ) {
        setView('chat')
        requestAnimationFrame(() => inputRef.current?.focus())
        return true
      }
      const conversation = createConversation(
        projectId,
        runtimeSettings
          ? getProjectDefaultRuntimeSelection(project, runtimeSettings)
          : undefined,
        tRef.current('conversation.greeting')
      )
      const nextConversations = [
        conversation,
        ...navigation.conversations
      ]
      conversationNavigationRef.current = {
        activeId: conversation.id,
        conversations: nextConversations
      }
      setConversations(nextConversations)
      setActiveId(conversation.id)
      setView('chat')
      requestAnimationFrame(() => inputRef.current?.focus())
      return true
    },
    [notify, projects, runtimeSettings, setActiveId, setView]
  )
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId),
    [activeProjectId, projects]
  )
  const filteredConversations = useMemo(() => {
    const query = deferredSearchQuery.trim().toLocaleLowerCase()
    const candidates = query
      ? searchConversationSnapshot
      : conversations
    return candidates.filter(
      (conversation) =>
        (!activeProjectId ||
          conversation.projectId === activeProjectId) &&
        (activeProject?.kind !== 'channel' ||
          conversation.remote !== undefined) &&
        (!query ||
        conversation.title.toLocaleLowerCase().includes(query) ||
        conversation.messages.some((message) =>
          message.content.toLocaleLowerCase().includes(query)
        ))
    )
  }, [
    activeProject,
    activeProjectId,
    conversations,
    deferredSearchQuery,
    searchConversationSnapshot
  ])
  const productAssistantTasks = useMemo(
    () =>
      assistantTasks.filter(
        (task) => !task.parentTaskId && task.origin === 'schedule'
      ),
    [assistantTasks]
  )
  const tasksByConversation = useMemo(() => {
    const grouped = new Map<string, AssistantTask[]>()
    for (const task of productAssistantTasks) {
      if (!task.conversationId) {
        continue
      }
      const existing = grouped.get(task.conversationId) ?? []
      existing.push(task)
      grouped.set(task.conversationId, existing)
    }
    for (const tasks of grouped.values()) {
      tasks.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
      )
    }
    return grouped
  }, [productAssistantTasks])
  const conversationTitles = useMemo(
    () =>
      new Map(
        conversations.map((conversation) => [
          conversation.id,
          getConversationDisplayTitle(
            conversation,
            t('conversation.defaultTitle')
          )
        ])
      ),
    [conversations, t]
  )
  const projectNames = useMemo(
    () =>
      new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  )
  const pendingSidebarApprovals = useMemo<PendingSidebarApproval[]>(
    () =>
      conversations.flatMap((conversation) =>
        conversation.messages.flatMap((message) =>
          message.approval
            ? [
                {
                  conversationId: conversation.id,
                  messageId: message.id,
                  approvalId: message.approval.id,
                  title: message.approval.title,
                  description: message.approval.description,
                  toolName: message.approval.toolName
                }
              ]
            : []
        )
      ),
    [conversations]
  )
  const sidebarArtifacts = useMemo<SidebarArtifact[]>(
    () =>
      assistantArtifacts
        .filter(
          (artifact) =>
            !activeProjectId || artifact.projectId === activeProjectId
        )
        .map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          content: artifact.content ?? '',
          createdAt: new Date(artifact.createdAt).getTime(),
          mimeType: artifact.mimeType
        })),
    [activeProjectId, assistantArtifacts]
  )
  const enabledSidebarLibraries = useMemo(
    () =>
      knowledgeSnapshot.libraries.filter((library) =>
        enabledKnowledgeLibraryIds.includes(library.id)
      ),
    [enabledKnowledgeLibraryIds, knowledgeSnapshot.libraries]
  )
  const pendingHeartbeatSuggestionCount = useMemo(() => {
    const memoryIds = new Set(
      heartbeatEntries.flatMap((entry) => entry.proposedMemoryIds)
    )
    const taskIds = new Set(
      heartbeatEntries.flatMap((entry) => entry.followUpTaskIds)
    )
    return (
      heartbeatMemories.filter(
        (memory) =>
          memoryIds.has(memory.id) && memory.status === 'proposed'
      ).length +
      assistantTasks.filter(
        (task) =>
          taskIds.has(task.id) &&
          task.status !== 'completed' &&
          task.status !== 'cancelled'
      ).length
    )
  }, [assistantTasks, heartbeatEntries, heartbeatMemories])

  const updateMessage = useCallback(
    (
      conversationId: string,
      messageId: string,
      update: (message: Message) => Message
    ): void => {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                updatedAt: Date.now(),
                messages: conversation.messages.map((message) =>
                  message.id === messageId ? update(message) : message
                )
              }
            : conversation
        )
      )
    },
    []
  )

  const recordActivity = useCallback(
    (
      record: Omit<ActivityRecord, 'id' | 'createdAt' | 'scope'>,
      scopeOverride?: ActivityRecord['scope']
    ): void => {
      const conversation = conversationsRef.current.find(
        (candidate) => candidate.id === record.conversationId
      )
      const project = conversation?.projectId
        ? projectsRef.current.find(
            (candidate) => candidate.id === conversation.projectId
          )
        : undefined
      const scope: ActivityRecord['scope'] =
        scopeOverride ??
        (!conversation
          ? { kind: 'unavailable' }
          : !conversation.projectId
            ? { kind: 'global' }
            : project?.id && project.name
              ? {
                  kind: 'project',
                  projectId: project.id.slice(0, 256),
                  projectName: project.name.slice(0, 120)
                }
              : { kind: 'unavailable' })
      setActivityRecords((current) =>
        upsertActivityRecord(current, {
          ...record,
          scope,
          id: crypto.randomUUID(),
          createdAt: Date.now()
        })
      )
    },
    []
  )

  const updateRequestActivity = useCallback(
    (
      requestId: string,
      status: ActivityRecord['status'],
      detail?: string
    ): void => {
      setActivityRecords((current) =>
        current.map((record) =>
          record.requestId === requestId && record.kind === 'request'
            ? {
                ...record,
                status,
                detail: detail?.slice(0, 4_000) ?? record.detail
              }
            : record
        )
      )
    },
    []
  )

  useEffect(() => {
    const api = window.goodbuddy.channels
    if (!api) {
      return
    }
    return api.onRemoteActivity((activity) => {
      if (activity.kind === 'result') {
        updateRequestActivity(
          activity.requestId,
          activity.status,
          activity.detail
        )
      }
      recordActivity(
        {
          requestId: activity.requestId,
          conversationId: activity.conversationId,
          callId: activity.callId,
          kind: activity.kind,
          title: activity.title,
          detail: activity.detail,
          status: activity.status
        },
        {
          kind: 'project',
          projectId: activity.projectId.slice(0, 256),
          projectName: activity.projectName.slice(0, 120)
        }
      )
    })
  }, [recordActivity, updateRequestActivity])

  const refreshKnowledge = useCallback(
    async (libraryId?: string): Promise<KnowledgeSnapshot> => {
      const requestId = ++knowledgeLoadRequestRef.current
      try {
        const snapshot =
          await window.goodbuddy.knowledge.getSnapshot(libraryId)
        if (requestId !== knowledgeLoadRequestRef.current) {
          return snapshot
        }
        failedKnowledgeLibraryIdRef.current = undefined
        setKnowledgeSnapshot(snapshot)
        setKnowledgeLoadError(undefined)
        if (!knowledgeScopeInitialized.current) {
          knowledgeScopeInitialized.current = true
          setEnabledKnowledgeLibraryIds(
            snapshot.libraries.map((library) => library.id)
          )
        } else {
          setEnabledKnowledgeLibraryIds((current) =>
            current.filter((id) =>
              snapshot.libraries.some((library) => library.id === id)
            )
          )
        }
        return snapshot
      } catch (reason) {
        if (requestId !== knowledgeLoadRequestRef.current) {
          throw reason
        }
        failedKnowledgeLibraryIdRef.current = libraryId
        setKnowledgeLoadError(
          displayErrorMessage(
            reason,
            tRef.current('notices.knowledgeReadFailed')
          )
        )
        throw reason
      }
    },
    []
  )

  const retryKnowledgeLoad = useCallback(async (): Promise<void> => {
    setKnowledgeLoading(true)
    setKnowledgeLoadError(undefined)
    try {
      await refreshKnowledge(failedKnowledgeLibraryIdRef.current)
    } catch {
      // The recoverable page state is set by refreshKnowledge.
    } finally {
      setKnowledgeLoading(false)
    }
  }, [refreshKnowledge])

  const switchRuntime = useCallback(
    async (selection: AgentRuntimeSelection): Promise<void> => {
      if (!runtimeSettings || !activeConversation || runtimeSwitching) {
        return
      }
      runtimeMenuButtonRef.current?.focus()
      setRuntimeSwitching(true)
      setRuntimeMenuOpen(false)
      const requestId = runtimeStatusRequestRef.current + 1
      runtimeStatusRequestRef.current = requestId
      try {
        const status = await window.goodbuddy.agent.getStatus(selection)
        if (runtimeStatusRequestRef.current !== requestId) {
          return
        }
        const selectionKey = agentRuntimeSelectionKey(selection)
        runtimeStatusCacheRef.current = {
          key: selectionKey,
          settings: runtimeSettings
        }
        const label = getRuntimeSelectionLabel(
          selection,
          runtimeSettings,
          status,
          runtimeLabels
        )
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === activeConversation.id
              ? {
                  ...conversation,
                  runtimeSelection: selection,
                  updatedAt: Date.now()
                }
              : conversation
          )
        )
        setRuntime(status)
        setRuntimeStatusKey(selectionKey)
        notify({
          tone: status.available ? 'success' : 'error',
          message: status.available
            ? tRef.current('runtime.switched', { label })
            : tRef.current('runtime.selectionUnavailable', {
                label,
                detail: status.detail
              }),
          dedupeKey: 'runtime-switch'
        })
      } catch (reason) {
        if (runtimeStatusRequestRef.current !== requestId) {
          return
        }
        notify({
          tone: 'error',
          message:
            reason instanceof Error
              ? reason.message
              : tRef.current('runtime.errors.switch'),
          dedupeKey: 'runtime-switch'
        })
      } finally {
        if (runtimeStatusRequestRef.current === requestId) {
          setRuntimeSwitching(false)
          requestAnimationFrame(() => {
            runtimeMenuButtonRef.current?.focus()
          })
        }
      }
    },
    [
      activeConversation,
      runtimeLabels,
      runtimeSettings,
      runtimeSwitching
    ]
  )

  const refreshTokenUsage = useCallback(async (): Promise<void> => {
    setTokenUsage(await window.goodbuddy.usage.getTokenSummary())
  }, [])

  const loadWorkspaceChanges = useCallback(
    async (projectId: string): Promise<void> => {
      const requestId = workspaceChangesRequestRef.current + 1
      workspaceChangesRequestRef.current = requestId
      const changes = await window.goodbuddy.workspace.getChanges(projectId)
      if (
        workspaceChangesRequestRef.current === requestId &&
        activeProjectIdRef.current === projectId
      ) {
        setWorkspaceChanges(changes)
      }
    },
    []
  )

  const handleAgentEvent = useCallback(
    (event: AgentEvent): void => {
      const run = activeRuns.current.get(event.requestId)
      if (!run) {
        if (event.type !== 'approval') {
          return
        }
        const attachScheduledApproval = (
          task: AssistantTask | undefined
        ): void => {
          if (
            !task?.conversationId ||
            task.origin !== 'schedule'
          ) {
            return
          }
          setAssistantTasks((current) =>
            current.map((candidate) =>
              candidate.id === task.id
                ? { ...candidate, status: 'waiting_approval' }
                : candidate
            )
          )
          if (
            activeConversationIdRef.current !== task.conversationId
          ) {
            setUnreadConversationIds((current) => {
              const next = new Set(current)
              next.add(task.conversationId!)
              return next
            })
          }
          setConversations((current) =>
            current.map((conversation) => {
              if (conversation.id !== task.conversationId) {
                return conversation
              }
              const existing = conversation.messages.find(
                (message) =>
                  message.approval?.id === event.approvalId
              )
              if (existing) {
                return conversation
              }
              return {
                ...conversation,
                updatedAt: Date.now(),
                messages: [
                  ...conversation.messages,
                  {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: event.title,
                    createdAt: Date.now(),
                    state: 'complete',
                    task: {
                      id: task.id,
                      title: task.title
                    },
                    approval: {
                      id: event.approvalId,
                      title: event.title,
                      description: event.description,
                      toolName: event.toolName,
                      argumentSummary: event.argumentSummary,
                      allowPermanent: event.allowPermanent
                    }
                  }
                ]
              }
            })
          )
        }
        const task = assistantTasksRef.current.find(
          (candidate) => candidate.id === event.requestId
        )
        if (task) {
          attachScheduledApproval(task)
        } else {
          void window.goodbuddy.tasks
            .list()
            .then((tasks) => {
              setAssistantTasks(tasks)
              assistantTasksRef.current = tasks
              attachScheduledApproval(
                tasks.find(
                  (candidate) => candidate.id === event.requestId
                )
              )
            })
            .catch(() => undefined)
        }
        return
      }

      setAssistantTasks((current) => {
        let changed = false
        const updated = current.map((task) => {
          if (task.id !== event.requestId) {
            return task
          }
          const status: AssistantTask['status'] =
            event.type === 'approval' || event.type === 'question'
              ? 'waiting_approval'
              : event.type === 'done'
                ? 'completed'
                : event.type === 'error'
                  ? event.status
                  : 'running'
          const completedAt =
            event.type === 'done' || event.type === 'error'
              ? new Date().toISOString()
              : task.completedAt
          const error =
            event.type === 'error' ? event.message : task.error
          if (
            task.status === status &&
            task.completedAt === completedAt &&
            task.error === error
          ) {
            return task
          }
          changed = true
          return {
            ...task,
            status,
            completedAt,
            error
          }
        })
        return changed ? updated : current
      })
      if (event.type === 'done') {
        if (
          run.projectId &&
          activeProjectIdRef.current === run.projectId
        ) {
          void loadWorkspaceChanges(run.projectId).catch(() =>
            notify({
              tone: 'error',
              message: tRef.current(
                'notices.workspaceChangesReadFailed'
              )
            })
          )
        }
        if (viewRef.current === 'activity') {
          void refreshTokenUsage().catch(() =>
            notify({
              tone: 'error',
              message: tRef.current('notices.tokenUsageReadFailed')
            })
          )
        }
        void window.goodbuddy.artifacts
          .list()
          .then((artifacts) =>
            setAssistantArtifacts((current) =>
              mergeArtifacts(current, artifacts)
            )
          )
          .catch(() =>
            notify({
              tone: 'error',
              message: tRef.current('notices.resultsRefreshFailed')
            })
          )
      } else if (event.type === 'artifact') {
        hydratingArtifactIds.current.add(event.artifactId)
        void window.goodbuddy.artifacts
          .get(event.artifactId)
          .then((artifact) =>
            setAssistantArtifacts((current) =>
              mergeArtifacts(current, [artifact])
            )
          )
          .catch(() =>
            notify({
              tone: 'error',
              message: tRef.current(
                'notices.generatedImageReadFailed'
              )
            })
          )
          .finally(() => {
            hydratingArtifactIds.current.delete(event.artifactId)
          })
      }

      if (event.type === 'text') {
        updateMessage(run.conversationId, run.messageId, (message) => {
          const remaining = Math.max(
            0,
            maxMessageContentLength - message.content.length
          )
          const acceptedDelta = event.delta.slice(0, remaining)
          return {
            ...message,
            content: `${message.content}${acceptedDelta}`,
            blocks: appendMessageContentBlock(
              message.blocks,
              'text',
              acceptedDelta
            ),
            status:
              event.delta.length > remaining
                ? tRef.current('chat.status.responseTruncated')
                : undefined
          }
        })
      } else if (event.type === 'reasoning') {
        updateMessage(run.conversationId, run.messageId, (message) => {
          const currentReasoning = message.reasoning ?? ''
          const acceptedDelta = event.delta.slice(
            0,
            Math.max(
              0,
              maxMessageContentLength - currentReasoning.length
            )
          )
          return {
            ...message,
            reasoning: `${currentReasoning}${acceptedDelta}`,
            status: undefined,
            blocks: appendMessageContentBlock(
              message.blocks,
              'reasoning',
              acceptedDelta
            )
          }
        })
      } else if (event.type === 'context-metrics') {
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === run.conversationId
              ? {
                  ...conversation,
                  contextMetrics: {
                    contextTokens: event.contextTokens,
                    source: event.source,
                    basis: 'model-call',
                    runtimeSelectionKey: run.runtimeSelectionKey
                  }
                }
              : conversation
          )
        )
      } else if (event.type === 'context-compression') {
        const estimatedAfterTokens = event.estimatedAfterTokens
        const conversationScoped = event.scope !== 'agent-run'
        const scope = event.scope ?? 'conversation'
        const marker: ConversationContextCompressionMarker = {
            state:
              event.state === 'started'
                ? 'compressing'
                : event.state,
            scope,
            estimatedBeforeTokens: event.estimatedBeforeTokens,
            estimatedAfterTokens: event.estimatedAfterTokens,
            compressionCount: event.compressionCount
          }
        updateMessage(run.conversationId, run.messageId, (message) => {
          const current =
            message.contextCompressions ??
            (message.contextCompression
              ? [message.contextCompression]
              : [])
          const existingIndex = current.findIndex(
            (compression) =>
              (compression.scope ?? 'conversation') === scope
          )
          const contextCompressions =
            existingIndex >= 0
              ? [
                  ...current.filter(
                    (_compression, index) =>
                      index !== existingIndex
                  ),
                  marker
                ]
              : [...current, marker]
          return {
            ...message,
            contextCompression: undefined,
            contextCompressions
          }
        })
        if (
          conversationScoped &&
          event.state === 'completed' &&
          estimatedAfterTokens !== undefined
        ) {
          setConversations((current) =>
            current.map((conversation) =>
              conversation.id === run.conversationId
                ? {
                    ...conversation,
                    contextMetrics: {
                      runtimeSelectionKey: run.runtimeSelectionKey,
                      contextTokens: estimatedAfterTokens,
                      source: 'estimated',
                      basis: 'conversation'
                    },
                    contextCompressionState:
                      event.conversationState ??
                      conversation.contextCompressionState
                  }
                : conversation
            )
          )
        } else if (
          conversationScoped &&
          event.conversationState
        ) {
          setConversations((current) =>
            current.map((conversation) =>
              conversation.id === run.conversationId
                ? {
                    ...conversation,
                    contextCompressionState: event.conversationState
                  }
                : conversation
            )
          )
        }
      } else if (event.type === 'status') {
        updateMessage(run.conversationId, run.messageId, (message) => ({
          ...message,
          status: event.message
        }))
      } else if (event.type === 'tool') {
        recordActivity({
          conversationId: run.conversationId,
          requestId: event.requestId,
          callId: event.callId.slice(0, 256),
          kind: 'tool',
          title: event.name,
          detail: [event.summary, event.error]
            .filter(Boolean)
            .join('\n')
            .slice(0, 4_000),
          status:
            event.state === 'pending'
              ? 'pending'
              : event.state === 'running'
                ? 'running'
                : event.state === 'failed'
                  ? 'failed'
                  : 'completed'
        })
        updateMessage(run.conversationId, run.messageId, (message) => {
          const tools = [...(message.tools ?? [])]
          const index = tools.findIndex(
            (tool) => tool.callId === event.callId.slice(0, 256)
          )
          const tool = {
            callId: event.callId.slice(0, 256),
            name: event.name,
            state: event.state,
            summary: event.summary,
            input: event.input,
            output: event.output,
            error: event.error
          }
          if (index >= 0) {
            tools[index] = tool
          } else {
            tools.push(tool)
          }
          return {
            ...message,
            tools,
            blocks: upsertMessageToolBlock(message.blocks, tool)
          }
        })
      } else if (event.type === 'subagent') {
        const childStatus = event.state
        const completedAt =
          event.state === 'completed' ||
          event.state === 'failed' ||
          event.state === 'cancelled'
            ? new Date().toISOString()
            : undefined
        setAssistantTasks((current) => {
          const existing = current.find(
            (task) => task.id === event.childTaskId
          )
          const childTask: AssistantTask = {
            id: event.childTaskId,
            projectId: run.projectId,
            conversationId: run.conversationId,
            parentTaskId: event.requestId,
            expertId: event.expertId,
            routingMode: event.routingMode,
            title: event.expertName,
            instructions:
              event.reason ??
              tRef.current('chat.subagents.fallbackTask', {
                name: event.expertName
              }),
            origin: 'subagent',
            status: childStatus,
            createdAt:
              existing?.createdAt ?? new Date().toISOString(),
            startedAt:
              event.state === 'running'
                ? existing?.startedAt ?? new Date().toISOString()
                : existing?.startedAt,
            completedAt: completedAt ?? existing?.completedAt,
            error: event.error
          }
          return existing
            ? current.map((task) =>
                task.id === event.childTaskId ? childTask : task
              )
            : [...current, childTask].slice(0, 100)
        })
        recordActivity({
          conversationId: run.conversationId,
          requestId: event.requestId,
          callId: event.childTaskId,
          kind: 'subagent',
          title: event.expertName,
          detail: [
            event.routingMode === 'smart'
              ? tRef.current('chat.subagents.smart')
              : tRef.current('chat.subagents.manual'),
            event.reason,
            event.error
          ]
            .filter(Boolean)
            .join(' · ')
            .slice(0, 4_000),
          status:
            event.state === 'queued'
              ? 'pending'
              : event.state
        })
        updateMessage(run.conversationId, run.messageId, (message) => {
          const subagents = [...(message.subagents ?? [])]
          const index = subagents.findIndex(
            (subagent) =>
              subagent.childTaskId === event.childTaskId
          )
          const subagent: SubagentActivity = {
            childTaskId: event.childTaskId,
            expertId: event.expertId,
            expertName: event.expertName,
            routingMode: event.routingMode,
            state: event.state,
            reason: event.reason,
            output: event.output,
            error: event.error
          }
          if (index >= 0) {
            subagents[index] = subagent
          } else if (subagents.length < 3) {
            subagents.push(subagent)
          }
          return { ...message, subagents }
        })
      } else if (event.type === 'approval') {
        recordActivity({
          conversationId: run.conversationId,
          requestId: event.requestId,
          kind: 'approval',
          title: event.title,
          detail: event.description.slice(0, 4_000),
          status: 'pending'
        })
        updateMessage(run.conversationId, run.messageId, (message) => ({
          ...message,
          status: undefined,
          approval: {
            id: event.approvalId,
            title: event.title,
            description: event.description,
            toolName: event.toolName,
            argumentSummary: event.argumentSummary,
            allowPermanent: event.allowPermanent
          }
        }))
      } else if (event.type === 'question') {
        updateMessage(run.conversationId, run.messageId, (message) => ({
          ...message,
          status: undefined,
          question: event
        }))
      } else if (event.type === 'artifact') {
        updateMessage(run.conversationId, run.messageId, (message) => ({
          ...message,
          artifactIds: [
            ...new Set([...(message.artifactIds ?? []), event.artifactId])
          ].slice(-8),
          status: tRef.current('chat.status.savingImage')
        }))
      } else if (event.type === 'knowledge-retrieval') {
        updateMessage(run.conversationId, run.messageId, (message) => ({
          ...message,
          knowledgeRetrieval: {
            mode: event.mode,
            state: event.state,
            libraryCount: event.libraryCount,
            resultCount: event.resultCount,
            durationMs: event.durationMs,
            usedChannels: event.usedChannels,
            warnings: event.warnings
          },
          status:
            event.state === 'searching'
              ? tRef.current('chat.knowledgeRetrieval.searching')
              : undefined
        }))
      } else if (event.type === 'source-references') {
        updateMessage(run.conversationId, run.messageId, (message) => {
          const referenceKey = (
            reference: KnowledgeSearchReference
          ): string =>
            [
              reference.libraryId,
              reference.documentId,
              reference.chunkId ?? '',
              reference.locator ?? '',
              reference.snippet
            ].join('\0')
          const incoming = [
            ...new Map(
              event.references.map((reference) => [
                referenceKey(reference),
                reference
              ])
            ).values()
          ]
          const incomingKeys = new Set(incoming.map(referenceKey))
          const references = [
            ...incoming,
            ...(message.sourceReferences ?? []).filter(
              (reference) => !incomingKeys.has(referenceKey(reference))
            )
          ].slice(0, 20)
          return {
            ...message,
            sourceReferences: references
          }
        })
      } else {
        const terminalStatus =
          event.type === 'error'
            ? event.status === 'cancelled'
              ? 'cancelled'
              : 'failed'
            : 'completed'
        updateRequestActivity(
          event.requestId,
          terminalStatus,
          event.type === 'error'
            ? event.message
            : tRef.current('chat.status.taskCompleted')
        )
        if (event.type === 'error') {
          setActivityRecords((current) =>
            current.map((record) =>
              record.requestId === event.requestId &&
              record.kind !== 'request' &&
              (record.status === 'pending' ||
                record.status === 'running')
                ? {
                    ...record,
                    status: terminalStatus,
                    detail: `${record.detail}\n${event.message}`.slice(
                      0,
                      4_000
                    )
                  }
                : record
            )
          )
        }
        recordActivity({
          conversationId: run.conversationId,
          requestId: event.requestId,
          kind: 'result',
          title:
            event.type === 'error'
              ? tRef.current('chat.status.taskFailed')
              : tRef.current('chat.status.taskCompleted'),
          detail:
            event.type === 'error'
              ? event.message.slice(0, 4_000)
              : tRef.current('chat.status.runtimeCompleted'),
          status: terminalStatus
        })
        updateMessage(run.conversationId, run.messageId, (message) => {
          const representedToolError =
            event.type === 'error' &&
            isErrorRepresentedByFailedTool(
              message.tools,
              event.message
            )
          const toolTerminalState =
            event.type === 'error'
              ? event.status === 'cancelled'
                ? ('cancelled' as const)
                : ('failed' as const)
              : undefined
          const fallbackError =
            event.type === 'error' &&
            !representedToolError &&
            !message.content
              ? event.message.slice(0, maxMessageContentLength)
              : ''
          return {
            ...message,
            state: event.type === 'error' ? 'error' : 'complete',
            status:
              event.type === 'error' && !representedToolError
                ? event.message
                : undefined,
            contextCompression:
              event.type === 'error' &&
              message.contextCompression?.state === 'compressing'
                ? {
                    ...message.contextCompression,
                    state: 'failed' as const
                  }
                : message.contextCompression,
            contextCompressions:
              event.type === 'error'
                ? message.contextCompressions?.map((compression) =>
                    compression.state === 'compressing'
                      ? {
                          ...compression,
                          state: 'failed' as const
                        }
                      : compression
                  )
                : message.contextCompressions,
            approval: undefined,
            question: undefined,
            tools: toolTerminalState
              ? message.tools?.map((tool) =>
                  tool.state === 'pending' || tool.state === 'running'
                    ? { ...tool, state: toolTerminalState }
                    : tool
                )
              : message.tools,
            blocks: toolTerminalState
              ? terminalizeMessageToolBlocks(
                  appendMessageContentBlock(
                    message.blocks,
                    'text',
                    fallbackError
                  ),
                  toolTerminalState
                )
              : appendMessageContentBlock(
                  message.blocks,
                  'text',
                  fallbackError
                ),
            content: fallbackError || message.content
          }
        })
        activeRuns.current.delete(event.requestId)
        setConversationActivity(run.conversationId, false)
        flushConversationPersistenceAfterRenderRef.current = true
      }
    },
    [
      recordActivity,
      loadWorkspaceChanges,
      refreshTokenUsage,
      setConversationActivity,
      updateMessage,
      updateRequestActivity
    ]
  )

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId
    if (activeProjectId) {
      try {
        localStorage.setItem(activeProjectStorageKey, activeProjectId)
      } catch {
        // The project selection still works when persistence is unavailable.
      }
    }
  }, [activeProjectId])

  useEffect(() => {
    viewRef.current = view
  }, [view])

  const persistLocalConversationChanges = useCallback((): void => {
    const operation = conversationPersistenceQueueRef.current.then(
      async () => {
        if (conversationPersistencePausedRef.current) {
          return
        }
        const { batch, acknowledgements } =
          createLocalConversationSaveBatch(
            conversationsRef.current,
            persistedLocalConversationsRef.current,
            deletingLocalConversationIdsRef.current
          )
        if (batch.length === 0) {
          return
        }
        await window.goodbuddy.conversations.saveLocal(batch)
        for (const conversation of acknowledgements) {
          persistedLocalConversationsRef.current.set(
            conversation.id,
            conversation
          )
        }
      }
    )
    conversationPersistenceQueueRef.current =
      operation.catch(() => undefined)
    void operation.catch(() => {
      notify({
        tone: 'error',
        message: tRef.current(
          'notices.conversationPersistenceFailed'
        ),
        dedupeKey: 'conversation-persistence'
      })
    })
  }, [])

  useEffect(() => {
    if (!conversationStoreReady) {
      return
    }
    persistLocalConversationChanges()
    const interval = window.setInterval(
      persistLocalConversationChanges,
      conversationPersistenceIntervalMs
    )
    return () => {
      window.clearInterval(interval)
      persistLocalConversationChanges()
    }
  }, [conversationStoreReady, persistLocalConversationChanges])

  useEffect(() => {
    if (
      !conversationStoreReady ||
      !flushConversationPersistenceAfterRenderRef.current
    ) {
      return
    }
    flushConversationPersistenceAfterRenderRef.current = false
    persistLocalConversationChanges()
  }, [
    conversationStoreReady,
    conversations,
    persistLocalConversationChanges
  ])

  useEffect(
    () =>
      window.goodbuddy.app.onBeforeQuit(async () => {
        saveActivityRecords(activityRecordsRef.current)
        if (!conversationStoreReady) {
          return
        }
        flushConversationPersistenceAfterRenderRef.current = false
        persistLocalConversationChanges()
        await conversationPersistenceQueueRef.current
      }),
    [conversationStoreReady, persistLocalConversationChanges]
  )

  useEffect(() => {
    if (!conversationStoreReady) {
      return
    }
    let active = true
    let refreshSequence = 0
    let refreshTimer: number | undefined
    let refreshInFlight = false
    let refreshQueued = false
    const queueRefresh = (): void => {
      refreshSequence += 1
      refreshQueued = true
      if (refreshInFlight || refreshTimer !== undefined) {
        return
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        refresh()
      }, 50)
    }
    const refresh = (): void => {
      if (refreshInFlight) {
        refreshQueued = true
        return
      }
      refreshInFlight = true
      refreshQueued = false
      const sequence = refreshSequence
      const tasksRefresh = window.goodbuddy.tasks
        .list()
        .then((tasks) => {
          if (!active || sequence !== refreshSequence) {
            return
          }
          setAssistantTasks(tasks)
          setActivityRecords((current) =>
            reconcileActivityRecords(
              current,
              tasks,
              new Set(activeRuns.current.keys())
            )
          )
        })
        .catch(() => {
          if (active && sequence === refreshSequence) {
            notify({
              tone: 'error',
              message: tRef.current('notices.taskHistoryReadFailed'),
              dedupeKey: 'task-lifecycle-refresh'
            })
          }
        })
      const schedulesRefresh = window.goodbuddy.schedules
        .list()
        .then((schedules) => {
          if (active && sequence === refreshSequence) {
            setAssistantSchedules(schedules)
          }
        })
        .catch(() => {
          if (active && sequence === refreshSequence) {
            notify({
              tone: 'error',
              message: tRef.current('notices.schedulesReadFailed'),
              dedupeKey: 'schedule-lifecycle-refresh'
            })
          }
        })
      const conversationsRefresh = window.goodbuddy.conversations
        .list()
        .then((persisted) => {
          if (!active || sequence !== refreshSequence) {
            return
          }
          const remote = persisted.filter(
            (conversation) => conversation.remote
          )
          const previousById = new Map(
            conversationsRef.current.map((conversation) => [
              conversation.id,
              conversation
            ])
          )
          const updated = remote.filter((conversation) => {
            const previous = previousById.get(conversation.id)
            return (
              previous === undefined ||
              conversation.updatedAt > previous.updatedAt
            )
          })
          const unread = updated.filter(
            (conversation) =>
              conversation.id !== activeConversationIdRef.current
          )
          if (unread.length > 0) {
            setUnreadConversationIds((current) => {
              const next = new Set(current)
              unread.forEach((conversation) =>
                next.add(conversation.id)
              )
              return next
            })
            notify({
              tone: 'info',
              message: tRef.current('notices.remoteMessage', {
                channel:
                  projectChannelLabels[
                    unread[0]!.remote!.channel
                  ]
              }),
              dedupeKey: 'remote-channel-message'
            })
          }
          setConversations((current) =>
            mergePersistedConversations(
              current,
              persisted,
              persistedLocalConversationsRef.current
            )
          )
        })
        .catch(() => {
          if (active && sequence === refreshSequence) {
            notify({
              tone: 'error',
              message: tRef.current(
                'notices.remoteConversationRefreshFailed'
              ),
              dedupeKey: 'remote-conversation-refresh'
            })
          }
        })
      void Promise.allSettled([
        tasksRefresh,
        schedulesRefresh,
        conversationsRefresh
      ]).finally(() => {
        refreshInFlight = false
        if (active && refreshQueued) {
          queueRefresh()
        }
      })
    }
    const remove = window.goodbuddy.conversations.onChanged(queueRefresh)
    return () => {
      active = false
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer)
      }
      remove()
    }
  }, [conversationStoreReady])

  useEffect(() => {
    activityRecordsRef.current = activityRecords
    const timeout = window.setTimeout(() => {
      saveActivityRecords(activityRecords)
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [activityRecords])

  useEffect(
    () => () => {
      saveActivityRecords(activityRecordsRef.current)
    },
    []
  )

  useEffect(() => {
    let active = true
    void Promise.all([
      window.goodbuddy.projects.list(false),
      window.goodbuddy.conversations.list()
    ])
      .then(async ([value, persistedConversations]) => {
        if (!active || value.length === 0) {
          return
        }
        const lastActiveProjectId = loadActiveProjectId()
        const project =
          value.find(
            (candidate) => candidate.id === lastActiveProjectId
          ) ?? value[0]!
        setProjects(value)
        setActiveProjectId(project.id)
        setWorkMode(
          normalizeInteractiveWorkMode(project.defaultWorkMode)
        )
        const persistedLocalConversations =
          persistedConversations.filter(
            (conversation) => !conversation.remote
          )
        const persistedConversationIds = new Set(
          persistedConversations.map((conversation) => conversation.id)
        )
        const shouldMigrateLocalStorage =
          conversationMigrationStoragePresent.current ||
          persistedConversations.length === 0
        const migratedLocalConversations =
          shouldMigrateLocalStorage
            ? migrationConversations.current
                .filter(
                  (conversation) =>
                    !conversation.remote &&
                    !persistedConversationIds.has(conversation.id)
                )
                .map((conversation) =>
                  conversation.projectId || project.kind === 'channel'
                    ? conversation
                    : { ...conversation, projectId: project.id }
                )
            : []
        let nextConversations: Conversation[] = [
          ...persistedConversations,
          ...migratedLocalConversations
        ]
        let projectConversation = nextConversations.find(
          (conversation) =>
            conversation.projectId === project.id &&
            (project.kind !== 'channel' ||
              conversation.remote !== undefined)
        )
        if (!projectConversation && project.kind !== 'channel') {
          projectConversation = createConversation(
            project.id,
            undefined,
            tRef.current('conversation.greeting')
          )
          nextConversations = [
            projectConversation,
            ...nextConversations
          ]
        }
        const acknowledgedLocalConversations = new Map(
          persistedLocalConversations.map((conversation) => [
            conversation.id,
            conversation
          ])
        )
        if (
          nextConversations.some(
            (conversation) =>
              !conversation.remote &&
              acknowledgedLocalConversations.get(conversation.id) !==
                conversation
          )
        ) {
          if (persistedConversations.length === 0) {
            const migratedSnapshots =
              toConversationSnapshots(nextConversations)
            await window.goodbuddy.conversations.replace(
              migratedSnapshots
            )
            const migratedSnapshotIds = new Set(
              migratedSnapshots.map((conversation) => conversation.id)
            )
            for (const conversation of nextConversations) {
              if (migratedSnapshotIds.has(conversation.id)) {
                acknowledgedLocalConversations.set(
                  conversation.id,
                  conversation
                )
              }
            }
          }
          while (true) {
            const migration = createLocalConversationSaveBatch(
              nextConversations,
              acknowledgedLocalConversations,
              new Set()
            )
            if (migration.batch.length === 0) {
              break
            }
            await window.goodbuddy.conversations.saveLocal(
              migration.batch
            )
            for (const conversation of migration.acknowledgements) {
              acknowledgedLocalConversations.set(
                conversation.id,
                conversation
              )
            }
          }
        }
        if (!active) {
          return
        }
        persistedLocalConversationsRef.current =
          acknowledgedLocalConversations
        setConversations(nextConversations)
        setActiveId(projectConversation?.id ?? '')
        try {
          localStorage.removeItem(storageKey)
          conversationMigrationStoragePresent.current = false
        } catch {
          // The SQLite migration has already completed successfully.
        }
        setConversationStoreReady(true)
      })
      .catch((reason: unknown) => {
        if (active) {
          notify({
            tone: 'error',
            message:
              reason instanceof Error
                ? reason.message
                : tRef.current('notices.projectReadFailed')
          })
        }
      })
    return () => {
      active = false
    }
  }, [setActiveId])

  useEffect(() => {
    if (!activeProjectId) {
      return
    }
    void window.goodbuddy.memory
      .list(activeProjectId)
      .then(setAssistantMemories)
      .catch(() =>
        notify({
          tone: 'error',
          message: tRef.current('notices.memoryReadFailed')
        })
      )
  }, [activeProjectId])

  const refreshWorkspaceChanges = useCallback(async (): Promise<void> => {
    if (!activeProjectId) {
      workspaceChangesRequestRef.current += 1
      setWorkspaceChanges(undefined)
      return
    }
    await loadWorkspaceChanges(activeProjectId)
  }, [activeProjectId, loadWorkspaceChanges])

  const listWorkspaceDirectory = useCallback(
    async (path: string) => {
      if (!activeProjectId) {
        throw new Error(tRef.current('notices.selectProject'))
      }
      return window.goodbuddy.workspace.listDirectory(activeProjectId, path)
    },
    [activeProjectId]
  )

  const loadWorkspaceFile = useCallback(
    async (path: string) => {
      if (!activeProjectId) {
        throw new Error(tRef.current('notices.selectProject'))
      }
      return window.goodbuddy.workspace.readFile(activeProjectId, path)
    },
    [activeProjectId]
  )
  const openWorkspaceEntry = useCallback(
    async (
      path: string,
      type: 'file' | 'directory'
    ): Promise<void> => {
      if (!activeProjectId) {
        throw new Error(tRef.current('notices.selectProject'))
      }
      await window.goodbuddy.workspace.openPath(
        activeProjectId,
        path,
        type
      )
    },
    [activeProjectId]
  )

  useEffect(() => {
    if (assistantSidebarTab !== 'workspace') {
      return
    }
    const timeout = setTimeout(() => {
      void refreshWorkspaceChanges().catch(() => {
        notify({
          tone: 'error',
          message: tRef.current('notices.workspaceChangesReadFailed')
        })
      })
    }, 0)
    return () => clearTimeout(timeout)
  }, [assistantSidebarTab, refreshWorkspaceChanges])

  useEffect(() => {
    void window.goodbuddy.experts
      .list()
      .then(setAssistantExperts)
      .catch(() =>
        notify({
          tone: 'error',
          message: tRef.current('notices.expertsReadFailed')
        })
      )
  }, [])

  useEffect(() => {
    if (!activeProjectId) {
      return
    }
    void window.goodbuddy.schedules
      .list()
      .then(setAssistantSchedules)
      .catch(() =>
        notify({
          tone: 'error',
          message: tRef.current('notices.schedulesReadFailed')
        })
      )
  }, [activeProjectId])

  const loadHeartbeats = useCallback(async () => {
    const [configs, memories] = await Promise.all([
      window.goodbuddy.heartbeats.list(),
      window.goodbuddy.memory.list()
    ])
    const history = await window.goodbuddy.heartbeats.history()
    return {
      configs,
      memories,
      runs: history.runs,
      entries: history.entries
    }
  }, [])

  const refreshHeartbeats = useCallback(async (): Promise<void> => {
    const requestId = ++heartbeatLoadRequestRef.current
    const result = await loadHeartbeats()
    if (requestId !== heartbeatLoadRequestRef.current) {
      return
    }
    setAssistantHeartbeats(result.configs)
    setHeartbeatMemories(result.memories)
    setHeartbeatRuns(result.runs)
    setHeartbeatEntries(result.entries)
  }, [loadHeartbeats])

  useEffect(() => {
    if (projects.length === 0) {
      return
    }
    const requestId = ++heartbeatLoadRequestRef.current
    const timeout = setTimeout(() => {
      if (requestId !== heartbeatLoadRequestRef.current) {
        return
      }
      setHeartbeatLoading(true)
      setHeartbeatLoadError(undefined)
      setAssistantHeartbeats([])
      setHeartbeatRuns([])
      setHeartbeatEntries([])
      void loadHeartbeats()
        .then((result) => {
          if (requestId !== heartbeatLoadRequestRef.current) {
            return
          }
          setAssistantHeartbeats(result.configs)
          setHeartbeatMemories(result.memories)
          setHeartbeatRuns(result.runs)
          setHeartbeatEntries(result.entries)
          setHeartbeatLoadError(undefined)
        })
        .catch((reason: unknown) => {
          if (requestId !== heartbeatLoadRequestRef.current) {
            return
          }
          setHeartbeatLoadError(
            displayErrorMessage(
              reason,
              tRef.current('notices.heartbeatReadFailed')
            )
          )
        })
        .finally(() => {
          if (requestId === heartbeatLoadRequestRef.current) {
            setHeartbeatLoading(false)
          }
        })
    }, 0)
    return () => {
      clearTimeout(timeout)
      if (requestId === heartbeatLoadRequestRef.current) {
        heartbeatLoadRequestRef.current += 1
      }
    }
  }, [loadHeartbeats, projects.length])

  const refreshHeartbeatCenter = useCallback(async (): Promise<void> => {
    const [artifacts] = await Promise.all([
      window.goodbuddy.artifacts.list(),
      refreshHeartbeats()
    ])
    setAssistantArtifacts((current) =>
      mergeArtifacts(current, artifacts)
    )
  }, [refreshHeartbeats])

  const retryHeartbeatLoad = useCallback(async (): Promise<void> => {
    setHeartbeatLoading(true)
    setHeartbeatLoadError(undefined)
    try {
      await refreshHeartbeatCenter()
      setHeartbeatLoadError(undefined)
    } catch (reason) {
      setHeartbeatLoadError(
        displayErrorMessage(
          reason,
          tRef.current('notices.heartbeatReadFailed')
        )
      )
    } finally {
      setHeartbeatLoading(false)
    }
  }, [refreshHeartbeatCenter])

  const createHeartbeat = useCallback(
    async (input: HeartbeatCreateInput): Promise<void> => {
      await window.goodbuddy.heartbeats.create(input)
      await refreshHeartbeats()
    },
    [refreshHeartbeats]
  )

  const updateHeartbeat = useCallback(
    async (
      heartbeatId: string,
      input: HeartbeatUpdateInput
    ): Promise<void> => {
      await window.goodbuddy.heartbeats.update(heartbeatId, input)
      await refreshHeartbeats()
    },
    [refreshHeartbeats]
  )

  const removeHeartbeat = useCallback(
    async (heartbeatId: string): Promise<void> => {
      await window.goodbuddy.heartbeats.remove(heartbeatId)
      await refreshHeartbeats()
    },
    [refreshHeartbeats]
  )

  const runHeartbeat = useCallback(
    async (heartbeatId: string): Promise<void> => {
      await window.goodbuddy.heartbeats.runNow(heartbeatId)
      await refreshHeartbeatCenter()
    },
    [refreshHeartbeatCenter]
  )

  const setHeartbeatPaused = useCallback(
    async (heartbeatId: string, paused: boolean): Promise<void> => {
      await window.goodbuddy.heartbeats.setPaused(heartbeatId, paused)
      await refreshHeartbeats()
    },
    [refreshHeartbeats]
  )

  useEffect(() => {
    if (view !== 'heartbeat') {
      return
    }
    let refreshing = false
    const refresh = (): void => {
      if (refreshing) {
        return
      }
      refreshing = true
      void refreshHeartbeatCenter()
        .then(() => setHeartbeatLoadError(undefined))
        .catch((reason: unknown) =>
          setHeartbeatLoadError(
            displayErrorMessage(
              reason,
              tRef.current('notices.heartbeatRefreshFailed')
            )
          )
        )
        .finally(() => {
          refreshing = false
        })
    }
    const timeout = setTimeout(refresh, 0)
    const interval = setInterval(refresh, 30_000)
    return () => {
      clearTimeout(timeout)
      clearInterval(interval)
    }
  }, [refreshHeartbeatCenter, view])

  useEffect(() => {
    void window.goodbuddy.tasks
      .list()
      .then((tasks) => {
        setAssistantTasks(tasks)
        setActivityRecords((current) =>
          reconcileActivityRecords(
            current,
            tasks,
            new Set(activeRuns.current.keys())
          )
        )
      })
      .catch(() =>
        notify({
          tone: 'error',
          message: tRef.current('notices.taskHistoryReadFailed')
        })
      )
  }, [])

  useEffect(() => {
    if (view !== 'activity') {
      return
    }
    const timeout = setTimeout(() => {
      void refreshTokenUsage().catch(() =>
        notify({
          tone: 'error',
          message: tRef.current('notices.tokenUsageReadFailed')
        })
      )
    }, 0)
    return () => clearTimeout(timeout)
  }, [refreshTokenUsage, view])

  useEffect(() => {
    void window.goodbuddy.artifacts
      .list()
      .then((artifacts) =>
        setAssistantArtifacts((current) =>
          mergeArtifacts(current, artifacts)
        )
      )
      .catch(() =>
        notify({
          tone: 'error',
          message: tRef.current('notices.resultHistoryReadFailed')
        })
      )
  }, [])

  useEffect(() => {
    const missingIds = [
      ...new Set(
        (activeConversation?.messages ?? []).flatMap(
          (message) => message.artifactIds ?? []
        )
      )
    ]
      .filter(
        (artifactId) =>
          !assistantArtifactById.get(artifactId)?.content &&
          !hydratingArtifactIds.current.has(artifactId)
      )
      .slice(-32)
    if (missingIds.length === 0) {
      return
    }
    for (const artifactId of missingIds) {
      hydratingArtifactIds.current.add(artifactId)
    }
    void Promise.allSettled(
      missingIds.map((artifactId) =>
        window.goodbuddy.artifacts.get(artifactId)
      )
    ).then((results) => {
      const artifacts = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      )
      if (artifacts.length > 0) {
        setAssistantArtifacts((current) =>
          mergeArtifacts(current, artifacts)
        )
      }
      for (const artifactId of missingIds) {
        hydratingArtifactIds.current.delete(artifactId)
      }
    })
  }, [activeConversation, assistantArtifactById])

  useEffect(() => {
    const timeout = setTimeout(() => {
      void refreshKnowledge()
        .catch(() => {
          // refreshKnowledge exposes a recoverable page-local error.
        })
        .finally(() => setKnowledgeLoading(false))
    }, 0)
    return () => clearTimeout(timeout)
  }, [refreshKnowledge])

  useEffect(() => {
    if (view !== 'knowledge' && knowledgeOperationCount === 0) {
      return
    }
    const interval = setInterval(() => {
      void refreshKnowledge(
        knowledgeSnapshot.selectedLibraryId
      ).catch(() => {
        // The task center keeps the last successful snapshot while polling.
      })
    }, knowledgeOperationCount > 0 ? 350 : 1_000)
    return () => clearInterval(interval)
  }, [
    knowledgeOperationCount,
    knowledgeSnapshot.selectedLibraryId,
    refreshKnowledge,
    view
  ])

  useEffect(() => {
    void Promise.all([
      window.goodbuddy.settings.getRuntime(),
      window.goodbuddy.agent.getStatus()
    ])
      .then(([settings, status]) => {
        const selectionKey = agentRuntimeSelectionKey(
          getDefaultRuntimeSelection(settings)
        )
        runtimeStatusCacheRef.current = {
          key: selectionKey,
          settings
        }
        setRuntimeSettings(settings)
        setRuntime(status)
        setRuntimeStatusKey(selectionKey)
        if (!status.available && !runtimeSetupPromptedRef.current) {
          runtimeSetupPromptedRef.current = true
          setView('settings')
        }
      })
      .catch(() =>
        notify({
          tone: 'error',
          message: tRef.current('runtime.errors.readSettings')
        })
      )
    void window.goodbuddy.app
      .getInfo()
      .then(setAppInfo)
      .catch(() =>
        notify({
          tone: 'error',
          message: tRef.current('notices.appInfoReadFailed')
        })
      )
    const removeAgentListener =
      window.goodbuddy.agent.onEvent(handleAgentEvent)
    const removeOpenSettingsListener =
      window.goodbuddy.app.onOpenSettings(() => setView('settings'))
    return () => {
      removeAgentListener()
      removeOpenSettingsListener()
    }
  }, [handleAgentEvent, setView])

  useEffect(
    () => {
      const browserApi = window.goodbuddy.browser
      if (!browserApi) {
        return
      }
      return browserApi.onState((state) => {
        setBrowserStates((current) => {
          const previous = current[state.conversationId]
          return {
            ...current,
            [state.conversationId]:
              state.status === 'stopped' ||
              state.frameDataUrl ||
              !previous?.frameDataUrl
                ? state
                : {
                    ...state,
                    frameDataUrl: previous.frameDataUrl
                  }
          }
        })
        if (
          state.status !== 'stopped' &&
          state.conversationId ===
            conversationNavigationRef.current.activeId
        ) {
          setAssistantSidebarOpen(true)
          setAssistantSidebarTab('browser')
        }
      })
    },
    []
  )

  useEffect(
    () =>
      window.goodbuddy.app.onNewConversation(() => {
        startNewConversation(activeProjectIdRef.current || undefined)
      }),
    [startNewConversation]
  )

  useEffect(() => {
    const handleNewConversationShortcut = (
      event: KeyboardEvent
    ): void => {
      if (
        event.key.toLocaleLowerCase() !== 'n' ||
        (!event.ctrlKey && !event.metaKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return
      }
      event.preventDefault()
      startNewConversation(activeProjectIdRef.current || undefined)
    }
    document.addEventListener(
      'keydown',
      handleNewConversationShortcut
    )
    return () =>
      document.removeEventListener(
        'keydown',
        handleNewConversationShortcut
      )
  }, [startNewConversation])

  const selectProject = (projectId: string): void => {
    const project = projects.find((candidate) => candidate.id === projectId)
    if (!project) {
      return
    }
    setActiveProjectId(projectId)
    setWorkMode(normalizeInteractiveWorkMode(project.defaultWorkMode))
    const conversation = conversations.find(
      (candidate) =>
        candidate.projectId === projectId &&
        (project.kind !== 'channel' || candidate.remote !== undefined)
    )
    if (conversation) {
      setActiveId(conversation.id)
    } else if (project.kind === 'channel') {
      setActiveId('')
    } else {
      const created = createConversation(
        projectId,
        runtimeSettings
          ? getProjectDefaultRuntimeSelection(project, runtimeSettings)
          : undefined,
        t('conversation.greeting')
      )
      setConversations((current) => [created, ...current])
      setActiveId(created.id)
    }
    setView('chat')
  }

  const createProject = async (
    input: ProjectCreateInput
  ): Promise<AssistantProject> => {
    const project = await window.goodbuddy.projects.create(input)
    setProjects((current) => [project, ...current])
    setActiveProjectId(project.id)
    setWorkMode(normalizeInteractiveWorkMode(project.defaultWorkMode))
    const conversation = createConversation(
      project.id,
      runtimeSettings
        ? getProjectDefaultRuntimeSelection(project, runtimeSettings)
        : undefined,
      t('conversation.greeting')
    )
    setConversations((current) => [conversation, ...current])
    setActiveId(conversation.id)
    setView('chat')
    return project
  }

  const updateProject = async (
    projectId: string,
    input: ProjectCreateInput
  ): Promise<AssistantProject> => {
    const project = await window.goodbuddy.projects.update(
      projectId,
      input
    )
    setProjects((current) =>
      current.map((candidate) =>
        candidate.id === project.id ? project : candidate
      )
    )
    if (project.id === activeProjectId) {
      setWorkMode(
        normalizeInteractiveWorkMode(project.defaultWorkMode)
      )
    }
    return project
  }

  const archiveProject = async (projectId: string): Promise<void> => {
    await window.goodbuddy.projects.setArchived(projectId, true)
    const remaining = projects.filter((project) => project.id !== projectId)
    setProjects(remaining)
    const next = remaining[0]
    if (next) {
      selectProject(next.id)
    }
  }

  const deleteProject = async (
    projectId: string,
    confirmation: string
  ): Promise<void> => {
    await window.goodbuddy.projects.delete(projectId, confirmation)
    const remainingProjects = projects.filter(
      (project) => project.id !== projectId
    )
    const remainingConversations = conversations.filter(
      (conversation) => conversation.projectId !== projectId
    )
    setProjects(remainingProjects)
    setConversations(remainingConversations)
    setAssistantTasks((current) =>
      current.filter((task) => task.projectId !== projectId)
    )
    setAssistantArtifacts((current) =>
      current.filter((artifact) => artifact.projectId !== projectId)
    )
    setAssistantMemories((current) =>
      current.filter(
        (memory) =>
          !(
            memory.scope === 'project' &&
            memory.scopeId === projectId
          )
      )
    )
    setAssistantSchedules((current) =>
      current.filter((schedule) => schedule.projectId !== projectId)
    )
    setAssistantHeartbeats((current) =>
      current.flatMap((heartbeat) => {
        if (heartbeat.scope.kind === 'global') {
          return heartbeat
        }
        const projectIds = heartbeat.scope.projectIds.filter(
          (id) => id !== projectId
        )
        return projectIds.length > 0
          ? [{ ...heartbeat, scope: { kind: 'projects', projectIds } }]
          : []
      })
    )
    const next = remainingProjects[0]
    if (next) {
      setActiveProjectId(next.id)
      setWorkMode(
        normalizeInteractiveWorkMode(next.defaultWorkMode)
      )
      const nextConversation = remainingConversations.find(
        (conversation) =>
          conversation.projectId === next.id &&
          (next.kind !== 'channel' ||
            conversation.remote !== undefined)
      )
      if (nextConversation) {
        setActiveId(nextConversation.id)
      } else if (next.kind === 'channel') {
        setActiveId('')
      } else {
        const created = createConversation(
          next.id,
          runtimeSettings
            ? getProjectDefaultRuntimeSelection(next, runtimeSettings)
            : undefined,
          t('conversation.greeting')
        )
        setConversations((current) => [created, ...current])
        setActiveId(created.id)
      }
    }
    setView('chat')
  }

  const newConversation = (): boolean => {
    return startNewConversation(activeProjectId || undefined)
  }

  const setMemoryStatus = async (
    memoryId: string,
    status: AssistantMemory['status']
  ): Promise<void> => {
    await window.goodbuddy.memory.setStatus(memoryId, status)
    setAssistantMemories((current) =>
      status === 'rejected'
        ? current.filter((memory) => memory.id !== memoryId)
        : current.map((memory) =>
            memory.id === memoryId ? { ...memory, status } : memory
          )
    )
    setHeartbeatMemories((current) =>
      status === 'rejected'
        ? current.filter((memory) => memory.id !== memoryId)
        : current.map((memory) =>
            memory.id === memoryId ? { ...memory, status } : memory
          )
    )
  }

  const useHeartbeatTask = (task: AssistantTask): void => {
    if (task.projectId && task.projectId !== activeProjectId) {
      setActiveProjectId(task.projectId)
    }
    if (
      !startNewConversation(
        task.projectId ?? (activeProjectId || undefined)
      )
    ) {
      return
    }
    setWorkMode('ask')
    setInput(
      [
        t('notices.heartbeatTaskPrompt'),
        task.title,
        task.instructions
      ].join('\n\n')
    )
    notify({
      tone: 'info',
      message: t('notices.heartbeatTaskAdded', { title: task.title })
    })
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const setHeartbeatTaskStatus = async (
    taskId: string,
    status: 'completed' | 'cancelled'
  ): Promise<void> => {
    await window.goodbuddy.tasks.setStatus(taskId, status)
    setAssistantTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              status,
              completedAt: new Date().toISOString()
            }
          : task
      )
    )
  }

  const deleteConversation = async (
    conversationId: string
  ): Promise<void> => {
    if (deletingConversationId) {
      return
    }
    setDeletingConversationId(conversationId)
    const activeRequests = [...activeRuns.current.entries()]
      .filter(([, run]) => run.conversationId === conversationId)
      .map(([requestId]) => requestId)
    try {
      await Promise.all(
        activeRequests.map((requestId) =>
          window.goodbuddy.agent.cancel(requestId)
        )
      )
    } catch {
      notify({
        tone: 'error',
        message: t('notices.deleteConversationCancelFailed')
      })
      setDeletingConversationId('')
      return
    }
    const deletingConversation = conversations.find(
      (conversation) => conversation.id === conversationId
    )
    if (deletingConversation && !deletingConversation.remote) {
      deletingLocalConversationIdsRef.current.add(conversationId)
      try {
        await conversationPersistenceQueueRef.current
        await window.goodbuddy.conversations.deleteLocal(conversationId)
        persistedLocalConversationsRef.current.delete(conversationId)
      } catch {
        deletingLocalConversationIdsRef.current.delete(conversationId)
        notify({
          tone: 'error',
          message: t(
            'notices.deleteConversationPersistenceFailed'
          )
        })
        setDeletingConversationId('')
        return
      }
    }
    setConfirmingConversationId('')
    setDeletingConversationId('')
    if (conversationActionsId === conversationId) {
      setConversationActionsId('')
    }
    if (renamingConversationId === conversationId) {
      setRenamingConversationId('')
    }
    const browserStop = window.goodbuddy.browser?.stop(conversationId)
    if (browserStop) {
      void browserStop.catch(() => {
        notify({
          tone: 'error',
          message: t('notices.deletedConversationBrowserCloseFailed')
        })
      })
    }
    setBrowserStates((current) => {
      const next = { ...current }
      delete next[conversationId]
      return next
    })
    const draftAttachments =
      attachmentsRef.current.get(conversationId) ?? []
    attachmentsRef.current.delete(conversationId)
    for (const attachment of draftAttachments) {
      void window.goodbuddy.context.remove(attachment.id)
    }
    setAttachmentsByConversation((current) => {
      const next = { ...current }
      delete next[conversationId]
      return next
    })
    setConversationDrafts((current) => {
      const next = { ...current }
      delete next[conversationId]
      return next
    })
    setChatScrollSnapshots((current) => {
      const next = { ...current }
      delete next[conversationId]
      return next
    })
    setVisibleMessageCounts((current) => {
      const next = { ...current }
      delete next[conversationId]
      return next
    })
    setConversationActivity(conversationId, false)
    const remaining = conversations.filter(
      (conversation) => conversation.id !== conversationId
    )
    conversationsRef.current = remaining
    deletingLocalConversationIdsRef.current.delete(conversationId)
    const projectRemaining = remaining.filter(
      (conversation) => conversation.projectId === activeProjectId
    )
    setConversations(remaining)
    if (projectRemaining.length > 0) {
      if (conversationId === activeId) {
        setActiveId(projectRemaining[0]?.id ?? '')
      }
      return
    }
    if (activeProject?.kind === 'channel') {
      setActiveId('')
      return
    }
    const replacement = createConversation(
      activeProjectId || undefined,
      runtimeSettings
        ? getProjectDefaultRuntimeSelection(
            activeProject,
            runtimeSettings
          )
        : undefined,
      t('conversation.greeting')
    )
    setConversations((current) => [replacement, ...current])
    setActiveId(replacement.id)
  }

  const focusConversationActions = (conversationId: string): void => {
    requestAnimationFrame(() =>
      conversationActionTriggerRefs.current.get(conversationId)?.focus()
    )
  }

  const saveTitle = (
    conversationId: string,
    titleInput: string
  ): void => {
    const title = titleInput.trim().slice(0, 80)
    if (!title) {
      return
    }
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, title, updatedAt: Date.now() }
          : conversation
      )
    )
    setRenamingConversationId('')
    focusConversationActions(conversationId)
  }

  const copyConversation = async (
    conversation: ConversationSnapshot
  ): Promise<void> => {
    const transcript = conversation.messages
      .map(
        (message) =>
          t('chat.exportSpeaker', {
            speaker:
              message.role === 'user' ? t('chat.user') : 'GoodBuddy',
            content: `${message.content}${formatAttachmentList(
              message.attachments,
              t
            )}`
          })
      )
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(transcript)
      notify({
        tone: 'success',
        message: t('notices.conversationCopied')
      })
    } catch {
      notify({
        tone: 'error',
        message: t('notices.clipboardUnavailable')
      })
    }
  }

  const exportConversation = (
    conversation: ConversationSnapshot
  ): void => {
    const markdown = [
      `# ${conversation.title}`,
      '',
      ...conversation.messages.flatMap((message) => [
        `## ${message.role === 'user' ? t('chat.user') : 'GoodBuddy'}`,
        '',
        `${message.content}${formatAttachmentList(
          message.attachments,
          t
        )}`,
        ''
      ])
    ].join('\n')
    const blob = new Blob([markdown], {
      type: 'text/markdown;charset=utf-8'
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${
      conversation.title.replace(/[\\/:*?"<>|]/g, '_') ||
      t('conversation.exportFallbackName')
    }.md`
    anchor.click()
    URL.revokeObjectURL(url)
    notify({ tone: 'success', message: t('notices.conversationExported') })
  }

  const openImageViewer = useCallback((
    item: ImageViewerItem,
    trigger: HTMLElement
  ): void => {
    if (!imageDataUrlPattern.test(item.src)) {
      notify({
        tone: 'error',
        message: tRef.current('notices.imageUnavailable')
      })
      return
    }
    imageViewerTriggerRef.current = trigger
    setImageViewerItem(item)
  }, [])

  const closeImageViewer = (): void => {
    setImageViewerItem(undefined)
    requestAnimationFrame(() => {
      imageViewerTriggerRef.current?.focus()
      imageViewerTriggerRef.current = undefined
    })
  }

  const openCitationContext = useCallback(async (
    reference: KnowledgeSearchReference
  ): Promise<void> => {
    setCitationDialog({
      reference,
      loading: true
    })
    if (!reference.chunkId) {
      setCitationDialog({
        reference,
        loading: false,
        error: tRef.current('chat.citations.contextUnavailable')
      })
      return
    }
    try {
      const context =
        await window.goodbuddy.knowledge.getReferenceContext({
          knowledgeBaseId: reference.libraryId,
          documentId: reference.documentId,
          chunkId: reference.chunkId
        })
      setCitationDialog({
        reference,
        loading: false,
        context: {
          libraryName: reference.libraryName,
          documentName: context.documentTitle,
          sourceName: context.sourceDisplayName,
          locator: context.locator,
          matchedContent: context.matchedContent,
          contextContent: context.contextContent,
          truncated: context.truncated
        }
      })
    } catch (reason) {
      setCitationDialog({
        reference,
        loading: false,
        error:
          reason instanceof Error
            ? reason.message
            : tRef.current('chat.citations.contextUnavailable')
      })
    }
  }, [])

  const openCitationSource = useCallback(async (
    reference: KnowledgeSearchReference
  ): Promise<void> => {
    if (!reference.chunkId) {
      return
    }
    try {
      await window.goodbuddy.knowledge.openReferenceSource({
        knowledgeBaseId: reference.libraryId,
        documentId: reference.documentId,
        chunkId: reference.chunkId
      })
    } catch (reason) {
      notify({
        tone: 'error',
        message:
          reason instanceof Error
            ? reason.message
            : tRef.current('chat.citations.openFailed')
      })
    }
  }, [])

  const downloadImage = useCallback((item: ImageViewerItem): void => {
    if (!imageDataUrlPattern.test(item.src)) {
      notify({
        tone: 'error',
        message: tRef.current('notices.imageUnavailable')
      })
      return
    }
    const anchor = document.createElement('a')
    anchor.href = item.src
    anchor.download = getImageDownloadName(
      item.title,
      item.src,
      tRef.current('chat.images.fallbackTitle')
    )
    anchor.rel = 'noopener'
    anchor.click()
    notify({
      tone: 'info',
      message: tRef.current('notices.imageDownloadStarted')
    })
  }, [])

  const submit = async (): Promise<void> => {
    const command =
      activeRuntimeSelection?.provider === 'opencode'
        ? runtimeNativeSnapshot?.commands.find(
            (candidate) =>
              candidate.id === selectedRuntimeCommand
          )
        : undefined
    const commandArguments = input.trim()
    const prompt = command
      ? `/${command.name}${
          commandArguments ? ` ${commandArguments}` : ''
        }`
      : commandArguments
    if (!prompt || !activeConversation) {
      return
    }
    if (selectingContextFilesRef.current) {
      notify({
        tone: 'info',
        message: t('composer.attachmentProgress.waitBeforeSending')
      })
      return
    }
    if (activeConversation.remote) {
      notify({
        tone: 'info',
        message: t('notices.remoteConversationReadOnly')
      })
      return
    }
    if (!runtime) {
      notify({
        tone: 'info',
        message: t('runtime.loadingRetry')
      })
      return
    }
    if (
      runtimeSwitching ||
      runtimeStatusKey !== activeRuntimeSelectionKey
    ) {
      notify({
        tone: 'info',
        message: t('runtime.updatingRetry')
      })
      return
    }
    if (!runtime.available) {
      return
    }
    if (
      preparingConversations.current.has(activeConversation.id) ||
      [...activeRuns.current.values()].some(
        (run) => run.conversationId === activeConversation.id
      )
    ) {
      notify({
        tone: 'info',
        message: t('notices.conversationAlreadyRunning')
      })
      return
    }

    const requestId = crypto.randomUUID()
    const conversationId = activeConversation.id
    const attachmentSnapshot = attachments.slice(0, 8)
    const historySnapshot = activeConversation.messages
    const retainedHistorySnapshot = historySnapshot
      .filter(
        (message) =>
          message.state === 'complete' && message.content.trim()
      )
      .slice(-500)
    const projectIdSnapshot = activeProjectId || undefined
    const knowledgeRetrievalModeSnapshot =
      activeConversation.knowledgeRetrievalMode ?? 'auto'
    const runtimeSelectionSnapshot = activeRuntimeSelection
    if (!runtimeSelectionSnapshot) {
      notify({ tone: 'info', message: t('runtime.notSelected') })
      return
    }
    const runtimeControlSnapshot: RuntimeControl | undefined =
      runtimeSelectionSnapshot.provider === 'opencode' &&
      (selectedRuntimeAgent || command)
        ? {
            provider: 'opencode',
            ...(selectedRuntimeAgent
              ? { agent: selectedRuntimeAgent }
              : {}),
            ...(command
              ? {
                  command: {
                    name: command.name,
                    arguments: commandArguments
                  }
                }
              : {})
          }
        : runtimeSelectionSnapshot.provider === 'continue' &&
            selectedContinuePreset
          ? {
              provider: 'continue',
              presetId: selectedContinuePreset
            }
          : undefined
    const selectedExpertSnapshot =
      runtime.capability === 'image-generation' ? '' : selectedExpertId
    const workModeSnapshot = effectiveWorkMode
    setComposerMenuOpen(undefined)
    setRuntimeMenuOpen(false)
    preparingConversations.current.add(conversationId)
    setConversationActivity(conversationId, true)
    setInput('')
    updateAttachments([])
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      createdAt: Date.now(),
      state: 'complete',
      attachments:
        attachmentSnapshot.length > 0 ? attachmentSnapshot : undefined
    }
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              title:
                conversation.title === '新对话'
                  ? prompt.slice(0, 24)
                  : conversation.title,
              updatedAt: Date.now(),
              messages: [
                ...conversation.messages.slice(-499),
                userMessage
              ]
            }
          : conversation
      )
    )
    const memoryContext =
      runtime.capability === 'image-generation'
        ? ''
        : buildMemoryContext(assistantMemories)
    const executionPrompt = command
      ? prompt
      : memoryContext
      ? `${prompt}\n\n${memoryContext}`
      : prompt
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      blocks: [],
      createdAt: Date.now(),
      state: 'streaming',
      status: t('runtime.connecting')
    }

    activeRuns.current.set(requestId, {
      conversationId,
      messageId: assistantMessage.id,
      projectId: projectIdSnapshot,
      runtimeSelectionKey: agentRuntimeSelectionKey(
        runtimeSettings
          ? resolveContextMetricsRuntimeSelection(
              runtimeSelectionSnapshot,
              runtimeSettings
            )
          : runtimeSelectionSnapshot
      )
    })
    preparingConversations.current.delete(conversationId)
    const startedAt = new Date().toISOString()
    setAssistantTasks((current) =>
      [
        {
          id: requestId,
          projectId: projectIdSnapshot,
          conversationId,
          title: prompt.slice(0, 120),
          instructions: prompt,
          origin: 'user' as const,
          status: 'running' as const,
          createdAt: startedAt,
          startedAt
        },
        ...current
      ].slice(0, 100)
    )
    recordActivity({
      conversationId,
      requestId,
      kind: 'request',
      title: prompt.slice(0, 120),
      detail: t('notices.userStartedTask'),
      status: 'running'
    })
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              updatedAt: Date.now(),
              messages: [
                ...conversation.messages.slice(-499),
                assistantMessage
              ]
            }
          : conversation
      )
    )
    try {
      await window.goodbuddy.agent.run({
        requestId,
        conversationId,
        projectId: projectIdSnapshot,
        runtimeSelection: runtimeSelectionSnapshot,
        runtimeControl: runtimeControlSnapshot,
        expertId:
          selectedExpertSnapshot && selectedExpertSnapshot !== 'team'
            ? selectedExpertSnapshot
            : undefined,
        teamMode: selectedExpertSnapshot === 'team',
        smartRouting:
          runtime.capability !== 'image-generation' &&
          runtimeSettings?.subagentSmartRoutingEnabled === true &&
          !selectedExpertSnapshot &&
          supportsSubagentSmartRouting(workModeSnapshot)
            ? true
            : undefined,
        workMode: workModeSnapshot,
        prompt: executionPrompt,
        knowledgeLibraryIds: enabledKnowledgeLibraryIds,
        knowledgeRetrievalMode: knowledgeRetrievalModeSnapshot,
        contextIds: attachmentSnapshot.map(
          (attachment) => attachment.id
        ),
        contextCompressionState:
          activeConversation.contextCompressionState,
        history: retainedHistorySnapshot.map((message) => ({
          role: message.role,
          content: message.content
        })),
        historyMessageIds: retainedHistorySnapshot.map(
          (message) => message.id
        ),
        currentUserMessageId: userMessage.id,
        currentAssistantMessageId: assistantMessage.id
      })
      for (const attachment of attachmentSnapshot) {
        void window.goodbuddy.context.remove(attachment.id)
      }
      if (command) {
        setSelectedRuntimeCommand('')
      }
    } catch (error) {
      preparingConversations.current.delete(conversationId)
      for (const attachment of attachmentSnapshot) {
        void window.goodbuddy.context.remove(attachment.id)
      }
      handleAgentEvent({
        requestId,
        type: 'error',
        status: 'failed',
        message:
          error instanceof Error ? error.message : t('notices.sendFailed')
      })
    }
  }

  const compactRuntimeContext = async (): Promise<void> => {
    if (
      !activeConversation ||
      !activeRuntimeSelection ||
      (activeRuntimeSelection.provider !== 'opencode' &&
        activeRuntimeSelection.provider !== 'continue') ||
      runtimeContextCompacting ||
      isRunning
    ) {
      return
    }
    const history = activeConversation.messages
      .filter(
        (message) =>
          message.state === 'complete' && message.content.trim()
      )
      .slice(-500)
    if (history.length < 2) {
      notify({
        tone: 'info',
        message: t('composer.context.nothingToCompact'),
        dedupeKey: 'runtime-context-compact'
      })
      return
    }
    const requestId = crypto.randomUUID()
    setRuntimeContextCompacting(true)
    try {
      const result =
        await window.goodbuddy.agent.compactConversation({
          requestId,
          conversationId: activeConversation.id,
          projectId: activeConversation.projectId,
          runtimeSelection: activeRuntimeSelection,
          history: history.map((message) => ({
            role: message.role,
            content: message.content
          })),
          historyMessageIds: history.map((message) => message.id),
          contextCompressionState:
            activeConversation.contextCompressionState
        })
      if (result.contextCompressionState) {
        const state = result.contextCompressionState
        const remainingHistory = history.slice(
          Math.min(state.coveredMessageCount, history.length)
        )
        const estimatedAfterTokens =
          estimatedContextRequestOverheadTokens +
          estimateMessagesTokens([
            ...buildConversationSummaryHistory(state.summary),
            ...remainingHistory.map((message) => ({
              role: message.role,
              content: message.content
            }))
          ])
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === activeConversation.id
              ? {
                  ...conversation,
                  contextCompressionState: state,
                  contextMetrics: {
                    runtimeSelectionKey:
                      activeRuntimeSelectionKey,
                    contextTokens: estimatedAfterTokens,
                    source: 'estimated',
                    basis: 'conversation'
                  },
                  updatedAt: Date.now()
                }
              : conversation
          )
        )
      }
      notify({
        tone: result.compacted ? 'success' : 'info',
        message: result.detail,
        dedupeKey: 'runtime-context-compact'
      })
    } catch (reason) {
      notify({
        tone: 'error',
        message:
          reason instanceof Error
            ? reason.message
            : t('composer.context.compactFailed'),
        dedupeKey: 'runtime-context-compact'
      })
    } finally {
      setRuntimeContextCompacting(false)
    }
  }

  const stop = async (): Promise<void> => {
    const requestId = [...activeRuns.current.entries()].find(
      ([, run]) => run.conversationId === activeId
    )?.[0]
    if (requestId) {
      try {
        await window.goodbuddy.agent.cancel(requestId)
      } catch {
        notify({ tone: 'error', message: t('notices.stopFailed') })
      }
    }
  }

  const respondToApproval = useCallback(async (
    conversationId: string,
    messageId: string,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> => {
    try {
      await window.goodbuddy.agent.respondApproval(approvalId, decision)
      const approved = decision !== 'deny'
      const decisionLabel = {
        deny: tRef.current('chat.approval.decisionDeny'),
        once: tRef.current('chat.approval.decisionOnce'),
        session: tRef.current('chat.approval.decisionSession'),
        permanent: tRef.current('chat.approval.decisionPermanent')
      }[decision]
      setActivityRecords((current) => {
        let updated = false
        return current.map((record) => {
          if (
            !updated &&
            record.conversationId === conversationId &&
            record.kind === 'approval' &&
            record.status === 'pending'
          ) {
            updated = true
            return {
              ...record,
              status: approved ? ('completed' as const) : ('denied' as const),
              detail: `${record.detail}\n${tRef.current(
                'notices.userDecision',
                { decision: decisionLabel }
              )}`
            }
          }
          return record
        })
      })
      updateMessage(conversationId, messageId, (message) => ({
        ...message,
        approval: undefined,
        status:
          approved && message.task
            ? undefined
            : approved
              ? tRef.current('chat.approval.executing', {
                  decision: decisionLabel
                })
              : tRef.current('chat.approval.denied')
      }))
    } catch {
      updateMessage(conversationId, messageId, (message) => ({
        ...message,
        status: tRef.current('chat.approval.responseFailed')
      }))
    }
  }, [updateMessage])

  const respondToQuestion = useCallback(async (
    conversationId: string,
    messageId: string,
    questionId: string,
    answers?: AgentQuestionAnswer[]
  ): Promise<void> => {
    await window.goodbuddy.agent.respondQuestion(questionId, answers)
    updateMessage(conversationId, messageId, (message) => ({
      ...message,
      question: undefined,
      status: answers
        ? tRef.current('chat.status.answerSubmitted')
        : tRef.current('chat.status.questionSkipped')
    }))
  }, [updateMessage])

  const addContext = async (
    action: () => Promise<ContextAttachment | ContextAttachment[]>
  ): Promise<void> => {
    const conversationId = activeId
    setContextError(undefined)
    try {
      const result = await action()
      const selected = Array.isArray(result) ? result : [result]
      const current =
        attachmentsRef.current.get(conversationId) ?? []
      const unique = selected.filter(
        (item) =>
          !current.some((existing) => existing.id === item.id)
      )
      const accepted = unique.slice(
        0,
        Math.max(0, 8 - current.length)
      )
      for (const attachment of unique.slice(accepted.length)) {
        void window.goodbuddy.context.remove(attachment.id)
      }
      updateAttachments([...current, ...accepted])
      if (accepted.length < unique.length) {
        setContextError(t('composer.errors.attachmentLimit'))
      }
    } catch (reason) {
      setContextError(
        reason instanceof Error
          ? reason.message
          : t('composer.errors.addContext')
      )
    }
  }

  const selectContextFiles = async (): Promise<void> => {
    if (selectingContextFilesRef.current) {
      return
    }
    selectingContextFilesRef.current = true
    setSelectingContextFiles(true)
    setFileSelectionProgress(undefined)
    try {
      await addContext(() => window.goodbuddy.context.selectFiles())
    } finally {
      selectingContextFilesRef.current = false
      setSelectingContextFiles(false)
      setFileSelectionProgress(undefined)
    }
  }

  const removeAttachment = (attachmentId: string): void => {
    void window.goodbuddy.context.remove(attachmentId)
    updateAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId)
    )
  }

  const startWebSpeechInput = async (): Promise<void> => {
    const SpeechRecognition =
      getSpeechRecognitionConstructor(window)
    if (!SpeechRecognition) {
      notify({
        tone: 'info',
        message: t('composer.voice.unsupported')
      })
      return
    }
    setVoiceListening(true)
    setVoiceRecording(false)
    let started = false
    try {
      const prepared = await prepareSpeechRecognition(
        SpeechRecognition,
        'zh-CN',
        () => {
          notify({
            tone: 'info',
            message: t('composer.voice.downloadingPack'),
            dedupeKey: 'speech-status'
          })
        }
      )
      const { recognition } = prepared
      recognition.onresult = (event) => {
        const transcript = event.results[0]?.[0]?.transcript?.trim()
        if (transcript) {
          setInput((current) =>
            current ? `${current} ${transcript}` : transcript
          )
          notify({
            tone: 'success',
            message: t('composer.voice.transcribed'),
            dedupeKey: 'speech-status'
          })
        }
      }
      recognition.onerror = (event) => {
        notify({
          tone: 'error',
          message: describeSpeechRecognitionError(event),
          dedupeKey: 'speech-status'
        })
        setVoiceListening(false)
        setVoiceRecording(false)
      }
      recognition.onend = () => {
        setVoiceListening(false)
        setVoiceRecording(false)
      }
      recognition.start()
      started = true
      setVoiceRecording(true)
      notify({
        tone: 'info',
        message: prepared.local
          ? t('composer.voice.localListening')
          : t('composer.voice.systemListening'),
        dedupeKey: 'speech-status'
      })
    } catch (reason) {
      notify({
        tone: 'error',
        message:
          reason instanceof Error
            ? reason.message
            : t('composer.voice.startFailed'),
        dedupeKey: 'speech-status'
      })
    } finally {
      if (!started) {
        setVoiceListening(false)
        setVoiceRecording(false)
      }
    }
  }

  const startVoiceInput = async (): Promise<void> => {
    const speech = window.goodbuddy.speech
    if (!speech) {
      await startWebSpeechInput()
      return
    }
    const audioWindow = window as typeof window & {
      webkitAudioContext?: typeof AudioContext
    }
    const AudioContextType =
      audioWindow.AudioContext ?? audioWindow.webkitAudioContext
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextType) {
      notify({
        tone: 'error',
        message: t('composer.voice.microphoneUnavailable'),
        dedupeKey: 'speech-status'
      })
      return
    }
    setVoiceListening(true)
    setVoiceRecording(false)
    voiceStartingRef.current = true
    try {
      const recording = await startPcmRecording(
        navigator.mediaDevices,
        AudioContextType
      )
      voiceStartingRef.current = false
      if (voiceDisposedRef.current) {
        void recording.result.catch(() => undefined)
        recording.cancel()
        return
      }
      voiceRecordingRef.current = recording
      setVoiceRecording(true)
      notify({
        tone: 'info',
        message: t('composer.voice.recording'),
        dedupeKey: 'speech-status'
      })
      void recording.result
        .then(async ({ audio, sampleRate }) => {
          voiceRecordingRef.current = undefined
          setVoiceRecording(false)
          const requestId = crypto.randomUUID()
          voiceRequestIdRef.current = requestId
          notify({
            tone: 'info',
            message: t('composer.voice.localRecognizing'),
            dedupeKey: 'speech-status'
          })
          const result = await speech.transcribe({
            requestId,
            sampleRate,
            audio
          })
          if (voiceRequestIdRef.current !== requestId) {
            return
          }
          const transcript = result.text.trim()
          if (!transcript) {
            notify({
              tone: 'info',
              message: t('composer.voice.noSpeech'),
              dedupeKey: 'speech-status'
            })
            return
          }
          setInput((current) =>
            current ? `${current} ${transcript}` : transcript
          )
          notify({
            tone: 'success',
            message: t('composer.voice.transcribed'),
            dedupeKey: 'speech-status'
          })
        })
        .catch((reason: unknown) => {
          notify({
            tone:
              reason instanceof Error &&
              reason.name === 'AbortError'
                ? 'info'
                : 'error',
            message:
              reason instanceof Error &&
              reason.name === 'AbortError'
                ? t('composer.voice.cancelled')
                : reason instanceof Error
                  ? reason.message
                  : t('composer.voice.localFailed'),
            dedupeKey: 'speech-status'
          })
        })
        .finally(() => {
          voiceRequestIdRef.current = undefined
          setVoiceListening(false)
          setVoiceRecording(false)
        })
    } catch (reason) {
      voiceStartingRef.current = false
      setVoiceListening(false)
      setVoiceRecording(false)
      notify({
        tone: 'error',
        message:
          reason instanceof Error &&
          reason.name === 'NotAllowedError'
            ? t('composer.voice.permissionDenied')
            : reason instanceof Error
              ? reason.message
              : t('composer.voice.recordingStartFailed'),
        dedupeKey: 'speech-status'
      })
    }
  }

  const toggleVoiceInput = (): void => {
    if (voiceStartingRef.current) {
      return
    }
    const recording = voiceRecordingRef.current
    if (recording) {
      setVoiceRecording(false)
      recording.stop()
      notify({
        tone: 'info',
        message: t('composer.voice.preparing'),
        dedupeKey: 'speech-status'
      })
      return
    }
    const requestId = voiceRequestIdRef.current
    if (requestId) {
      voiceRequestIdRef.current = undefined
      void window.goodbuddy.speech?.cancel(requestId)
      notify({
        tone: 'info',
        message: t('composer.voice.cancelled'),
        dedupeKey: 'speech-status'
      })
      setVoiceListening(false)
      setVoiceRecording(false)
      return
    }
    void startVoiceInput()
  }

  const refreshSelectedKnowledge = async (): Promise<void> => {
    await refreshKnowledge(knowledgeSnapshot.selectedLibraryId)
  }

  const createKnowledgeLibrary = async (
    input: Parameters<
      typeof window.goodbuddy.knowledge.createLibrary
    >[0]
  ): Promise<void> => {
    const library = await window.goodbuddy.knowledge.createLibrary(input)
    setEnabledKnowledgeLibraryIds((current) => [...current, library.id])
    await refreshKnowledge(library.id)
  }

  const deleteKnowledgeLibrary = async (libraryId: string): Promise<void> => {
    await window.goodbuddy.knowledge.deleteLibrary(libraryId)
    await refreshKnowledge()
  }

  const runKnowledgeSourceAction = async <T,>(
    action: () => Promise<T>
  ): Promise<T> => {
    setKnowledgeOperationCount((count) => count + 1)
    try {
      const result = await action()
      await refreshSelectedKnowledge()
      return result
    } catch (error) {
      await refreshSelectedKnowledge().catch(() => undefined)
      throw error
    } finally {
      setKnowledgeOperationCount((count) => Math.max(0, count - 1))
    }
  }

  const openActivityConversation = (conversationId: string): void => {
    const conversation = conversations.find(
      (candidate) => candidate.id === conversationId
    )
    if (!conversation) {
      notify({
        tone: 'info',
        message: t('notices.conversationDeleted')
      })
      return
    }
    if (conversation.projectId) {
      const project = projects.find(
        (candidate) => candidate.id === conversation.projectId
      )
      setActiveProjectId(conversation.projectId)
      if (project) {
        setWorkMode(
          normalizeInteractiveWorkMode(project.defaultWorkMode)
        )
      }
    }
    setActiveId(conversationId)
    setUnreadConversationIds((current) => {
      if (!current.has(conversationId)) {
        return current
      }
      const next = new Set(current)
      next.delete(conversationId)
      return next
    })
    setView('chat')
  }

  const openAssistantTask = (task: AssistantTask): void => {
    if (!task.conversationId) {
      notify({
        tone: 'info',
        message: t('notices.conversationDeleted')
      })
      return
    }
    const conversation = conversations.find(
      (candidate) => candidate.id === task.conversationId
    )
    if (!conversation) {
      notify({
        tone: 'info',
        message: t('notices.conversationDeleted')
      })
      return
    }
    if (task.projectId) {
      const project = projects.find(
        (candidate) => candidate.id === task.projectId
      )
      setActiveProjectId(task.projectId)
      if (project) {
        setWorkMode(
          normalizeInteractiveWorkMode(project.defaultWorkMode)
        )
      }
    }
    setSelectedAssistantTaskId(task.id)
    setExpandedTaskConversationIds((current) => {
      const next = new Set(current)
      next.add(conversation.id)
      return next
    })
    setActiveId(conversation.id)
    setView('chat')
  }

  const openCustomTaskDialog = (
    defaultDestination: CustomTaskDestination
  ): void => {
    if (!activeProject || activeProject.kind !== 'user') {
      notify({
        tone: 'info',
        message: t('customTask.errors.projectUnavailable')
      })
      return
    }
    setCustomTaskDialog({ defaultDestination })
  }

  const createCustomTask = async (
    input: Parameters<typeof window.goodbuddy.schedules.create>[0]
  ): Promise<AssistantSchedule> => {
    if (input.conversationId) {
      persistLocalConversationChanges()
      await conversationPersistenceQueueRef.current
    }
    const schedule = await window.goodbuddy.schedules.create(input)
    setAssistantSchedules((current) => [
      schedule,
      ...current.filter((item) => item.id !== schedule.id)
    ])
    setSelectedAssistantTaskId(schedule.taskId)
    setExpandedTaskConversationIds((current) => {
      const next = new Set(current)
      next.add(schedule.conversationId)
      return next
    })

    const [conversationResult, taskResult, scheduleResult] =
      await Promise.allSettled([
        window.goodbuddy.conversations.list(),
        window.goodbuddy.tasks.list(),
        window.goodbuddy.schedules.list()
      ])
    if (conversationResult.status === 'fulfilled') {
      setConversations((current) =>
        mergePersistedConversations(
          current,
          conversationResult.value,
          persistedLocalConversationsRef.current
        )
      )
    } else {
      notify({
        tone: 'error',
        message: t('notices.remoteConversationRefreshFailed'),
        dedupeKey: 'custom-task-conversation-refresh'
      })
    }
    if (taskResult.status === 'fulfilled') {
      setAssistantTasks(taskResult.value)
    }
    if (scheduleResult.status === 'fulfilled') {
      setAssistantSchedules(scheduleResult.value)
    }
    if (
      taskResult.status === 'rejected' ||
      scheduleResult.status === 'rejected'
    ) {
      notify({
        tone: 'error',
        message: t('notices.taskHistoryReadFailed'),
        dedupeKey: 'custom-task-discovery-refresh'
      })
    }
    if (schedule.projectId) {
      const project = projects.find(
        (candidate) => candidate.id === schedule.projectId
      )
      setActiveProjectId(schedule.projectId)
      if (project) {
        setWorkMode(
          normalizeInteractiveWorkMode(project.defaultWorkMode)
        )
      }
    }
    setActiveId(schedule.conversationId)
    setView('chat')
    return schedule
  }

  const runAssistantSchedule = async (
    scheduleId: string
  ): Promise<void> => {
    await window.goodbuddy.schedules.runNow(scheduleId)
    notify({
      tone: 'success',
      message: t('notices.scheduleStarted')
    })
  }

  const setAssistantScheduleEnabled = async (
    scheduleId: string,
    enabled: boolean
  ): Promise<void> => {
    await window.goodbuddy.schedules.setEnabled(scheduleId, enabled)
    setAssistantSchedules((current) =>
      current.map((schedule) =>
        schedule.id === scheduleId
          ? { ...schedule, enabled }
          : schedule
      )
    )
  }

  const removeAssistantSchedule = async (
    scheduleId: string
  ): Promise<void> => {
    await window.goodbuddy.schedules.remove(scheduleId)
    setAssistantSchedules((current) =>
      current.filter((schedule) => schedule.id !== scheduleId)
    )
  }

  const clearLocalData = async (): Promise<void> => {
    conversationPersistencePausedRef.current = true
    try {
      await conversationPersistenceQueueRef.current
      for (const requestId of activeRuns.current.keys()) {
        await window.goodbuddy.agent.cancel(requestId)
      }
      activeRuns.current.clear()
      setActiveConversationIds(new Set())
      for (const attachments of attachmentsRef.current.values()) {
        for (const attachment of attachments) {
          await window.goodbuddy.context.remove(attachment.id)
        }
      }
      attachmentsRef.current.clear()
      setAttachmentsByConversation({})
      for (const library of knowledgeSnapshot.libraries) {
        await window.goodbuddy.knowledge.deleteLibrary(library.id)
      }
      await window.goodbuddy.app.clearLocalData()
      const conversation = createConversation(
        activeProjectId || undefined,
        runtimeSettings
          ? getProjectDefaultRuntimeSelection(
              activeProject,
              runtimeSettings
            )
          : undefined,
        t('conversation.greeting')
      )
      conversationsRef.current = [conversation]
      persistedLocalConversationsRef.current.clear()
      setConversations([conversation])
      setActiveId(conversation.id)
      setActivityRecords([])
      setAssistantTasks([])
      setTokenUsage(emptyTokenUsage)
      setAssistantArtifacts([])
      setAssistantMemories([])
      setAssistantSchedules([])
      setAssistantHeartbeats([])
      setHeartbeatEntries([])
      setHeartbeatRuns([])
      setHeartbeatMemories([])
      setKnowledgeSnapshot({
        libraries: [],
        sources: [],
        documents: [],
        graphNodes: [],
        graphRelations: [],
        evidence: []
      })
      setEnabledKnowledgeLibraryIds([])
      updateAttachments([])
      setInput('')
      setView('chat')
      notify({
        tone: 'success',
        message: t('notices.localDataCleared')
      })
    } finally {
      conversationPersistencePausedRef.current = false
      persistLocalConversationChanges()
    }
  }

  const isRunning =
    activeConversation?.messages.some(
      (message) => message.state === 'streaming'
    ) ?? false
  const runtimeAgentControlAvailable =
    activeRuntimeSelection?.provider === 'opencode' &&
    runtimeAgentOptions.length > 1
  const runtimePresetControlAvailable =
    activeRuntimeSelection?.provider === 'continue' &&
    runtimePresetOptions.length > 1
  const runtimeActionControlAvailable =
    (activeRuntimeSelection?.provider === 'opencode' ||
      activeRuntimeSelection?.provider === 'continue') &&
    runtimeActionOptions.length > 1
  const runtimeControlsAvailable =
    runtimeAgentControlAvailable ||
    runtimePresetControlAvailable ||
    runtimeActionControlAvailable
  const runtimeControlsProvider = runtimeControlsAvailable
    ? activeRuntimeSelection?.provider === 'opencode'
      ? 'OpenCode'
      : activeRuntimeSelection?.provider === 'continue'
        ? 'Continue'
        : undefined
    : undefined
  const runtimeControlsLabel = runtimeControlsProvider
    ? t('composer.runtimeControls.groupLabel', {
        runtime: runtimeControlsProvider
      })
    : ''
  const runtimeContextCompactAvailable =
    (activeRuntimeSelection?.provider === 'opencode' ||
      activeRuntimeSelection?.provider === 'continue') &&
    runtimeNativeSnapshot?.context.manualCompact === true

  const composerContextMetrics = useMemo(() => {
    if (
      !activeConversation ||
      !runtimeSettings ||
      !activeRuntimeSelection ||
      activeConversation.remote
    ) {
      return undefined
    }
    const resolvedRuntimeSelection =
      resolveContextMetricsRuntimeSelection(
        activeRuntimeSelection,
        runtimeSettings
      )
    const activeModelProfile =
      'profileId' in resolvedRuntimeSelection &&
      resolvedRuntimeSelection.profileId
        ? runtimeSettings.modelProfiles.find(
            (candidate) =>
              candidate.id === resolvedRuntimeSelection.profileId
          )
        : undefined
    if (activeModelProfile?.protocol === 'openai-images-generations') {
      return undefined
    }
    const latest = activeConversation.contextMetrics
    const applicableLatest =
      latest?.runtimeSelectionKey ===
      agentRuntimeSelectionKey(resolvedRuntimeSelection)
        ? latest
        : undefined
    if (!applicableLatest) {
      return undefined
    }
    const compressionSettings =
      runtimeSettings.contextCompression ??
      defaultContextCompressionSettings
    const contextTokens = applicableLatest.contextTokens
    const contextWindowTokens =
      activeModelProfile?.contextWindowTokens
    const effectiveTriggerTokens = getEffectiveContextTriggerTokens({
      triggerTokens: compressionSettings.triggerTokens,
      contextWindowTokens
    })
    const denominatorTokens = contextWindowTokens
    const percentage =
      denominatorTokens === undefined
        ? undefined
        : Math.round(
            (contextTokens / denominatorTokens) * 100
          )

    return {
      contextTokens,
      effectiveTriggerTokens,
      contextWindowTokens,
      compressionEnabled:
        resolvedRuntimeSelection.provider === 'model' &&
        compressionSettings.enabled,
      source: applicableLatest.source,
      basis:
        applicableLatest.basis ??
        (applicableLatest.source === 'estimated' &&
        activeConversation.contextCompressionState
          ? 'conversation'
          : 'model-call'),
      denominatorTokens,
      percentage
    }
  }, [
    activeConversation,
    activeRuntimeSelection,
    runtimeSettings
  ])

  return (
    <div className="app-shell">
      <aside
        aria-label={
          narrowWindow && sidebarOpen ? t('sidebar.label') : undefined
        }
        aria-hidden={!sidebarOpen}
        aria-modal={narrowWindow && sidebarOpen ? 'true' : undefined}
        className={sidebarOpen ? 'sidebar' : 'sidebar sidebar--closed'}
        inert={!sidebarOpen}
        ref={sidebarRef}
        role={narrowWindow && sidebarOpen ? 'dialog' : undefined}
      >
        <div className="brand">
          <div className="brand__mark">
            <img
              alt=""
              aria-hidden="true"
              src={
                resolvedAppearanceTheme === 'dark'
                  ? goodbuddyDarkIcon
                  : goodbuddyLightIcon
              }
            />
          </div>
          <div className="brand__copy">
            <strong>GoodBuddy</strong>
            <span>{t('brand.desktopWorkspace')}</span>
          </div>
        </div>

        <ProjectSwitcher
          activeProjectId={activeProjectId}
          runtimeSettings={runtimeSettings}
          onArchive={archiveProject}
          onCreate={createProject}
          onDelete={deleteProject}
          onSelect={selectProject}
          onSelectRoot={() =>
            window.goodbuddy.settings.selectWorkspace()
          }
          onUpdate={updateProject}
          projects={projects}
        />

        {activeProject?.kind !== 'channel' && (
          <button
            className="new-chat"
            onClick={newConversation}
            type="button"
          >
            <MessageSquarePlus size={17} />
            <span>{t('sidebar.newConversation')}</span>
            <kbd>Ctrl N</kbd>
          </button>
        )}

        <div className="sidebar-search">
          <Search size={15} />
          <input
            aria-label={t('sidebar.searchLabel')}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('sidebar.searchPlaceholder')}
            value={searchQuery}
          />
        </div>

        <nav className="primary-nav" aria-label={t('navigation.label')}>
          <button
            aria-current={view === 'chat' ? 'page' : undefined}
            className={
              view === 'chat' ? 'nav-item nav-item--active' : 'nav-item'
            }
            onClick={() => setView('chat')}
            type="button"
          >
            <MessageSquare aria-hidden="true" size={17} />
            <span>{t('navigation.chat')}</span>
          </button>
          {magicNotesEnabled && (
            <button
              aria-current={view === 'magic-notes' ? 'page' : undefined}
              className={
                view === 'magic-notes'
                  ? 'nav-item nav-item--active'
                  : 'nav-item'
              }
              onClick={() => setView('magic-notes')}
              type="button"
            >
              <Sparkles aria-hidden="true" size={17} />
              <span>{t('navigation.magicNotes')}</span>
            </button>
          )}
          <button
            aria-current={view === 'knowledge' ? 'page' : undefined}
            className={
              view === 'knowledge'
                ? 'nav-item nav-item--active'
                : 'nav-item'
            }
            onClick={() => setView('knowledge')}
            type="button"
          >
            <Library aria-hidden="true" size={17} />
            <span>{t('navigation.knowledge')}</span>
          </button>
          <button
            aria-current={view === 'heartbeat' ? 'page' : undefined}
            className={
              view === 'heartbeat'
                ? 'nav-item nav-item--active'
                : 'nav-item'
            }
            onClick={() => setView('heartbeat')}
            type="button"
          >
            <HeartPulse aria-hidden="true" size={17} />
            <span>{t('navigation.heartbeat')}</span>
            {pendingHeartbeatSuggestionCount > 0 && (
              <span
                aria-label={t('navigation.pendingSuggestions', {
                  count: pendingHeartbeatSuggestionCount
                })}
                className="nav-item__badge"
              >
                {pendingHeartbeatSuggestionCount}
              </span>
            )}
          </button>
          <button
            aria-current={view === 'activity' ? 'page' : undefined}
            className={
              view === 'activity'
                ? 'nav-item nav-item--active'
                : 'nav-item'
            }
            onClick={() => setView('activity')}
            type="button"
          >
            <TerminalSquare aria-hidden="true" size={17} />
            <span>{t('navigation.activity')}</span>
          </button>
        </nav>

        <div className="conversation-list">
          <p className="section-label">{t('sidebar.recent')}</p>
          {filteredConversations.map((conversation) => {
            const conversationTasks =
              tasksByConversation.get(conversation.id) ?? []
            const tasksExpanded =
              expandedTaskConversationIds.has(conversation.id)
            const conversationTitle = getConversationDisplayTitle(
              conversation,
              t('conversation.defaultTitle')
            )
            return (
            <div className="conversation-entry" key={conversation.id}>
              <div
                className={
                  conversation.id === activeId
                    ? 'conversation-row conversation-row--active'
                    : 'conversation-row'
                }
              >
                {conversationTasks.length > 0 && (
                  <button
                    aria-expanded={tasksExpanded}
                    aria-label={t('conversation.tasks.toggle', {
                      title: conversationTitle,
                      count: conversationTasks.length
                    })}
                    className="conversation-task-toggle"
                    onClick={() =>
                      setExpandedTaskConversationIds((current) => {
                        const next = new Set(current)
                        if (next.has(conversation.id)) {
                          next.delete(conversation.id)
                        } else {
                          next.add(conversation.id)
                        }
                        return next
                      })
                    }
                    type="button"
                  >
                    {tasksExpanded ? (
                      <ChevronDown aria-hidden="true" size={13} />
                    ) : (
                      <ChevronRight aria-hidden="true" size={13} />
                    )}
                  </button>
                )}
                <button
                  className={
                    conversation.id === activeId
                      ? 'conversation-item conversation-item--active'
                      : 'conversation-item'
                  }
                  type="button"
                  onClick={() => {
                    setConversationActionsId('')
                    setSelectedAssistantTaskId(undefined)
                    setActiveId(conversation.id)
                    setUnreadConversationIds((current) => {
                      if (!current.has(conversation.id)) {
                        return current
                      }
                      const next = new Set(current)
                      next.delete(conversation.id)
                      return next
                    })
                    setView('chat')
                  }}
                >
                  <span className="conversation-item__primary">
                    {conversation.remote && (
                      <b className="conversation-source-badge">
                        {
                          projectChannelLabels[
                            conversation.remote.channel
                          ]
                        }
                      </b>
                    )}
                    <OverflowMarquee
                      className="conversation-item__title"
                      text={conversationTitle}
                    />
                    {unreadConversationIds.has(conversation.id) && (
                      <i
                        aria-label={t('conversation.unread')}
                        className="conversation-unread"
                        title={t('conversation.unreadRemote')}
                      />
                    )}
                  </span>
                  <small>
                    <time
                      dateTime={new Date(
                        conversation.updatedAt
                      ).toISOString()}
                      title={formatMediumDateTime(
                        conversation.updatedAt,
                        locale
                      )}
                    >
                      {formatConversationListTime(
                        conversation.updatedAt,
                        locale
                      )}
                    </time>
                  </small>
                </button>
                {activeConversationIds.has(conversation.id) && (
                  <span
                    aria-label={t('conversation.active')}
                    className="conversation-activity-indicator"
                    role="status"
                    title={t('conversation.active')}
                  />
                )}
                <button
                  aria-controls={`conversation-actions-${conversation.id}`}
                  aria-expanded={
                    conversationActionsId === conversation.id
                  }
                  aria-label={t('conversation.actions.more', {
                    title: conversationTitle
                  })}
                  className="conversation-more"
                  onClick={() => {
                    setRenamingConversationId('')
                    setConfirmingConversationId('')
                    setConversationActionsId((current) =>
                      current === conversation.id ? '' : conversation.id
                    )
                  }}
                  ref={(element) => {
                    if (element) {
                      conversationActionTriggerRefs.current.set(
                        conversation.id,
                        element
                      )
                    } else {
                      conversationActionTriggerRefs.current.delete(
                        conversation.id
                      )
                    }
                  }}
                  type="button"
                >
                  <MoreHorizontal size={14} />
                </button>
              </div>
              {conversationActionsId === conversation.id && (
                <div
                  aria-label={t('conversation.actions.region', {
                    title: conversationTitle
                  })}
                  className="conversation-actions"
                  id={`conversation-actions-${conversation.id}`}
                >
                  {!conversation.remote && (
                    <button
                      onClick={() => {
                        setConversationActionsId('')
                        setRenamingConversationId(conversation.id)
                      }}
                      type="button"
                    >
                      <Edit3 size={14} />
                      {t('conversation.actions.rename')}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setConversationActionsId('')
                      void copyConversation(conversation).finally(() =>
                        focusConversationActions(conversation.id)
                      )
                    }}
                    type="button"
                  >
                    <Copy size={14} />
                    {t('conversation.actions.copy')}
                  </button>
                  <button
                    onClick={() => {
                      setConversationActionsId('')
                      exportConversation(conversation)
                      focusConversationActions(conversation.id)
                    }}
                    type="button"
                  >
                    <Download size={14} />
                    {t('conversation.actions.export')}
                  </button>
                  {!conversation.remote && (
                    <DestructiveConfirmActions
                      cancelAriaLabel={t('conversation.delete.cancelAria', {
                        title: conversationTitle
                      })}
                      confirmAriaLabel={t('conversation.delete.confirmAria', {
                        title: conversationTitle
                      })}
                      confirmLabel={t('conversation.delete.confirm')}
                      confirming={
                        confirmingConversationId === conversation.id
                      }
                      disabled={
                        deletingConversationId === conversation.id
                      }
                      icon={<Trash2 aria-hidden="true" size={14} />}
                      message={t('conversation.delete.message')}
                      onCancel={() => setConfirmingConversationId('')}
                      onConfirm={() =>
                        void deleteConversation(conversation.id)
                      }
                      onRequestConfirm={() =>
                        setConfirmingConversationId(conversation.id)
                      }
                      triggerAriaLabel={t('conversation.delete.triggerAria', {
                        title: conversationTitle
                      })}
                      triggerLabel={t('conversation.delete.trigger')}
                    />
                  )}
                </div>
              )}
              {!conversation.remote &&
                renamingConversationId === conversation.id && (
                <form
                  className="conversation-rename"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const input =
                      event.currentTarget.elements.namedItem('title')
                    if (input instanceof HTMLInputElement) {
                      saveTitle(conversation.id, input.value)
                    }
                  }}
                >
                  <input
                    aria-label={t('conversation.renameAria', {
                      title: conversationTitle
                    })}
                    autoFocus
                    defaultValue={conversation.title}
                    maxLength={80}
                    name="title"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setRenamingConversationId('')
                        focusConversationActions(conversation.id)
                      }
                    }}
                    pattern=".*\S.*"
                    required
                  />
                  <button
                    aria-label={t('conversation.saveName')}
                    type="submit"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    aria-label={t('conversation.cancelRename')}
                    onClick={() => {
                      setRenamingConversationId('')
                      focusConversationActions(conversation.id)
                    }}
                    type="button"
                  >
                    <X size={14} />
                  </button>
                </form>
                )}
              {tasksExpanded && conversationTasks.length > 0 && (
                <ul
                  aria-label={t('conversation.tasks.list', {
                    title: conversationTitle
                  })}
                  className="conversation-task-children"
                >
                  {conversationTasks.slice(0, 3).map((task) => {
                    const schedule = findTaskSchedule(
                      task,
                      assistantSchedules
                    )
                    return (
                      <li key={task.id}>
                        <button
                          className={
                            selectedAssistantTaskId === task.id
                              ? 'conversation-task-child conversation-task-child--active'
                              : 'conversation-task-child'
                          }
                          onClick={() => openAssistantTask(task)}
                          type="button"
                        >
                          <ListTodo
                            aria-hidden="true"
                            className={`conversation-task-child__icon conversation-task-child__icon--${task.status}`}
                            size={13}
                          />
                          <span className="conversation-task-child__title">
                            {task.title}
                          </span>
                          <small className="conversation-task-child__meta">
                            {schedule
                              ? `${tWorkspace(`task.mode.${schedule.workMode}`)} · ${tWorkspace(
                                  `sidebar.tasks.schedule.recurrence.${schedule.recurrence}`
                                )} · `
                              : ''}
                            {tWorkspace(`task.status.${task.status}`)}
                          </small>
                        </button>
                      </li>
                    )
                  })}
                  {conversationTasks.length > 3 && (
                    <li>
                      <button
                        className="conversation-task-view-all"
                        onClick={() => {
                          setSelectedAssistantTaskId(
                            conversationTasks[0]?.id
                          )
                          setActiveId(conversation.id)
                          setView('chat')
                        }}
                        type="button"
                      >
                        {t('conversation.tasks.viewAll', {
                          count: conversationTasks.length
                        })}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
            )
          })}
          {filteredConversations.length === 0 && (
            <p className="conversation-empty">
              {activeProject?.kind === 'channel' &&
              !deferredSearchQuery.trim()
                ? t('conversation.noRemote')
                : t('conversation.noMatches')}
            </p>
          )}
        </div>

        <div className="sidebar-footer">
          <button
            className="user-card"
            type="button"
            onClick={() => setView('settings')}
          >
            <span className="avatar">GB</span>
            <span className="user-card__copy">
              <strong>{t('sidebar.localWorkspace')}</strong>
              <small>
                {appInfo
                  ? `${appInfo.platform} · ${appInfo.arch}`
                  : t('sidebar.loading')}
              </small>
            </span>
            <Settings size={16} />
          </button>
        </div>
      </aside>
      {sidebarOpen && (
        <button
          aria-label={t('sidebar.close')}
          className="sidebar-backdrop"
          onClick={closeNarrowSidebar}
          type="button"
        />
      )}

      <main
        aria-hidden={narrowWindow && sidebarOpen ? 'true' : undefined}
        className="workspace"
        inert={narrowWindow && sidebarOpen}
      >
        <header className="topbar">
          <button
            className="icon-button sidebar-toggle"
            type="button"
            aria-label={t('sidebar.toggle')}
            onClick={() => setSidebarOpen((open) => !open)}
            ref={sidebarToggleRef}
          >
            <PanelLeft aria-hidden="true" size={18} />
          </button>
          {view === 'chat' && (
            <>
              <div
                className="conversation-title"
                title={activeConversation?.title}
              >
                <span>
                  {activeConversation
                    ? getConversationDisplayTitle(
                        activeConversation,
                        t('conversation.defaultTitle')
                      )
                    :
                    (activeProject?.kind === 'channel'
                      ? t('conversation.remoteTitle')
                      : t('conversation.defaultTitle'))}
                </span>
                {activeConversation?.remote && (
                  <b className="conversation-source-badge">
                    {
                      projectChannelLabels[
                        activeConversation.remote.channel
                      ]
                    }
                  </b>
                )}
              </div>
              <ScopeBadge
                scope={
                  activeProject
                    ? {
                        kind: 'project',
                        projectName: activeProject.name
                      }
                    : {
                        kind: 'unavailable',
                        explanation: t('notices.projectNotLoaded')
                      }
                }
              />
            </>
          )}
          <div className="topbar__actions">
            <span
              className={
                runtime?.available
                  ? 'runtime-status runtime-status--online'
                  : 'runtime-status'
              }
              title={runtime?.detail}
            >
              <span className="runtime-status__dot" />
              <span className="runtime-status__label">
                {runtime?.label ?? t('runtime.detecting')}
              </span>
              {runtime?.capability === 'image-generation' && (
                <span className="runtime-capability-badge">
                  {t('runtime.imageGeneration')}
                </span>
              )}
            </span>
            {view === 'chat' && (
              <button
                aria-label={t('topbar.toggleAssistantSidebar')}
                aria-pressed={assistantSidebarOpen}
                className={
                  assistantSidebarOpen
                    ? 'icon-button icon-button--active'
                    : 'icon-button'
                }
                onClick={() =>
                  setAssistantSidebarOpen((current) => !current)
                }
                type="button"
              >
                <PanelRightOpen size={18} />
              </button>
            )}
            <button
              aria-label={
                resolvedAppearanceTheme === 'dark'
                  ? t('topbar.switchLight')
                  : t('topbar.switchDark')
              }
              aria-pressed={resolvedAppearanceTheme === 'dark'}
              className="icon-button theme-toggle-button"
              onClick={toggleAppearanceTheme}
              title={
                resolvedAppearanceTheme === 'dark'
                  ? t('topbar.switchLight')
                  : t('topbar.switchDark')
              }
              type="button"
            >
              {resolvedAppearanceTheme === 'dark' ? (
                <Sun aria-hidden="true" size={18} />
              ) : (
                <Moon aria-hidden="true" size={18} />
              )}
            </button>
          </div>
          <WindowControls
            onError={handleWindowControlError}
          />
        </header>

        {(view === 'chat' || cachedWorkspaceViewKeys.has('chat')) && (
          <KeepAliveRoute
            active={view === 'chat'}
            route="chat"
          >
            <PageShell variant="reading">
              <div className="chat-scroll-region">
                {cachedConversations.map((conversation) => (
                  <ChatHistoryPane
                    active={
                      view === 'chat' && conversation.id === activeId
                    }
                    artifactById={assistantArtifactById}
                    conversation={conversation}
                    key={conversation.id}
                    locale={locale}
                    onDownloadImage={downloadImage}
                    onOpenCitationContext={openCitationContext}
                    onOpenCitationSource={openCitationSource}
                    onOpenImage={openImageViewer}
                    onRespondApproval={respondToApproval}
                    onRespondQuestion={respondToQuestion}
                    onRetry={retryMessage}
                    onScrollSnapshotChange={
                      handleChatScrollSnapshotChange
                    }
                    onSetInput={(value) => {
                      setInput(value)
                      requestAnimationFrame(() =>
                        inputRef.current?.focus()
                      )
                    }}
                    onVisibleMessageCountChange={
                      handleVisibleMessageCountChange
                    }
                    quickActions={quickActions}
                    scrollSnapshot={
                      chatScrollSnapshots[conversation.id]
                    }
                    taskStrip={
                      !conversation.remote ? (
                        <ConversationTaskStrip
                          locale={locale}
                          onCreate={() =>
                            openCustomTaskDialog('current')
                          }
                          onRemoveSchedule={removeAssistantSchedule}
                          onRunSchedule={runAssistantSchedule}
                          onSelectTask={setSelectedAssistantTaskId}
                          onSetScheduleEnabled={
                            setAssistantScheduleEnabled
                          }
                          schedules={assistantSchedules}
                          selectedTaskId={
                            (tasksByConversation.get(conversation.id) ?? [])
                              .some(
                                (task) =>
                                  task.id === selectedAssistantTaskId
                              )
                              ? selectedAssistantTaskId
                              : undefined
                          }
                          tasks={
                            tasksByConversation.get(conversation.id) ?? []
                          }
                        />
                      ) : undefined
                    }
                    visibleMessageCount={
                      visibleMessageCounts[conversation.id] ??
                      messageRenderBatchSize
                    }
                  />
                ))}
                {activeProject?.kind === 'channel' &&
                  !activeConversation && (
                  <section className="chat">
                    <EmptyState
                      action={
                        <button
                          className="secondary-button"
                          onClick={() => {
                            setSettingsInitialCategory('channels')
                            setSettingsInitialChannel(
                              activeProject.channel
                            )
                            setView('settings')
                          }}
                          type="button"
                        >
                          {t('chat.remote.openSettings')}
                        </button>
                      }
                      description={t('chat.remote.emptyDescription', {
                        project: activeProject.name
                      })}
                      icon={<MessageSquare size={28} />}
                      level="page"
                      title={t('conversation.noRemote')}
                    />
                  </section>
                )}
              </div>

              <footer className="composer-wrap">
          {activeProject?.kind === 'channel' ? (
            <div className="remote-conversation-notice">
              <MessageSquare aria-hidden="true" size={18} />
              <div>
                <strong>{t('chat.remote.title')}</strong>
                <span>
                  {activeConversation?.remote
                    ? t('chat.remote.continueInClient', {
                        client:
                          projectChannelLabels[
                            activeConversation.remote.channel
                          ]
                      })
                    : t('chat.remote.waiting')}
                </span>
              </div>
            </div>
          ) : (
          <>
          <div className="composer">
            {(attachments.length > 0 || selectingContextFiles) && (
              <div
                aria-busy={selectingContextFiles}
                className="context-list"
              >
                {attachments.map((attachment) => (
                  <div
                    className="context-chip"
                    key={attachment.id}
                    title={attachment.preview}
                  >
                    {attachment.kind === 'image' &&
                    attachment.thumbnailUrl ? (
                      <img
                        alt=""
                        className="context-chip__thumbnail"
                        src={attachment.thumbnailUrl}
                      />
                    ) : (
                      <FileText size={14} />
                    )}
                    <span>
                      <strong>{attachment.name}</strong>
                      <small>
                        {formatAttachmentSize(attachment.size)}
                      </small>
                    </span>
                    <button
                      aria-label={t('composer.removeAttachment', {
                        name: attachment.name
                      })}
                      onClick={() => {
                        void window.goodbuddy.context.remove(attachment.id)
                        updateAttachments((current) =>
                          current.filter(
                            (item) => item.id !== attachment.id
                          )
                        )
                      }}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {selectingContextFiles && (
                  <div
                    aria-live="polite"
                    className="context-chip context-chip--processing"
                    role="status"
                  >
                    <LoaderCircle
                      aria-hidden="true"
                      className="context-chip__spinner"
                      size={16}
                    />
                    <span>
                      <strong>
                        {fileSelectionProgress
                          ? t(
                              `composer.attachmentProgress.${fileSelectionProgress.phase}`,
                              {
                                name: fileSelectionProgress.fileName
                              }
                            )
                          : t(
                              'composer.attachmentProgress.selecting'
                            )}
                      </strong>
                      <small>
                        {fileSelectionProgress
                          ? t(
                              'composer.attachmentProgress.fileCount',
                              {
                                current:
                                  fileSelectionProgress.fileNumber,
                                total:
                                  fileSelectionProgress.fileCount
                              }
                            )
                          : t(
                              'composer.attachmentProgress.waiting'
                            )}
                      </small>
                    </span>
                    <progress
                      aria-label={t(
                        'composer.attachmentProgress.progressLabel'
                      )}
                    />
                  </div>
                )}
              </div>
            )}
            <div className="composer__input">
              <textarea
                aria-label={t('composer.inputLabel')}
                placeholder={`${
                  runtime?.capability === 'image-generation'
                    ? t('composer.imagePlaceholder')
                    : t('composer.placeholder')
                }\n${t('composer.keyboardHint')}`}
                ref={inputRef}
                rows={3}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onInput={(event) =>
                  resizeComposerTextarea(event.currentTarget)
                }
                onPaste={(event) => {
                  const imageItem = Array.from(
                    event.clipboardData.items
                  ).find(
                    (item) =>
                      item.kind === 'file' &&
                      item.type.startsWith('image/')
                  )
                  if (!imageItem) {
                    return
                  }
                  const image = imageItem.getAsFile()
                  const mimeType =
                    image?.type === 'image/jpeg' ||
                    image?.type === 'image/png' ||
                    image?.type === 'image/webp'
                      ? image.type
                      : undefined
                  event.preventDefault()
                  if (!image || !mimeType) {
                    setContextError(
                      t('composer.errors.pasteImageType')
                    )
                    return
                  }
                  void addContext(async () => {
                    if (image.size > maximumPastedImageBytes) {
                      throw new Error(t('composer.errors.pasteImageSize'))
                    }
                    return window.goodbuddy.context.addPastedImage({
                      data: new Uint8Array(await image.arrayBuffer()),
                      mimeType
                    })
                  })
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void submit()
                  }
                }}
              />
            </div>
            <div
              className={`composer__toolbar${
                runtimeControlsProvider
                  ? ' composer__toolbar--with-runtime-controls'
                  : ''
              }`}
            >
              <div className="composer__controls">
                <div
                  aria-label={t('composer.addContent')}
                  className="composer__tool-group"
                  role="group"
                >
                  <button
                    type="button"
                    aria-label={t('composer.addAttachment')}
                    disabled={selectingContextFiles}
                    onClick={() => void selectContextFiles()}
                    title={t('composer.addAttachment')}
                  >
                    <Paperclip aria-hidden="true" size={18} />
                  </button>
                  <button
                    aria-label={
                      voiceRecording
                        ? t('composer.voice.stopRecording')
                        : voiceListening
                          ? t('composer.voice.cancel')
                          : t('composer.voice.input')
                    }
                    aria-pressed={voiceRecording}
                    className={
                      voiceRecording
                        ? 'composer__voice-button composer__voice-button--recording'
                        : voiceListening
                          ? 'composer__voice-button composer__voice-button--processing'
                          : 'composer__voice-button'
                    }
                    data-state={
                      voiceRecording
                        ? 'recording'
                        : voiceListening
                          ? 'processing'
                          : 'idle'
                    }
                    onClick={toggleVoiceInput}
                    title={
                      voiceRecording
                        ? t('composer.voice.stopAndRecognize')
                        : voiceListening
                          ? t('composer.voice.cancel')
                          : t('composer.voice.description')
                    }
                    type="button"
                  >
                    <Mic aria-hidden="true" size={18} />
                  </button>
                </div>
                {knowledgeSnapshot.libraries.length > 0 && (
                  <div className="knowledge-scope">
                    <button
                      aria-label={t('composer.knowledge.select', {
                        count: enabledKnowledgeLibraryIds.length
                      })}
                      aria-expanded={knowledgeScopeOpen}
                      onClick={() =>
                        setKnowledgeScopeOpen((current) => !current)
                      }
                      title={t('composer.knowledge.title')}
                      type="button"
                    >
                      <Library aria-hidden="true" size={16} />
                      <span>
                        {t('navigation.knowledge')}
                        <strong>{enabledKnowledgeLibraryIds.length}</strong>
                      </span>
                    </button>
                    {knowledgeScopeOpen && (
                      <div className="knowledge-scope__popover">
                        <strong>{t('composer.knowledge.scope')}</strong>
                        {knowledgeSnapshot.libraries.map((library) => (
                          <label key={library.id}>
                            <input
                              checked={enabledKnowledgeLibraryIds.includes(
                                library.id
                              )}
                              onChange={(event) =>
                                setEnabledKnowledgeLibraryIds((current) =>
                                  event.target.checked
                                    ? [...new Set([...current, library.id])]
                                    : current.filter(
                                        (id) => id !== library.id
                                      )
                                )
                              }
                              type="checkbox"
                            />
                            <span>{library.name}</span>
                            <small>
                              {t('composer.knowledge.documents', {
                                count: library.documentCount
                              })}
                            </small>
                          </label>
                        ))}
                        <div className="knowledge-scope__retrieval-mode">
                          <strong>
                            {t('composer.knowledge.modeLabel')}
                          </strong>
                          <SegmentedControl
                            ariaLabel={t('composer.knowledge.modeLabel')}
                            onChange={(mode) =>
                              setConversations((current) =>
                                current.map((conversation) =>
                                  conversation.id === activeId
                                    ? {
                                        ...conversation,
                                        knowledgeRetrievalMode: mode,
                                        updatedAt: Date.now()
                                      }
                                    : conversation
                                )
                              )
                            }
                            options={[
                              {
                                value: 'auto',
                                label: t('composer.knowledge.auto')
                              },
                              {
                                value: 'always',
                                label: t('composer.knowledge.always')
                              }
                            ]}
                            value={
                              activeConversation?.knowledgeRetrievalMode ??
                              'auto'
                            }
                          />
                          <small>
                            {activeConversation?.knowledgeRetrievalMode ===
                            'always'
                              ? t('composer.knowledge.alwaysDescription')
                              : t('composer.knowledge.autoDescription')}
                          </small>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div
                  aria-label={t('composer.settings')}
                  className="composer__configuration"
                  role="group"
                >
                  <ComposerMenuSelect
                    ariaLabel={t('composer.expertLabel')}
                    className="composer-picker--expert"
                    disabled={
                      isRunning ||
                      runtime?.capability === 'image-generation'
                    }
                    icon={<Bot aria-hidden="true" size={15} />}
                    menuOpen={composerMenuOpen === 'expert'}
                    onChange={setSelectedExpertId}
                    onOpenChange={setExpertMenuOpen}
                    options={assistantExpertOptions}
                    value={selectedExpertId}
                  />
                  <ComposerMenuSelect
                    ariaLabel={t('composer.modeLabel')}
                    className={`composer-picker--mode composer-picker--${effectiveWorkMode}`}
                    disabled={isRunning}
                    icon={
                      effectiveWorkMode === 'execute' ? (
                        <ShieldCheck aria-hidden="true" size={15} />
                      ) : (
                        <CircleHelp aria-hidden="true" size={15} />
                      )
                    }
                    menuOpen={composerMenuOpen === 'mode'}
                    onChange={setWorkMode}
                    onOpenChange={setModeMenuOpen}
                    options={workModeOptions}
                    triggerLabel={
                      effectiveWorkMode === 'execute'
                        ? 'Execute'
                        : 'Ask'
                    }
                    value={effectiveWorkMode}
                  />
                  <div className="runtime-picker">
                    <button
                      aria-expanded={runtimeMenuOpen}
                      aria-haspopup="menu"
                      className="model-button"
                      disabled={isRunning || runtimeSwitching}
                      onClick={() => {
                        setComposerMenuOpen(undefined)
                        setRuntimeMenuOpen(!runtimeMenuOpen)
                      }}
                      onKeyDown={(event) => {
                        if (
                          !runtimeMenuOpen &&
                          (event.key === 'ArrowDown' ||
                            event.key === 'Enter' ||
                            event.key === ' ')
                        ) {
                          event.preventDefault()
                          setComposerMenuOpen(undefined)
                          setRuntimeMenuOpen(true)
                        }
                      }}
                      ref={runtimeMenuButtonRef}
                      title={t('runtime.pickerTitle', {
                        label: activeRuntimeLabel
                      })}
                      type="button"
                    >
                      <Sparkles aria-hidden="true" size={15} />
                      <span className="model-button__label">
                        {runtimeSwitching
                          ? t('runtime.switching')
                          : activeRuntimeLabel}
                      </span>
                      {runtime?.capability === 'image-generation' && (
                        <span className="runtime-capability-badge">
                          {t('runtime.imageGeneration')}
                        </span>
                      )}
                      <ChevronDown aria-hidden="true" size={14} />
                    </button>
                    {runtimeMenuOpen && (
                      <div
                        aria-label={t('runtime.picker')}
                        className="runtime-picker__menu"
                        onKeyDown={(event) => {
                          const items = Array.from(
                            event.currentTarget.querySelectorAll<HTMLButtonElement>(
                              '[role="menuitemradio"], [role="menuitem"]'
                            )
                          ).filter((item) => !item.disabled)
                          const currentIndex = items.indexOf(
                            document.activeElement as HTMLButtonElement
                          )
                          let nextIndex: number | undefined
                          if (event.key === 'ArrowDown') {
                            nextIndex = (currentIndex + 1) % items.length
                          } else if (event.key === 'ArrowUp') {
                            nextIndex =
                              (currentIndex - 1 + items.length) % items.length
                          } else if (event.key === 'Home') {
                            nextIndex = 0
                          } else if (event.key === 'End') {
                            nextIndex = items.length - 1
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            setRuntimeMenuOpen(false)
                            runtimeMenuButtonRef.current?.focus()
                          }
                          const nextItem =
                            nextIndex === undefined
                              ? undefined
                              : items.at(nextIndex)
                          if (nextItem) {
                            event.preventDefault()
                            items.forEach((item) => {
                              item.tabIndex = item === nextItem ? 0 : -1
                            })
                            nextItem.focus()
                          }
                        }}
                        ref={runtimeMenuRef}
                        role="menu"
                      >
                        <strong
                          role="presentation"
                        >
                          {t('runtime.directModels')}
                        </strong>
                        {runtimeSettings?.modelProfiles.map((profile) => (
                        <button
                          aria-checked={
                            activeRuntimeSelectionKey ===
                            `model:${profile.id}`
                          }
                          key={profile.id}
                          onClick={() =>
                            void switchRuntime({
                              provider: 'model',
                              profileId: profile.id
                            })
                          }
                          role="menuitemradio"
                          tabIndex={
                            activeRuntimeSelectionKey ===
                            `model:${profile.id}`
                              ? 0
                              : -1
                          }
                          type="button"
                        >
                          <span>
                            {profile.name}
                            {profile.protocol ===
                              'openai-images-generations' && (
                              <span className="runtime-capability-badge">
                                {t('runtime.imageGeneration')}
                              </span>
                            )}
                          </span>
                          <small>{profile.modelName}</small>
                        </button>
                        ))}
                        <div
                          className="runtime-picker__divider"
                          role="separator"
                        />
                        <strong
                          role="presentation"
                        >
                          OpenCode Runtime
                        </strong>
                        {openCodeMenuSelection && openCodeMenuSource && (
                        <button
                          aria-checked={
                            activeRuntimeSelectionKey ===
                            agentRuntimeSelectionKey(openCodeMenuSelection)
                          }
                          onClick={() =>
                            void switchRuntime(openCodeMenuSelection)
                          }
                          role="menuitemradio"
                          tabIndex={
                            activeRuntimeSelectionKey ===
                            agentRuntimeSelectionKey(openCodeMenuSelection)
                              ? 0
                              : -1
                          }
                          type="button"
                        >
                          <span>{openCodeMenuSource.label}</span>
                          <small>{openCodeMenuSource.detail}</small>
                        </button>
                        )}
                        <div
                          className="runtime-picker__divider"
                          role="separator"
                        />
                        <strong
                          role="presentation"
                        >
                          Continue Runtime
                        </strong>
                        {continueMenuSelection && continueMenuSource && (
                        <button
                          aria-checked={
                            activeRuntimeSelectionKey ===
                            agentRuntimeSelectionKey(continueMenuSelection)
                          }
                          onClick={() =>
                            void switchRuntime(continueMenuSelection)
                          }
                          role="menuitemradio"
                          tabIndex={
                            activeRuntimeSelectionKey ===
                            agentRuntimeSelectionKey(continueMenuSelection)
                              ? 0
                              : -1
                          }
                          type="button"
                        >
                          <span>{continueMenuSource.label}</span>
                          <small>{continueMenuSource.detail}</small>
                        </button>
                        )}
                        <div
                          className="runtime-picker__divider"
                          role="separator"
                        />
                        <strong role="presentation">
                          {t('runtime.deepseekHarnessGroup')}
                        </strong>
                        {deepseekHarnessMenuSelection &&
                          deepseekHarnessMenuSource && (
                          <button
                            aria-checked={
                              activeRuntimeSelectionKey ===
                              agentRuntimeSelectionKey(
                                deepseekHarnessMenuSelection
                              )
                            }
                            onClick={() =>
                              void switchRuntime(
                                deepseekHarnessMenuSelection
                              )
                            }
                            role="menuitemradio"
                            tabIndex={
                              activeRuntimeSelectionKey ===
                              agentRuntimeSelectionKey(
                                deepseekHarnessMenuSelection
                              )
                                ? 0
                                : -1
                            }
                            type="button"
                          >
                            <span>
                              {deepseekHarnessMenuSource.label}
                            </span>
                            <small>
                              {deepseekHarnessMenuSource.detail}
                            </small>
                          </button>
                        )}
                        <div
                          className="runtime-picker__divider"
                          role="separator"
                        />
                        <button
                          onClick={() => {
                            setRuntimeMenuOpen(false)
                            setView('settings')
                          }}
                          role="menuitem"
                          tabIndex={-1}
                          type="button"
                        >
                          <span>{t('runtime.manage')}</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {isRunning ? (
                <button
                  className="send-button send-button--stop"
                  type="button"
                  aria-label={t('composer.stop')}
                  onClick={() => void stop()}
                  title={t('composer.stop')}
                >
                  <Square
                    aria-hidden="true"
                    fill="currentColor"
                    size={15}
                  />
                </button>
              ) : (
                <button
                  className="send-button"
                  type="button"
                  aria-label={t('composer.send')}
                  disabled={
                    (!input.trim() &&
                      !(
                        activeRuntimeSelection?.provider ===
                          'opencode' &&
                        runtimeNativeSnapshot?.commands.some(
                          (command) =>
                            command.id === selectedRuntimeCommand
                        )
                      )) ||
                    selectingContextFiles ||
                    !runtime?.available ||
                    runtimeSwitching ||
                    runtimeStatusKey !== activeRuntimeSelectionKey
                  }
                  onClick={() => void submit()}
                  title={t('composer.sendTitle')}
                >
                  <Send aria-hidden="true" size={17} />
                </button>
              )}
            </div>
            {runtimeControlsProvider && (
              <div
                aria-label={runtimeControlsLabel}
                className="composer__runtime-toolbar"
                role="group"
              >
                <strong className="composer__runtime-toolbar-label">
                  {runtimeControlsLabel}
                </strong>
                <div className="composer__runtime-controls">
                  {runtimeAgentControlAvailable && (
                    <ComposerMenuSelect
                      ariaLabel={t(
                        'composer.runtimeControls.agentLabel'
                      )}
                      className="composer-picker--runtime"
                      disabled={isRunning}
                      icon={
                        <TerminalSquare aria-hidden="true" size={15} />
                      }
                      menuOpen={
                        composerMenuOpen === 'runtime-agent'
                      }
                      onChange={setSelectedRuntimeAgent}
                      onOpenChange={setRuntimeAgentMenuOpen}
                      options={runtimeAgentOptions}
                      value={selectedRuntimeAgent}
                    />
                  )}
                  {runtimePresetControlAvailable && (
                    <ComposerMenuSelect
                      ariaLabel={t(
                        'composer.runtimeControls.presetLabel'
                      )}
                      className="composer-picker--runtime"
                      disabled={isRunning}
                      icon={
                        <TerminalSquare aria-hidden="true" size={15} />
                      }
                      menuOpen={
                        composerMenuOpen === 'runtime-preset'
                      }
                      onChange={setSelectedContinuePreset}
                      onOpenChange={setRuntimePresetMenuOpen}
                      options={runtimePresetOptions}
                      value={selectedContinuePreset}
                    />
                  )}
                  {runtimeActionControlAvailable && (
                    <ComposerMenuSelect
                      ariaLabel={t(
                        'composer.runtimeControls.actionLabel'
                      )}
                      className="composer-picker--runtime-action"
                      disabled={isRunning}
                      icon={
                        <TerminalSquare aria-hidden="true" size={15} />
                      }
                      menuOpen={
                        composerMenuOpen === 'runtime-action'
                      }
                      onChange={selectRuntimeAction}
                      onOpenChange={setRuntimeActionMenuOpen}
                      options={runtimeActionOptions}
                      value={
                        runtimeActionOptions.find(
                          (option) =>
                            option.action?.type === 'command' &&
                            option.action.id ===
                              selectedRuntimeCommand
                        )?.value ?? ''
                      }
                    />
                  )}
                </div>
              </div>
            )}
          </div>
          <div
            className={`composer-meta${
              runtimeContextCompactAvailable
                ? ' composer-meta--with-context-compact'
                : ''
            }`}
          >
            {runtimeContextCompactAvailable && (
              <button
                className="composer-context-compact"
                disabled={runtimeContextCompacting || isRunning}
                onClick={() => void compactRuntimeContext()}
                title={runtimeNativeSnapshot?.context.detail}
                type="button"
              >
                {runtimeContextCompacting ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="context-chip__spinner"
                    size={13}
                  />
                ) : (
                  <RefreshCw aria-hidden="true" size={13} />
                )}
                {runtimeContextCompacting
                  ? t('composer.context.compacting')
                  : t('composer.context.compact')}
              </button>
            )}
            {composerContextMetrics && (
              <div
                className={`composer-context-meter${
                  composerContextMetrics.percentage !== undefined &&
                  composerContextMetrics.percentage >= 90
                    ? ' composer-context-meter--warning'
                    : ''
                }`}
                title={
                  composerContextMetrics.compressionEnabled
                    ? t('composer.context.compressionTrigger', {
                        tokens: formatCompactTokens(
                          composerContextMetrics.effectiveTriggerTokens
                        )
                      })
                    : undefined
                }
              >
                <span className="composer-context-meter__summary">
                  {composerContextMetrics.denominatorTokens === undefined
                      ? t(
                          composerContextMetrics.basis === 'conversation'
                            ? composerContextMetrics.compressionEnabled
                              ? 'composer.context.conversationThresholdUsage'
                              : 'composer.context.conversationTokenCount'
                            : composerContextMetrics.compressionEnabled
                              ? composerContextMetrics.source === 'provider'
                                ? 'composer.context.confirmedThresholdUsage'
                                : 'composer.context.thresholdUsage'
                              : composerContextMetrics.source === 'provider'
                                ? 'composer.context.confirmedTokenCount'
                                : 'composer.context.tokenCount',
                          {
                            used: formatCompactTokens(
                              composerContextMetrics.contextTokens
                            ),
                            total: formatCompactTokens(
                              composerContextMetrics.effectiveTriggerTokens
                            )
                          }
                        )
                      : t(
                          composerContextMetrics.basis === 'conversation'
                            ? 'composer.context.conversationWindowUsage'
                            : composerContextMetrics.source === 'provider'
                              ? 'composer.context.confirmedWindowUsage'
                              : 'composer.context.windowUsage',
                          {
                            used: formatCompactTokens(
                              composerContextMetrics.contextTokens
                            ),
                            total: formatCompactTokens(
                              composerContextMetrics.denominatorTokens
                            ),
                            percentage:
                              composerContextMetrics.percentage ?? 0
                          }
                        )}
                </span>
                {composerContextMetrics.denominatorTokens !== undefined && (
                  <div
                    aria-label={t('composer.context.progressLabel')}
                    aria-valuemax={
                      composerContextMetrics.denominatorTokens
                    }
                    aria-valuemin={0}
                    aria-valuenow={Math.min(
                      composerContextMetrics.contextTokens,
                      composerContextMetrics.denominatorTokens
                    )}
                    className="composer-context-meter__track"
                    role="progressbar"
                  >
                    <span
                      className="composer-context-meter__fill"
                      style={{
                        width: `${Math.min(
                          100,
                          composerContextMetrics.percentage ?? 0
                        )}%`
                      }}
                    />
                    {composerContextMetrics.contextWindowTokens !==
                      undefined &&
                      composerContextMetrics.compressionEnabled && (
                        <span
                          aria-hidden="true"
                          className="composer-context-meter__trigger"
                          style={{
                            left: `${Math.min(
                              100,
                              Math.round(
                                (composerContextMetrics.effectiveTriggerTokens /
                                  composerContextMetrics.contextWindowTokens) *
                                  100
                              )
                            )}%`
                          }}
                        />
                      )}
                  </div>
                )}
              </div>
            )}
            {contextError && (
              <span className="composer-meta__error">
                {contextError}
              </span>
            )}
            {appInfo?.shortcut && (
              <span className="composer-meta__shortcut">
                {t('composer.shortcut')}
                <kbd>{appInfo.shortcut}</kbd>
              </span>
            )}
          </div>
          </>
          )}
            </footer>
            </PageShell>
          </KeepAliveRoute>
        )}
        {magicNotesEnabled &&
          (view === 'magic-notes' ||
            cachedWorkspaceViewKeys.has('magic-notes')) && (
          <KeepAliveRoute
            active={view === 'magic-notes'}
            route="magic-notes"
          >
            <PageShell variant="master-detail">
            <RouteErrorBoundary
              key="magic-notes"
              fallback={
                <RouteLoadError
                  message={t('route.loadFailed')}
                  reloadLabel={t('route.reload')}
                />
              }
            >
              <Suspense
                fallback={
                  <RouteLoadingStatus label={t('route.loading')} />
                }
              >
                <MagicNotesWorkspace onNotify={notify} />
              </Suspense>
            </RouteErrorBoundary>
            </PageShell>
          </KeepAliveRoute>
        )}
        {(view === 'knowledge' ||
          cachedWorkspaceViewKeys.has('knowledge')) && (
          <KeepAliveRoute
            active={view === 'knowledge'}
            route="knowledge"
          >
            <PageShell variant="master-detail">
            <RouteErrorBoundary
              key="knowledge"
              fallback={
                <RouteLoadError
                  message={t('route.loadFailed')}
                  reloadLabel={t('route.reload')}
                />
              }
            >
              <Suspense
                fallback={
                  <RouteLoadingStatus label={t('route.loading')} />
                }
              >
                <KnowledgeWorkspace
              documents={knowledgeSnapshot.documents}
              evidence={knowledgeSnapshot.evidence}
              graphNodes={knowledgeSnapshot.graphNodes}
              graphRelations={knowledgeSnapshot.graphRelations}
              libraries={knowledgeSnapshot.libraries}
              loadError={knowledgeLoadError}
              loading={knowledgeLoading}
              onCreateLibrary={createKnowledgeLibrary}
              onCreateEntity={async (input) => {
                const libraryId = knowledgeSnapshot.selectedLibraryId
                if (!libraryId) {
                  throw new Error(t('notices.selectKnowledgeBase'))
                }
                await runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.createEntity(
                    libraryId,
                    input
                  )
                )
              }}
              onCreateRelation={async (input) => {
                const libraryId = knowledgeSnapshot.selectedLibraryId
                if (!libraryId) {
                  throw new Error(t('notices.selectKnowledgeBase'))
                }
                await runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.createRelation(
                    libraryId,
                    input
                  )
                )
              }}
              onDeleteEntity={(entityId) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.deleteEntity(entityId)
                )
              }
              onDeleteLibrary={deleteKnowledgeLibrary}
              onReextractGraph={async (libraryId) => {
                await runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.reextractGraph(libraryId)
                )
                notify({
                  tone: 'success',
                  message: t('notices.knowledgeGraphRebuilt'),
                  dedupeKey: `knowledge-graph:${libraryId}`
                })
              }}
              onUpdateLibrary={async (libraryId, update) => {
                await runKnowledgeSourceAction(async () => {
                  await window.goodbuddy.knowledge.updateLibrary(
                    libraryId,
                    update
                  )
                })
                notify({
                  tone: 'success',
                  message: t('notices.knowledgeSettingsUpdated'),
                  dedupeKey: `knowledge-library:${libraryId}`
                })
              }}
              onDeleteRelation={(relationId) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.deleteRelation(relationId)
                )
              }
              onImportDirectory={(libraryId, files, graphStrategy) => {
                void files
                return runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.selectDirectory(
                    libraryId,
                    graphStrategy
                  )
                )
              }}
              onImportFiles={(libraryId, files, graphStrategy) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.importDroppedFiles(
                    libraryId,
                    files,
                    graphStrategy
                  )
                )
              }
              onImportUrl={(libraryId, url, graphStrategy) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.importUrl(
                    libraryId,
                    url,
                    graphStrategy
                  )
                )
              }
              onMergeEntities={(sourceId, targetId) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.mergeEntities(
                    sourceId,
                    targetId
                  )
                )
              }
              onMoveNode={(nodeId, position) => {
                setKnowledgeSnapshot((current) => ({
                  ...current,
                  graphNodes: current.graphNodes.map((node) =>
                    node.id === nodeId
                      ? { ...node, ...position }
                      : node
                  )
                }))
                void window.goodbuddy.knowledge
                  .moveEntity(nodeId, position)
                  .catch(() => void refreshSelectedKnowledge())
              }}
              onOpenEvidence={(evidence) =>
                notify({
                  tone: 'info',
                  message: t('notices.evidenceExcerpt', {
                    source: `${evidence.documentName}${
                      evidence.location ? ` · ${evidence.location}` : ''
                    }`,
                    excerpt: evidence.excerpt
                  }).slice(0, 500)
                })
              }
              onPauseSource={(sourceId) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.pauseSource(sourceId)
                )
              }
              onRemoveSource={(sourceId) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.removeSource(sourceId)
                )
              }
              onRetrieve={(libraryId, query, settings) =>
                window.goodbuddy.knowledge.retrieve({
                  knowledgeBaseId: libraryId,
                  query,
                  settings
                })
              }
              onUpdateKnowledgeSettings={async (
                libraryId,
                settings
              ) => {
                await runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.updateSettings({
                    knowledgeBaseId: libraryId,
                    ...settings
                  })
                )
                notify({
                  tone: 'success',
                  message: t('notices.knowledgeSettingsUpdated'),
                  dedupeKey: `knowledge-retrieval-settings:${libraryId}`
                })
              }}
              onListChunks={({
                libraryId,
                documentId,
                page,
                pageSize,
                search
              }) =>
                window.goodbuddy.knowledge.listChunks({
                  knowledgeBaseId: libraryId,
                  documentId,
                  page,
                  pageSize,
                  search
                })
              }
              onUpdateChunk={(input) =>
                window.goodbuddy.knowledge.updateChunk(input)
              }
              onDeleteChunk={(input) =>
                window.goodbuddy.knowledge.deleteChunk(input)
              }
              onRebuildDocument={(libraryId, documentId) =>
                runKnowledgeSourceAction(async () => {
                  await window.goodbuddy.knowledge.rebuildDocument({
                    knowledgeBaseId: libraryId,
                    documentId
                  })
                })
              }
              onRebuildLibrary={(libraryId) =>
                runKnowledgeSourceAction(async () => {
                  const result =
                    await window.goodbuddy.knowledge.rebuildLibrary({
                      knowledgeBaseId: libraryId
                    })
                  if (result.failed > 0) {
                    throw new Error(
                      t('notices.knowledgeRebuildPartial', {
                        rebuilt: result.rebuilt,
                        failed: result.failed
                      })
                    )
                  }
                  notify({
                    tone: 'success',
                    message: t('notices.knowledgeRebuildCompleted', {
                      count: result.rebuilt
                    }),
                    dedupeKey: `knowledge-rebuild:${libraryId}`
                  })
                })
              }
              onCancelRebuild={async (libraryId) => {
                const cancelled =
                  await window.goodbuddy.knowledge.cancelRebuild(
                    libraryId
                  )
                if (!cancelled) {
                  throw new Error(
                    t('notices.knowledgeRebuildNotRunning')
                  )
                }
              }}
              onGetEmbeddingIndex={(libraryId) =>
                window.goodbuddy.knowledge.getEmbeddingIndex(libraryId)
              }
              onRebuildEmbeddingIndex={(libraryId) =>
                window.goodbuddy.knowledge.rebuildEmbeddingIndex(
                  libraryId
                )
              }
              onCancelTask={async (taskId) => {
                const cancelled =
                  await window.goodbuddy.knowledge.cancelTask(taskId)
                if (!cancelled) {
                  throw new Error(
                    t('notices.knowledgeTaskNotRunning')
                  )
                }
                await refreshSelectedKnowledge()
              }}
              onOpenReferenceSource={(input) =>
                window.goodbuddy.knowledge.openReferenceSource(input)
              }
              onRetrySource={(sourceId) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.retrySource(sourceId)
                )
              }
              onRetryTask={(taskId) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.retryTask(taskId)
                )
              }
              onRetryLoad={retryKnowledgeLoad}
              onSelectLibrary={(libraryId) => {
                void refreshKnowledge(libraryId).catch(() => {
                  // KnowledgeWorkspace renders the recoverable load error.
                })
              }}
              onSyncSource={(sourceId) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.syncSource(sourceId)
                )
              }
              onUpdateEntity={(entityId, update) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.updateEntity(entityId, update)
                )
              }
              onUpdateRelation={(relationId, input) =>
                runKnowledgeSourceAction(() =>
                  window.goodbuddy.knowledge.updateRelation(
                    relationId,
                    input
                  )
                )
              }
              selectedLibraryId={knowledgeSnapshot.selectedLibraryId}
              sources={knowledgeSnapshot.sources}
              tasks={knowledgeSnapshot.tasks}
                />
              </Suspense>
            </RouteErrorBoundary>
            </PageShell>
          </KeepAliveRoute>
        )}
        {(view === 'heartbeat' ||
          cachedWorkspaceViewKeys.has('heartbeat')) && (
          <KeepAliveRoute
            active={view === 'heartbeat'}
            route="heartbeat"
          >
            <PageShell variant="dashboard">
            <RouteErrorBoundary
              key="heartbeat"
              fallback={
                <RouteLoadError
                  message={t('route.loadFailed')}
                  reloadLabel={t('route.reload')}
                />
              }
            >
              <Suspense
                fallback={
                  <RouteLoadingStatus label={t('route.loading')} />
                }
              >
                <HeartbeatCenter
              configs={assistantHeartbeats}
              entries={heartbeatEntries}
              loadError={heartbeatLoadError}
              loading={heartbeatLoading}
              memories={heartbeatMemories}
              onCreate={createHeartbeat}
              onRefresh={retryHeartbeatLoad}
              onRetryLoad={retryHeartbeatLoad}
              onRemove={removeHeartbeat}
              onRunNow={runHeartbeat}
              onSetMemoryStatus={setMemoryStatus}
              onSetPaused={setHeartbeatPaused}
              onSetTaskStatus={setHeartbeatTaskStatus}
              onUpdate={updateHeartbeat}
              onUseFollowUpTask={useHeartbeatTask}
              projects={projects}
              runs={heartbeatRuns}
              tasks={assistantTasks}
                />
              </Suspense>
            </RouteErrorBoundary>
            </PageShell>
          </KeepAliveRoute>
        )}
        {(view === 'settings' ||
          cachedWorkspaceViewKeys.has('settings')) && (
          <KeepAliveRoute
            active={view === 'settings'}
            route="settings"
          >
            <RouteErrorBoundary
            key="settings"
            fallback={
              <RouteLoadError
                message={t('route.loadFailed')}
                reloadLabel={t('route.reload')}
              />
            }
          >
            <Suspense
              fallback={
                <RouteLoadingStatus label={t('route.loading')} />
              }
            >
              <SettingsPanel
            appearanceTheme={appearanceTheme}
            initialCategory={settingsInitialCategory}
            initialChannel={settingsInitialChannel}
            magicNotesEnabled={magicNotesEnabled}
            onAppearanceThemeChange={setAppearanceTheme}
            onClearLocalData={clearLocalData}
            onClose={() => {
              setSettingsInitialCategory(undefined)
              setSettingsInitialChannel(undefined)
              setView('chat')
            }}
            onExpertsChanged={(experts) => {
              setAssistantExperts(experts)
              if (
                (selectedExpertId === 'team' && experts.length < 2) ||
                (selectedExpertId &&
                  selectedExpertId !== 'team' &&
                  !experts.some(
                    (expert) => expert.id === selectedExpertId
                  ))
              ) {
                setSelectedExpertId('')
              }
            }}
            onMagicNotesEnabledChange={(enabled) => {
              setMagicNotesEnabled(enabled)
            }}
            onNotify={notify}
            onSaved={(settings) => {
              setRuntimeSettings(settings)
            }}
            onUpdateProject={updateProject}
            open={view === 'settings'}
            presentation="page"
            projects={projects}
              />
            </Suspense>
            </RouteErrorBoundary>
          </KeepAliveRoute>
        )}
        {(view === 'activity' ||
          cachedWorkspaceViewKeys.has('activity')) && (
          <KeepAliveRoute
            active={view === 'activity'}
            route="activity"
          >
            <PageShell variant="dashboard">
              <ActivityPanel
                onClear={() => setActivityRecords([])}
                onOpenConversation={openActivityConversation}
                records={activityRecords}
                tokenUsage={tokenUsage}
              />
            </PageShell>
          </KeepAliveRoute>
        )}
      </main>
      <AppNotificationViewport
        dispatch={notify}
        notifications={notifications}
      />
      {releaseNotes && (
        <ReleaseNotesDialog
          locale={locale}
          onAcknowledge={async (version) => {
            const releaseNotesApi = window.goodbuddy.releaseNotes
            if (!releaseNotesApi) {
              throw new Error('Release notes service is unavailable')
            }
            await releaseNotesApi.acknowledge(version)
          }}
          onClose={() => setReleaseNotes(undefined)}
          snapshot={releaseNotes}
        />
      )}
      {citationDialog && (
        <KnowledgeCitationDialog
          context={citationDialog.context}
          error={citationDialog.error}
          loading={citationDialog.loading}
          onClose={() => setCitationDialog(undefined)}
          onOpenSource={async () => {
            const { reference } = citationDialog
            if (!reference.chunkId) {
              throw new Error(t('chat.citations.contextUnavailable'))
            }
            await window.goodbuddy.knowledge.openReferenceSource({
              knowledgeBaseId: reference.libraryId,
              documentId: reference.documentId,
              chunkId: reference.chunkId
            })
          }}
          reference={citationDialog.reference}
        />
      )}
      {imageViewerItem && (
        <div
          className="image-viewer-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeImageViewer()
            }
          }}
        >
          <section
            aria-labelledby="image-viewer-title"
            aria-modal="true"
            className="image-viewer-dialog"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                closeImageViewer()
              }
            }}
            role="dialog"
          >
            <header className="image-viewer-dialog__header">
              <strong id="image-viewer-title">
                {imageViewerItem.title}
              </strong>
              <div>
                <button
                  className="secondary-button"
                  onClick={() => downloadImage(imageViewerItem)}
                  type="button"
                >
                  <Download size={14} />
                  {t('chat.images.downloadImage')}
                </button>
                <button
                  aria-label={t('chat.images.closeViewer')}
                  autoFocus
                  className="icon-button"
                  onClick={closeImageViewer}
                  type="button"
                >
                  <X size={16} />
                </button>
              </div>
            </header>
            <div className="image-viewer-dialog__content">
              <img
                alt={imageViewerItem.title}
                src={imageViewerItem.src}
              />
            </div>
          </section>
        </div>
      )}
      {customTaskDialog && activeProject?.kind === 'user' && (
        <CustomTaskDialog
          currentConversationAvailable={Boolean(
            activeConversation &&
              !activeConversation.remote &&
              activeConversation.projectId === activeProject.id
          )}
          currentConversationId={activeConversation?.id}
          defaultDestination={customTaskDialog.defaultDestination}
          onClose={() => setCustomTaskDialog(undefined)}
          onCreate={createCustomTask}
          projectId={activeProject.id}
          projectName={activeProject.name}
          runtimeLabel={activeRuntimeLabel}
          supportsToolExecution={Boolean(
            runtime?.supportsToolExecution
          )}
          workspaceLabel={
            activeProject.rootPath || t('customTask.scope.noWorkspace')
          }
        />
      )}
      <RightAssistantSidebar
        approvals={pendingSidebarApprovals}
        artifacts={sidebarArtifacts}
        attachments={attachments}
        browserState={browserStates[activeId]}
        conversationTitles={conversationTitles}
        enabledLibraries={enabledSidebarLibraries}
        memories={assistantMemories}
        onCreateCustomTask={() => openCustomTaskDialog('new')}
        schedules={assistantSchedules}
        selectedTaskId={selectedAssistantTaskId}
        tasks={productAssistantTasks}
        projectNames={projectNames}
        onClose={() => setAssistantSidebarOpen(false)}
        onInteractBrowser={async () => {
          if (!activeId) {
            return
          }
          const browserApi = window.goodbuddy.browser
          if (!browserApi) {
            notify({
              tone: 'error',
              message: t('notices.browserControlUnavailable')
            })
            return
          }
          await browserApi.interact(activeId)
        }}
        onStopBrowser={async () => {
          if (!activeId) {
            return
          }
          const browserApi = window.goodbuddy.browser
          if (!browserApi) {
            notify({
              tone: 'error',
              message: t('notices.browserControlUnavailable')
            })
            return
          }
          try {
            await browserApi.stop(activeId)
          } catch {
            notify({
              tone: 'error',
              message: t('notices.browserStopFailed')
            })
          }
        }}
        onImportArtifacts={async () => {
          const imported = await window.goodbuddy.artifacts.importFiles(
            activeProjectId || undefined
          )
          if (imported.length > 0) {
            setAssistantArtifacts((current) => [
              ...imported,
              ...current
            ])
            setAssistantSidebarTab('results')
          }
        }}
        onLoadArtifact={async (artifactId) => {
          if (assistantArtifactById.get(artifactId)?.content) {
            return
          }
          const artifact = await window.goodbuddy.artifacts.get(
            artifactId
          )
          setAssistantArtifacts((current) =>
            mergeArtifacts(current, [artifact])
          )
        }}
        onRemoveAttachment={removeAttachment}
        onOpenTask={openAssistantTask}
        onRemoveSchedule={removeAssistantSchedule}
        onRespondApproval={(approval, decision) => {
          void respondToApproval(
            approval.conversationId,
            approval.messageId,
            approval.approvalId,
            decision
          )
        }}
        onRunSchedule={runAssistantSchedule}
        onSetScheduleEnabled={setAssistantScheduleEnabled}
        onListWorkspaceDirectory={listWorkspaceDirectory}
        onLoadWorkspaceFile={loadWorkspaceFile}
        onOpenWorkspaceEntry={openWorkspaceEntry}
        onRefreshChanges={refreshWorkspaceChanges}
        onTabChange={setAssistantSidebarTab}
        open={
          assistantSidebarOpen && view === 'chat'
        }
        tab={assistantSidebarTab}
        workspaceChanges={workspaceChanges}
        workspaceProjectId={activeProjectId || undefined}
      />
    </div>
  )
}

export default App
