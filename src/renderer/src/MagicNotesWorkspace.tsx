import {
  ArrowLeft,
  Bot,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Circle,
  FileText,
  FolderTree,
  Lightbulb,
  ListTodo,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  Plus,
  Sparkles,
  Trash2
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import type {
  MagicNoteAnalysisOptions,
  MagicNoteEntryAnalysisOptions,
  MagicNoteCommentDirection,
  MagicNoteCommentFormat,
  MagicNoteDraftAnalysis,
  MagicNoteComment,
  MagicNoteDetail,
  MagicNoteEntry,
  MagicNoteContent as NoteContent,
  MagicNoteSummary,
  MagicTodoItem,
  MagicTodoAnalysisOptions
} from '../../shared/magic-notes-contracts'
import type { ApplicationSettings, MagicNoteCommentMode } from '../../shared/application-settings-contracts'
import { magicNoteCanvasAnalysisText } from '../../shared/magic-note-canvas-text'
import { MagicNoteContent } from './MagicNoteContent'
import { MagicNoteEditor } from './MagicNoteEditor'
import { MagicCanvasEditor, canvasHasContent, type MagicCanvasEditorHandle } from './MagicCanvasEditor'
import type { MagicCanvasContentHandle } from './MagicCanvasContent'
import { MagicCanvasThumbnail } from './MagicCanvasThumbnail'
import { MarkdownRenderer } from './MarkdownRenderer'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import type { AppNotificationInput } from './notifications'
import {
  EmptyState,
  DestructiveConfirmActions,
  PageHeader,
  SegmentedControl
} from './WorkspacePrimitives'

export type MagicNotesWorkspaceProps = {
  applicationSettings?: ApplicationSettings
  onNotify: (notification: AppNotificationInput) => void
  onBeforeLeave?: (requester: ((leave: () => void) => void) | undefined) => void
}

type LibraryView = 'notes' | 'todos'
type TodoFilter = 'active' | 'completed' | 'all'
type LoadStatus = 'loading' | 'ready' | 'error'
type ValidationTarget =
  | 'create-note'
  | 'note-title'
  | 'new-entry'
  | 'edit-entry'
type DraftSwitchTarget =
  | { kind: 'leave'; leave: () => void }
  | { kind: 'select-entry'; entry: MagicNoteEntry }
  | { kind: 'entry-type'; value: 'text' | 'canvas' }
  | { kind: 'cancel-edit' }
  | { kind: 'overview' }
  | { kind: 'library-view'; value: LibraryView }
  | { kind: 'create-note'; title: string }
  | { kind: 'edit-entry'; entry: MagicNoteEntry }
  | { kind: 'note'; noteId: string; entryId?: string }

const defaultAiPaneWidth = 280
const minimumAiPaneWidth = 240
const maximumAiPaneWidth = 520
const defaultIndexPaneWidth = 168
const minimumIndexPaneWidth = 140
const maximumIndexPaneWidth = 320
const minimumMagicNotesEditorWidth = 300
const magicNotesResizeHandleWidth = 9
const magicNotesPaneKeyboardResizeStep = 16
const magicNotesLayoutStorageKey =
  'goodbuddy.magic-notes-layout.v1'

type MagicNotesLayoutPreferences = {
  indexPaneOpen: boolean
  indexPaneWidth: number
  aiPaneOpen: boolean
  aiPaneWidth: number
}

function loadMagicNotesLayoutPreferences(): MagicNotesLayoutPreferences {
  const defaults = {
    indexPaneOpen: true,
    indexPaneWidth: defaultIndexPaneWidth,
    aiPaneOpen: true,
    aiPaneWidth: defaultAiPaneWidth
  }
  try {
    const value = localStorage.getItem(magicNotesLayoutStorageKey)
    if (!value || value.length > 10_000) {
      return defaults
    }
    const parsed = JSON.parse(value) as Partial<
      MagicNotesLayoutPreferences
    >
    return {
      indexPaneOpen: parsed.indexPaneOpen !== false,
      indexPaneWidth: typeof parsed.indexPaneWidth === 'number' && Number.isFinite(parsed.indexPaneWidth)
        ? Math.min(maximumIndexPaneWidth, Math.max(minimumIndexPaneWidth, parsed.indexPaneWidth))
        : defaults.indexPaneWidth,
      aiPaneOpen: parsed.aiPaneOpen !== false,
      aiPaneWidth:
        typeof parsed.aiPaneWidth === 'number' &&
        Number.isFinite(parsed.aiPaneWidth)
          ? Math.min(
              maximumAiPaneWidth,
              Math.max(minimumAiPaneWidth, parsed.aiPaneWidth)
            )
          : defaults.aiPaneWidth
    }
  } catch {
    return defaults
  }
}

function persistMagicNotesLayoutPreferences(
  preferences: MagicNotesLayoutPreferences
): void {
  try {
    localStorage.setItem(
      magicNotesLayoutStorageKey,
      JSON.stringify(preferences)
    )
  } catch {
    // The in-memory layout remains usable when browser storage is unavailable.
  }
}

type MagicNotesPaneWidthLimits = {
  minimum: number
  maximum: number
}

function getAiPaneWidthLimits(layoutWidth: number, indexWidth: number): MagicNotesPaneWidthLimits {
  return {
    minimum: minimumAiPaneWidth,
    maximum: Math.max(
      minimumAiPaneWidth,
      Math.min(
        maximumAiPaneWidth,
          layoutWidth -
          indexWidth -
          minimumMagicNotesEditorWidth -
          magicNotesResizeHandleWidth
      )
    )
  }
}

function clampMagicNotesPaneWidth(
  width: number,
  limits: MagicNotesPaneWidthLimits
): number {
  return Math.round(
    Math.min(limits.maximum, Math.max(limits.minimum, width))
  )
}

function noteSummary(note: MagicNoteDetail): MagicNoteSummary {
  return {
    id: note.id,
    title: note.title,
    preview: note.preview,
    entryCount: note.entryCount,
    pinned: note.pinned,
    revision: note.revision,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  }
}

function hasContent(content?: NoteContent): boolean {
  if (content?.version === 2) return canvasHasContent(content)
  return Boolean(
    content?.ops.some((operation) =>
      typeof operation.insert === 'string'
        ? operation.insert.trim().length > 0
        : true
    )
  )
}

function richContentEqual(
  left: NoteContent | undefined,
  right: NoteContent | undefined
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

// Geometry and paper changes do not require another automatic AI comment.
function analysisContentKey(content: NoteContent): string {
  if (content.version === 1) return JSON.stringify(content)
  return JSON.stringify({
    flow: content.flow?.ops.map((op) => typeof op.insert === 'string'
      ? op.insert : 'canvasPageBreak' in op.insert ? '' : JSON.stringify(op.insert)).join('').trim() ?? '',
    pages: content.pages.map((page) => ({
      background: page.background.type === 'pdf' ? page.background : undefined,
      objects: page.objects.map((object) => Object.fromEntries(Object.entries(object).filter(([key]) =>
        !['left', 'top', 'width', 'height', 'scaleX', 'scaleY', 'angle', 'skewX', 'skewY', 'originX', 'originY', 'id'].includes(key)
      )))
    })).filter((page) => page.background || page.objects.length),
    assets: content.assets
  })
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string') {
    return error
  }
  return error instanceof Error ? error.message : fallback
}

function AiComment({
  comment
}: {
  comment: MagicNoteComment
}): React.JSX.Element {
  const { t } = useTranslation('magicNotes')
  const kindLabel =
    comment.kind === 'narrative'
      ? t('comments.kinds.narrative')
      : comment.kind === 'warning'
        ? t('comments.kinds.warning')
        : comment.kind === 'suggestion'
          ? t('comments.kinds.suggestion')
          : t('comments.kinds.summary')
  return (
    <div
      className={`magic-note-comment magic-note-comment--${comment.kind}`}
    >
      <span aria-hidden="true">
        {comment.kind === 'warning' ? (
          <CircleAlert size={15} />
        ) : comment.kind === 'suggestion' ? (
          <Lightbulb size={15} />
        ) : (
          <Bot size={15} />
        )}
      </span>
      <div>
        <strong>
          {kindLabel}
        </strong>
        {comment.direction && (
          <span className="magic-note-comment__direction">
            {t(`comments.directions.${comment.direction}`)}
          </span>
        )}
        {comment.inputMode && <span className="magic-note-comment__direction">{t(`canvas.inputMode.${comment.inputMode}`)}</span>}
        {comment.kind === 'narrative' ? (
          <div className="magic-note-comment__narrative markdown-content">
            <MarkdownRenderer>{comment.content}</MarkdownRenderer>
          </div>
        ) : (
          <p>{comment.content}</p>
        )}
      </div>
    </div>
  )
}

function TodoListItem({
  disabled,
  expanded,
  id,
  onSelect,
  onToggle,
  todo
}: {
  disabled: boolean
  expanded: boolean
  id: string
  onSelect: () => void
  onToggle: () => void
  todo: MagicTodoItem
}): React.JSX.Element {
  const { t } = useTranslation('magicNotes')
  return (
    <div className={`magic-todo-list-item${todo.completed ? ' magic-todo-list-item--completed' : ''}`}>
      <button
        aria-label={t(
          todo.completed
            ? 'todos.markIncomplete'
            : 'todos.markComplete',
          { title: todo.title }
        )}
        aria-pressed={todo.completed}
        className="magic-todo-list-item__check"
        disabled={disabled}
        onClick={onToggle}
        type="button"
      >
        {todo.completed ? (
          <CheckCircle2 size={16} />
        ) : (
          <Circle size={16} />
        )}
      </button>
      <button
        aria-controls={expanded ? `magic-todo-detail-${todo.id}` : undefined}
        aria-expanded={expanded}
        className="magic-todo-list-item__content"
        disabled={disabled}
        id={id}
        onClick={onSelect}
        type="button"
      >
        <strong>{todo.title}</strong>
        <small>{t('todos.sourceNote', { title: todo.noteTitle })}</small>
        <ChevronRight aria-hidden="true" size={16} />
      </button>
    </div>
  )
}

export function MagicNotesWorkspace({
  onNotify,
  onBeforeLeave,
  applicationSettings
}: MagicNotesWorkspaceProps): React.JSX.Element {
  const { i18n, t } = useTranslation('magicNotes')
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const currentLocale = i18n.resolvedLanguage || i18n.language
  const todoFilters = useMemo<
    ReadonlyArray<{ value: TodoFilter; label: string }>
  >(
    () => [
      { value: 'all', label: t('todos.filters.all') },
      { value: 'active', label: t('todos.filters.active') },
      { value: 'completed', label: t('todos.filters.completed') }
    ],
    [t]
  )
  const commentDirections = useMemo<
    ReadonlyArray<{
      value: MagicNoteCommentDirection
      label: string
    }>
  >(
    () => [
      { value: 'general', label: t('comments.directions.general') },
      { value: 'expand', label: t('comments.directions.expand') },
      { value: 'polish', label: t('comments.directions.polish') },
      {
        value: 'challenge',
        label: t('comments.directions.challenge')
      },
      {
        value: 'brainstorm',
        label: t('comments.directions.brainstorm')
      }
    ],
    [t]
  )
  const commentDirectionLabels = useMemo(
    () =>
      Object.fromEntries(
        commentDirections.map((direction) => [
          direction.value,
          direction.label
        ])
      ) as Record<MagicNoteCommentDirection, string>,
    [commentDirections]
  )
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(
        currentLocale,
        {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        }
      ),
    [currentLocale]
  )
  const [notes, setNotes] = useState<MagicNoteSummary[]>([])
  const [todos, setTodos] = useState<MagicTodoItem[]>([])
  const [libraryView, setLibraryView] = useState<LibraryView>('notes')
  const [detailView, setDetailView] = useState<'notes'>()
  const overviewFocusRef = useRef('')
  const [todoFilter, setTodoFilter] = useState<TodoFilter>('active')
  const [loadedCommentMode, setCommentMode] =
    useState<MagicNoteCommentMode>('immediate')
  const [commentDirection, setCommentDirection] =
    useState<MagicNoteCommentDirection>('general')
  const [loadedCommentFormat, setCommentFormat] =
    useState<MagicNoteCommentFormat>('combined')
  const commentMode = applicationSettings?.magicNoteCommentMode ?? loadedCommentMode
  const commentFormat = applicationSettings?.magicNoteCommentFormat ?? loadedCommentFormat
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [selectedTodoId, setSelectedTodoId] = useState('')
  const [detail, setDetail] = useState<MagicNoteDetail>()
  const [todoSourceDetail, setTodoSourceDetail] =
    useState<MagicNoteDetail>()
  const [todoSourceStatus, setTodoSourceStatus] = useState<LoadStatus>('loading')
  const [todoSourceRetry, setTodoSourceRetry] = useState(0)
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading')
  const [loadError, setLoadError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [detailLoadError, setDetailLoadError] = useState<{
    message: string
    noteId: string
  }>()
  const [busy, setBusy] = useState('')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [titleDraft, setTitleDraft] = useState('')
  const [deletingNote, setDeletingNote] = useState(false)
  const [noteActionsId, setNoteActionsId] = useState('')
  const noteActionsRef = useRef<HTMLDivElement>(null)
  const noteActionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [composerKey, setComposerKey] = useState(0)
  const [entryType, setEntryType] = useState<'text' | 'canvas'>('text')
  const composerCanvasRef = useRef<MagicCanvasEditorHandle>(null)
  const editingCanvasRef = useRef<MagicCanvasEditorHandle>(null)
  const canvasViewRefs = useRef(new Map<string, MagicCanvasContentHandle>())
  const todoCanvasRef = useRef<MagicCanvasContentHandle>(null)
  const [editingEntry, setEditingEntry] = useState<MagicNoteEntry>()
  const [selectedEntryId, setSelectedEntryId] = useState('')
  const [deletingEntryId, setDeletingEntryId] = useState('')
  const initialLayoutPreferences = useMemo(
    () => loadMagicNotesLayoutPreferences(),
    []
  )
  const [aiPaneOpen, setAiPaneOpen] = useState(
    initialLayoutPreferences.aiPaneOpen
  )
  const [aiPaneWidth, setAiPaneWidth] = useState(
    initialLayoutPreferences.aiPaneWidth
  )
  const [indexPaneOpen, setIndexPaneOpen] = useState(initialLayoutPreferences.indexPaneOpen)
  const [indexPaneWidth, setIndexPaneWidth] = useState(initialLayoutPreferences.indexPaneWidth)
  const [narrowIndexOpen, setNarrowIndexOpen] = useState(false)
  const [resizingPane, setResizingPane] = useState<'ai' | 'index'>()
  const [magicNotesLayoutWidth, setMagicNotesLayoutWidth] = useState(
    window.innerWidth
  )
  const [draftAnalyses, setDraftAnalyses] = useState<
    MagicNoteDraftAnalysis[]
  >([])
  const [canvasDraftAnalysis, setCanvasDraftAnalysis] = useState<MagicNoteDraftAnalysis>()
  const canvasDraftContextRef = useRef(0)
  const clearCanvasDraftAnalysis = useCallback((): void => {
    canvasDraftContextRef.current += 1
    setCanvasDraftAnalysis(undefined)
  }, [])
  const [draftAnalysisRunning, setDraftAnalysisRunning] = useState(false)
  const [liveAnalysis, setLiveAnalysis] = useState<{
    requestId: string
    content: string
    direction: MagicNoteCommentDirection
    format: MagicNoteCommentFormat
  }>()
  const [validation, setValidation] = useState<{
    target: ValidationTarget
    message: string
  }>()
  const [pendingDraftSwitch, setPendingDraftSwitch] =
    useState<DraftSwitchTarget>()
  const detailRequestRef = useRef(0)
  const todoSourceRequestRef = useRef(0)
  const requestedNoteIdRef = useRef('')
  const refreshRequestRef = useRef(0)
  const hasLoadedRef = useRef(false)
  const busyRef = useRef('')
  const refreshContextRef = useRef({ detail, titleDraft, editingEntry })
  useEffect(() => {
    refreshContextRef.current = { detail, titleDraft, editingEntry }
  }, [detail, titleDraft, editingEntry])
  const composerContentRef = useRef<NoteContent | undefined>(
    undefined
  )
  const editingContentRef = useRef<NoteContent | undefined>(
    undefined
  )
  // Quill/Fabric normalize persisted JSON when the editor loads a revision.
  const editingBaselineRef = useRef<NoteContent | undefined>(undefined)
  const draftAnalysisTimerRef = useRef<number | undefined>(undefined)
  const draftAnalysisContentRef = useRef<
    NoteContent | undefined
  >(undefined)
  const draftAnalysisQueuedRef = useRef(false)
  const draftAnalysisRunningRef = useRef(false)
  const draftAnalysisArmedRef = useRef(false)
  const draftAnalysisContextRef = useRef(0)
  const lastDraftAnalysisStartedAtRef = useRef(0)
  const magicNotesLayoutRef = useRef<HTMLDivElement>(null)
  const paneResizeRef = useRef<{ pane: 'ai' | 'index'; pointerId: number; width: number } | undefined>(undefined)
  const composerRef = useRef<HTMLDivElement>(null)
  const continueEditingRef = useRef<HTMLButtonElement>(null)
  const discardDraftRef = useRef<HTMLButtonElement>(null)
  const discardDraftDialogRef = useRef<HTMLDivElement>(null)
  const discardDraftTitleId = useId()
  const discardDraftDescriptionId = useId()
  const runDraftAnalysisRef = useRef<
    (content: NoteContent) => Promise<void>
  >(async () => undefined)

  const createAnalysisOptions = useCallback(
    async (canvas?: MagicCanvasContentHandle | null): Promise<MagicNoteAnalysisOptions> => {
      let format = commentFormat
      let pageCount = applicationSettings?.magicNoteCanvasPageCount ?? 1
      // Read capability for this request, never reuse a previous profile's flag.
      const runtimePromise = canvas !== undefined
        ? window.goodbuddy.settings.getRuntime()
        : Promise.resolve(undefined)
      const [settingsResult, runtimeResult] = await Promise.allSettled([
        window.goodbuddy.updates?.getSettings(), runtimePromise
      ])
      // Keep the last loaded format if application settings cannot be refreshed.
      if (settingsResult.status === 'fulfilled' && settingsResult.value) {
        format = settingsResult.value.magicNoteCommentFormat
        pageCount = settingsResult.value.magicNoteCanvasPageCount ?? 1
        setCommentFormat(format)
      }
      const options: MagicNoteAnalysisOptions = {
        requestId: crypto.randomUUID(),
        direction: commentDirection,
        format
      }
      if (runtimeResult.status === 'rejected') throw runtimeResult.reason
      const runtime = runtimeResult.value
      if (runtime) {
        const profile = runtime.modelProfiles.find((candidate) => candidate.id === runtime.defaultModelProfileId)
        const supportsImages = (profile ? profile.supportsImageInput : runtime.supportsImageInput) === true
        if (!canvas) throw new Error(tRef.current('canvas.notReady'))
        const pages = await canvas.capturePages(pageCount, supportsImages)
        options.canvasPageText = pages.map(({ pageId, text }) => ({ pageId, text: text ?? '' }))
        if (supportsImages) options.canvasImages = pages.map(({ pageId, dataUrl }) => ({ pageId, dataUrl }))
      }
      return options
    },
    [commentDirection, commentFormat, applicationSettings?.magicNoteCanvasPageCount]
  )

  const getLayoutBounds = useCallback((): {
    left: number
    width: number
    right: number
  } => {
    const bounds = magicNotesLayoutRef.current?.getBoundingClientRect()
    const width = bounds?.width || window.innerWidth
    return {
      left: bounds?.left ?? 0,
      width,
      right: bounds?.right || width
    }
  }, [])

  useEffect(
    () =>
      window.goodbuddy.magicNotes.onAnalysisEvent((event) => {
        setLiveAnalysis((current) =>
          current?.requestId === event.requestId
            ? {
                ...current,
                content: current.content + event.delta
              }
            : current
        )
      }),
    []
  )

  useEffect(() => {
    persistMagicNotesLayoutPreferences({
      indexPaneOpen,
      indexPaneWidth,
      aiPaneOpen,
      aiPaneWidth
    })
  }, [indexPaneOpen, indexPaneWidth, aiPaneOpen, aiPaneWidth])

  useEffect(() => {
    const layout = magicNotesLayoutRef.current
    const updateLayoutWidth = (): void => {
      const width = layout?.getBoundingClientRect().width || window.innerWidth
      setMagicNotesLayoutWidth(width)
    }
    updateLayoutWidth()
    const observer =
      layout && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(updateLayoutWidth)
        : undefined
    if (layout && observer) {
      observer.observe(layout)
    } else {
      window.addEventListener('resize', updateLayoutWidth)
    }
    return () => {
      if (!observer) {
        window.removeEventListener('resize', updateLayoutWidth)
      }
      observer?.disconnect()
    }
  }, [aiPaneOpen, detailView, loadStatus])

  const notifyError = useCallback(
    (error: unknown): void =>
      onNotify({
        tone: 'error',
        message: errorMessage(
          error,
          tRef.current('errors.operationFailed')
        ),
        dedupeKey: 'magic-notes-error'
      }),
    [onNotify]
  )
  const notifySuccess = useCallback(
    (message: string): void => onNotify({ tone: 'success', message }),
    [onNotify]
  )
  const notifyInfo = useCallback(
    (message: string): void => onNotify({ tone: 'info', message }),
    [onNotify]
  )
  const clearValidation = useCallback((target: ValidationTarget): void => {
    setValidation((current) =>
      current?.target === target ? undefined : current
    )
  }, [])

  const beginBusy = useCallback((operation: string): boolean => {
    if (busyRef.current) {
      notifyInfo(tRef.current('notifications.waitForOperation'))
      return false
    }
    busyRef.current = operation
    setBusy(operation)
    return true
  }, [notifyInfo])

  const endBusy = useCallback((operation: string): void => {
    if (busyRef.current !== operation) {
      return
    }
    busyRef.current = ''
    setBusy('')
  }, [])

  useEffect(() => {
    let active = true
    void window.goodbuddy.updates
      ?.getSettings()
      .then((settings) => {
        if (active) {
          setCommentMode(settings.magicNoteCommentMode)
          setCommentFormat(settings.magicNoteCommentFormat)
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const runDraftAnalysis = useCallback(
    async (content: NoteContent): Promise<void> => {
      if (draftAnalysisRunningRef.current) {
        draftAnalysisContentRef.current = content
        draftAnalysisQueuedRef.current = true
        return
      }
      draftAnalysisArmedRef.current = false
      draftAnalysisRunningRef.current = true
      const analysisContext = draftAnalysisContextRef.current
      lastDraftAnalysisStartedAtRef.current = Date.now()
      setDraftAnalysisRunning(true)
      let options: MagicNoteAnalysisOptions | undefined
      try {
        options = await createAnalysisOptions()
        if (draftAnalysisContextRef.current !== analysisContext) return
        setLiveAnalysis({
          requestId: options.requestId,
          content: '',
          direction: options.direction,
          format: options.format
        })
        const analysis =
          await window.goodbuddy.magicNotes.analyzeDraft(content, options)
        if (draftAnalysisContextRef.current === analysisContext) {
          setDraftAnalyses((current) => [analysis, ...current].slice(0, 20))
        }
      } catch (analysisError) {
        if (draftAnalysisContextRef.current === analysisContext) {
          notifyError(analysisError)
        }
      } finally {
        setLiveAnalysis((current) =>
          current?.requestId === options?.requestId ? undefined : current
        )
        draftAnalysisRunningRef.current = false
        setDraftAnalysisRunning(false)
        if (draftAnalysisQueuedRef.current) {
          draftAnalysisQueuedRef.current = false
          const queuedContent = draftAnalysisContentRef.current
          const delay = Math.max(
            0,
            5_000 -
              (Date.now() - lastDraftAnalysisStartedAtRef.current)
          )
          if (queuedContent) {
            draftAnalysisTimerRef.current = window.setTimeout(() => {
              void runDraftAnalysisRef.current(queuedContent)
            }, delay)
          }
        }
      }
    },
    [createAnalysisOptions, notifyError]
  )
  useEffect(() => {
    runDraftAnalysisRef.current = runDraftAnalysis
  }, [runDraftAnalysis])

  const scheduleDraftAnalysis = useCallback(
    (content: NoteContent): void => {
      draftAnalysisContentRef.current = content
      if (draftAnalysisTimerRef.current !== undefined) {
        window.clearTimeout(draftAnalysisTimerRef.current)
      }
      draftAnalysisTimerRef.current = window.setTimeout(() => {
        draftAnalysisTimerRef.current = undefined
        void runDraftAnalysisRef.current(content)
      }, 5_000)
    },
    []
  )

  useEffect(() => {
    if (commentMode === 'immediate') {
      return
    }
    draftAnalysisArmedRef.current = false
    draftAnalysisQueuedRef.current = false
    if (draftAnalysisTimerRef.current !== undefined) {
      window.clearTimeout(draftAnalysisTimerRef.current)
      draftAnalysisTimerRef.current = undefined
    }
  }, [commentMode])

  useEffect(
    () => () => {
      if (draftAnalysisTimerRef.current !== undefined) {
        window.clearTimeout(draftAnalysisTimerRef.current)
      }
      draftAnalysisQueuedRef.current = false
    },
    []
  )

  const applyNoteSummary = useCallback((next: MagicNoteDetail) => {
    setNotes((current) => {
      const summary = noteSummary(next)
      const existing = current.some((note) => note.id === next.id)
      return (existing
        ? current.map((note) => (note.id === next.id ? summary : note))
        : [summary, ...current]
      ).sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) ||
          right.updatedAt.localeCompare(left.updatedAt)
      )
    })
  }, [])

  const applyDetail = useCallback(
    (next: MagicNoteDetail, submittedTitle?: string) => {
      const previous = refreshContextRef.current.detail
      setDetail(next)
      setTitleDraft((current) => previous?.id !== next.id ||
        current === (submittedTitle ?? previous.title) ? next.title : current)
      applyNoteSummary(next)
    },
    [applyNoteSummary]
  )

  const applyTodo = useCallback((next: MagicTodoItem) => {
    setTodos((current) =>
      [
        next,
        ...current.filter((candidate) => candidate.id !== next.id)
      ].sort(
        (left, right) =>
          Number(left.completed) - Number(right.completed) ||
          right.updatedAt.localeCompare(left.updatedAt)
      )
    )
  }, [])

  const clearDraftAnalysis = useCallback((): void => {
    clearCanvasDraftAnalysis()
    draftAnalysisArmedRef.current = false
    draftAnalysisQueuedRef.current = false
    draftAnalysisContentRef.current = undefined
    draftAnalysisContextRef.current += 1
    setDraftAnalyses([])
    setLiveAnalysis(undefined)
    setDraftAnalysisRunning(false)
    if (draftAnalysisTimerRef.current !== undefined) {
      window.clearTimeout(draftAnalysisTimerRef.current)
      draftAnalysisTimerRef.current = undefined
    }
  }, [clearCanvasDraftAnalysis])

  const loadDetail = useCallback(
    async (noteId: string, entryId?: string): Promise<void> => {
      const requestId = ++detailRequestRef.current
      requestedNoteIdRef.current = noteId
      setDetailLoadError(undefined)
      try {
        const nextDetail = await window.goodbuddy.magicNotes.get(noteId)
        if (detailRequestRef.current === requestId) {
          clearDraftAnalysis()
          composerContentRef.current = undefined
          setComposerKey((current) => current + 1)
          setEditingEntry(undefined)
          setSelectedEntryId(nextDetail.entries.find((entry) => entry.id === entryId)?.id ?? nextDetail.entries.at(-1)?.id ?? '')
          editingContentRef.current = undefined
          setSelectedNoteId(noteId)
          applyDetail(nextDetail)
        }
      } catch (loadError) {
        if (detailRequestRef.current === requestId) {
          setDetailLoadError({
            message: errorMessage(
              loadError,
              tRef.current('errors.operationFailed')
            ),
            noteId
          })
        }
      }
    },
    [applyDetail, clearDraftAnalysis]
  )

  const discardComposerDraft = useCallback((): void => {
    clearDraftAnalysis()
    composerContentRef.current = undefined
    setComposerKey((current) => current + 1)
  }, [clearDraftAnalysis])

  const discardEditingDraft = useCallback((): void => {
    clearDraftAnalysis()
    setEditingEntry(undefined)
    editingContentRef.current = undefined
    clearValidation('edit-entry')
  }, [clearValidation, clearDraftAnalysis])

  const hasDirtyEditingDraft = useCallback(
    (): boolean =>
      Boolean(
        editingEntry &&
          !richContentEqual(
            editingContentRef.current,
            editingBaselineRef.current ?? editingEntry.content
          )
      ),
    [editingEntry]
  )

  const createNote = useCallback(
    async (title: string, discardDraft: boolean): Promise<void> => {
      const operation = 'create-note'
      if (!beginBusy(operation)) {
        return
      }
      try {
        const created = await window.goodbuddy.magicNotes.create({
          title
        })
        if (discardDraft) {
          discardComposerDraft()
          discardEditingDraft()
        }
        applyDetail(created)
        detailRequestRef.current += 1
        requestedNoteIdRef.current = created.id
        setSelectedNoteId(created.id)
        setSelectedEntryId('')
        setDetailView('notes')
        setNewTitle('')
        setCreating(false)
        notifySuccess(t('notifications.noteCreated'))
      } catch (createError) {
        notifyError(createError)
      } finally {
        endBusy(operation)
      }
    },
    [
      applyDetail,
      beginBusy,
      discardComposerDraft,
      discardEditingDraft,
      endBusy,
      notifyError,
      notifySuccess,
      t
    ]
  )

  const focusSwitchTarget = useCallback(
    (target: DraftSwitchTarget): void => {
      requestAnimationFrame(() => {
        if (target.kind === 'edit-entry' && target.entry.content.version === 2) {
          document.getElementById(`magic-note-entry-${target.entry.id}`)?.scrollIntoView({ block: 'start' })
          editingCanvasRef.current?.focus()
          return
        }
        const focusTarget =
          target.kind === 'overview'
            ? (document.getElementById('magic-todo-back')?.checkVisibility?.() &&
                document.getElementById('magic-todo-back')) || document.getElementById(overviewFocusRef.current) ||
              document.getElementById('magic-note-new')
            : target.kind === 'library-view'
              ? document.getElementById('magic-library-switch')
               : target.kind === 'note'
                ? document.getElementById('magic-notes-back')
                : target.kind === 'edit-entry'
                  ? document
                      .getElementById(
                        `magic-note-entry-${target.entry.id}`
                      )
                      ?.querySelector<HTMLElement>(
                        '.ql-editor, [data-testid="magic-note-editor"]'
                      )
                  : composerRef.current?.querySelector<HTMLElement>(
                      '.ql-editor, [data-testid="magic-note-editor"]'
                    )
        focusTarget?.focus({ preventScroll: true })
      })
    },
    []
  )

  const performDraftSwitch = useCallback(
    (target: DraftSwitchTarget): void => {
      setPendingDraftSwitch(undefined)
      setValidation(undefined)
      if (target.kind === 'leave') {
        discardComposerDraft()
        discardEditingDraft()
        setTitleDraft(detail?.title ?? '')
        target.leave()
        return
      }
      if (target.kind === 'select-entry') {
        setSelectedEntryId(target.entry.id)
        setNarrowIndexOpen(false)
        const article = document.getElementById(`magic-note-entry-${target.entry.id}`)
        article?.scrollIntoView({ block: 'start' })
        if (narrowIndexOpen) article?.focus({ preventScroll: true })
        return
      }
      if (target.kind === 'entry-type') {
        discardComposerDraft()
        setEntryType(target.value)
        return
      }
      if (target.kind === 'cancel-edit') {
        discardEditingDraft()
        setSelectedEntryId((current) => detail?.entries.some((entry) => entry.id === current) ? current : detail?.entries.at(-1)?.id ?? '')
        return
      }
      if (target.kind === 'overview') {
        discardComposerDraft()
        discardEditingDraft()
        detailRequestRef.current += 1
        requestedNoteIdRef.current = ''
        setSelectedNoteId('')
        setDetail(undefined)
        setTitleDraft('')
        setDetailLoadError(undefined)
        setRefreshError('')
        setDeletingEntryId('')
        setDetailView(undefined)
        focusSwitchTarget(target)
        return
      }
      if (target.kind === 'library-view') {
        if (target.value === 'todos') {
          discardComposerDraft()
          discardEditingDraft()
        }
        setLibraryView(target.value)
        setCreating(false)
        setSearch('')
        focusSwitchTarget(target)
        return
      }
      if (target.kind === 'edit-entry') {
        discardComposerDraft()
        setSelectedEntryId(target.entry.id)
        discardEditingDraft()
        setDeletingEntryId('')
        setEditingEntry(target.entry)
        editingBaselineRef.current = target.entry.content
        editingContentRef.current = target.entry.content
        focusSwitchTarget(target)
        return
      }
      if (target.kind === 'create-note') {
        overviewFocusRef.current = 'magic-note-new'
        void createNote(target.title, true)
          .then(() => focusSwitchTarget(target))
        return
      }
      setDeletingNote(false)
      if (!detailView && libraryView === 'notes') overviewFocusRef.current = `magic-note-select-${target.noteId}`
      setDetailView('notes')
      focusSwitchTarget(target)
      void loadDetail(target.noteId, target.entryId).then(() => {
        if (!target.entryId || requestedNoteIdRef.current !== target.noteId) {
          return
        }
        requestAnimationFrame(() =>
          document
            .getElementById(`magic-note-entry-${target.entryId}`)
            ?.scrollIntoView({ block: 'center' })
        )
      })
    },
    [
      createNote,
      detail,
      detailView,
      discardComposerDraft,
      discardEditingDraft,
      focusSwitchTarget,
      loadDetail,
      libraryView,
      narrowIndexOpen
    ]
  )

  const requestDraftSwitch = useCallback(
    async (target: DraftSwitchTarget): Promise<void> => {
      if (pendingDraftSwitch) {
        return
      }
      if (target.kind === 'select-entry') {
        performDraftSwitch(target)
        return
      }
      if (busyRef.current) {
        notifyInfo(tRef.current('notifications.waitForOperation'))
        return
      }
      if (composerCanvasRef.current || editingCanvasRef.current) {
        if (!beginBusy('flush-switch')) return
        try {
          if (composerCanvasRef.current) composerContentRef.current = await composerCanvasRef.current.flush()
          if (editingCanvasRef.current) editingContentRef.current = await editingCanvasRef.current.flush()
        } catch (error) {
          notifyError(error)
          return
        } finally {
          endBusy('flush-switch')
        }
      }
      const changesContext =
        target.kind === 'library-view'
          ? target.value !== libraryView
          : target.kind === 'note'
            ? !detailView || target.noteId !== selectedNoteId ||
              target.entryId !== undefined
             : target.kind === 'edit-entry'
                ? target.entry.id !== editingEntry?.id
                : true
      if (!changesContext) {
        return
      }
      const wouldClearComposer = target.kind !== 'cancel-edit'
      const current = refreshContextRef.current
      if (
        (wouldClearComposer && hasContent(composerContentRef.current)) ||
        (target.kind !== 'entry-type' && hasDirtyEditingDraft()) ||
        ((target.kind === 'overview' || target.kind === 'leave') && current.detail && current.titleDraft !== current.detail.title)
      ) {
        setPendingDraftSwitch(target)
        return
      }
      performDraftSwitch(target)
    },
    [
      editingEntry?.id,
      detailView,
      notifyInfo,
      hasDirtyEditingDraft,
      libraryView,
      pendingDraftSwitch,
      performDraftSwitch,
       selectedNoteId, beginBusy, endBusy, notifyError
    ]
  )

  useLayoutEffect(() => {
    onBeforeLeave?.((leave) => { void requestDraftSwitch({ kind: 'leave', leave }) })
    return () => onBeforeLeave?.(undefined)
  }, [onBeforeLeave, requestDraftSwitch])

  const continueEditing = useCallback((): void => {
    setPendingDraftSwitch(undefined)
    requestAnimationFrame(() => {
      const canvas = editingEntry?.content.version === 2 ? editingCanvasRef.current : composerCanvasRef.current
      if (canvas) { canvas.focus(); return }
      const editor = editingEntry
        ? document
            .getElementById(`magic-note-entry-${editingEntry.id}`)
            ?.querySelector<HTMLElement>(
              '.ql-editor, [data-testid="magic-note-editor"]'
            )
        : composerRef.current?.querySelector<HTMLElement>(
            '.ql-editor, [data-testid="magic-note-editor"]'
          )
      editor?.focus()
    })
  }, [editingEntry])

  useEffect(() => {
    if (!pendingDraftSwitch) {
      return
    }
    return activateModalFocus(() => continueEditingRef.current)
  }, [pendingDraftSwitch])

  const refreshNotes = useCallback(
    async (preferredId?: string, background = false): Promise<void> => {
      const requestId = ++refreshRequestRef.current
      const detailRequestAtStart = detailRequestRef.current
      await Promise.resolve()
      if (refreshRequestRef.current !== requestId) {
        return
      }
      const isInitialLoad = !hasLoadedRef.current
      if (isInitialLoad) {
        setLoadStatus('loading')
        setLoadError('')
      }
      setRefreshError('')
      try {
        const [snapshot, todoSnapshot] = await Promise.all([
          window.goodbuddy.magicNotes.list(),
          window.goodbuddy.magicNotes.listTodos()
        ])
        const nextId =
          preferredId && snapshot.notes.some((note) => note.id === preferredId)
            ? preferredId
            : ''
        const nextDetail = nextId
          ? await window.goodbuddy.magicNotes.get(nextId)
          : undefined
        if (background && editingCanvasRef.current) {
          const editor = editingCanvasRef.current
          const content = await editor.flush()
          if (editingCanvasRef.current === editor) editingContentRef.current = content
        }
        if (refreshRequestRef.current !== requestId) {
          return
        }
        const preserveNewerSelection =
          detailRequestRef.current !== detailRequestAtStart
        setNotes(snapshot.notes)
        setTodos(todoSnapshot.todos)
        setSelectedTodoId((current) =>
          todoSnapshot.todos.some((todo) => todo.id === current)
            ? current
            : ''
        )
        hasLoadedRef.current = true
        setLoadStatus('ready')
        if (preserveNewerSelection) {
          return
        }
        const current = refreshContextRef.current
        const editingDirty = current.editingEntry && !richContentEqual(editingContentRef.current, editingBaselineRef.current ?? current.editingEntry.content)
        const titleDirty = current.detail &&
          current.titleDraft !== current.detail.title
        if (background && current.detail?.id !== nextId) {
          if (
            titleDirty ||
            hasContent(composerContentRef.current) ||
             editingDirty
          ) {
            setRefreshError(tRef.current('errors.noteDeletedExternally'))
            return
          }
          discardComposerDraft()
          discardEditingDraft()
        }
        detailRequestRef.current += 1
        requestedNoteIdRef.current = nextId
        setSelectedNoteId(nextId)
        setDetail(nextDetail)
        if (!editingDirty) {
          setSelectedEntryId((selected) => nextDetail?.entries.some((entry) => entry.id === selected) ? selected : nextDetail?.entries.at(-1)?.id ?? '')
        }
        if (background && current.editingEntry && !editingDirty) {
          const refreshed = nextDetail?.entries.find((entry) => entry.id === current.editingEntry?.id)
          // An unchanged revision keeps the mounted editor's normalized baseline.
          if (refreshed?.revision !== current.editingEntry.revision) {
            setEditingEntry(refreshed)
            editingBaselineRef.current = refreshed?.content
            editingContentRef.current = refreshed?.content
          }
        }
        if (preferredId && !nextId) setDetailView(undefined)
        if (!background || !titleDirty) {
          setTitleDraft(nextDetail?.title ?? '')
        }
        if (
          background && editingDirty && current.editingEntry && nextDetail &&
          !nextDetail.entries.some((entry) => entry.id === current.editingEntry?.id)
        ) {
          setRefreshError(tRef.current('errors.entryDeletedExternally'))
        }
        setDetailLoadError(undefined)
      } catch (loadError) {
        if (refreshRequestRef.current === requestId) {
          const message = errorMessage(
            loadError,
            tRef.current('errors.operationFailed')
          )
          if (hasLoadedRef.current) {
            setRefreshError(message)
          } else {
            setLoadError(message)
            setLoadStatus('error')
          }
        }
      }
    },
    [discardComposerDraft, discardEditingDraft]
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void refreshNotes()
    }, 0)
    return () => {
      window.clearTimeout(timeout)
      refreshRequestRef.current += 1
      detailRequestRef.current += 1
    }
  }, [refreshNotes])

  useEffect(() => {
    let timeout: number | undefined
    const refresh = (): void => {
      if (busyRef.current) {
        timeout = window.setTimeout(refresh, 100)
        return
      }
      timeout = undefined
      void refreshNotes(requestedNoteIdRef.current, true)
    }
    const unsubscribe = window.goodbuddy.magicNotes.onChanged(() => {
      refreshRequestRef.current += 1
      window.clearTimeout(timeout)
      timeout = window.setTimeout(refresh, 100)
    })
    return () => {
      unsubscribe()
      window.clearTimeout(timeout)
      refreshRequestRef.current += 1
    }
  }, [refreshNotes])

  const visibleNotes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return query
      ? notes.filter(
          (note) =>
            note.title.toLocaleLowerCase().includes(query) ||
            note.preview.toLocaleLowerCase().includes(query)
        )
      : notes
  }, [notes, search])

  const actionNote = useMemo(
    () => !detailView && libraryView === 'notes' && !pendingDraftSwitch
      ? visibleNotes.find((note) => note.id === noteActionsId)
      : undefined,
    [libraryView, detailView, noteActionsId, pendingDraftSwitch, visibleNotes]
  )
  if (noteActionsId && !actionNote) {
    setNoteActionsId('')
    setDeletingNote(false)
  }

  const closeNoteActions = (): void => {
    setNoteActionsId('')
    setDeletingNote(false)
    noteActionTriggerRef.current?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    const surface = noteActionsRef.current
    const trigger = noteActionTriggerRef.current
    if (!noteActionsId || !surface || !trigger) return
    const position = (): void => {
      const anchor = trigger.getBoundingClientRect()
      const bounds = surface.getBoundingClientRect()
      surface.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))}px`
      surface.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - bounds.height - 8))}px`
    }
    position()
    surface.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    const dismiss = (event: Event): void => {
      if (event.target instanceof Node && !surface.contains(event.target) && !trigger.contains(event.target)) {
        setNoteActionsId('')
        setDeletingNote(false)
      }
    }
    const observer = new ResizeObserver(position)
    observer.observe(surface)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', dismiss)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [noteActionsId])

  const pinNote = async (note: MagicNoteSummary): Promise<void> => {
    const operation = 'pin-note'
    if (!beginBusy(operation)) return
    closeNoteActions()
    try {
      const updated = await window.goodbuddy.magicNotes.update({
        noteId: note.id,
        pinned: !note.pinned,
        expectedRevision: note.revision
      })
      applyNoteSummary(updated)
      setDetail((current) => current?.id === updated.id ? updated : current)
    } catch (error) {
      notifyError(error)
    } finally {
      endBusy(operation)
    }
  }

  const deleteNote = async (note: MagicNoteSummary): Promise<void> => {
    const operation = 'delete-note'
    if (!beginBusy(operation)) return
    try {
      await window.goodbuddy.magicNotes.remove(note.id)
      notifySuccess(t('notifications.noteDeleted'))
      closeNoteActions()
      await refreshNotes()
      requestAnimationFrame(() => document.getElementById('magic-note-new')?.focus({ preventScroll: true }))
    } catch (error) {
      notifyError(error)
    } finally {
      endBusy(operation)
    }
  }

  const visibleTodos = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase()
    return todos.filter((todo) => {
      const matchesStatus =
        todoFilter === 'all' ||
        (todoFilter === 'completed' ? todo.completed : !todo.completed)
      return (
        matchesStatus &&
        (!normalized ||
          `${todo.title} ${todo.instructions} ${todo.noteTitle ?? ''}`
            .toLocaleLowerCase()
            .includes(normalized))
      )
    })
  }, [search, todoFilter, todos])

  const todoDirectories = useMemo(() => {
    const directories = new Map<
      string,
      { noteId: string; noteTitle: string; todos: MagicTodoItem[] }
    >()
    for (const todo of visibleTodos) {
      const directory = directories.get(todo.noteId) ?? {
        noteId: todo.noteId,
        noteTitle: todo.noteTitle,
        todos: []
      }
      directory.todos.push(todo)
      directories.set(todo.noteId, directory)
    }
    return [...directories.values()].sort((left, right) =>
      left.noteTitle.localeCompare(
        right.noteTitle,
        currentLocale
      )
    )
  }, [currentLocale, visibleTodos])

  const selectedTodo = useMemo(
    () => visibleTodos.find((todo) => todo.id === selectedTodoId),
    [selectedTodoId, visibleTodos]
  )
  const selectedTodoNoteId = selectedTodo?.noteId
  const selectedTodoEntryId = selectedTodo?.entryId

  useEffect(() => {
    if (detailView || libraryView !== 'todos' || !selectedTodoNoteId) {
      return
    }
    const requestId = ++todoSourceRequestRef.current
    void Promise.resolve().then(() => {
      if (todoSourceRequestRef.current !== requestId) return undefined
      setTodoSourceStatus('loading')
      return window.goodbuddy.magicNotes.get(selectedTodoNoteId)
    })
      .then((sourceDetail) => {
        if (todoSourceRequestRef.current === requestId) {
          setTodoSourceDetail(sourceDetail)
          setTodoSourceStatus('ready')
        }
      })
      .catch((sourceError: unknown) => {
        if (todoSourceRequestRef.current === requestId) {
          setTodoSourceDetail(undefined)
          setTodoSourceStatus('error')
          notifyError(sourceError)
        }
      })
    return () => {
      todoSourceRequestRef.current += 1
    }
  }, [detailView, libraryView, notifyError, selectedTodoNoteId, todos, todoSourceRetry])

  const selectedTodoSourceEntry = useMemo(
    () =>
      todoSourceDetail && todoSourceDetail.id === selectedTodoNoteId
        ? todoSourceDetail.entries.find(
            (entry) => entry.id === selectedTodoEntryId
          )
        : undefined,
    [selectedTodoEntryId, selectedTodoNoteId, todoSourceDetail]
  )
  const reloadTodos = useCallback(async (): Promise<void> => {
    const snapshot = await window.goodbuddy.magicNotes.listTodos()
    setTodos(snapshot.todos)
    setSelectedTodoId((current) =>
      snapshot.todos.some((todo) => todo.id === current)
        ? current
        : ''
    )
  }, [])

  const aiEntries = useMemo(
    () =>
      [...(detail?.entries ?? [])]
        .filter((entry) => entry.comments.length > 0)
        .reverse(),
    [detail]
  )
  const displayedEntries = useMemo(() => {
    const entries = detail?.entries ?? []
    // Keep an externally deleted entry mounted until its draft is resolved.
    return (editingEntry && !entries.some((entry) => entry.id === editingEntry.id)
      ? [...entries, editingEntry] : [...entries]).reverse()
  }, [detail, editingEntry])
  const isNarrowLayout = magicNotesLayoutWidth <= 800
  const indexExpanded = isNarrowLayout ? narrowIndexOpen : indexPaneOpen
  // Clamp displayed widths without replacing the user's saved desktop preferences.
  const layoutInnerWidth = Math.max(0, magicNotesLayoutWidth - 2)
  const displayedIndexWidth = clampMagicNotesPaneWidth(indexPaneWidth, {
    minimum: minimumIndexPaneWidth,
    maximum: Math.max(minimumIndexPaneWidth, Math.min(maximumIndexPaneWidth,
      layoutInnerWidth - minimumMagicNotesEditorWidth - magicNotesResizeHandleWidth -
      (aiPaneOpen ? minimumAiPaneWidth + magicNotesResizeHandleWidth : 0)))
  })
  const aiPaneWidthLimits = getAiPaneWidthLimits(
    layoutInnerWidth, indexPaneOpen ? displayedIndexWidth + magicNotesResizeHandleWidth : 0
  )
  const displayedAiWidth = clampMagicNotesPaneWidth(aiPaneWidth, aiPaneWidthLimits)
  const indexPaneWidthLimits = {
    minimum: minimumIndexPaneWidth,
    maximum: Math.max(minimumIndexPaneWidth, Math.min(maximumIndexPaneWidth,
      layoutInnerWidth - minimumMagicNotesEditorWidth - magicNotesResizeHandleWidth -
      (aiPaneOpen ? displayedAiWidth + magicNotesResizeHandleWidth : 0)))
  }
  const finishPaneResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const resize = paneResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    paneResizeRef.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (resize.pane === 'ai') setAiPaneWidth(resize.width)
    else setIndexPaneWidth(resize.width)
    setResizingPane(undefined)
  }
  const updatePanePointerWidth = (event: React.PointerEvent<HTMLDivElement>): void => {
    const resize = paneResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const isAi = resize.pane === 'ai'
    const limits = isAi ? aiPaneWidthLimits : indexPaneWidthLimits
    if (isNarrowLayout) { finishPaneResize(event); return }
    const bounds = getLayoutBounds()
    resize.width = clampMagicNotesPaneWidth(isAi ? bounds.right - 1 - event.clientX : event.clientX - bounds.left - 1, limits)
    magicNotesLayoutRef.current?.style.setProperty(`--magic-notes-${resize.pane}-width`, `${resize.width}px`)
    event.currentTarget.setAttribute('aria-valuenow', String(resize.width))
    event.currentTarget.setAttribute('aria-valuetext', t(isAi ? 'accessibility.aiPaneWidth' : 'accessibility.indexPaneWidth', { width: resize.width }))
  }
  const startPaneResize = (pane: 'ai' | 'index', event: React.PointerEvent<HTMLDivElement>): void => {
    const limits = pane === 'ai' ? aiPaneWidthLimits : indexPaneWidthLimits
    if (event.button !== 0 || isNarrowLayout || limits.maximum <= limits.minimum) return
    event.preventDefault()
    paneResizeRef.current = { pane, pointerId: event.pointerId, width: pane === 'ai' ? displayedAiWidth : displayedIndexWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizingPane(pane)
  }
  const renderPaneSeparator = (pane: 'ai' | 'index'): React.JSX.Element => {
    const isAi = pane === 'ai'
    const limits = isAi ? aiPaneWidthLimits : indexPaneWidthLimits
    const width = isAi ? displayedAiWidth : displayedIndexWidth
    const enabled = !isNarrowLayout && limits.maximum > limits.minimum
    const setWidth = isAi ? setAiPaneWidth : setIndexPaneWidth
    return <div
      aria-controls={isAi ? 'magic-notes-ai-pane' : 'magic-notes-index'}
      aria-disabled={!enabled}
      aria-label={t(isAi ? 'accessibility.resizeAiPane' : 'accessibility.resizeIndexPane')}
      aria-orientation="vertical"
      aria-valuemax={limits.maximum}
      aria-valuemin={limits.minimum}
      aria-valuenow={width}
      aria-valuetext={t(isAi ? 'accessibility.aiPaneWidth' : 'accessibility.indexPaneWidth', { width })}
      className={`magic-notes-pane-resize-handle magic-notes-${pane}-resize-handle`}
      onKeyDown={(event) => {
        if (!enabled) return
        const direction = isAi ? -1 : 1
        const next = event.key === 'Home' ? limits.minimum : event.key === 'End' ? limits.maximum
          : event.key === 'ArrowRight' ? width + direction * magicNotesPaneKeyboardResizeStep
          : event.key === 'ArrowLeft' ? width - direction * magicNotesPaneKeyboardResizeStep : undefined
        if (next === undefined) return
        event.preventDefault()
        setWidth(clampMagicNotesPaneWidth(next, limits))
      }}
      onLostPointerCapture={finishPaneResize}
      onPointerCancel={finishPaneResize}
      onPointerDown={(event) => startPaneResize(pane, event)}
      onPointerMove={updatePanePointerWidth}
      onPointerUp={finishPaneResize}
      role="separator"
      tabIndex={enabled ? 0 : -1}
    />
  }

  const submitCreateNote = async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title) {
      setValidation({
        target: 'create-note',
        message: t('validation.createNoteTitle')
      })
      return
    }
    clearValidation('create-note')
    requestDraftSwitch({
      kind: 'create-note',
      title
    })
  }

  const analyzeTodo = async (todoId: string): Promise<void> => {
    const operation = `analyze-todo-${todoId}`
    if (!beginBusy(operation)) {
      return
    }
    let options: MagicTodoAnalysisOptions | undefined
    try {
      const source = selectedTodoSourceEntry
      options = {
        ...await createAnalysisOptions(source?.content.version === 2 ? todoCanvasRef.current : undefined),
        sourceEntryRevision: source?.revision
      }
      setLiveAnalysis({ ...options, content: '' })
      applyTodo(
        await window.goodbuddy.magicNotes.analyzeTodo(todoId, options)
      )
      notifySuccess(t('notifications.aiCommentAdded'))
    } catch (analysisError) {
      notifyError(analysisError)
    } finally {
      setLiveAnalysis((current) =>
        current?.requestId === options?.requestId ? undefined : current
      )
      endBusy(operation)
    }
  }

  const updateTodoCompletion = async (
    todo: MagicTodoItem
  ): Promise<void> => {
    const operation = `update-todo-${todo.id}`
    if (!beginBusy(operation)) {
      return
    }
    try {
      const completed = !todo.completed
      const result = await window.goodbuddy.magicNotes.updateTodo({
        todoId: todo.id,
        completed,
        expectedRevision: todo.revision
      })
      applyTodo(result.todo)
      if (todoFilter !== 'all') {
        requestAnimationFrame(() => {
          if (document.activeElement === document.body) {
            document.querySelector<HTMLElement>('#magic-library-panel-todos .magic-todo-list-item__check, #magic-library-panel-todos .segmented-control__option--active')?.focus()
          }
        })
      }
      if (selectedTodoId === todo.id) {
        todoSourceRequestRef.current += 1
        setTodoSourceDetail(result.note)
      }
      if (requestedNoteIdRef.current === result.note.id) {
        applyDetail(result.note)
      } else {
        applyNoteSummary(result.note)
      }
      notifySuccess(
        t(
          completed
            ? 'notifications.todoCompleted'
            : 'notifications.todoReopened'
        )
      )
    } catch (updateError) {
      notifyError(updateError)
    } finally {
      endBusy(operation)
    }
  }

  const updateTitle = async (): Promise<void> => {
    if (!detail || titleDraft.trim() === detail.title) {
      return
    }
    if (!titleDraft.trim()) {
      setTitleDraft(detail.title)
      setValidation({
        target: 'note-title',
        message: t('validation.noteTitleRequired')
      })
      return
    }
    clearValidation('note-title')
    const operation = 'update-title'
    if (!beginBusy(operation)) {
      return
    }
    try {
      const updated = await window.goodbuddy.magicNotes.update({
        noteId: detail.id,
        title: titleDraft.trim(),
        expectedRevision: detail.revision
      })
      applyDetail(updated, titleDraft)
      await reloadTodos()
    } catch (updateError) {
      notifyError(updateError)
    } finally {
      endBusy(operation)
    }
  }

  const saveEntry = async (): Promise<void> => {
    if (!detail) return
    const operation = 'create-entry'
    if (!beginBusy(operation)) {
      return
    }
    try {
      const composerContent = entryType === 'canvas'
        ? await composerCanvasRef.current?.flush()
        : composerContentRef.current
      composerContentRef.current = composerContent
      if (!composerContent || !hasContent(composerContent)) {
        setValidation({ target: 'new-entry', message: t('validation.newEntryRequired') })
        return
      }
      clearValidation('new-entry')
      const shouldAnalyze = commentMode === 'after-save-auto' && (composerContent.version === 1 ||
        composerContent.pages.some((page) => page.objects.length || page.background.type === 'pdf') ||
        composerContent.flow?.ops.some((op) => typeof op.insert === 'string' && op.insert.trim()))
      let options: MagicNoteAnalysisOptions | undefined
      let analysisPreparationError: string | undefined
      if (shouldAnalyze) {
        try {
          options = await createAnalysisOptions(composerContent.version === 2 ? composerCanvasRef.current : undefined)
        } catch (error) {
          analysisPreparationError = errorMessage(error, t('errors.operationFailed'))
        }
      }
      const updated = await window.goodbuddy.magicNotes.createEntry({
        noteId: detail.id,
        content: composerContent
      })
      applyDetail(updated)
      const createdEntry = updated.entries.find(
        (entry) => entry.id === updated.createdEntryId
      )
      if (createdEntry) {
        setSelectedEntryId(createdEntry.id)
      }
      composerContentRef.current = undefined
      setPendingDraftSwitch(undefined)
      clearDraftAnalysis()
      setComposerKey((current) => current + 1)
      notifySuccess(t('notifications.entrySaved'))
      if (analysisPreparationError !== undefined) notifyError(t('canvas.savedAnalysisFailed', { error: analysisPreparationError }))
      try {
        await reloadTodos()
      } catch (refreshTodosError) {
        notifyError(refreshTodosError)
      }
      if (options && createdEntry) {
        setLiveAnalysis({
          requestId: options.requestId,
          content: '',
          direction: options.direction,
          format: options.format
        })
        try {
          const analyzed = await window.goodbuddy.magicNotes.analyze(createdEntry.id, {
            ...options, expectedRevision: createdEntry.revision
          })
          applyDetail(analyzed)
          notifySuccess(t('notifications.aiCommentAdded'))
        } catch (analysisError) {
          notifyError(analysisError)
        } finally {
          setLiveAnalysis((current) =>
            current?.requestId === options.requestId
              ? undefined
              : current
          )
        }
      }
    } catch (saveError) {
      notifyError(saveError)
    } finally {
      endBusy(operation)
    }
  }

  const saveEditedEntry = async (): Promise<void> => {
    if (!editingEntry) return
    const operation = `edit-${editingEntry.id}`
    if (!beginBusy(operation)) {
      return
    }
    try {
      const editingContent = editingEntry.content.version === 2
        ? await editingCanvasRef.current?.flush() : editingContentRef.current
      editingContentRef.current = editingContent
      if (!editingContent || !hasContent(editingContent)) {
        setValidation({ target: 'edit-entry', message: t('validation.entryRequired') })
        return
      }
      clearValidation('edit-entry')
      const currentEntry = detail?.entries.find((entry) => entry.id === editingEntry.id) ?? editingEntry
      const shouldAnalyze = commentMode === 'after-save-auto' &&
        (editingContent.version === 1 || currentEntry.content.version === 1 ||
          (currentEntry.comments.some((comment) => comment.inputMode === 'canvas-images')
            ? !richContentEqual(editingContent, currentEntry.content)
            : currentEntry.comments.length > 0
              ? magicNoteCanvasAnalysisText(editingContent) !== magicNoteCanvasAnalysisText(currentEntry.content)
              : analysisContentKey(editingContent) !== analysisContentKey(currentEntry.content)))
      let options: MagicNoteAnalysisOptions | undefined
      let analysisPreparationError: string | undefined
      if (shouldAnalyze) {
        try {
          options = await createAnalysisOptions(editingContent.version === 2 ? editingCanvasRef.current : undefined)
        } catch (error) {
          analysisPreparationError = errorMessage(error, t('errors.operationFailed'))
        }
      }
      const updated = await window.goodbuddy.magicNotes.updateEntry({
        entryId: editingEntry.id,
        content: editingContent,
        expectedRevision: editingEntry.revision
      })
      applyDetail(updated)
      const savedEntry = updated.entries.find((entry) => entry.id === editingEntry.id)
      setEditingEntry(savedEntry)
      editingBaselineRef.current = savedEntry?.content
      editingContentRef.current = savedEntry?.content
      clearDraftAnalysis()
      notifySuccess(t('notifications.entryUpdated'))
      if (analysisPreparationError !== undefined) notifyError(t('canvas.savedAnalysisFailed', { error: analysisPreparationError }))
      try {
        await reloadTodos()
      } catch (refreshTodosError) {
        notifyError(refreshTodosError)
      }
      if (options && savedEntry) {
        setLiveAnalysis({
          requestId: options.requestId,
          content: '',
          direction: options.direction,
          format: options.format
        })
        try {
          const analyzed = await window.goodbuddy.magicNotes.analyze(savedEntry.id, {
            ...options, expectedRevision: savedEntry.revision
          })
          applyDetail(analyzed)
          const analyzedEntry = analyzed.entries.find((entry) => entry.id === editingEntry.id)
          setEditingEntry(analyzedEntry)
          notifySuccess(t('notifications.aiCommentAdded'))
        } catch (analysisError) {
          notifyError(analysisError)
        } finally {
          setLiveAnalysis((current) =>
            current?.requestId === options.requestId
              ? undefined
              : current
          )
        }
      }
    } catch (updateError) {
      notifyError(updateError)
    } finally {
      endBusy(operation)
    }
  }

  const analyzeEntry = async (entryId: string): Promise<void> => {
    const operation = `analyze-${entryId}`
    if (!beginBusy(operation)) {
      return
    }
    let options: MagicNoteEntryAnalysisOptions | undefined
    try {
      const entry = detail?.entries.find((entry) => entry.id === entryId)
      options = {
        ...await createAnalysisOptions(entry?.content.version === 2 ? canvasViewRefs.current.get(entryId) ?? null : undefined),
        expectedRevision: entry?.revision
      }
      setLiveAnalysis({ ...options, content: '' })
      applyDetail(
        await window.goodbuddy.magicNotes.analyze(entryId, options)
      )
      notifySuccess(t('notifications.aiCommentAdded'))
    } catch (analysisError) {
      notifyError(analysisError)
    } finally {
      setLiveAnalysis((current) =>
        current?.requestId === options?.requestId ? undefined : current
      )
      endBusy(operation)
    }
  }

  const analyzeCanvasDraft = async (editing: boolean): Promise<void> => {
    const editor = editing ? editingCanvasRef.current : composerCanvasRef.current
    if (!editor || !beginBusy('analyze-canvas-draft')) return
    let options: MagicNoteAnalysisOptions | undefined
    try {
      const content = await editor.flush()
      if (editing) editingContentRef.current = content
      else composerContentRef.current = content
      if (!hasContent(content)) {
        setValidation({ target: editing ? 'edit-entry' : 'new-entry', message: t('validation.newEntryRequired') })
        return
      }
      clearCanvasDraftAnalysis()
      const analysisContext = canvasDraftContextRef.current
      options = await createAnalysisOptions(editor)
      setLiveAnalysis({ ...options, content: '' })
      const analysis = await window.goodbuddy.magicNotes.analyzeDraft(content, options)
      if (analysisContext === canvasDraftContextRef.current) setCanvasDraftAnalysis(analysis)
    } catch (error) {
      notifyError(error)
    } finally {
      setLiveAnalysis((current) => current?.requestId === options?.requestId ? undefined : current)
      endBusy('analyze-canvas-draft')
    }
  }

  return (
    <div className="magic-notes-page">
      <PageHeader
        actions={
          <>
            {detailView && (
            <button
              id="magic-notes-back"
              className="secondary-button"
              onClick={() => requestDraftSwitch({ kind: 'overview' })}
              disabled={Boolean(busy)}
              type="button"
            >
              <ArrowLeft aria-hidden="true" size={15} />
               {t(libraryView === 'todos' ? 'actions.backToTodos' : 'actions.backToOverview')}
            </button>
            )}
            {detailView && (
            <button
              aria-controls="magic-notes-ai-pane"
              aria-expanded={aiPaneOpen}
              aria-label={t(aiPaneOpen ? 'actions.hideAiComments' : 'actions.showAiComments')}
              className={`icon-button${aiPaneOpen ? ' icon-button--active' : ''}`}
              onClick={() => setAiPaneOpen((current) => !current)}
              title={t(aiPaneOpen ? 'actions.hideAiComments' : 'actions.showAiComments')}
              type="button"
            >
              {aiPaneOpen ? (
                <PanelRightClose aria-hidden="true" size={15} />
              ) : (
                <PanelRightOpen aria-hidden="true" size={15} />
              )}
            </button>
            )}
            {!detailView && (
              <>
              <button
                id="magic-library-switch"
                className="secondary-button"
                disabled={Boolean(busy)}
                onClick={() => requestDraftSwitch({ kind: 'library-view', value: libraryView === 'notes' ? 'todos' : 'notes' })}
                type="button"
              >
                {libraryView === 'notes' ? <ListTodo aria-hidden="true" size={15} /> : <BookOpen aria-hidden="true" size={15} />}
                {t(libraryView === 'notes' ? 'actions.switchToTodos' : 'actions.switchToNotes')}
              </button>
              <button
                id="magic-note-new"
                className="primary-button"
                disabled={Boolean(busy)}
                type="button"
                onClick={() => {
                  setValidation(undefined)
                  setLibraryView('notes')
                  setCreating(true)
                }}
              >
                <Plus aria-hidden="true" size={15} />
                {t('actions.newNote')}
              </button>
              </>
            )}
          </>
        }
        description={detailView ? undefined : t('page.description')}
        headingId="magic-notes-title"
        icon={<Sparkles size={20} />}
        scope={{ kind: 'global' }}
        title={detailView && detail ? detail.title : t('page.title')}
      />

      {loadStatus === 'error' ? (
        <EmptyState
          action={
            <button
              className="secondary-button"
              onClick={() => void refreshNotes()}
              type="button"
            >
              {t('actions.retry')}
            </button>
          }
          description={t('errors.initialLoadDescription', {
            error: loadError
          })}
          icon={<CircleAlert size={24} />}
          level="page"
          title={t('errors.initialLoadTitle')}
        />
      ) : (
        <>
          {refreshError && (
            <div className="magic-note-delete-confirmation" role="alert">
              <span>
                {t('errors.refreshFailed', { error: refreshError })}
              </span>
              <button
                className="secondary-button"
                onClick={() => void refreshNotes(selectedNoteId, true)}
                type="button"
              >
                {t('actions.retry')}
              </button>
            </div>
          )}
      <div
        ref={magicNotesLayoutRef}
        aria-busy={Boolean(busy)}
        className={`magic-notes-layout${
          detailView ? ' magic-notes-layout--detail' : ' magic-notes-layout--overview'
        }${
          aiPaneOpen ? '' : ' magic-notes-layout--ai-hidden'
        }${
          indexExpanded ? '' : ' magic-notes-layout--index-hidden'
        }${
          (resizingPane && !isNarrowLayout)
            ? ' magic-notes-layout--resizing'
            : ''
        }${
          resizingPane && !isNarrowLayout
            ? ` magic-notes-layout--${resizingPane}-resizing`
            : ''
        }`}
        style={
          {
            '--magic-notes-ai-width': `${displayedAiWidth}px`,
            '--magic-notes-index-width': `${displayedIndexWidth}px`
          } as React.CSSProperties
        }
      >
        <section
          aria-label={t(
            libraryView === 'notes'
              ? 'notes.listLabel'
              : 'todos.listLabel'
          )}
           className={`magic-notes-overview${libraryView === 'todos' ? ' magic-notes-overview--todos' : ''}`}
          hidden={Boolean(detailView)}
        >
          {libraryView === 'notes' ? (
            <div
              className="magic-notes-library-panel"
              id="magic-library-panel-notes"
            >
          <div className="magic-notes-pane-heading">
            <strong>{t('notes.heading')}</strong>
            <span>{notes.length}</span>
          </div>
          <label className="magic-notes-search">
            <span className="sr-only">{t('notes.searchLabel')}</span>
            <input
              placeholder={t('notes.searchPlaceholder')}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {creating && (
            <form
              className="magic-notes-create"
              onSubmit={(event) => {
                event.preventDefault()
                void submitCreateNote()
              }}
            >
              <label>
                <span>{t('notes.titleLabel')}</span>
                <input
                  aria-describedby={
                    validation?.target === 'create-note'
                      ? 'magic-note-create-error'
                      : undefined
                  }
                  aria-invalid={validation?.target === 'create-note'}
                  autoFocus
                  maxLength={100}
                  value={newTitle}
                  onChange={(event) => {
                    setNewTitle(event.target.value)
                    clearValidation('create-note')
                  }}
                />
              </label>
              {validation?.target === 'create-note' && (
                <small
                  className="magic-notes-field-error"
                  id="magic-note-create-error"
                  role="alert"
                >
                  {validation.message}
                </small>
              )}
              <div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setCreating(false)
                    clearValidation('create-note')
                  }}
                >
                  {t('actions.cancel')}
                </button>
                <button
                  className="primary-button"
                  disabled={busy === 'create-note'}
                  type="submit"
                >
                  {t('actions.createNote')}
                </button>
              </div>
            </form>
          )}
          <div className="magic-notes-list magic-notes-card-grid">
            {loadStatus === 'loading' ? (
              <p className="magic-notes-muted">
                {t('status.loadingNotes')}
              </p>
            ) : visibleNotes.length === 0 ? (
              <>
                <p className="magic-notes-muted">
                  {search.trim()
                    ? t('notes.noMatches')
                    : t('notes.empty')}
                </p>
                {search.trim() && (
                  <button
                    className="secondary-button"
                    onClick={() => setSearch('')}
                    type="button"
                  >
                    {t('actions.clearFilters')}
                  </button>
                )}
              </>
            ) : (
              visibleNotes.map((note) => (
                <div className="magic-note-row" key={note.id}>
                <button
                  id={`magic-note-select-${note.id}`}
                  className="magic-note-list-item"
                  type="button"
                  onClick={() =>
                    requestDraftSwitch({
                      kind: 'note',
                      noteId: note.id
                    })
                  }
                >
                  <span className="magic-note-list-item__title">
                    {note.pinned && (
                      <Pin aria-label={t('status.pinned')} size={12} />
                    )}
                    {note.title}
                  </span>
                  <span className="magic-note-list-item__preview">
                    {note.preview || t('notes.noPreview')}
                  </span>
                  <span className="magic-note-list-item__meta">
                    <span>
                      {t(
                        note.entryCount === 1
                          ? 'notes.entryCountOne'
                          : 'notes.entryCountOther',
                        { count: note.entryCount }
                      )}
                    </span>
                    <time dateTime={note.updatedAt}>
                      {t('notes.updatedAt', {
                        date: dateFormatter.format(
                          new Date(note.updatedAt)
                        )
                      })}
                    </time>
                  </span>
                </button>
                <button
                  aria-controls={`magic-note-actions-${note.id}`}
                  aria-expanded={noteActionsId === note.id}
                  aria-haspopup="menu"
                  aria-label={t('actions.more', { title: note.title })}
                  title={t('actions.more', { title: note.title })}
                  className="magic-note-more icon-button"
                  type="button"
                  onClick={(event) => {
                    noteActionTriggerRef.current = event.currentTarget
                    setDeletingNote(false)
                    setNoteActionsId((current) => current === note.id ? '' : note.id)
                  }}
                >
                  <MoreHorizontal aria-hidden="true" size={14} />
                </button>
                </div>
              ))
            )}
            {actionNote && createPortal(
              <div
                className="conversation-actions magic-note-actions"
                id={`magic-note-actions-${actionNote.id}`}
                aria-label={t('actions.more', { title: actionNote.title })}
                ref={noteActionsRef}
                role="menu"
                onKeyDown={(event) => {
                  if (event.defaultPrevented) return
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    closeNoteActions()
                    return
                  }
                  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
                  const index = items.indexOf(document.activeElement as HTMLButtonElement)
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                  items[next]?.focus()
                }}
              >
                <button role="menuitem" type="button" disabled={Boolean(busy)} onClick={() => void pinNote(actionNote)}>
                  {actionNote.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                  {t(actionNote.pinned ? 'actions.unpinNote' : 'actions.pinNote')}
                </button>
                <DestructiveConfirmActions
                  triggerRole="menuitem"
                  triggerLabel={t('actions.deleteNote')}
                  confirmLabel={t('actions.deleteNote')}
                  confirming={deletingNote}
                  disabled={Boolean(busy)}
                  icon={<Trash2 size={14} />}
                  message={t('confirmations.deleteNote', { title: actionNote.title })}
                  onCancel={() => setDeletingNote(false)}
                  onRequestConfirm={() => setDeletingNote(true)}
                  onConfirm={() => void deleteNote(actionNote)}
                />
              </div>, document.body
            )}
          </div>
            </div>
          ) : (
            <div
              className="magic-notes-library-panel"
              id="magic-library-panel-todos"
            >
              <div className="magic-notes-pane-heading">
                <strong>{t('todos.heading')}</strong>
                <span>{t('todos.resultCount', { count: visibleTodos.length, total: todos.length })}</span>
              </div>
              <div className="magic-todo-toolbar">
              <label className="magic-notes-search">
                <span className="sr-only">{t('todos.searchLabel')}</span>
                <input
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('todos.searchPlaceholder')}
                  type="search"
                  value={search}
                />
              </label>
              <SegmentedControl
                ariaLabel={t('todos.filterLabel')}
                onChange={setTodoFilter}
                options={todoFilters}
                value={todoFilter}
              />
              </div>
              <div className={`magic-todo-workspace${selectedTodo ? ' magic-todo-workspace--selected' : ''}`}>
              <div className="magic-notes-list">
                {loadStatus === 'loading' ? (
                  <p className="magic-notes-muted">
                    {t('status.loadingTodos')}
                  </p>
                ) : visibleTodos.length === 0 ? (
                  <>
                    <p className="magic-notes-muted">
                      {todos.length === 0
                        ? t('todos.empty')
                        : search.trim() || todoFilter !== 'all'
                          ? t('todos.noMatches')
                          : t('todos.empty')}
                    </p>
                    {todos.length > 0 &&
                      (Boolean(search.trim()) ||
                        todoFilter !== 'all') && (
                        <button
                          className="secondary-button"
                          onClick={() => {
                            setSearch('')
                            setTodoFilter('all')
                          }}
                          type="button"
                        >
                          {t('actions.clearFilters')}
                        </button>
                      )}
                  </>
                ) : (
                  todoDirectories.map((directory) => (
                    <section
                      className="magic-todo-directory"
                      key={directory.noteId}
                    >
                      <div className="magic-todo-directory__heading">
                        <FolderTree aria-hidden="true" size={14} />
                        <strong>{directory.noteTitle}</strong>
                        <span>{directory.todos.length}</span>
                      </div>
                      <div className="magic-todo-directory__items">
                        {directory.todos.map((todo) => (
                          <div className="magic-todo-task" key={todo.id}>
                          <TodoListItem
                            disabled={Boolean(busy)}
                            expanded={selectedTodo?.id === todo.id}
                            id={`magic-todo-select-${todo.id}`}
                            onSelect={() => {
                              overviewFocusRef.current = `magic-todo-select-${todo.id}`
                              setSelectedTodoId((current) => current === todo.id ? '' : todo.id)
                              requestAnimationFrame(() => {
                                const back = document.getElementById('magic-todo-back')
                                if (back?.checkVisibility?.()) back.focus({ preventScroll: true })
                              })
                            }}
                            onToggle={() =>
                              void updateTodoCompletion(todo)
                            }
                            todo={todo}
                          />
                          </div>
                        ))}
                      </div>
                    </section>
                  ))
                )}
              </div>
                          {selectedTodo ? (
                            <section
                              aria-label={t('todos.detailLabel')}
                              className="magic-todo-detail"
                              id={`magic-todo-detail-${selectedTodo.id}`}
                              key={selectedTodo.id}
                            >
                              <button id="magic-todo-back" className="secondary-button" disabled={Boolean(busy)} type="button" onClick={() => {
                                setSelectedTodoId('')
                                requestAnimationFrame(() => document.getElementById(`magic-todo-select-${selectedTodo.id}`)?.focus({ preventScroll: true }))
                              }}>
                                <ArrowLeft aria-hidden="true" size={14} />
                                {t('actions.backToTodoList')}
                              </button>
                              <h3>{selectedTodo.title}</h3>
                              <p className="magic-todo-instructions">{selectedTodo.instructions || t('todos.defaultInstructions')}</p>
                              <button
                                className="secondary-button"
                                disabled={Boolean(busy)}
                                onClick={() => requestDraftSwitch({ kind: 'note', noteId: selectedTodo.noteId, entryId: selectedTodo.entryId })}
                                type="button"
                              >
                                <BookOpen aria-hidden="true" size={14} />
                                {t('actions.openSourceNote')}
                              </button>
                              <section aria-label={t('todos.sourceEntryLabel')} className="magic-todo-source-entry">
                                <header><strong>{t('todos.sourceEntryHeading')}</strong></header>
                                {selectedTodoSourceEntry ? (
                                  <MagicNoteContent content={selectedTodoSourceEntry.content} canvasRef={todoCanvasRef} onError={notifyError} />
                                ) : todoSourceStatus === 'error' ? (
                                  <button className="secondary-button" onClick={() => setTodoSourceRetry((current) => current + 1)} type="button">{t('todos.retrySource')}</button>
                                ) : (
                                  <p className="magic-notes-muted">{t(todoSourceStatus === 'loading' || todoSourceDetail?.id !== selectedTodo.noteId ? 'todos.loadingSource' : 'todos.sourceEntryMissing')}</p>
                                )}
                              </section>
                              <section aria-label={t('comments.paneLabel')} className="magic-todo-comments">
                                <strong>{t('comments.paneLabel')}</strong>
                                <div className="magic-notes-ai-controls">
                                  <label>
                                    <span>{t('comments.directionLabel')}</span>
                                    <select
                                      aria-label={t('comments.directionAriaLabel')}
                                      onChange={(event) => setCommentDirection(event.target.value as MagicNoteCommentDirection)}
                                      value={commentDirection}
                                    >
                                      {commentDirections.map((direction) => <option key={direction.value} value={direction.value}>{direction.label}</option>)}
                                    </select>
                                  </label>
                                  <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void analyzeTodo(selectedTodo.id)} type="button">
                                    <Bot aria-hidden="true" size={14} />
                                    {t(busy === `analyze-todo-${selectedTodo.id}` ? 'actions.analyzing' : selectedTodo.analyzedAt ? 'actions.analyzeAgain' : 'actions.analyze')}
                                  </button>
                                  <small>{t('comments.directionHelp')}</small>
                                </div>
                                {liveAnalysis && busy === `analyze-todo-${selectedTodo.id}` && (
                                  <div className="magic-notes-ai-live" aria-live="polite">
                                    <p role="status">{t(liveAnalysis.format === 'structured' ? 'status.generatingPoints' : 'status.generatingDirection', { direction: commentDirectionLabels[liveAnalysis.direction] })}</p>
                                    {liveAnalysis.format !== 'structured' && <div className="markdown-content"><MarkdownRenderer>{liveAnalysis.content || t('status.preparingComment')}</MarkdownRenderer></div>}
                                  </div>
                                )}
                                {selectedTodo.comments.map((comment) => <AiComment comment={comment} key={comment.id} />)}
                                {!liveAnalysis && selectedTodo.comments.length === 0 && <p className="magic-notes-muted">{t('comments.analyzeTodoHint')}</p>}
                              </section>
                            </section>
                          ) : (
                            <div className="magic-todo-detail magic-todo-detail--empty">
                              <EmptyState icon={<ListTodo size={24} />} title={t('todos.emptySelectionTitle')} description={t('todos.emptySelectionDescription')} />
                            </div>
                          )}
              </div>
            </div>
          )}
        </section>

        {detailView && (
        <>
        <aside className={`magic-notes-index-pane${narrowIndexOpen ? ' magic-notes-index-pane--drawer-open' : ''}`} hidden={!indexExpanded} aria-label={t('records.pane')} onKeyDown={(event) => {
          if (event.key === 'Escape') { setNarrowIndexOpen(false); document.getElementById('magic-notes-index-toggle')?.focus() }
        }}>
          <nav id="magic-notes-index" className="magic-note-records" aria-label={t('records.title')} hidden={!indexExpanded}>
            {displayedEntries.map((entry) => <button key={entry.id} type="button" className="magic-note-record" aria-current={selectedEntryId === entry.id ? 'true' : undefined} onClick={() => void requestDraftSwitch({ kind: 'select-entry', entry })}>
              {entry.content.version === 2 ? <MagicCanvasThumbnail content={entry.content} /> : <span className="magic-note-record__summary">{entry.plainText || t('notes.noPreview')}</span>}
              <span>{t(entry.content.version === 2 ? 'canvas.canvas' : 'canvas.text')}{entry.content.version === 2 && ` · ${t('records.pages', { count: entry.content.pages.length })}`}</span>
              <time dateTime={entry.createdAt}>{dateFormatter.format(new Date(entry.createdAt))}</time>
            </button>)}
          </nav>
        </aside>
        {indexExpanded && !isNarrowLayout && renderPaneSeparator('index')}
        <section
          aria-label={t('notes.streamLabel')}
          className="magic-notes-stream-pane"
        >
          {!detail ? (
            <EmptyState
              action={detailLoadError ? (
                <button
                  className="secondary-button"
                  onClick={() => void loadDetail(detailLoadError.noteId)}
                  type="button"
                >
                  {t('actions.retry')}
                </button>
              ) : undefined}
              description={detailLoadError ? detailLoadError.message : t('status.loadingNotes')}
              icon={<FileText size={24} />}
              title={
                detailLoadError ? t('errors.initialLoadTitle') : t('status.loading')
              }
            />
          ) : (
            <>
              {detailLoadError && (
                <div className="magic-note-delete-confirmation" role="alert">
                  <span>
                    {t('errors.detailLoadFailed', {
                      error: detailLoadError.message
                    })}
                  </span>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      requestDraftSwitch({
                        kind: 'note',
                        noteId: detailLoadError.noteId
                      })
                    }
                    type="button"
                  >
                    {t('actions.retry')}
                  </button>
                </div>
              )}
              <header className="magic-note-detail-header">
                <button
                  id="magic-notes-index-toggle"
                  type="button"
                  className="icon-button"
                  aria-controls="magic-notes-index"
                  aria-expanded={indexExpanded}
                  aria-label={t(indexExpanded ? 'records.hide' : 'records.show')}
                  title={t(indexExpanded ? 'records.hide' : 'records.show')}
                  onClick={() => isNarrowLayout
                    ? setNarrowIndexOpen((current) => !current)
                    : setIndexPaneOpen((current) => !current)}
                >
                  {indexExpanded ? <PanelLeftClose aria-hidden="true" size={16} /> : <PanelLeftOpen aria-hidden="true" size={16} />}
                </button>
                <input
                  aria-describedby={
                    validation?.target === 'note-title'
                      ? 'magic-note-title-error'
                      : undefined
                  }
                  aria-invalid={validation?.target === 'note-title'}
                  aria-label={t('notes.titleLabel')}
                  maxLength={100}
                  value={titleDraft}
                  onBlur={(event) => {
                    if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.magic-note-more, .magic-note-actions')) return
                    void updateTitle()
                  }}
                  onChange={(event) => {
                    setTitleDraft(event.target.value)
                    clearValidation('note-title')
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur()
                    }
                    if (event.key === 'Escape') {
                      setTitleDraft(detail.title)
                      event.currentTarget.blur()
                    }
                  }}
                />
              </header>
              {validation?.target === 'note-title' && (
                <p
                  className="magic-notes-field-error"
                  id="magic-note-title-error"
                  role="alert"
                >
                  {validation.message}
                </p>
              )}

              {!editingEntry && <div className="magic-note-composer" ref={composerRef} inert={Boolean(busy)}>
                <div className="magic-note-composer__header">
                <div className="magic-note-entry-type" role="group" aria-label={t('canvas.entryType')}>
                  {(['text', 'canvas'] as const).map((value) => <button key={value} type="button" className="secondary-button" aria-pressed={entryType === value} disabled={Boolean(busy) || entryType === value} onClick={() => void requestDraftSwitch({ kind: 'entry-type', value })}>{t(`canvas.${value}`)}</button>)}
                </div>
                {entryType === 'canvas' && <div className="magic-note-canvas-actions">
                  <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void analyzeCanvasDraft(false)}>{t('canvas.analyzeDraft')}</button>
                  <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void saveEntry()}>{t('actions.saveEntry')}</button>
                </div>}
                </div>
                {entryType === 'canvas' ? <MagicCanvasEditor
                  key={`${detail.id}-${composerKey}-canvas`}
                  ref={composerCanvasRef}
                  disabled={Boolean(busy)}
                  onChange={(content) => {
                    if (!richContentEqual(composerContentRef.current, content)) clearCanvasDraftAnalysis()
                    composerContentRef.current = content
                    clearValidation('new-entry')
                  }}
                  onError={notifyError}
                /> : <MagicNoteEditor
                  key={`${detail.id}-${composerKey}`}
                  ariaDescribedBy={
                    validation?.target === 'new-entry'
                      ? 'magic-note-entry-create-error'
                      : undefined
                  }
                  ariaInvalid={validation?.target === 'new-entry'}
                  ariaLabel={t('notes.newEntryLabel')}
                  onChange={(content) => {
                    composerContentRef.current = content
                    clearValidation('new-entry')
                    if (
                      commentMode === 'immediate' &&
                      draftAnalysisArmedRef.current
                    ) {
                      scheduleDraftAnalysis(content)
                    }
                  }}
                  onError={(message) =>
                    setValidation({ target: 'new-entry', message })
                  }
                  onParagraphCommit={(content) => {
                    if (
                      commentMode === 'immediate' &&
                      hasContent(content)
                    ) {
                      draftAnalysisArmedRef.current = true
                      scheduleDraftAnalysis(content)
                    }
                  }}
                />}
                {validation?.target === 'new-entry' && (
                  <p
                    className="magic-notes-field-error"
                    id="magic-note-entry-create-error"
                    role="alert"
                  >
                    {validation.message}
                  </p>
                )}
                {entryType === 'text' && <footer>
                  <span>
                    {commentMode === 'immediate'
                      ? t('notes.composerImmediateHint')
                      : t('notes.composerRichTextHint')}
                  </span>
                  <button
                    className="primary-button"
                    disabled={Boolean(busy)}
                    type="button"
                    onClick={() => void saveEntry()}
                  >
                    {t('actions.saveEntry')}
                  </button>
                </footer>}
              </div>}
                {pendingDraftSwitch && (
                  <div
                    aria-describedby={discardDraftDescriptionId}
                    aria-labelledby={discardDraftTitleId}
                    aria-modal="true"
                    className="magic-note-draft-confirmation"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        continueEditing()
                        return
                      }
                      trapTabFocus(event, discardDraftDialogRef.current)
                    }}
                    ref={discardDraftDialogRef}
                    role="alertdialog"
                    tabIndex={-1}
                  >
                    <strong id={discardDraftTitleId}>
                      {t('confirmations.discardDraftTitle')}
                    </strong>
                    <span id={discardDraftDescriptionId}>
                      {t(entryType === 'canvas' || editingEntry?.content.version === 2 ? 'canvas.discardDescription' : 'confirmations.discardDraftDescription')}
                    </span>
                    <div>
                      <button
                        className="secondary-button"
                        onClick={continueEditing}
                        ref={continueEditingRef}
                        type="button"
                      >
                        {t('actions.continueEditing')}
                      </button>
                      <button
                        className="danger-button"
                        onClick={() =>
                          performDraftSwitch(pendingDraftSwitch)
                        }
                        ref={discardDraftRef}
                        type="button"
                      >
                        {t('actions.discardAndSwitch')}
                      </button>
                    </div>
                  </div>
                )}
              <div className="magic-note-entry-stream">
                {displayedEntries.length === 0 ? (
                  <p className="magic-notes-muted">
                    {t('notes.emptyEntries')}
                  </p>
                ) : (
                  displayedEntries.map((entry) => (
                    <article
                      key={entry.id}
                      id={`magic-note-entry-${entry.id}`}
                      tabIndex={-1}
                      className={`magic-note-entry${editingEntry?.id === entry.id && entry.content.version === 2 ? ' magic-note-entry--canvas-editing' : ''}`}
                    >
                      <header>
                        <time dateTime={entry.createdAt}>
                          {dateFormatter.format(new Date(entry.createdAt))}
                        </time>
                        {editingEntry?.id === entry.id && entry.content.version === 2 ? <div className="magic-note-canvas-actions">
                          <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void analyzeCanvasDraft(true)}>{t('canvas.analyzeDraft')}</button>
                          <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void requestDraftSwitch({ kind: 'cancel-edit' })}>{t('actions.cancel')}</button>
                          <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void saveEditedEntry()}>{t('actions.saveChanges')}</button>
                        </div> : <div>
                          {(commentMode === 'after-save-manual' || entry.content.version === 2) && editingEntry?.id !== entry.id && (
                            <button
                              className="secondary-button"
                              disabled={Boolean(busy)}
                              type="button"
                              onClick={() => void analyzeEntry(entry.id)}
                            >
                              <Bot size={14} />
                              {busy === `analyze-${entry.id}`
                                ? t('actions.analyzing')
                                : entry.analyzedAt
                                  ? t('actions.analyzeAgain')
                                  : t('actions.analyze')}
                            </button>
                          )}
                          <button
                            className="secondary-button"
                            disabled={Boolean(busy) || editingEntry?.id === entry.id}
                            type="button"
                            onClick={() =>
                              requestDraftSwitch({
                                kind: 'edit-entry',
                                entry
                              })
                            }
                          >
                            {t(entry.content.version === 2 ? 'canvas.edit' : 'actions.edit')}
                          </button>
                          <button
                            aria-label={t('actions.deleteEntry')}
                            className="danger-button danger-button--quiet"
                            disabled={Boolean(busy) || Boolean(editingEntry)}
                            type="button"
                            onClick={() => {
                              setEditingEntry(undefined)
                              editingContentRef.current = undefined
                              clearValidation('edit-entry')
                              setDeletingEntryId(entry.id)
                            }}
                          >
                            <Trash2 aria-hidden="true" size={14} />
                            {t('actions.deleteEntry')}
                          </button>
                        </div>}
                      </header>
                      {deletingEntryId === entry.id && (
                        <div className="magic-note-entry__delete">
                          <span>{t('confirmations.deleteEntry')}</span>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => setDeletingEntryId('')}
                          >
                            {t('actions.cancel')}
                          </button>
                          <button
                            className="danger-solid"
                            type="button"
                            onClick={() => {
                              const operation = `delete-${entry.id}`
                              if (!beginBusy(operation)) {
                                return
                              }
                              void window.goodbuddy.magicNotes
                                .removeEntry(entry.id)
                                .then(async (next) => {
                                  applyDetail(next)
                                  setSelectedEntryId((selected) => next.entries.some((entry) => entry.id === selected) ? selected : next.entries.at(-1)?.id ?? '')
                                  await reloadTodos()
                                  setDeletingEntryId('')
                                  notifySuccess(
                                    t('notifications.entryDeleted')
                                  )
                                })
                                .catch((deleteError) =>
                                  notifyError(deleteError)
                                )
                                .finally(() => endBusy(operation))
                            }}
                          >
                            {t('actions.deleteEntry')}
                          </button>
                        </div>
                      )}
                      {editingEntry?.id === entry.id ? (
                        <div className="magic-note-entry__editor" inert={Boolean(busy)}>
                          {editingEntry.content.version === 2 ? <>
                            <MagicCanvasEditor
                              key={`${editingEntry.id}-${editingEntry.revision}`}
                              ref={editingCanvasRef}
                              initialContent={editingEntry.content}
                              onReady={(content) => { editingBaselineRef.current = content; editingContentRef.current = content }}
                              disabled={Boolean(busy)}
                              onChange={(content) => {
                                if (!richContentEqual(editingContentRef.current, content)) clearCanvasDraftAnalysis()
                                editingContentRef.current = content
                                clearValidation('edit-entry')
                              }}
                              onError={notifyError}
                            />
                          </> : <MagicNoteEditor
                            key={`${editingEntry.id}-${editingEntry.revision}`}
                            ariaDescribedBy={
                              validation?.target === 'edit-entry'
                                ? 'magic-note-entry-edit-error'
                                : undefined
                            }
                            ariaInvalid={
                              validation?.target === 'edit-entry'
                            }
                            ariaLabel={t('notes.editEntryLabel')}
                            initialContent={editingEntry.content}
                            onReady={(content) => { editingBaselineRef.current = content; editingContentRef.current = content }}
                            onChange={(content) => {
                              editingContentRef.current = content
                              clearValidation('edit-entry')
                              if (
                                commentMode === 'immediate' &&
                                draftAnalysisArmedRef.current
                              ) {
                                scheduleDraftAnalysis(content)
                              }
                            }}
                            onError={(message) =>
                              setValidation({
                                target: 'edit-entry',
                                message
                              })
                            }
                            onParagraphCommit={(content) => {
                              if (
                                commentMode === 'immediate' &&
                                hasContent(content)
                              ) {
                                draftAnalysisArmedRef.current = true
                                scheduleDraftAnalysis(content)
                              }
                            }}
                          />}
                          {validation?.target === 'edit-entry' && (
                            <p
                              className="magic-notes-field-error"
                              id="magic-note-entry-edit-error"
                              role="alert"
                            >
                              {validation.message}
                            </p>
                          )}
                          {editingEntry.content.version === 1 && <div className="magic-note-entry__editor-actions">
                            <button
                              className="secondary-button"
                              disabled={Boolean(busy)}
                              type="button"
                              onClick={() => {
                                void requestDraftSwitch({ kind: 'cancel-edit' })
                              }}
                            >
                              {t('actions.cancel')}
                            </button>
                            <button
                              className="primary-button"
                              disabled={Boolean(busy)}
                              type="button"
                              onClick={() => void saveEditedEntry()}
                            >
                              {t('actions.saveChanges')}
                            </button>
                          </div>}
                        </div>
                      ) : (
                        <MagicNoteContent content={entry.content} onError={notifyError} canvasRef={(viewer) => {
                          if (viewer) canvasViewRefs.current.set(entry.id, viewer)
                          else canvasViewRefs.current.delete(entry.id)
                        }} />
                      )}
                    </article>
                  ))
                )}
              </div>
            </>
          )}
        </section>

        {aiPaneOpen && renderPaneSeparator('ai')}

        <aside
          aria-label={t('comments.paneLabel')}
          className="magic-notes-ai-pane"
          hidden={!aiPaneOpen}
          id="magic-notes-ai-pane"
        >
          <div className="magic-notes-ai-controls">
            <label>
              <span>{t('comments.directionLabel')}</span>
              <select
                aria-label={t('comments.directionAriaLabel')}
                onChange={(event) =>
                  setCommentDirection(
                    event.target.value as MagicNoteCommentDirection
                  )
                }
                value={commentDirection}
              >
                {commentDirections.map((direction) => (
                  <option key={direction.value} value={direction.value}>
                    {direction.label}
                  </option>
                ))}
              </select>
            </label>
            <small>
              {t('comments.directionHelp')}
            </small>
          </div>
          {liveAnalysis?.format === 'structured' ? (
            <p className="magic-notes-muted" role="status">
              {t('status.generatingPoints', {
                direction:
                  commentDirectionLabels[liveAnalysis.direction]
              })}
            </p>
          ) : liveAnalysis ? (
            <section
              aria-live="polite"
              className="magic-notes-ai-group magic-notes-ai-live"
            >
              <span className="magic-notes-ai-source">
                {t('status.generatingDirection', {
                  direction:
                    commentDirectionLabels[liveAnalysis.direction]
                })}
              </span>
              <div className="magic-note-comment magic-note-comment--narrative">
                <span aria-hidden="true">
                  <Bot size={15} />
                </span>
                <div>
                  <strong>{t('comments.kinds.narrative')}</strong>
                  {liveAnalysis.content ? (
                    <div className="magic-note-comment__narrative markdown-content">
                      <MarkdownRenderer>
                        {liveAnalysis.content}
                      </MarkdownRenderer>
                    </div>
                  ) : (
                    <p role="status">
                      {t('status.preparingComment')}
                    </p>
                  )}
                </div>
              </div>
            </section>
          ) : null}
          {!detail ? (
            <EmptyState
              description={detailLoadError ? detailLoadError.message : t('status.loadingNotes')}
              icon={<Bot size={20} />}
              title={t('status.loading')}
            />
          ) : aiEntries.length === 0 &&
            draftAnalyses.length === 0 &&
            !canvasDraftAnalysis &&
            !draftAnalysisRunning &&
            !liveAnalysis ? (
            <EmptyState
              description={
                (!editingEntry && entryType === 'canvas') || editingEntry?.content.version === 2
                  ? undefined : commentMode === 'immediate'
                  ? t('comments.immediateHint')
                  : commentMode === 'after-save-auto'
                    ? t('comments.autoHint')
                    : t('comments.manualHint')
              }
              icon={<Bot size={20} />}
              title={
                commentMode === 'immediate'
                  ? t('comments.startWritingTitle')
                  : commentMode === 'after-save-auto'
                    ? t('comments.saveEntryTitle')
                    : t('comments.analyzeEntryTitle')
              }
            />
          ) : (
            <div className="magic-notes-ai-feed">
              {draftAnalysisRunning && !liveAnalysis && (
                <p className="magic-notes-muted" role="status">
                  {t('status.commentingDraft')}
                </p>
              )}
              {[...(canvasDraftAnalysis ? [canvasDraftAnalysis] : []), ...draftAnalyses].map((analysis) => (
                <section
                  className="magic-notes-ai-group"
                  key={analysis.id}
                >
                  <span className="magic-notes-ai-source">
                    {dateFormatter.format(new Date(analysis.analyzedAt))} ·
                    {t('status.unsavedDraft')}
                  </span>
                  {analysis.comments.map((comment) => (
                    <AiComment comment={{ ...comment, inputMode: comment.inputMode ?? analysis.inputMode }} key={comment.id} />
                  ))}
                </section>
              ))}
              {aiEntries.map((entry) => (
                <section className="magic-notes-ai-group" key={entry.id}>
                  <button type="button" className="secondary-button" onClick={() => void requestDraftSwitch({ kind: 'select-entry', entry })}>
                    {t('notes.entryAt', {
                      date: dateFormatter.format(
                        new Date(entry.createdAt)
                      )
                    })}
                  </button>
                  {entry.comments.map((comment) => (
                    <AiComment comment={comment} key={comment.id} />
                  ))}
                </section>
              ))}
            </div>
          )}
        </aside>
        </>
        )}
      </div>
        </>
      )}
    </div>
  )
}
