import {
  Bot,
  BookOpen,
  CheckCircle2,
  CircleAlert,
  Circle,
  FileText,
  FolderTree,
  Lightbulb,
  ListTodo,
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
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  MagicNoteAnalysisOptions,
  MagicNoteCommentDirection,
  MagicNoteCommentFormat,
  MagicNoteDraftAnalysis,
  MagicNoteComment,
  MagicNoteDetail,
  MagicNoteEntry,
  MagicNoteRichContent,
  MagicNoteSummary,
  MagicTodoItem
} from '../../shared/magic-notes-contracts'
import type { MagicNoteCommentMode } from '../../shared/application-settings-contracts'
import { MagicNoteContent } from './MagicNoteContent'
import { MagicNoteEditor } from './MagicNoteEditor'
import { MarkdownRenderer } from './MarkdownRenderer'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import type { AppNotificationInput } from './notifications'
import {
  EmptyState,
  PageHeader,
  PageTabs,
  SegmentedControl,
  type PageTab
} from './WorkspacePrimitives'

export type MagicNotesWorkspaceProps = {
  onNotify: (notification: AppNotificationInput) => void
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
  | { kind: 'library-view'; value: LibraryView }
  | { kind: 'create-note'; title: string }
  | { kind: 'edit-entry'; entry: MagicNoteEntry }
  | { kind: 'note'; noteId: string; entryId?: string }
  | { kind: 'todo'; todoId: string }

const defaultAiPaneWidth = 280
const minimumAiPaneWidth = 240
const maximumAiPaneWidth = 520
const defaultMagicNotesListPaneWidth = 220
const minimumMagicNotesListPaneWidth = 180
const maximumMagicNotesListPaneWidth = 360
const minimumMagicNotesEditorWidth = 300
const magicNotesResizeHandleWidth = 9
const magicNotesPaneKeyboardResizeStep = 16
const magicNotesLayoutStorageKey =
  'goodbuddy.magic-notes-layout.v1'

type MagicNotesLayoutPreferences = {
  listPaneOpen: boolean
  listPaneWidth: number
  aiPaneOpen: boolean
  aiPaneWidth: number
}

function loadMagicNotesLayoutPreferences(): MagicNotesLayoutPreferences {
  const defaults = {
    listPaneOpen: true,
    listPaneWidth: defaultMagicNotesListPaneWidth,
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
      listPaneOpen: parsed.listPaneOpen !== false,
      listPaneWidth:
        typeof parsed.listPaneWidth === 'number' &&
        Number.isFinite(parsed.listPaneWidth)
          ? Math.min(
              maximumMagicNotesListPaneWidth,
              Math.max(
                minimumMagicNotesListPaneWidth,
                parsed.listPaneWidth
              )
            )
          : defaults.listPaneWidth,
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

function getMagicNotesPaneWidthLimits({
  adjacentPaneOpen,
  adjacentPaneWidth,
  layoutWidth,
  maximum,
  minimum
}: {
  adjacentPaneOpen: boolean
  adjacentPaneWidth: number
  layoutWidth: number
  maximum: number
  minimum: number
}): MagicNotesPaneWidthLimits {
  const reservedAdjacentWidth = adjacentPaneOpen
    ? adjacentPaneWidth + magicNotesResizeHandleWidth
    : 0
  return {
    minimum,
    maximum: Math.max(
      minimum,
      Math.min(
        maximum,
        layoutWidth -
          reservedAdjacentWidth -
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

function getAiPaneWidthLimits(
  layoutWidth: number,
  listPaneWidth: number,
  listPaneOpen: boolean
): MagicNotesPaneWidthLimits {
  return getMagicNotesPaneWidthLimits({
    adjacentPaneOpen: listPaneOpen,
    adjacentPaneWidth: listPaneWidth,
    layoutWidth,
    maximum: maximumAiPaneWidth,
    minimum: minimumAiPaneWidth
  })
}

function clampAiPaneWidth(
  width: number,
  layoutWidth: number,
  listPaneWidth: number,
  listPaneOpen: boolean
): number {
  return clampMagicNotesPaneWidth(
    width,
    getAiPaneWidthLimits(
      layoutWidth,
      listPaneWidth,
      listPaneOpen
    )
  )
}

function getListPaneWidthLimits(
  layoutWidth: number,
  aiPaneWidth: number,
  aiPaneOpen: boolean
): MagicNotesPaneWidthLimits {
  return getMagicNotesPaneWidthLimits({
    adjacentPaneOpen: aiPaneOpen,
    adjacentPaneWidth: aiPaneWidth,
    layoutWidth,
    maximum: maximumMagicNotesListPaneWidth,
    minimum: minimumMagicNotesListPaneWidth
  })
}

function clampListPaneWidth(
  width: number,
  layoutWidth: number,
  aiPaneWidth: number,
  aiPaneOpen: boolean
): number {
  return clampMagicNotesPaneWidth(
    width,
    getListPaneWidthLimits(
      layoutWidth,
      aiPaneWidth,
      aiPaneOpen
    )
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

function hasContent(content?: MagicNoteRichContent): boolean {
  return Boolean(
    content?.ops.some((operation) =>
      typeof operation.insert === 'string'
        ? operation.insert.trim().length > 0
        : true
    )
  )
}

function richContentEqual(
  left: MagicNoteRichContent | undefined,
  right: MagicNoteRichContent | undefined
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
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
  id,
  onSelect,
  onToggle,
  selected,
  todo
}: {
  disabled: boolean
  id: string
  onSelect: () => void
  onToggle: () => void
  selected: boolean
  todo: MagicTodoItem
}): React.JSX.Element {
  const { t } = useTranslation('magicNotes')
  return (
    <div
      className={`magic-todo-list-item ${
        selected ? 'magic-todo-list-item--active' : ''
      }`}
    >
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
        aria-pressed={selected}
        className="magic-todo-list-item__content"
        id={id}
        onClick={onSelect}
        type="button"
      >
        <strong>{todo.title}</strong>
        <small>{t('todos.sourceNote', { title: todo.noteTitle })}</small>
      </button>
    </div>
  )
}

export function MagicNotesWorkspace({
  onNotify
}: MagicNotesWorkspaceProps): React.JSX.Element {
  const { i18n, t } = useTranslation('magicNotes')
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const currentLocale = i18n.resolvedLanguage || i18n.language
  const libraryTabs = useMemo<ReadonlyArray<PageTab<LibraryView>>>(
    () => [
      {
        id: 'notes',
        label: t('tabs.notes'),
        icon: <BookOpen size={14} />
      },
      {
        id: 'todos',
        label: t('tabs.todos'),
        icon: <ListTodo size={14} />
      }
    ],
    [t]
  )
  const todoFilters = useMemo<
    ReadonlyArray<{ value: TodoFilter; label: string }>
  >(
    () => [
      { value: 'active', label: t('todos.filters.active') },
      { value: 'completed', label: t('todos.filters.completed') },
      { value: 'all', label: t('todos.filters.all') }
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
  const [todoFilter, setTodoFilter] = useState<TodoFilter>('active')
  const [commentMode, setCommentMode] =
    useState<MagicNoteCommentMode>('immediate')
  const [commentDirection, setCommentDirection] =
    useState<MagicNoteCommentDirection>('general')
  const [commentFormat, setCommentFormat] =
    useState<MagicNoteCommentFormat>('combined')
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [selectedTodoId, setSelectedTodoId] = useState('')
  const [detail, setDetail] = useState<MagicNoteDetail>()
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
  const [composerKey, setComposerKey] = useState(0)
  const [editingEntry, setEditingEntry] = useState<MagicNoteEntry>()
  const [deletingEntryId, setDeletingEntryId] = useState('')
  const initialLayoutPreferences = useMemo(
    () => loadMagicNotesLayoutPreferences(),
    []
  )
  const [listPaneOpen, setListPaneOpen] = useState(
    initialLayoutPreferences.listPaneOpen
  )
  const [listPaneWidth, setListPaneWidth] = useState(
    initialLayoutPreferences.listPaneWidth
  )
  const [listPaneResizing, setListPaneResizing] = useState(false)
  const [aiPaneOpen, setAiPaneOpen] = useState(
    initialLayoutPreferences.aiPaneOpen
  )
  const [aiPaneWidth, setAiPaneWidth] = useState(
    initialLayoutPreferences.aiPaneWidth
  )
  const [aiPaneResizing, setAiPaneResizing] = useState(false)
  const [magicNotesLayoutWidth, setMagicNotesLayoutWidth] = useState(
    window.innerWidth
  )
  const [draftAnalyses, setDraftAnalyses] = useState<
    MagicNoteDraftAnalysis[]
  >([])
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
  const requestedNoteIdRef = useRef('')
  const refreshRequestRef = useRef(0)
  const hasLoadedRef = useRef(false)
  const busyRef = useRef('')
  const composerContentRef = useRef<MagicNoteRichContent | undefined>(
    undefined
  )
  const editingContentRef = useRef<MagicNoteRichContent | undefined>(
    undefined
  )
  const draftAnalysisTimerRef = useRef<number | undefined>(undefined)
  const draftAnalysisContentRef = useRef<
    MagicNoteRichContent | undefined
  >(undefined)
  const draftAnalysisQueuedRef = useRef(false)
  const draftAnalysisRunningRef = useRef(false)
  const draftAnalysisArmedRef = useRef(false)
  const draftAnalysisContextRef = useRef(0)
  const lastDraftAnalysisStartedAtRef = useRef(0)
  const magicNotesLayoutRef = useRef<HTMLDivElement>(null)
  const liveListPaneWidthRef = useRef(listPaneWidth)
  const listResizePointerIdRef = useRef<number | undefined>(undefined)
  const liveAiPaneWidthRef = useRef(aiPaneWidth)
  const aiResizePointerIdRef = useRef<number | undefined>(undefined)
  const composerRef = useRef<HTMLDivElement>(null)
  const continueEditingRef = useRef<HTMLButtonElement>(null)
  const discardDraftRef = useRef<HTMLButtonElement>(null)
  const discardDraftDialogRef = useRef<HTMLDivElement>(null)
  const discardDraftTitleId = useId()
  const discardDraftDescriptionId = useId()
  const runDraftAnalysisRef = useRef<
    (content: MagicNoteRichContent) => Promise<void>
  >(async () => undefined)

  const createAnalysisOptions = useCallback(
    async (): Promise<MagicNoteAnalysisOptions> => {
      let format = commentFormat
      try {
        const settings = await window.goodbuddy.updates?.getSettings()
        if (settings) {
          format = settings.magicNoteCommentFormat
          setCommentFormat(format)
        }
      } catch {
        // Keep the last loaded format if settings cannot be refreshed.
      }
      return {
        requestId: crypto.randomUUID(),
        direction: commentDirection,
        format
      }
    },
    [commentDirection, commentFormat]
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

  const resizeAiPaneFromClientX = useCallback(
    (clientX: number, commit: boolean): void => {
      const bounds = getLayoutBounds()
      const width = clampAiPaneWidth(
        bounds.right - clientX,
        bounds.width,
        liveListPaneWidthRef.current,
        listPaneOpen
      )
      liveAiPaneWidthRef.current = width
      if (commit) {
        setAiPaneWidth(width)
        return
      }
      magicNotesLayoutRef.current?.style.setProperty(
        '--magic-notes-ai-width',
        `${width}px`
      )
    },
    [getLayoutBounds, listPaneOpen]
  )

  const finishAiPaneResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (aiResizePointerIdRef.current !== event.pointerId) {
        return
      }
      aiResizePointerIdRef.current = undefined
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setAiPaneWidth(liveAiPaneWidthRef.current)
      setAiPaneResizing(false)
    },
    []
  )

  const resizeAiPaneWithKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const bounds = getLayoutBounds()
      const limits = getAiPaneWidthLimits(
        bounds.width,
        listPaneWidth,
        listPaneOpen
      )
      const nextWidth =
        event.key === 'Home'
          ? limits.minimum
          : event.key === 'End'
            ? limits.maximum
            : event.key === 'ArrowLeft'
              ? aiPaneWidth + magicNotesPaneKeyboardResizeStep
              : event.key === 'ArrowRight'
                ? aiPaneWidth - magicNotesPaneKeyboardResizeStep
                : undefined
      if (nextWidth === undefined) {
        return
      }
      event.preventDefault()
      const width = clampAiPaneWidth(
        nextWidth,
        bounds.width,
        listPaneWidth,
        listPaneOpen
      )
      liveAiPaneWidthRef.current = width
      setAiPaneWidth(width)
    },
    [aiPaneWidth, getLayoutBounds, listPaneOpen, listPaneWidth]
  )

  const resizeListPaneFromClientX = useCallback(
    (clientX: number, commit: boolean): void => {
      const bounds = getLayoutBounds()
      const width = clampListPaneWidth(
        clientX - bounds.left,
        bounds.width,
        liveAiPaneWidthRef.current,
        aiPaneOpen
      )
      liveListPaneWidthRef.current = width
      if (commit) {
        setListPaneWidth(width)
        return
      }
      magicNotesLayoutRef.current?.style.setProperty(
        '--magic-notes-list-width',
        `${width}px`
      )
    },
    [aiPaneOpen, getLayoutBounds]
  )

  const finishListPaneResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (listResizePointerIdRef.current !== event.pointerId) {
        return
      }
      listResizePointerIdRef.current = undefined
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setListPaneWidth(liveListPaneWidthRef.current)
      setListPaneResizing(false)
    },
    []
  )

  const resizeListPaneWithKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const bounds = getLayoutBounds()
      const limits = getListPaneWidthLimits(
        bounds.width,
        aiPaneWidth,
        aiPaneOpen
      )
      const nextWidth =
        event.key === 'Home'
          ? limits.minimum
          : event.key === 'End'
            ? limits.maximum
            : event.key === 'ArrowLeft'
              ? listPaneWidth - magicNotesPaneKeyboardResizeStep
              : event.key === 'ArrowRight'
                ? listPaneWidth + magicNotesPaneKeyboardResizeStep
                : undefined
      if (nextWidth === undefined) {
        return
      }
      event.preventDefault()
      const width = clampListPaneWidth(
        nextWidth,
        bounds.width,
        aiPaneWidth,
        aiPaneOpen
      )
      liveListPaneWidthRef.current = width
      setListPaneWidth(width)
    },
    [aiPaneOpen, aiPaneWidth, getLayoutBounds, listPaneWidth]
  )

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
      listPaneOpen,
      listPaneWidth,
      aiPaneOpen,
      aiPaneWidth
    })
  }, [aiPaneOpen, aiPaneWidth, listPaneOpen, listPaneWidth])

  useEffect(() => {
    const layout = magicNotesLayoutRef.current
    const updateLayoutWidth = (): void => {
      const width = layout?.getBoundingClientRect().width || window.innerWidth
      setMagicNotesLayoutWidth(width)
      if (width > 720) {
        setListPaneWidth((current) => {
          const next = clampListPaneWidth(
            current,
            width,
            liveAiPaneWidthRef.current,
            aiPaneOpen
          )
          liveListPaneWidthRef.current = next
          return next
        })
      }
      if (width > 800) {
        setAiPaneWidth((current) => {
          const next = clampAiPaneWidth(
            current,
            width,
            liveListPaneWidthRef.current,
            listPaneOpen
          )
          liveAiPaneWidthRef.current = next
          return next
        })
      }
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
  }, [aiPaneOpen, listPaneOpen])

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
    async (content: MagicNoteRichContent): Promise<void> => {
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
      const options = await createAnalysisOptions()
      setLiveAnalysis({
        requestId: options.requestId,
        content: '',
        direction: options.direction,
        format: options.format
      })
      try {
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
          current?.requestId === options.requestId ? undefined : current
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
    (content: MagicNoteRichContent): void => {
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
    (next: MagicNoteDetail) => {
      setDetail(next)
      setTitleDraft(next.title)
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
    setSelectedTodoId(next.id)
  }, [])

  const loadDetail = useCallback(
    async (noteId: string): Promise<void> => {
      const requestId = ++detailRequestRef.current
      requestedNoteIdRef.current = noteId
      setDetailLoadError(undefined)
      try {
        const nextDetail = await window.goodbuddy.magicNotes.get(noteId)
        if (detailRequestRef.current === requestId) {
          draftAnalysisArmedRef.current = false
          draftAnalysisQueuedRef.current = false
          draftAnalysisContextRef.current += 1
          setDraftAnalyses([])
          composerContentRef.current = undefined
          setComposerKey((current) => current + 1)
          if (draftAnalysisTimerRef.current !== undefined) {
            window.clearTimeout(draftAnalysisTimerRef.current)
            draftAnalysisTimerRef.current = undefined
          }
          setEditingEntry(undefined)
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
    [applyDetail]
  )

  const discardComposerDraft = useCallback((): void => {
    composerContentRef.current = undefined
    draftAnalysisArmedRef.current = false
    draftAnalysisQueuedRef.current = false
    draftAnalysisContextRef.current += 1
    setDraftAnalyses([])
    if (draftAnalysisTimerRef.current !== undefined) {
      window.clearTimeout(draftAnalysisTimerRef.current)
      draftAnalysisTimerRef.current = undefined
    }
    setComposerKey((current) => current + 1)
  }, [])

  const discardEditingDraft = useCallback((): void => {
    setEditingEntry(undefined)
    editingContentRef.current = undefined
    clearValidation('edit-entry')
  }, [clearValidation])

  const hasDirtyEditingDraft = useCallback(
    (): boolean =>
      Boolean(
        editingEntry &&
          !richContentEqual(
            editingContentRef.current,
            editingEntry.content
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
        requestedNoteIdRef.current = created.id
        setSelectedNoteId(created.id)
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
        const focusTarget =
          target.kind === 'library-view'
            ? document.getElementById(`magic-library-tab-${target.value}`)
            : target.kind === 'note'
              ? document.getElementById(
                  `magic-note-select-${target.noteId}`
                )
              : target.kind === 'todo'
                ? document.getElementById(
                    `magic-todo-select-${target.todoId}`
                  )
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
        focusTarget?.focus()
      })
    },
    []
  )

  const performDraftSwitch = useCallback(
    (target: DraftSwitchTarget): void => {
      setPendingDraftSwitch(undefined)
      setValidation(undefined)
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
      if (target.kind === 'todo') {
        setSelectedTodoId(target.todoId)
        focusSwitchTarget(target)
        return
      }
      if (target.kind === 'edit-entry') {
        discardEditingDraft()
        setDeletingEntryId('')
        setEditingEntry(target.entry)
        editingContentRef.current = target.entry.content
        focusSwitchTarget(target)
        return
      }
      if (target.kind === 'create-note') {
        void createNote(target.title, true)
          .then(() => focusSwitchTarget(target))
        return
      }
      setDeletingNote(false)
      setLibraryView('notes')
      void loadDetail(target.noteId).then(() => {
        focusSwitchTarget(target)
        if (!target.entryId) {
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
      discardComposerDraft,
      discardEditingDraft,
      focusSwitchTarget,
      loadDetail
    ]
  )

  const requestDraftSwitch = useCallback(
    (target: DraftSwitchTarget): void => {
      if (pendingDraftSwitch) {
        return
      }
      const changesContext =
        target.kind === 'library-view'
          ? target.value !== libraryView
          : target.kind === 'note'
            ? target.noteId !== selectedNoteId ||
              target.entryId !== undefined
            : target.kind === 'todo'
              ? target.todoId !== selectedTodoId
              : target.kind === 'edit-entry'
                ? target.entry.id !== editingEntry?.id
                : true
      if (!changesContext) {
        return
      }
      const wouldClearComposer = target.kind !== 'edit-entry'
      const wouldClearEditing = target.kind !== 'todo'
      if (
        (wouldClearComposer && hasContent(composerContentRef.current)) ||
        (wouldClearEditing && hasDirtyEditingDraft())
      ) {
        setPendingDraftSwitch(target)
        return
      }
      performDraftSwitch(target)
    },
    [
      editingEntry?.id,
      hasDirtyEditingDraft,
      libraryView,
      pendingDraftSwitch,
      performDraftSwitch,
      selectedNoteId,
      selectedTodoId
    ]
  )

  const continueEditing = useCallback((): void => {
    setPendingDraftSwitch(undefined)
    requestAnimationFrame(() => {
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
    async (preferredId?: string): Promise<void> => {
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
            : snapshot.notes[0]?.id ?? ''
        const nextDetail = nextId
          ? await window.goodbuddy.magicNotes.get(nextId)
          : undefined
        if (refreshRequestRef.current !== requestId) {
          return
        }
        const requestedNoteId = requestedNoteIdRef.current
        const preserveNewerSelection =
          detailRequestRef.current !== detailRequestAtStart &&
          snapshot.notes.some((note) => note.id === requestedNoteId)
        setNotes(snapshot.notes)
        setTodos(todoSnapshot.todos)
        setSelectedTodoId(todoSnapshot.todos[0]?.id ?? '')
        hasLoadedRef.current = true
        setLoadStatus('ready')
        if (preserveNewerSelection) {
          return
        }
        detailRequestRef.current += 1
        requestedNoteIdRef.current = nextId
        setSelectedNoteId(nextId)
        setDetail(nextDetail)
        setTitleDraft(nextDetail?.title ?? '')
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
    []
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
    () => todos.find((todo) => todo.id === selectedTodoId),
    [selectedTodoId, todos]
  )

  const reloadTodos = useCallback(async (): Promise<void> => {
    const snapshot = await window.goodbuddy.magicNotes.listTodos()
    setTodos(snapshot.todos)
    setSelectedTodoId((current) =>
      snapshot.todos.some((todo) => todo.id === current)
        ? current
        : snapshot.todos[0]?.id ?? ''
    )
  }, [])

  const aiEntries = useMemo(
    () =>
      [...(detail?.entries ?? [])]
        .filter((entry) => entry.comments.length > 0)
        .reverse(),
    [detail]
  )
  const listPaneWidthLimits = getListPaneWidthLimits(
    magicNotesLayoutWidth,
    aiPaneWidth,
    aiPaneOpen
  )
  const aiPaneWidthLimits = getAiPaneWidthLimits(
    magicNotesLayoutWidth,
    listPaneWidth,
    listPaneOpen
  )
  const canResizeListPane =
    listPaneOpen &&
    magicNotesLayoutWidth > 720 &&
    listPaneWidthLimits.maximum > listPaneWidthLimits.minimum
  const canResizeAiPane =
    aiPaneOpen &&
    magicNotesLayoutWidth > 800 &&
    aiPaneWidthLimits.maximum > aiPaneWidthLimits.minimum

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
    const options = await createAnalysisOptions()
    setLiveAnalysis({
      requestId: options.requestId,
      content: '',
      direction: options.direction,
      format: options.format
    })
    try {
      applyTodo(
        await window.goodbuddy.magicNotes.analyzeTodo(todoId, options)
      )
      notifySuccess(t('notifications.aiCommentAdded'))
    } catch (analysisError) {
      notifyError(analysisError)
    } finally {
      setLiveAnalysis((current) =>
        current?.requestId === options.requestId ? undefined : current
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
      applyDetail(updated)
      await reloadTodos()
    } catch (updateError) {
      setTitleDraft(detail.title)
      notifyError(updateError)
    } finally {
      endBusy(operation)
    }
  }

  const saveEntry = async (): Promise<void> => {
    const composerContent = composerContentRef.current
    if (!detail || !hasContent(composerContent) || !composerContent) {
      setValidation({
        target: 'new-entry',
        message: t('validation.newEntryRequired')
      })
      return
    }
    clearValidation('new-entry')
    const operation = 'create-entry'
    if (!beginBusy(operation)) {
      return
    }
    try {
      const existingEntryIds = new Set(
        detail.entries.map((entry) => entry.id)
      )
      const updated = await window.goodbuddy.magicNotes.createEntry({
        noteId: detail.id,
        content: composerContent
      })
      applyDetail(updated)
      composerContentRef.current = undefined
      setPendingDraftSwitch(undefined)
      draftAnalysisArmedRef.current = false
      draftAnalysisQueuedRef.current = false
      draftAnalysisContextRef.current += 1
      setDraftAnalyses([])
      if (draftAnalysisTimerRef.current !== undefined) {
        window.clearTimeout(draftAnalysisTimerRef.current)
        draftAnalysisTimerRef.current = undefined
      }
      setComposerKey((current) => current + 1)
      notifySuccess(t('notifications.entrySaved'))
      try {
        await reloadTodos()
      } catch (refreshTodosError) {
        notifyError(refreshTodosError)
      }
      const createdEntry = updated.entries.find(
        (entry) => !existingEntryIds.has(entry.id)
      )
      if (commentMode === 'after-save-auto' && createdEntry) {
        const options = await createAnalysisOptions()
        setLiveAnalysis({
          requestId: options.requestId,
          content: '',
          direction: options.direction,
          format: options.format
        })
        try {
          applyDetail(
            await window.goodbuddy.magicNotes.analyze(
              createdEntry.id,
              options
            )
          )
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
    const editingContent = editingContentRef.current
    if (!editingEntry || !editingContent || !hasContent(editingContent)) {
      setValidation({
        target: 'edit-entry',
        message: t('validation.entryRequired')
      })
      return
    }
    clearValidation('edit-entry')
    const operation = `edit-${editingEntry.id}`
    if (!beginBusy(operation)) {
      return
    }
    try {
      const updated = await window.goodbuddy.magicNotes.updateEntry({
        entryId: editingEntry.id,
        content: editingContent,
        expectedRevision: editingEntry.revision
      })
      applyDetail(updated)
      setEditingEntry(undefined)
      editingContentRef.current = undefined
      notifySuccess(t('notifications.entryUpdated'))
      try {
        await reloadTodos()
      } catch (refreshTodosError) {
        notifyError(refreshTodosError)
      }
      if (commentMode === 'after-save-auto') {
        const options = await createAnalysisOptions()
        setLiveAnalysis({
          requestId: options.requestId,
          content: '',
          direction: options.direction,
          format: options.format
        })
        try {
          applyDetail(
            await window.goodbuddy.magicNotes.analyze(
              editingEntry.id,
              options
            )
          )
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
    const options = await createAnalysisOptions()
    setLiveAnalysis({
      requestId: options.requestId,
      content: '',
      direction: options.direction,
      format: options.format
    })
    try {
      applyDetail(
        await window.goodbuddy.magicNotes.analyze(entryId, options)
      )
      notifySuccess(t('notifications.aiCommentAdded'))
    } catch (analysisError) {
      notifyError(analysisError)
    } finally {
      setLiveAnalysis((current) =>
        current?.requestId === options.requestId ? undefined : current
      )
      endBusy(operation)
    }
  }

  return (
    <div className="magic-notes-page">
      <PageHeader
        actions={
          <>
            <button
              aria-controls="magic-notes-list-pane"
              aria-expanded={listPaneOpen}
              className="secondary-button"
              onClick={() => setListPaneOpen((current) => !current)}
              type="button"
            >
              {listPaneOpen ? (
                <PanelLeftClose aria-hidden="true" size={15} />
              ) : (
                <PanelLeftOpen aria-hidden="true" size={15} />
              )}
              {t(
                listPaneOpen
                  ? 'actions.hideListPane'
                  : 'actions.showListPane'
              )}
            </button>
            <button
              aria-controls="magic-notes-ai-pane"
              aria-expanded={aiPaneOpen}
              className="secondary-button"
              onClick={() => setAiPaneOpen((current) => !current)}
              type="button"
            >
              {aiPaneOpen ? (
                <PanelRightClose aria-hidden="true" size={15} />
              ) : (
                <PanelRightOpen aria-hidden="true" size={15} />
              )}
              {t(
                aiPaneOpen
                  ? 'actions.hideAiComments'
                  : 'actions.showAiComments'
              )}
            </button>
            {libraryView === 'notes' && (
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  setValidation(undefined)
                  setCreating(true)
                }}
              >
                <Plus aria-hidden="true" size={15} />
                {t('actions.newNote')}
              </button>
            )}
          </>
        }
        description={t('page.description')}
        headingId="magic-notes-title"
        icon={<Sparkles size={20} />}
        scope={{ kind: 'global' }}
        title={t('page.title')}
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
                onClick={() => void refreshNotes(selectedNoteId)}
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
          listPaneOpen ? '' : ' magic-notes-layout--list-hidden'
        }${
          aiPaneOpen ? '' : ' magic-notes-layout--ai-hidden'
        }${
          (listPaneResizing && canResizeListPane) ||
          (aiPaneResizing && canResizeAiPane)
            ? ' magic-notes-layout--resizing'
            : ''
        }${
          listPaneResizing && canResizeListPane
            ? ' magic-notes-layout--list-resizing'
            : ''
        }${
          aiPaneResizing && canResizeAiPane
            ? ' magic-notes-layout--ai-resizing'
            : ''
        }`}
        style={
          {
            '--magic-notes-list-width': `${listPaneWidth}px`,
            '--magic-notes-ai-width': `${aiPaneWidth}px`
          } as React.CSSProperties
        }
      >
        <aside
          aria-label={t(
            libraryView === 'notes'
              ? 'notes.listLabel'
              : 'todos.listLabel'
          )}
          className="magic-notes-list-pane"
          hidden={!listPaneOpen}
          id="magic-notes-list-pane"
        >
          <PageTabs
            ariaLabel={t('page.contentLabel')}
            idPrefix="magic-library"
            onChange={(value) =>
              requestDraftSwitch({
                kind: 'library-view',
                value
              })
            }
            tabs={libraryTabs}
            value={libraryView}
            variant="segmented"
          />
          {libraryView === 'notes' ? (
            <div
              aria-labelledby="magic-library-tab-notes"
              className="magic-notes-library-panel"
              id="magic-library-panel-notes"
              role="tabpanel"
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
          <div className="magic-notes-list">
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
                <button
                  key={note.id}
                  id={`magic-note-select-${note.id}`}
                  aria-pressed={selectedNoteId === note.id}
                  className={`magic-note-list-item ${
                    selectedNoteId === note.id
                      ? 'magic-note-list-item--active'
                      : ''
                  }`}
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
              ))
            )}
          </div>
            </div>
          ) : (
            <div
              aria-labelledby="magic-library-tab-todos"
              className="magic-notes-library-panel"
              id="magic-library-panel-todos"
              role="tabpanel"
            >
              <div className="magic-notes-pane-heading">
                <strong>{t('todos.heading')}</strong>
                <span>{todos.length}</span>
              </div>
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
                          <TodoListItem
                            disabled={busy === `update-todo-${todo.id}`}
                            id={`magic-todo-select-${todo.id}`}
                            key={todo.id}
                            onSelect={() =>
                              requestDraftSwitch({
                                kind: 'todo',
                                todoId: todo.id
                              })
                            }
                            onToggle={() =>
                              void updateTodoCompletion(todo)
                            }
                            selected={selectedTodoId === todo.id}
                            todo={todo}
                          />
                        ))}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
        </aside>

        {listPaneOpen && (
          <div
            aria-controls="magic-notes-list-pane"
            aria-disabled={!canResizeListPane}
            aria-label={t('accessibility.resizeListPane')}
            aria-orientation="vertical"
            aria-valuemax={listPaneWidthLimits.maximum}
            aria-valuemin={listPaneWidthLimits.minimum}
            aria-valuenow={listPaneWidth}
            aria-valuetext={t('accessibility.listPaneWidth', {
              width: listPaneWidth
            })}
            className="magic-notes-list-resize-handle"
            onKeyDown={resizeListPaneWithKeyboard}
            onLostPointerCapture={(event) => {
              if (
                listResizePointerIdRef.current === event.pointerId
              ) {
                listResizePointerIdRef.current = undefined
                setListPaneWidth(liveListPaneWidthRef.current)
                setListPaneResizing(false)
              }
            }}
            onPointerCancel={finishListPaneResize}
            onPointerDown={(event) => {
              if (event.button !== 0 || !canResizeListPane) {
                return
              }
              event.preventDefault()
              listResizePointerIdRef.current = event.pointerId
              event.currentTarget.setPointerCapture(event.pointerId)
              resizeListPaneFromClientX(event.clientX, true)
              setListPaneResizing(true)
            }}
            onPointerMove={(event) => {
              if (
                listResizePointerIdRef.current !== event.pointerId
              ) {
                return
              }
              if (!canResizeListPane) {
                finishListPaneResize(event)
                return
              }
              event.preventDefault()
              resizeListPaneFromClientX(event.clientX, false)
            }}
            onPointerUp={finishListPaneResize}
            role="separator"
            tabIndex={canResizeListPane ? 0 : -1}
          />
        )}

        <section
          aria-label={t(
            libraryView === 'notes'
              ? 'notes.streamLabel'
              : 'todos.detailLabel'
          )}
          className="magic-notes-stream-pane"
        >
          {libraryView === 'notes' ? (
            !detail ? (
            <EmptyState
              description={t('notes.emptySelectionDescription')}
              icon={<FileText size={24} />}
              title={
                loadStatus === 'loading'
                  ? t('status.loading')
                  : t('notes.emptySelectionTitle')
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
                  onBlur={() => void updateTitle()}
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
                <div>
                  <button
                    aria-label={t(
                      detail.pinned
                        ? 'actions.unpinNote'
                        : 'actions.pinNote'
                    )}
                    className="icon-button"
                    title={t(
                      detail.pinned
                        ? 'actions.unpinNote'
                        : 'actions.pinNote'
                    )}
                    type="button"
                    onClick={() => {
                      const operation = 'pin-note'
                      if (!beginBusy(operation)) {
                        return
                      }
                      void window.goodbuddy.magicNotes
                        .update({
                          noteId: detail.id,
                          pinned: !detail.pinned,
                          expectedRevision: detail.revision
                        })
                        .then(applyDetail)
                        .catch((pinError) =>
                          notifyError(pinError)
                        )
                        .finally(() => endBusy(operation))
                    }}
                  >
                    {detail.pinned ? (
                      <PinOff size={15} />
                    ) : (
                      <Pin size={15} />
                    )}
                  </button>
                  <button
                    aria-label={t('actions.deleteNote')}
                    className="icon-button magic-note-detail-header__delete"
                    title={t('actions.deleteNote')}
                    type="button"
                    onClick={() => setDeletingNote(true)}
                  >
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </div>
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

              {deletingNote && (
                <div className="magic-note-delete-confirmation">
                  <span>
                    {t('confirmations.deleteNote', {
                      title: detail.title
                    })}
                  </span>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setDeletingNote(false)}
                  >
                    {t('actions.cancel')}
                  </button>
                  <button
                    className="danger-solid"
                    type="button"
                    onClick={() => {
                      const operation = 'delete-note'
                      if (!beginBusy(operation)) {
                        return
                      }
                      void window.goodbuddy.magicNotes
                        .remove(detail.id)
                        .then(async () => {
                          notifySuccess(t('notifications.noteDeleted'))
                          setDeletingNote(false)
                          await refreshNotes()
                        })
                        .catch((deleteError) =>
                          notifyError(deleteError)
                        )
                        .finally(() => endBusy(operation))
                    }}
                  >
                    {t('actions.deleteNote')}
                  </button>
                </div>
              )}

              <div className="magic-note-composer" ref={composerRef}>
                <MagicNoteEditor
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
                />
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
                      {t('confirmations.discardDraftDescription')}
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
                {validation?.target === 'new-entry' && (
                  <p
                    className="magic-notes-field-error"
                    id="magic-note-entry-create-error"
                    role="alert"
                  >
                    {validation.message}
                  </p>
                )}
                <footer>
                  <span>
                    {commentMode === 'immediate'
                      ? t('notes.composerImmediateHint')
                      : t('notes.composerRichTextHint')}
                  </span>
                  <button
                    className="primary-button"
                    disabled={busy === 'create-entry'}
                    type="button"
                    onClick={() => void saveEntry()}
                  >
                    {t('actions.saveEntry')}
                  </button>
                </footer>
              </div>

              <div className="magic-note-entry-stream">
                {detail.entries.length === 0 ? (
                  <p className="magic-notes-muted">
                    {t('notes.emptyEntries')}
                  </p>
                ) : (
                  [...detail.entries].reverse().map((entry) => (
                    <article
                      key={entry.id}
                      id={`magic-note-entry-${entry.id}`}
                      className="magic-note-entry"
                    >
                      <header>
                        <time dateTime={entry.createdAt}>
                          {dateFormatter.format(new Date(entry.createdAt))}
                        </time>
                        <div>
                          {commentMode === 'after-save-manual' && (
                            <button
                              className="secondary-button"
                              disabled={busy === `analyze-${entry.id}`}
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
                            type="button"
                            onClick={() =>
                              requestDraftSwitch({
                                kind: 'edit-entry',
                                entry
                              })
                            }
                          >
                            {t('actions.edit')}
                          </button>
                          <button
                            aria-label={t('actions.deleteEntry')}
                            className="danger-button danger-button--quiet"
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
                        </div>
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
                        <div className="magic-note-entry__editor">
                          <MagicNoteEditor
                            key={`${entry.id}-${entry.revision}`}
                            ariaDescribedBy={
                              validation?.target === 'edit-entry'
                                ? 'magic-note-entry-edit-error'
                                : undefined
                            }
                            ariaInvalid={
                              validation?.target === 'edit-entry'
                            }
                            ariaLabel={t('notes.editEntryLabel')}
                            initialContent={entry.content}
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
                          />
                          {validation?.target === 'edit-entry' && (
                            <p
                              className="magic-notes-field-error"
                              id="magic-note-entry-edit-error"
                              role="alert"
                            >
                              {validation.message}
                            </p>
                          )}
                          <div className="magic-note-entry__editor-actions">
                            <button
                              className="secondary-button"
                              type="button"
                              onClick={() => {
                                setEditingEntry(undefined)
                                editingContentRef.current = undefined
                                clearValidation('edit-entry')
                              }}
                            >
                              {t('actions.cancel')}
                            </button>
                            <button
                              className="primary-button"
                              disabled={busy === `edit-${entry.id}`}
                              type="button"
                              onClick={() => void saveEditedEntry()}
                            >
                              {t('actions.saveChanges')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <MagicNoteContent content={entry.content} />
                      )}
                    </article>
                  ))
                )}
              </div>
            </>
            )
          ) : !selectedTodo ? (
            <EmptyState
              description={t('todos.emptySelectionDescription')}
              icon={<ListTodo size={24} />}
              title={
                loadStatus === 'loading'
                  ? t('status.loading')
                  : t('todos.emptySelectionTitle')
              }
            />
          ) : (
            <section className="magic-todo-detail">
              <header>
                <button
                  aria-label={t(
                    selectedTodo.completed
                      ? 'todos.markIncomplete'
                      : 'todos.markComplete',
                    { title: selectedTodo.title }
                  )}
                  aria-pressed={selectedTodo.completed}
                  className="magic-todo-detail__check"
                  disabled={
                    busy === `update-todo-${selectedTodo.id}`
                  }
                  onClick={() =>
                    void updateTodoCompletion(selectedTodo)
                  }
                  type="button"
                >
                  {selectedTodo.completed ? (
                    <CheckCircle2 size={24} />
                  ) : (
                    <Circle size={24} />
                  )}
                </button>
                <div>
                  <h2>{selectedTodo.title}</h2>
                  <span>
                    {t('todos.sourceNote', {
                      title: selectedTodo.noteTitle
                    })}
                  </span>
                </div>
                <div className="magic-todo-detail__actions">
                  <button
                    className="secondary-button"
                    disabled={busy === `analyze-todo-${selectedTodo.id}`}
                    onClick={() => void analyzeTodo(selectedTodo.id)}
                    type="button"
                  >
                    <Bot aria-hidden="true" size={14} />
                    {busy === `analyze-todo-${selectedTodo.id}`
                      ? t('actions.analyzing')
                      : selectedTodo.analyzedAt
                        ? t('actions.analyzeAgain')
                        : t('actions.analyze')}
                  </button>
                </div>
              </header>

              <div className="magic-todo-detail__content">
                <p>
                  {selectedTodo.instructions ||
                    t('todos.defaultInstructions')}
                </p>
                <button
                  className="secondary-button"
                  onClick={() =>
                    requestDraftSwitch({
                      kind: 'note',
                      noteId: selectedTodo.noteId,
                      entryId: selectedTodo.entryId
                    })
                  }
                  type="button"
                >
                  <BookOpen size={14} />
                  {t('actions.openSourceNote')}
                </button>
              </div>
            </section>
          )}
        </section>

        {aiPaneOpen && (
          <div
            aria-controls="magic-notes-ai-pane"
            aria-disabled={!canResizeAiPane}
            aria-label={t('accessibility.resizeAiPane')}
            aria-orientation="vertical"
            aria-valuemax={aiPaneWidthLimits.maximum}
            aria-valuemin={aiPaneWidthLimits.minimum}
            aria-valuenow={aiPaneWidth}
            aria-valuetext={t('accessibility.aiPaneWidth', {
              width: aiPaneWidth
            })}
            className="magic-notes-ai-resize-handle"
            onKeyDown={resizeAiPaneWithKeyboard}
            onLostPointerCapture={(event) => {
              if (aiResizePointerIdRef.current === event.pointerId) {
                aiResizePointerIdRef.current = undefined
                setAiPaneWidth(liveAiPaneWidthRef.current)
                setAiPaneResizing(false)
              }
            }}
            onPointerCancel={finishAiPaneResize}
            onPointerDown={(event) => {
              if (event.button !== 0 || !canResizeAiPane) {
                return
              }
              event.preventDefault()
              aiResizePointerIdRef.current = event.pointerId
              event.currentTarget.setPointerCapture(event.pointerId)
              resizeAiPaneFromClientX(event.clientX, true)
              setAiPaneResizing(true)
            }}
            onPointerMove={(event) => {
              if (aiResizePointerIdRef.current !== event.pointerId) {
                return
              }
              if (!canResizeAiPane) {
                finishAiPaneResize(event)
                return
              }
              event.preventDefault()
              resizeAiPaneFromClientX(event.clientX, false)
            }}
            onPointerUp={finishAiPaneResize}
            role="separator"
            tabIndex={canResizeAiPane ? 0 : -1}
          />
        )}

        <aside
          aria-label={t('comments.paneLabel')}
          className="magic-notes-ai-pane"
          hidden={!aiPaneOpen}
          id="magic-notes-ai-pane"
        >
          <div className="magic-notes-pane-heading">
            <strong>{t('comments.paneLabel')}</strong>
            <button
              aria-label={t('comments.closePane')}
              className="icon-button"
              onClick={() => setAiPaneOpen(false)}
              title={t('comments.closePane')}
              type="button"
            >
              <PanelRightClose aria-hidden="true" size={15} />
            </button>
          </div>
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
          {libraryView === 'todos' ? (
            !selectedTodo ? (
              <EmptyState
                description={t('comments.selectTodo')}
                icon={<Bot size={20} />}
                title={t('comments.selectTodoTitle')}
              />
            ) : selectedTodo.comments.length === 0 ? (
              !liveAnalysis && (
                <EmptyState
                  description={t('comments.analyzeTodoHint')}
                  icon={<Bot size={20} />}
                  title={t('comments.analyzeTodoTitle')}
                />
              )
            ) : (
              <div className="magic-notes-ai-feed">
                <section className="magic-notes-ai-group">
                  <span className="magic-notes-ai-source">
                    {selectedTodo.title}
                  </span>
                  {selectedTodo.comments.map((comment) => (
                    <AiComment comment={comment} key={comment.id} />
                  ))}
                </section>
              </div>
            )
          ) : !detail ? (
            <EmptyState
              description={
                loadStatus === 'loading'
                  ? t('status.loadingNotes')
                  : t('comments.selectNote')
              }
              icon={<Bot size={20} />}
              title={
                loadStatus === 'loading'
                  ? t('status.loading')
                  : t('comments.selectNoteTitle')
              }
            />
          ) : aiEntries.length === 0 &&
            draftAnalyses.length === 0 &&
            !draftAnalysisRunning &&
            !liveAnalysis ? (
            <EmptyState
              description={
                commentMode === 'immediate'
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
              {draftAnalyses.map((analysis) => (
                <section
                  className="magic-notes-ai-group"
                  key={analysis.id}
                >
                  <span className="magic-notes-ai-source">
                    {dateFormatter.format(new Date(analysis.analyzedAt))} ·
                    {t('status.unsavedDraft')}
                  </span>
                  {analysis.comments.map((comment) => (
                    <AiComment comment={comment} key={comment.id} />
                  ))}
                </section>
              ))}
              {aiEntries.map((entry) => (
                <section className="magic-notes-ai-group" key={entry.id}>
                  <a href={`#magic-note-entry-${entry.id}`}>
                    {t('notes.entryAt', {
                      date: dateFormatter.format(
                        new Date(entry.createdAt)
                      )
                    })}
                  </a>
                  {entry.comments.map((comment) => (
                    <AiComment comment={comment} key={comment.id} />
                  ))}
                </section>
              ))}
            </div>
          )}
        </aside>
      </div>
        </>
      )}
    </div>
  )
}
