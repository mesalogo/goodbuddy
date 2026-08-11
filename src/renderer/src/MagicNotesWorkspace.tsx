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

const defaultAiPaneWidth = 300
const minimumAiPaneWidth = 240
const maximumAiPaneWidth = 520
const magicNotesListPaneWidth = 220
const minimumMagicNotesEditorWidth = 300
const magicNotesResizeHandleWidth = 9
const aiPaneKeyboardResizeStep = 16

function getAiPaneWidthLimits(layoutWidth: number): {
  minimum: number
  maximum: number
} {
  return {
    minimum: minimumAiPaneWidth,
    maximum: Math.max(
      minimumAiPaneWidth,
      Math.min(
        maximumAiPaneWidth,
        layoutWidth -
          magicNotesListPaneWidth -
          minimumMagicNotesEditorWidth -
          magicNotesResizeHandleWidth
      )
    )
  }
}

function clampAiPaneWidth(width: number, layoutWidth: number): number {
  const limits = getAiPaneWidthLimits(layoutWidth)
  return Math.min(limits.maximum, Math.max(limits.minimum, width))
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
  onSelect,
  onToggle,
  selected,
  todo
}: {
  disabled: boolean
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
  const [aiPaneOpen, setAiPaneOpen] = useState(true)
  const [aiPaneWidth, setAiPaneWidth] = useState(defaultAiPaneWidth)
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
  const liveAiPaneWidthRef = useRef(defaultAiPaneWidth)
  const aiResizePointerIdRef = useRef<number | undefined>(undefined)
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
    width: number
    right: number
  } => {
    const bounds = magicNotesLayoutRef.current?.getBoundingClientRect()
    const width = bounds?.width || window.innerWidth
    return {
      width,
      right: bounds?.right || width
    }
  }, [])

  const resizeAiPaneFromClientX = useCallback(
    (clientX: number, commit: boolean): void => {
      const bounds = getLayoutBounds()
      const width = clampAiPaneWidth(
        bounds.right - clientX,
        bounds.width
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
    [getLayoutBounds]
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
      const limits = getAiPaneWidthLimits(bounds.width)
      const nextWidth =
        event.key === 'Home'
          ? limits.minimum
          : event.key === 'End'
            ? limits.maximum
            : event.key === 'ArrowLeft'
              ? aiPaneWidth + aiPaneKeyboardResizeStep
              : event.key === 'ArrowRight'
                ? aiPaneWidth - aiPaneKeyboardResizeStep
                : undefined
      if (nextWidth === undefined) {
        return
      }
      event.preventDefault()
      const width = clampAiPaneWidth(nextWidth, bounds.width)
      liveAiPaneWidthRef.current = width
      setAiPaneWidth(width)
    },
    [aiPaneWidth, getLayoutBounds]
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
    const layout = magicNotesLayoutRef.current
    const updateLayoutWidth = (): void => {
      const width = layout?.getBoundingClientRect().width || window.innerWidth
      setMagicNotesLayoutWidth(width)
      if (width > 800) {
        setAiPaneWidth((current) => {
          const next = clampAiPaneWidth(current, width)
          liveAiPaneWidthRef.current = next
          return next
        })
      }
    }
    updateLayoutWidth()
    window.addEventListener('resize', updateLayoutWidth)
    const observer =
      layout && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(updateLayoutWidth)
        : undefined
    if (layout && observer) {
      observer.observe(layout)
    }
    return () => {
      window.removeEventListener('resize', updateLayoutWidth)
      observer?.disconnect()
    }
  }, [])

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

  const applyDetail = useCallback((next: MagicNoteDetail) => {
    setDetail(next)
    setTitleDraft(next.title)
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
  const aiPaneWidthLimits = getAiPaneWidthLimits(magicNotesLayoutWidth)
  const canResizeAiPane = aiPaneOpen && magicNotesLayoutWidth > 800

  const createNote = async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title) {
      setValidation({
        target: 'create-note',
        message: t('validation.createNoteTitle')
      })
      return
    }
    clearValidation('create-note')
    const operation = 'create-note'
    if (!beginBusy(operation)) {
      return
    }
    try {
      const created = await window.goodbuddy.magicNotes.create({
        title
      })
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
      applyTodo(
        await window.goodbuddy.magicNotes.updateTodo({
          todoId: todo.id,
          completed,
          expectedRevision: todo.revision
        })
      )
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
      await reloadTodos()
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
      notifySuccess(t('notifications.entrySaved'))
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
      await reloadTodos()
      setEditingEntry(undefined)
      editingContentRef.current = undefined
      notifySuccess(t('notifications.entryUpdated'))
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
        eyebrow={t('page.eyebrow')}
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
          aiPaneOpen ? '' : ' magic-notes-layout--ai-hidden'
        }${
          aiPaneResizing && canResizeAiPane
            ? ' magic-notes-layout--resizing'
            : ''
        }`}
        style={
          {
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
        >
          <PageTabs
            ariaLabel={t('page.contentLabel')}
            idPrefix="magic-library"
            onChange={(value) => {
              setLibraryView(value)
              setCreating(false)
              setValidation(undefined)
              setSearch('')
            }}
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
                void createNote()
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
                  aria-pressed={selectedNoteId === note.id}
                  className={`magic-note-list-item ${
                    selectedNoteId === note.id
                      ? 'magic-note-list-item--active'
                      : ''
                  }`}
                  type="button"
                  onClick={() => {
                    setValidation(undefined)
                    setDeletingNote(false)
                    setEditingEntry(undefined)
                    editingContentRef.current = undefined
                    void loadDetail(note.id)
                  }}
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
                    {t(
                      note.entryCount === 1
                        ? 'notes.entryCountOne'
                        : 'notes.entryCountOther',
                      { count: note.entryCount }
                    )}
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
                            key={todo.id}
                            onSelect={() => {
                              setValidation(undefined)
                              setSelectedTodoId(todo.id)
                            }}
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
                    onClick={() => void loadDetail(detailLoadError.noteId)}
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
                    className="danger-button danger-button--quiet"
                    type="button"
                    onClick={() => setDeletingNote(true)}
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    {t('actions.deleteNote')}
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

              <div className="magic-note-composer">
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
                            onClick={() => {
                              clearValidation('edit-entry')
                              setDeletingEntryId('')
                              setEditingEntry(entry)
                              editingContentRef.current = entry.content
                            }}
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
                  onClick={() => {
                    setLibraryView('notes')
                    void loadDetail(selectedTodo.noteId).then(() => {
                      requestAnimationFrame(() =>
                        document
                          .getElementById(
                            `magic-note-entry-${selectedTodo.entryId}`
                          )
                          ?.scrollIntoView({ block: 'center' })
                      )
                    })
                  }}
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
              <p className="magic-notes-muted">
                {t('comments.selectTodo')}
              </p>
            ) : selectedTodo.comments.length === 0 ? (
              !liveAnalysis && (
                <p className="magic-notes-muted">
                  {t('comments.analyzeTodoHint')}
                </p>
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
            <p className="magic-notes-muted">
              {t('comments.selectNote')}
            </p>
          ) : aiEntries.length === 0 &&
            draftAnalyses.length === 0 &&
            !draftAnalysisRunning &&
            !liveAnalysis ? (
            <p className="magic-notes-muted">
              {commentMode === 'immediate'
                ? t('comments.immediateHint')
                : commentMode === 'after-save-auto'
                  ? t('comments.autoHint')
                  : t('comments.manualHint')}
            </p>
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
