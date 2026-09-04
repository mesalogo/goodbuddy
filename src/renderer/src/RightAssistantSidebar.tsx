import {
  ArrowLeft,
  ArrowRight,
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
  Square,
  Upload,
  X
} from 'lucide-react'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantSchedule,
  AssistantTask,
  AssistantProject,
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
import type {
  TerminalSnapshot
} from '../../shared/terminal-contracts'
import {
  WORKBAR_APP_DEFINITIONS,
  workbarLayoutPreferencesSchema,
  type WorkbarAppDefinition,
  type WorkbarTabInstance,
  type WorkbarTargetRef
} from '../../shared/workbar-contracts'
import {
  DEFAULT_WORKBAR_INSTANCES,
  WorkbarShell,
  type WorkbarInstanceCreateRequest
} from './WorkbarShell'
import type { TerminalAdapter } from './TerminalPanel'
import './terminal-panel.css'

const TerminalPanel = lazy(async () => {
  const module = await import('./TerminalPanel')
  return { default: module.TerminalPanel }
})

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
  activeConversationId?: string
  browserState?: BrowserLiveState
  currentProject?: AssistantProject
  restoreFocusRef?: { current: HTMLElement | null }
  onBackBrowser?: () => Promise<void>
  onInteractBrowser: () => Promise<void>
  onNavigateBrowser?: (url: string) => Promise<void>
  onReloadBrowser?: () => Promise<void>
  onStopLoadingBrowser?: () => Promise<void>
  onStopBrowser: () => Promise<void>
  onCreateCustomTask: () => void
  onImportArtifacts: () => Promise<void>
  onLoadArtifact: (artifactId: string) => Promise<void>
  onRefreshChanges: () => Promise<void>
  onListWorkspaceDirectory: (
    path: string
  ) => Promise<WorkspaceDirectoryListing>
  onLoadWorkspaceFile: (
    path: string,
    offsetBytes?: number
  ) => Promise<WorkspaceFilePreview>
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
const workbarStorageKey = 'goodbuddy.workbar-layout.v1'

function loadPersistedWorkbarLayout(): ReturnType<
  typeof workbarLayoutPreferencesSchema.parse
> | undefined {
  try {
    const value = localStorage.getItem(workbarStorageKey)
    if (!value || value.length > 100_000) {
      return undefined
    }
    return workbarLayoutPreferencesSchema.parse(JSON.parse(value))
  } catch {
    return undefined
  }
}

function persistWorkbarLayout(
  instances: readonly WorkbarTabInstance[],
  activeInstanceId: string | null,
  expanded: boolean,
  widthRatio: number
): void {
  try {
    localStorage.setItem(
      workbarStorageKey,
      JSON.stringify(
        workbarLayoutPreferencesSchema.parse({
          instances,
          activeInstanceId,
          expanded,
          dock: 'right',
          widthRatio
        })
      )
    )
  } catch {
    // The in-memory workbar remains usable when browser storage is unavailable.
  }
}

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

function addDefaultBrowserProtocol(address: string): string {
  const protocol = /^[a-z][a-z\d+.-]*:/iu.exec(address)?.[0]
  if (
    protocol &&
    (/^https?:$/iu.test(protocol) ||
      !/^\d+(?:[/?#]|$)/u.test(address.slice(protocol.length)))
  ) {
    return address
  }
  return `http://${address}`
}

function BrowserToolbar({
  activeConversationId,
  browserState,
  onBack,
  onInteract,
  onNavigate,
  onReload,
  onStop,
  onStopLoading
}: {
  activeConversationId?: string
  browserState?: BrowserLiveState
  onBack: () => Promise<boolean>
  onInteract: () => Promise<boolean>
  onNavigate: (url: string) => Promise<boolean>
  onReload: () => Promise<boolean>
  onStop: () => Promise<boolean>
  onStopLoading: () => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const inputRef = useRef<HTMLInputElement>(null)
  const actionPendingRef = useRef(false)
  const [addressDraft, setAddressDraft] = useState(
    browserState?.url ?? ''
  )
  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const authoritativeUrl = browserState?.url ?? ''
  const hasBrowserState = browserState !== undefined
  const displayedAddress =
    hasBrowserState && !editing && !dirty
      ? authoritativeUrl
      : addressDraft
  const sessionActive = browserState?.sessionActive === true
  const isLoading = browserState?.isLoading === true
  const status = browserState?.status
  const isCreating = status === 'creating'
  const isActing = status === 'acting'
  const isInteractive = status === 'interactive'
  const operationBlocked =
    actionPending ||
    isCreating ||
    status === 'loading' ||
    isActing ||
    isInteractive
  const addressDisabled = operationBlocked || isLoading
  const backDisabled =
    operationBlocked ||
    !sessionActive ||
    browserState?.canGoBack !== true ||
    addressDisabled
  const refreshDisabled =
    operationBlocked ||
    !sessionActive ||
    isLoading
  const interactDisabled =
    operationBlocked ||
    !sessionActive ||
    isLoading ||
    (status !== 'ready' && status !== 'failed')
  const closeDisabled =
    operationBlocked ||
    !sessionActive ||
    isLoading
  const goDisabled =
    actionPending ||
    !activeConversationId ||
    addressDisabled ||
    displayedAddress.trim().length === 0

  const runToolbarAction = async (
    action: () => Promise<boolean>
  ): Promise<boolean> => {
    if (actionPendingRef.current) {
      return false
    }
    actionPendingRef.current = true
    setActionPending(true)
    try {
      return await action()
    } finally {
      actionPendingRef.current = false
      setActionPending(false)
    }
  }

  const submitAddress = async (): Promise<void> => {
    const address = displayedAddress.trim()
    if (goDisabled || !address) {
      return
    }
    const url = addDefaultBrowserProtocol(address)
    setAddressDraft(url)
    if (await runToolbarAction(() => onNavigate(url))) {
      setDirty(false)
      setEditing(false)
      inputRef.current?.blur()
    }
  }

  const refreshLabel = isLoading
    ? t('sidebar.browser.toolbar.stopLoading')
    : t('sidebar.browser.toolbar.refresh')

  return (
    <form
      aria-label={t('sidebar.browser.toolbar.ariaLabel')}
      className="assistant-sidebar__browser-toolbar"
      onSubmit={(event) => {
        event.preventDefault()
        void submitAddress()
      }}
    >
      <button
        aria-label={t('sidebar.browser.toolbar.back')}
        className="secondary-button assistant-sidebar__browser-tool-button"
        disabled={backDisabled}
        onClick={() => void runToolbarAction(onBack)}
        title={t('sidebar.browser.toolbar.back')}
        type="button"
      >
        <ArrowLeft aria-hidden="true" size={14} />
      </button>
      <button
        aria-label={refreshLabel}
        className="secondary-button assistant-sidebar__browser-tool-button"
        disabled={
          isLoading
            ? !sessionActive || isInteractive
            : refreshDisabled
        }
        onClick={() =>
          void (isLoading
            ? onStopLoading()
            : runToolbarAction(onReload))
        }
        title={refreshLabel}
        type="button"
      >
        {isLoading ? (
          <Square aria-hidden="true" size={12} />
        ) : (
          <RefreshCw aria-hidden="true" size={14} />
        )}
      </button>
      <label className="assistant-sidebar__browser-address">
        <span className="sr-only">
          {t('sidebar.browser.toolbar.address')}
        </span>
        <input
          aria-label={t('sidebar.browser.toolbar.address')}
          autoComplete="off"
          disabled={addressDisabled}
          onChange={(event) => {
            setAddressDraft(event.target.value)
            setDirty(true)
          }}
          onBlur={() => setEditing(false)}
          onFocus={() => {
            setAddressDraft(displayedAddress)
            setEditing(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submitAddress()
              return
            }
            if (event.key !== 'Escape') {
              return
            }
            event.preventDefault()
            setAddressDraft(authoritativeUrl)
            setDirty(false)
            setEditing(false)
            event.currentTarget.blur()
          }}
          placeholder={t('sidebar.browser.toolbar.addressPlaceholder')}
          ref={inputRef}
          spellCheck={false}
          title={t('sidebar.browser.toolbar.address')}
          type="text"
          value={displayedAddress}
        />
      </label>
      <button
        aria-label={t('sidebar.browser.toolbar.go')}
        className="secondary-button assistant-sidebar__browser-go"
        disabled={goDisabled}
        title={t('sidebar.browser.toolbar.go')}
        type="submit"
      >
        <ArrowRight aria-hidden="true" size={13} />
        <span>{t('sidebar.browser.toolbar.go')}</span>
      </button>
      <button
        aria-label={t('sidebar.browser.interact')}
        className="secondary-button assistant-sidebar__browser-interact"
        disabled={interactDisabled}
        onClick={() => void runToolbarAction(onInteract)}
        title={t('sidebar.browser.interact')}
        type="button"
      >
        <ExternalLink aria-hidden="true" size={12} />
        <span>{t('sidebar.browser.interact')}</span>
      </button>
      <button
        aria-label={t('sidebar.browser.close')}
        className="danger-ghost assistant-sidebar__browser-close"
        disabled={closeDisabled}
        onClick={() => void runToolbarAction(onStop)}
        title={t('sidebar.browser.close')}
        type="button"
      >
        <X aria-hidden="true" size={12} />
        <span>{t('sidebar.browser.close')}</span>
      </button>
    </form>
  )
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
  activeConversationId,
  browserState,
  currentProject,
  restoreFocusRef,
  onBackBrowser = async () => {},
  onInteractBrowser,
  onNavigateBrowser = async () => {},
  onReloadBrowser = async () => {},
  onStopLoadingBrowser = async () => {},
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
  const initialLayout = useMemo(
    () => loadPersistedWorkbarLayout(),
    []
  )
  const localizedAppDefinitions = useMemo(
    () =>
      WORKBAR_APP_DEFINITIONS.map((definition) => {
        const tabDefinition = tabs.find(
          (item) => item.id === definition.id
        )
        return {
          ...definition,
          label:
            tabDefinition?.label ??
            t('sidebar.tabs.terminal.label'),
          description:
            tabDefinition?.description ??
            t('sidebar.tabs.terminal.description')
        } satisfies WorkbarAppDefinition
      }),
    [t, tabs]
  )
  const defaultInstances = useMemo(
    () =>
      DEFAULT_WORKBAR_INSTANCES.map((instance) => ({
        ...instance,
        title:
          localizedAppDefinitions.find(
            (definition) => definition.id === instance.appId
          )?.label ?? instance.title
      })),
    [localizedAppDefinitions]
  )
  const [workbarInstances, setWorkbarInstances] = useState<
    WorkbarTabInstance[]
  >(() =>
    (initialLayout?.instances ?? defaultInstances).map((instance) =>
      instance.appId === 'terminal'
        ? instance
        : {
            ...instance,
            title:
              localizedAppDefinitions.find(
                (definition) => definition.id === instance.appId
              )?.label ?? instance.title
          }
    )
  )
  const [activeWorkbarInstanceId, setActiveWorkbarInstanceId] =
    useState<string | null>(
      () =>
        initialLayout?.activeInstanceId ??
        defaultInstances.find((instance) => instance.appId === tab)?.id ??
        defaultInstances[0]?.id ??
        null
    )
  const [splitLayoutWidth, setSplitLayoutWidth] = useState(
    window.innerWidth
  )
  const [sidebarRatio, setSidebarRatio] = useState(
    initialLayout?.widthRatio ?? defaultSidebarRatio
  )
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
  const [workspacePreviewLoadingMore, setWorkspacePreviewLoadingMore] =
    useState(false)
  const [workspacePreviewLoadMoreError, setWorkspacePreviewLoadMoreError] =
    useState('')
  const [workspaceRefreshVersion, setWorkspaceRefreshVersion] = useState(0)
  const [taskFilter, setTaskFilter] = useState<
    'attention' | 'active' | 'paused' | 'finished'
  >('active')
  const [actionError, setActionError] = useState('')
  const [terminalSessionIds, setTerminalSessionIds] = useState<
    Record<string, string>
  >({})
  const [terminalSnapshots, setTerminalSnapshots] = useState<
    Record<string, TerminalSnapshot>
  >({})
  const [terminalCloseConfirmation, setTerminalCloseConfirmation] =
    useState<{
      instance: WorkbarTabInstance
      resolve: (accepted: boolean) => void
      closing: boolean
      error?: string
    }>()
  const terminalCloseCancelRef = useRef<HTMLButtonElement>(null)
  const lastExternalTabRef = useRef(tab)
  const artifactPreview =
    artifacts.find((artifact) => artifact.id === selectedArtifactId)
  const currentWorkspacePreview =
    workspacePreview?.projectId === workspaceProjectId
      ? workspacePreview
      : undefined
  const terminalAdapter = useMemo<TerminalAdapter>(
    () => ({
      create: (request) => window.goodbuddy.terminal.create(request),
      write: (request) => window.goodbuddy.terminal.write(request),
      resize: (request) => window.goodbuddy.terminal.resize(request),
      close: (request) => window.goodbuddy.terminal.close(request),
      getSnapshot: (request) =>
        window.goodbuddy.terminal.getSnapshot(request),
      ack: (request) => window.goodbuddy.terminal.ack(request),
      subscribe: (listener) =>
        window.goodbuddy.terminal.onEvent(listener)
    }),
    []
  )
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
    if (lastExternalTabRef.current === tab) {
      return
    }
    lastExternalTabRef.current = tab
    const requested = workbarInstances.find(
      (instance) => instance.appId === tab
    )
    if (requested) {
      // This effect intentionally mirrors the legacy external tab prop into
      // the dynamic workbar only when that prop actually changes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveWorkbarInstanceId(requested.id)
    }
  }, [tab, workbarInstances])

  useEffect(() => {
    persistWorkbarLayout(
      workbarInstances,
      activeWorkbarInstanceId,
      open,
      sidebarRatio
    )
  }, [
    activeWorkbarInstanceId,
    open,
    sidebarRatio,
    workbarInstances
  ])

  useEffect(() => {
    if (terminalCloseConfirmation && !terminalCloseConfirmation.closing) {
      terminalCloseCancelRef.current?.focus()
    }
  }, [terminalCloseConfirmation])

  const resolveTerminalTarget = useCallback(
    (): WorkbarTargetRef =>
      currentProject
        ? { type: 'project', projectId: currentProject.id }
        : { type: 'local' },
    [currentProject]
  )

  const updateActiveWorkbarInstance = useCallback(
    (instanceId: string): void => {
      setActiveWorkbarInstanceId(instanceId)
      const instance = workbarInstances.find(
        (candidate) => candidate.id === instanceId
      )
      if (
        instance &&
        instance.appId !== 'terminal'
      ) {
        onTabChange(instance.appId)
      }
    },
    [onTabChange, workbarInstances]
  )

  const createWorkbarInstance = useCallback(
    (request: WorkbarInstanceCreateRequest): void => {
      const definition = localizedAppDefinitions.find(
        (candidate) => candidate.id === request.appId
      )
      if (!definition) {
        return
      }
      const sameTargetTerminals = workbarInstances.filter(
        (instance) =>
          instance.appId === 'terminal' &&
          JSON.stringify(instance.targetRef) ===
            JSON.stringify(request.targetRef)
      ).length
      const instance: WorkbarTabInstance = {
        id: crypto.randomUUID(),
        appId: request.appId,
        title:
          request.appId === 'terminal'
            ? `${definition.label} ${sameTargetTerminals + 1}`
            : definition.label,
        ...(request.targetRef
          ? { targetRef: request.targetRef }
          : {})
      }
      setWorkbarInstances((current) => {
        const afterIndex = request.insertAfterInstanceId
          ? current.findIndex(
              (candidate) =>
                candidate.id === request.insertAfterInstanceId
            )
          : -1
        const next = [...current]
        next.splice(afterIndex >= 0 ? afterIndex + 1 : next.length, 0, instance)
        return next
      })
      setActiveWorkbarInstanceId(instance.id)
    },
    [localizedAppDefinitions, workbarInstances]
  )

  const removeWorkbarInstance = useCallback(
    (instanceId: string): void => {
      setWorkbarInstances((current) =>
        current.filter((instance) => instance.id !== instanceId)
      )
      setTerminalSessionIds((current) => {
        const next = { ...current }
        delete next[instanceId]
        return next
      })
      setTerminalSnapshots((current) => {
        const next = { ...current }
        delete next[instanceId]
        return next
      })
    },
    []
  )

  const requestCloseWorkbarInstance = useCallback(
    async (instance: WorkbarTabInstance): Promise<boolean> => {
      if (instance.appId !== 'terminal') {
        removeWorkbarInstance(instance.id)
        return true
      }
      const sessionId = terminalSessionIds[instance.id]
      const snapshot = terminalSnapshots[instance.id]
      if (
        sessionId &&
        (!snapshot ||
          snapshot.state === 'starting' ||
          snapshot.state === 'running' ||
          snapshot.state === 'closing')
      ) {
        return new Promise<boolean>((resolve) => {
          setTerminalCloseConfirmation({
            instance,
            resolve,
            closing: false
          })
        })
      }
      if (sessionId) {
        try {
          await terminalAdapter.close({ sessionId })
        } catch {
          // An already-ended session can still be removed from the workbar.
        }
      }
      removeWorkbarInstance(instance.id)
      return true
    },
    [
      removeWorkbarInstance,
      terminalAdapter,
      terminalSessionIds,
      terminalSnapshots
    ]
  )

  const confirmTerminalClose = useCallback(async (): Promise<void> => {
    const confirmation = terminalCloseConfirmation
    if (!confirmation || confirmation.closing) {
      return
    }
    const sessionId = terminalSessionIds[confirmation.instance.id]
    setTerminalCloseConfirmation({
      ...confirmation,
      closing: true,
      error: undefined
    })
    try {
      if (sessionId) {
        await terminalAdapter.close({ sessionId })
      }
      removeWorkbarInstance(confirmation.instance.id)
      setTerminalCloseConfirmation(undefined)
      confirmation.resolve(true)
    } catch (reason) {
      setTerminalCloseConfirmation({
        ...confirmation,
        closing: false,
        error:
          reason instanceof Error
            ? reason.message
            : t('sidebar.terminal.closeDialog.error')
      })
    }
  }, [
    removeWorkbarInstance,
    terminalAdapter,
    terminalCloseConfirmation,
    terminalSessionIds,
    t
  ])

  const cancelTerminalClose = useCallback((): void => {
    const confirmation = terminalCloseConfirmation
    setTerminalCloseConfirmation(undefined)
    confirmation?.resolve(false)
  }, [terminalCloseConfirmation])

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
    setWorkspacePreviewLoadingMore(false)
    setWorkspacePreviewLoadMoreError('')
    setActionError('')
    void onLoadWorkspaceFile(path, 0)
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

  const loadMoreWorkspaceFile = (): void => {
    const preview = currentWorkspacePreview
    if (
      preview?.state !== 'ready' ||
      !preview.file.truncated ||
      workspacePreviewLoadingMore
    ) {
      return
    }
    const requestId = workspacePreviewRequest.current
    const expectedOffset = preview.file.nextOffsetBytes
    setWorkspacePreviewLoadingMore(true)
    setWorkspacePreviewLoadMoreError('')
    void onLoadWorkspaceFile(preview.path, expectedOffset)
      .then((nextPage) => {
        if (workspacePreviewRequest.current !== requestId) {
          return
        }
        if (
          nextPage.path !== preview.file.path ||
          nextPage.offsetBytes !== expectedOffset ||
          nextPage.size !== preview.file.size ||
          nextPage.mimeType !== preview.file.mimeType
        ) {
          throw new Error(t('sidebar.errors.workspacePreview'))
        }
        setWorkspacePreview({
          projectId: preview.projectId,
          path: preview.path,
          state: 'ready',
          file: {
            ...nextPage,
            content: `${preview.file.content}${nextPage.content}`,
            offsetBytes: preview.file.offsetBytes
          }
        })
      })
      .catch((reason: unknown) => {
        if (workspacePreviewRequest.current === requestId) {
          setWorkspacePreviewLoadMoreError(
            reason instanceof Error
              ? reason.message
              : t('sidebar.errors.workspacePreview')
          )
        }
      })
      .finally(() => {
        if (workspacePreviewRequest.current === requestId) {
          setWorkspacePreviewLoadingMore(false)
        }
      })
  }

  const runAction = async (
    action: () => Promise<void>,
    fallback: string,
    onSuccess?: () => void
  ): Promise<boolean> => {
    setActionError('')
    try {
      await action()
      onSuccess?.()
      return true
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : fallback
      )
      return false
    }
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
      <WorkbarShell
        activeInstanceId={activeWorkbarInstanceId}
        appDefinitions={localizedAppDefinitions}
        instances={workbarInstances}
        onActiveInstanceChange={updateActiveWorkbarInstance}
        onCloseInstance={requestCloseWorkbarInstance}
        onCreateInstance={createWorkbarInstance}
        onResolveTerminalTarget={resolveTerminalTarget}
        renderTabAdornment={(instance) =>
          instance.appId === 'tasks' && approvals.length > 0 ? (
            <span
              aria-label={`${t('sidebar.tasks.approvalsTitle')}: ${approvals.length}`}
              className="assistant-sidebar__badge"
            >
              {approvals.length}
            </span>
          ) : null
        }
        renderPanel={(instance) => (
          <div className="assistant-sidebar__body">
        {actionError ? (
          <p className="settings-error" role="alert">
            {actionError}
          </p>
        ) : null}
        {instance.appId === 'terminal' && instance.targetRef ? (
          <Suspense
            fallback={
              <section
                aria-busy="true"
                aria-label={t('sidebar.terminal.loading')}
                className="terminal-panel terminal-panel--loading"
              >
                <span>{t('sidebar.terminal.loading')}</span>
              </section>
            }
          >
            <TerminalPanel
              adapter={terminalAdapter}
              onRename={(title) =>
                setWorkbarInstances((current) =>
                  current.map((candidate) =>
                    candidate.id === instance.id
                      ? { ...candidate, title }
                      : candidate
                  )
                )
              }
              onSessionChange={(snapshot) => {
                setTerminalSessionIds((current) =>
                  current[instance.id] === snapshot.sessionId
                    ? current
                    : {
                        ...current,
                        [instance.id]: snapshot.sessionId
                      }
                )
                setTerminalSnapshots((current) => ({
                  ...current,
                  [instance.id]: snapshot
                }))
              }}
              sessionId={terminalSessionIds[instance.id]}
              target={instance.targetRef}
              title={instance.title}
            />
          </Suspense>
        ) : null}
        {instance.appId === 'tasks' && (
          <section className="assistant-sidebar__section">
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
                  aria-label={`${t('sidebar.tasks.approvalsTitle')}: ${
                    approval.toolName ?? approval.title
                  }`}
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

        {instance.appId === 'workspace' && (
          currentWorkspacePreview ? (
            <section
              aria-busy={currentWorkspacePreview.state === 'loading'}
              className="assistant-sidebar__preview"
            >
              <header>
                <button
                  aria-label={t('sidebar.workspace.back')}
                  className="assistant-sidebar__back"
                  onClick={() => {
                    workspacePreviewRequest.current += 1
                    setWorkspacePreview(undefined)
                    setWorkspacePreviewLoadingMore(false)
                    setWorkspacePreviewLoadMoreError('')
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
                <p
                  aria-label={t('sidebar.workspace.reading')}
                  aria-live="polite"
                  className="assistant-sidebar__empty"
                  role="status"
                >
                  {t('sidebar.workspace.reading')}
                </p>
              ) : currentWorkspacePreview.state === 'error' ? (
                <div className="assistant-sidebar__empty" role="alert">
                  <p>{currentWorkspacePreview.error}</p>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      openWorkspaceFile(currentWorkspacePreview.path)
                    }
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" size={13} />
                    {t('sidebar.workspace.refresh')}
                  </button>
                </div>
              ) : (
                <>
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
                  {currentWorkspacePreview.file.truncated && (
                    <div className="assistant-sidebar__preview-more">
                      <p>
                        {t('sidebar.workspace.partialPreview', {
                          loaded: currentWorkspacePreview.file
                            .nextOffsetBytes.toLocaleString(locale),
                          total:
                            currentWorkspacePreview.file.size.toLocaleString(
                              locale
                            )
                        })}
                      </p>
                      <button
                        className="secondary-button"
                        disabled={workspacePreviewLoadingMore}
                        onClick={loadMoreWorkspaceFile}
                        type="button"
                      >
                        {workspacePreviewLoadingMore
                          ? t('sidebar.workspace.loadingMore')
                          : t('sidebar.workspace.loadMore')}
                      </button>
                    </div>
                  )}
                  {workspacePreviewLoadMoreError && (
                    <p
                      className="assistant-sidebar__preview-more-error"
                      role="alert"
                    >
                      {workspacePreviewLoadMoreError}
                    </p>
                  )}
                </>
              )}
            </section>
          ) : (
            <section className="assistant-sidebar__section">
              <h3>
                <FolderTree size={15} />
                {t('sidebar.workspace.projectTitle')}
                <button
                  aria-label={t('sidebar.workspace.refreshAriaLabel')}
                  className="icon-button"
                  disabled={!workspaceProjectId}
                  onClick={() => {
                    setWorkspaceRefreshVersion((current) => current + 1)
                    void runAction(
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

        {instance.appId === 'results' && (
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
              <h3>
                <FileText size={15} />
                {t('sidebar.results.sectionTitle')}
              </h3>
              <button
                className="secondary-button assistant-sidebar__import"
                onClick={() =>
                  void runAction(
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
                      void runAction(
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

        {instance.appId === 'browser' && (
          <section
            className="assistant-sidebar__browser"
            key={activeConversationId}
          >
            <BrowserToolbar
              activeConversationId={activeConversationId}
              browserState={browserState}
              onBack={() =>
                runAction(
                  onBackBrowser,
                  t('sidebar.errors.backBrowser')
                )
              }
              onInteract={() =>
                runAction(
                  onInteractBrowser,
                  t('sidebar.errors.interactBrowser')
                )
              }
              onNavigate={(url) =>
                runAction(
                  () => onNavigateBrowser(url),
                  t('sidebar.errors.navigateBrowser')
                )
              }
              onReload={() =>
                runAction(
                  onReloadBrowser,
                  t('sidebar.errors.reloadBrowser')
                )
              }
              onStop={() =>
                runAction(
                  onStopBrowser,
                  t('sidebar.errors.stopBrowser')
                )
              }
              onStopLoading={() =>
                runAction(
                  onStopLoadingBrowser,
                  t('sidebar.errors.stopLoadingBrowser')
                )
              }
            />
            <header>
              <span>
                <Monitor size={15} />
                <strong>{t('sidebar.browser.title')}</strong>
              </span>
            </header>
            {!browserState ? (
              <p className="assistant-sidebar__empty">
                {t('sidebar.browser.empty')}
              </p>
            ) : (
              <>
                <div
                  aria-live={
                    browserState.status === 'failed'
                      ? 'assertive'
                      : 'polite'
                  }
                  className={`assistant-sidebar__browser-status assistant-sidebar__browser-status--${browserState.status}`}
                  role={
                    browserState.status === 'failed' ? 'alert' : 'status'
                  }
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
        )}
      />
      {terminalCloseConfirmation ? (
        <div className="assistant-sidebar__overlay">
          <section
            aria-label={t('sidebar.terminal.closeDialog.ariaLabel')}
            className="assistant-sidebar__terminal-close"
            onKeyDown={(event) => {
              if (
                event.key === 'Escape' &&
                !terminalCloseConfirmation.closing
              ) {
                event.preventDefault()
                cancelTerminalClose()
              }
            }}
            role="alertdialog"
          >
            <h2>{t('sidebar.terminal.closeDialog.title')}</h2>
            <p>{t('sidebar.terminal.closeDialog.description')}</p>
            {terminalCloseConfirmation.error ? (
              <p role="alert">{terminalCloseConfirmation.error}</p>
            ) : null}
            <div>
              <button
                className="secondary-button"
                disabled={terminalCloseConfirmation.closing}
                onClick={cancelTerminalClose}
                ref={terminalCloseCancelRef}
                type="button"
              >
                {t('sidebar.terminal.closeDialog.cancel')}
              </button>
              <button
                className="danger-button"
                disabled={terminalCloseConfirmation.closing}
                onClick={() => void confirmTerminalClose()}
                type="button"
              >
                {terminalCloseConfirmation.closing
                  ? t('sidebar.terminal.closeDialog.closing')
                  : t('sidebar.terminal.closeDialog.confirm')}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  )
}
