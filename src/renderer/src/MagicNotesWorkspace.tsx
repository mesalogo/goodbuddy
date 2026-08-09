import {
  Bot,
  BookOpen,
  CheckCircle2,
  CircleAlert,
  Circle,
  FileText,
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
import type {
  MagicNoteComment,
  MagicNoteDetail,
  MagicNoteEntry,
  MagicNoteRichContent,
  MagicNoteSummary,
  MagicTodoItem
} from '../../shared/magic-notes-contracts'
import { MagicNoteContent } from './MagicNoteContent'
import { MagicNoteEditor } from './MagicNoteEditor'
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
  projectId?: string
  projectName?: string
}

type LibraryView = 'notes' | 'todos'
type TodoFilter = 'active' | 'completed' | 'all'
type LoadStatus = 'loading' | 'ready' | 'error'
type ValidationTarget =
  | 'create-note'
  | 'create-todo'
  | 'edit-todo'
  | 'note-title'
  | 'new-entry'
  | 'edit-entry'

const libraryTabs: ReadonlyArray<PageTab<LibraryView>> = [
  { id: 'notes', label: '笔记', icon: <BookOpen size={14} /> },
  { id: 'todos', label: '待办', icon: <ListTodo size={14} /> }
]

const todoFilters = [
  { value: 'active', label: '未完成' },
  { value: 'completed', label: '已完成' },
  { value: 'all', label: '全部' }
] as const

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})

function noteSummary(note: MagicNoteDetail): MagicNoteSummary {
  return {
    id: note.id,
    projectId: note.projectId,
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

function errorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  return error instanceof Error ? error.message : '操作失败，请重试'
}

function AiComment({
  comment
}: {
  comment: MagicNoteComment
}): React.JSX.Element {
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
          {comment.kind === 'warning'
            ? '提醒'
            : comment.kind === 'suggestion'
              ? '建议'
              : '摘要'}
        </strong>
        <p>{comment.content}</p>
      </div>
    </div>
  )
}

export function MagicNotesWorkspace({
  onNotify,
  projectId,
  projectName
}: MagicNotesWorkspaceProps): React.JSX.Element {
  const [notes, setNotes] = useState<MagicNoteSummary[]>([])
  const [todos, setTodos] = useState<MagicTodoItem[]>([])
  const [libraryView, setLibraryView] = useState<LibraryView>('notes')
  const [todoFilter, setTodoFilter] = useState<TodoFilter>('active')
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
  const [newTodoTitle, setNewTodoTitle] = useState('')
  const [newTodoInstructions, setNewTodoInstructions] = useState('')
  const [editingTodo, setEditingTodo] = useState(false)
  const [todoTitleDraft, setTodoTitleDraft] = useState('')
  const [todoInstructionsDraft, setTodoInstructionsDraft] = useState('')
  const [deletingTodo, setDeletingTodo] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [deletingNote, setDeletingNote] = useState(false)
  const [composerKey, setComposerKey] = useState(0)
  const [editingEntry, setEditingEntry] = useState<MagicNoteEntry>()
  const [deletingEntryId, setDeletingEntryId] = useState('')
  const [aiPaneOpen, setAiPaneOpen] = useState(true)
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

  const notifyError = useCallback(
    (error: unknown): void =>
      onNotify({
        tone: 'error',
        message: errorMessage(error),
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
      notifyInfo('请等待当前操作完成')
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
    setTodoTitleDraft(next.title)
    setTodoInstructionsDraft(next.instructions)
  }, [])

  const loadDetail = useCallback(
    async (noteId: string): Promise<void> => {
      const requestId = ++detailRequestRef.current
      requestedNoteIdRef.current = noteId
      setDetailLoadError(undefined)
      try {
        const nextDetail = await window.goodbuddy.magicNotes.get(noteId)
        if (detailRequestRef.current === requestId) {
          setSelectedNoteId(noteId)
          applyDetail(nextDetail)
        }
      } catch (loadError) {
        if (detailRequestRef.current === requestId) {
          setDetailLoadError({
            message: errorMessage(loadError),
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
          window.goodbuddy.magicNotes.list(projectId),
          window.goodbuddy.magicNotes.listTodos(projectId)
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
          const message = errorMessage(loadError)
          if (hasLoadedRef.current) {
            setRefreshError(message)
          } else {
            setLoadError(message)
            setLoadStatus('error')
          }
        }
      }
    },
    [projectId]
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

  const selectedTodo = useMemo(
    () => todos.find((todo) => todo.id === selectedTodoId),
    [selectedTodoId, todos]
  )

  const reloadTodos = useCallback(async (): Promise<void> => {
    const snapshot = await window.goodbuddy.magicNotes.listTodos(projectId)
    setTodos(snapshot.todos)
    setSelectedTodoId((current) =>
      snapshot.todos.some((todo) => todo.id === current)
        ? current
        : snapshot.todos[0]?.id ?? ''
    )
  }, [projectId])

  const aiEntries = useMemo(
    () =>
      [...(detail?.entries ?? [])]
        .filter((entry) => entry.comments.length > 0)
        .reverse(),
    [detail]
  )

  const createNote = async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title) {
      setValidation({ target: 'create-note', message: '请输入笔记标题' })
      return
    }
    clearValidation('create-note')
    const operation = 'create-note'
    if (!beginBusy(operation)) {
      return
    }
    try {
      const created = await window.goodbuddy.magicNotes.create({
        projectId,
        title
      })
      applyDetail(created)
      requestedNoteIdRef.current = created.id
      setSelectedNoteId(created.id)
      setNewTitle('')
      setCreating(false)
      notifySuccess('笔记已创建')
    } catch (createError) {
      notifyError(createError)
    } finally {
      endBusy(operation)
    }
  }

  const createManualTodo = async (): Promise<void> => {
    const title = newTodoTitle.trim()
    if (!title) {
      setValidation({ target: 'create-todo', message: '请输入待办标题' })
      return
    }
    clearValidation('create-todo')
    const operation = 'create-todo'
    if (!beginBusy(operation)) {
      return
    }
    try {
      const created = await window.goodbuddy.magicNotes.createTodo({
        projectId,
        title,
        instructions: newTodoInstructions.trim()
      })
      applyTodo(created)
      setNewTodoTitle('')
      setNewTodoInstructions('')
      setCreating(false)
      notifySuccess('待办已创建')
    } catch (createError) {
      notifyError(createError)
    } finally {
      endBusy(operation)
    }
  }

  const toggleTodo = async (todo: MagicTodoItem): Promise<void> => {
    const operation = `toggle-todo-${todo.id}`
    if (!beginBusy(operation)) {
      return
    }
    try {
      const updated = await window.goodbuddy.magicNotes.updateTodo({
        todoId: todo.id,
        completed: !todo.completed,
        expectedRevision: todo.revision
      })
      applyTodo(updated)
      if (updated.noteId && updated.noteId === detail?.id) {
        applyDetail(await window.goodbuddy.magicNotes.get(updated.noteId))
      }
    } catch (updateError) {
      notifyError(updateError)
    } finally {
      endBusy(operation)
    }
  }

  const saveTodo = async (): Promise<void> => {
    if (!selectedTodo || selectedTodo.source !== 'manual') {
      return
    }
    const title = todoTitleDraft.trim()
    if (!title) {
      setValidation({ target: 'edit-todo', message: '待办标题不能为空' })
      return
    }
    clearValidation('edit-todo')
    const operation = `save-todo-${selectedTodo.id}`
    if (!beginBusy(operation)) {
      return
    }
    try {
      applyTodo(
        await window.goodbuddy.magicNotes.updateTodo({
          todoId: selectedTodo.id,
          title,
          instructions: todoInstructionsDraft.trim(),
          expectedRevision: selectedTodo.revision
        })
      )
      setEditingTodo(false)
      notifySuccess('待办已更新')
    } catch (updateError) {
      notifyError(updateError)
    } finally {
      endBusy(operation)
    }
  }

  const removeTodo = async (): Promise<void> => {
    if (!selectedTodo || selectedTodo.source !== 'manual') {
      return
    }
    const operation = `delete-todo-${selectedTodo.id}`
    if (!beginBusy(operation)) {
      return
    }
    try {
      await window.goodbuddy.magicNotes.removeTodo(selectedTodo.id)
      setDeletingTodo(false)
      await reloadTodos()
      notifySuccess('待办已删除')
    } catch (deleteError) {
      notifyError(deleteError)
    } finally {
      endBusy(operation)
    }
  }

  const analyzeTodo = async (todoId: string): Promise<void> => {
    const operation = `analyze-todo-${todoId}`
    if (!beginBusy(operation)) {
      return
    }
    try {
      applyTodo(await window.goodbuddy.magicNotes.analyzeTodo(todoId))
      notifySuccess('AI 评论已更新')
    } catch (analysisError) {
      notifyError(analysisError)
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
      setValidation({ target: 'note-title', message: '笔记标题不能为空' })
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
      setValidation({ target: 'new-entry', message: '请先输入记录内容' })
      return
    }
    clearValidation('new-entry')
    const operation = 'create-entry'
    if (!beginBusy(operation)) {
      return
    }
    try {
      const updated = await window.goodbuddy.magicNotes.createEntry({
        noteId: detail.id,
        content: composerContent
      })
      applyDetail(updated)
      await reloadTodos()
      composerContentRef.current = undefined
      setComposerKey((current) => current + 1)
      notifySuccess('记录已保存')
    } catch (saveError) {
      notifyError(saveError)
    } finally {
      endBusy(operation)
    }
  }

  const saveEditedEntry = async (): Promise<void> => {
    const editingContent = editingContentRef.current
    if (!editingEntry || !editingContent || !hasContent(editingContent)) {
      setValidation({ target: 'edit-entry', message: '记录内容不能为空' })
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
      notifySuccess('记录已更新，原 AI 评论已清除')
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
    try {
      applyDetail(await window.goodbuddy.magicNotes.analyze(entryId))
      notifySuccess('AI 评论已更新')
    } catch (analysisError) {
      notifyError(analysisError)
    } finally {
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
              {aiPaneOpen ? '隐藏 AI 评论' : '显示 AI 评论'}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                setValidation(undefined)
                setCreating(true)
              }}
            >
              <Plus aria-hidden="true" size={15} />
              {libraryView === 'notes' ? '新建笔记' : '新建待办'}
            </button>
          </>
        }
        description="连续记录富文本、本地图片和待办清单，由 AI 提供只读评论。"
        eyebrow="MAGIC NOTES"
        headingId="magic-notes-title"
        icon={<Sparkles size={20} />}
        scope={
          projectId && projectName
            ? { kind: 'project', projectName }
            : { kind: 'global' }
        }
        title="魔法笔记"
      />

      {loadStatus === 'error' ? (
        <EmptyState
          action={
            <button
              className="secondary-button"
              onClick={() => void refreshNotes()}
              type="button"
            >
              重试
            </button>
          }
          description={`无法加载魔法笔记：${loadError}`}
          icon={<CircleAlert size={24} />}
          level="page"
          title="魔法笔记加载失败"
        />
      ) : (
        <>
          {refreshError && (
            <div className="magic-note-delete-confirmation" role="alert">
              <span>刷新失败，已保留当前内容：{refreshError}</span>
              <button
                className="secondary-button"
                onClick={() => void refreshNotes(selectedNoteId)}
                type="button"
              >
                重试
              </button>
            </div>
          )}
      <div
        aria-busy={Boolean(busy)}
        className={`magic-notes-layout${
          aiPaneOpen ? '' : ' magic-notes-layout--ai-hidden'
        }`}
      >
        <aside
          aria-label={libraryView === 'notes' ? '笔记列表' : '待办列表'}
          className="magic-notes-list-pane"
        >
          <PageTabs
            ariaLabel="魔法笔记内容"
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
            <strong>笔记</strong>
            <span>{notes.length}</span>
          </div>
          <label className="magic-notes-search">
            <span className="sr-only">搜索当前范围的笔记</span>
            <input
              placeholder="搜索笔记"
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
                <span>笔记标题</span>
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
                  取消
                </button>
                <button
                  className="primary-button"
                  disabled={busy === 'create-note'}
                  type="submit"
                >
                  创建笔记
                </button>
              </div>
            </form>
          )}
          <div className="magic-notes-list">
            {loadStatus === 'loading' ? (
              <p className="magic-notes-muted">正在加载笔记…</p>
            ) : visibleNotes.length === 0 ? (
              <>
                <p className="magic-notes-muted">
                  {search.trim()
                    ? '没有符合条件的笔记'
                    : '还没有笔记'}
                </p>
                {search.trim() && (
                  <button
                    className="secondary-button"
                    onClick={() => setSearch('')}
                    type="button"
                  >
                    清除筛选
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
                    {note.pinned && <Pin aria-label="已置顶" size={12} />}
                    {note.title}
                  </span>
                  <span className="magic-note-list-item__preview">
                    {note.preview || '还没有记录'}
                  </span>
                  <span className="magic-note-list-item__meta">
                    {note.entryCount} 条记录
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
                <strong>全部待办</strong>
                <span>{todos.length}</span>
              </div>
              <label className="magic-notes-search">
                <span className="sr-only">搜索当前范围的待办</span>
                <input
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索待办"
                  type="search"
                  value={search}
                />
              </label>
              <SegmentedControl
                ariaLabel="筛选待办"
                onChange={setTodoFilter}
                options={todoFilters}
                value={todoFilter}
              />
              {creating && (
                <form
                  className="magic-notes-create"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void createManualTodo()
                  }}
                >
                  <label>
                    <span>待办标题</span>
                    <input
                      aria-describedby={
                        validation?.target === 'create-todo'
                          ? 'magic-todo-create-error'
                          : undefined
                      }
                      aria-invalid={validation?.target === 'create-todo'}
                      autoFocus
                      maxLength={120}
                      onChange={(event) => {
                        setNewTodoTitle(event.target.value)
                        clearValidation('create-todo')
                      }}
                      value={newTodoTitle}
                    />
                  </label>
                  {validation?.target === 'create-todo' && (
                    <small
                      className="magic-notes-field-error"
                      id="magic-todo-create-error"
                      role="alert"
                    >
                      {validation.message}
                    </small>
                  )}
                  <label>
                    <span>说明</span>
                    <textarea
                      maxLength={20_000}
                      onChange={(event) =>
                        setNewTodoInstructions(event.target.value)
                      }
                      rows={3}
                      value={newTodoInstructions}
                    />
                  </label>
                  <div>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setCreating(false)
                        clearValidation('create-todo')
                      }}
                      type="button"
                    >
                      取消
                    </button>
                    <button
                      className="primary-button"
                      disabled={busy === 'create-todo'}
                      type="submit"
                    >
                      创建待办
                    </button>
                  </div>
                </form>
              )}
              <div className="magic-notes-list">
                {loadStatus === 'loading' ? (
                  <p className="magic-notes-muted">正在加载待办…</p>
                ) : visibleTodos.length === 0 ? (
                  <>
                    <p className="magic-notes-muted">
                      {todos.length === 0
                        ? '还没有待办'
                        : search.trim() || todoFilter !== 'all'
                          ? '没有符合条件的待办'
                          : '还没有待办'}
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
                          清除筛选
                        </button>
                      )}
                  </>
                ) : (
                  visibleTodos.map((todo) => (
                    <button
                      aria-pressed={selectedTodoId === todo.id}
                      className={`magic-todo-list-item ${
                        selectedTodoId === todo.id
                          ? 'magic-todo-list-item--active'
                          : ''
                      }`}
                      key={todo.id}
                      onClick={() => {
                        setValidation(undefined)
                        setSelectedTodoId(todo.id)
                        setEditingTodo(false)
                        setDeletingTodo(false)
                      }}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="magic-todo-list-item__check"
                      >
                        {todo.completed ? (
                          <CheckCircle2 size={16} />
                        ) : (
                          <Circle size={16} />
                        )}
                      </span>
                      <span>
                        <strong>{todo.title}</strong>
                        <small>
                          {todo.source === 'note'
                            ? `笔记：${todo.noteTitle ?? '未命名笔记'}`
                            : '手动待办'}
                        </small>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </aside>

        <section
          aria-label={libraryView === 'notes' ? '笔记记录' : '待办详情'}
          className="magic-notes-stream-pane"
        >
          {libraryView === 'notes' ? (
            !detail ? (
            <EmptyState
              description="从左侧选择笔记，或新建一篇笔记开始记录。"
              icon={<FileText size={24} />}
              title={
                loadStatus === 'loading' ? '正在加载' : '还没有选择笔记'
              }
            />
          ) : (
            <>
              {detailLoadError && (
                <div className="magic-note-delete-confirmation" role="alert">
                  <span>
                    笔记加载失败，已保留当前内容：
                    {detailLoadError.message}
                  </span>
                  <button
                    className="secondary-button"
                    onClick={() => void loadDetail(detailLoadError.noteId)}
                    type="button"
                  >
                    重试
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
                  aria-label="笔记标题"
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
                    aria-label={detail.pinned ? '取消置顶' : '置顶笔记'}
                    className="icon-button"
                    title={detail.pinned ? '取消置顶' : '置顶笔记'}
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
                    aria-label="删除笔记"
                    className="danger-ghost icon-button"
                    title="删除笔记"
                    type="button"
                    onClick={() => setDeletingNote(true)}
                  >
                    <Trash2 size={15} />
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
                  <span>删除“{detail.title}”及其中全部记录？</span>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setDeletingNote(false)}
                  >
                    取消
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
                          notifySuccess('笔记已删除')
                          setDeletingNote(false)
                          await refreshNotes()
                        })
                        .catch((deleteError) =>
                          notifyError(deleteError)
                        )
                        .finally(() => endBusy(operation))
                    }}
                  >
                    删除笔记
                  </button>
                </div>
              )}

              <div className="magic-note-composer">
                <MagicNoteEditor
                  key={composerKey}
                  ariaDescribedBy={
                    validation?.target === 'new-entry'
                      ? 'magic-note-entry-create-error'
                      : undefined
                  }
                  ariaInvalid={validation?.target === 'new-entry'}
                  ariaLabel="新记录内容"
                  onChange={(content) => {
                    composerContentRef.current = content
                    clearValidation('new-entry')
                  }}
                  onError={(message) =>
                    setValidation({ target: 'new-entry', message })
                  }
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
                  <span>支持富文本、粘贴或拖入本地图片</span>
                  <button
                    className="primary-button"
                    disabled={busy === 'create-entry'}
                    type="button"
                    onClick={() => void saveEntry()}
                  >
                    保存记录
                  </button>
                </footer>
              </div>

              <div className="magic-note-entry-stream">
                {detail.entries.length === 0 ? (
                  <p className="magic-notes-muted">
                    还没有记录，在上方写下第一条内容。
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
                          <button
                            className="secondary-button"
                            disabled={busy === `analyze-${entry.id}`}
                            type="button"
                            onClick={() => void analyzeEntry(entry.id)}
                          >
                            <Bot size={14} />
                            {busy === `analyze-${entry.id}`
                              ? '分析中…'
                              : entry.analyzedAt
                                ? '重新分析'
                                : 'AI 分析'}
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => {
                              clearValidation('edit-entry')
                              setEditingEntry(entry)
                              editingContentRef.current = entry.content
                            }}
                          >
                            编辑
                          </button>
                          <button
                            aria-label="删除记录"
                            className="danger-ghost icon-button"
                            title="删除记录"
                            type="button"
                            onClick={() => setDeletingEntryId(entry.id)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </header>
                      {deletingEntryId === entry.id && (
                        <div className="magic-note-entry__delete">
                          <span>删除这条记录？此操作不可撤销。</span>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => setDeletingEntryId('')}
                          >
                            取消
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
                                  notifySuccess('记录已删除')
                                })
                                .catch((deleteError) =>
                                  notifyError(deleteError)
                                )
                                .finally(() => endBusy(operation))
                            }}
                          >
                            删除记录
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
                            ariaLabel="编辑记录内容"
                            initialContent={entry.content}
                            onChange={(content) => {
                              editingContentRef.current = content
                              clearValidation('edit-entry')
                            }}
                            onError={(message) =>
                              setValidation({
                                target: 'edit-entry',
                                message
                              })
                            }
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
                          <div>
                            <button
                              className="secondary-button"
                              type="button"
                              onClick={() => {
                                setEditingEntry(undefined)
                                editingContentRef.current = undefined
                                clearValidation('edit-entry')
                              }}
                            >
                              取消
                            </button>
                            <button
                              className="primary-button"
                              disabled={busy === `edit-${entry.id}`}
                              type="button"
                              onClick={() => void saveEditedEntry()}
                            >
                              保存修改
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
              description="从左侧选择待办，或新建一个手动待办。"
              icon={<ListTodo size={24} />}
              title={
                loadStatus === 'loading' ? '正在加载' : '还没有选择待办'
              }
            />
          ) : (
            <section className="magic-todo-detail">
              <header>
                <button
                  aria-label={
                    selectedTodo.completed ? '标记为未完成' : '标记为已完成'
                  }
                  className="magic-todo-detail__check"
                  disabled={busy === `toggle-todo-${selectedTodo.id}`}
                  onClick={() => void toggleTodo(selectedTodo)}
                  type="button"
                >
                  {selectedTodo.completed ? (
                    <CheckCircle2 size={24} />
                  ) : (
                    <Circle size={24} />
                  )}
                </button>
                <div>
                  <span>
                    {selectedTodo.source === 'note'
                      ? `来自笔记：${selectedTodo.noteTitle ?? '未命名笔记'}`
                      : '手动待办'}
                  </span>
                  <h2>{selectedTodo.title}</h2>
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
                      ? '分析中…'
                      : selectedTodo.analyzedAt
                        ? '重新分析'
                        : 'AI 分析'}
                  </button>
                  {selectedTodo.source === 'manual' && (
                    <>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          clearValidation('edit-todo')
                          setTodoTitleDraft(selectedTodo.title)
                          setTodoInstructionsDraft(
                            selectedTodo.instructions
                          )
                          setEditingTodo(true)
                        }}
                        type="button"
                      >
                        编辑
                      </button>
                      <button
                        aria-label="删除待办"
                        className="danger-ghost icon-button"
                        onClick={() => setDeletingTodo(true)}
                        title="删除待办"
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </header>

              {deletingTodo && (
                <div className="magic-note-delete-confirmation">
                  <span>删除“{selectedTodo.title}”？此操作不可撤销。</span>
                  <button
                    className="secondary-button"
                    onClick={() => setDeletingTodo(false)}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="danger-solid"
                    disabled={busy === `delete-todo-${selectedTodo.id}`}
                    onClick={() => void removeTodo()}
                    type="button"
                  >
                    删除待办
                  </button>
                </div>
              )}

              {editingTodo && selectedTodo.source === 'manual' ? (
                <form
                  className="magic-todo-detail__editor"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void saveTodo()
                  }}
                >
                  <label>
                    <span>待办标题</span>
                    <input
                      aria-describedby={
                        validation?.target === 'edit-todo'
                          ? 'magic-todo-edit-error'
                          : undefined
                      }
                      aria-invalid={validation?.target === 'edit-todo'}
                      maxLength={120}
                      onChange={(event) => {
                        setTodoTitleDraft(event.target.value)
                        clearValidation('edit-todo')
                      }}
                      value={todoTitleDraft}
                    />
                  </label>
                  {validation?.target === 'edit-todo' && (
                    <small
                      className="magic-notes-field-error"
                      id="magic-todo-edit-error"
                      role="alert"
                    >
                      {validation.message}
                    </small>
                  )}
                  <label>
                    <span>说明</span>
                    <textarea
                      maxLength={20_000}
                      onChange={(event) =>
                        setTodoInstructionsDraft(event.target.value)
                      }
                      rows={8}
                      value={todoInstructionsDraft}
                    />
                  </label>
                  <div>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setEditingTodo(false)
                        clearValidation('edit-todo')
                      }}
                      type="button"
                    >
                      取消
                    </button>
                    <button
                      className="primary-button"
                      disabled={busy === `save-todo-${selectedTodo.id}`}
                      type="submit"
                    >
                      保存待办
                    </button>
                  </div>
                </form>
              ) : (
                <div className="magic-todo-detail__content">
                  <p>
                    {selectedTodo.instructions ||
                      (selectedTodo.source === 'note'
                        ? '此待办来自笔记正文中的待办清单。'
                        : '尚未添加说明。')}
                  </p>
                  {selectedTodo.source === 'note' &&
                    selectedTodo.noteId &&
                    selectedTodo.entryId && (
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setLibraryView('notes')
                          void loadDetail(selectedTodo.noteId!).then(() => {
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
                        打开原笔记
                      </button>
                    )}
                </div>
              )}
            </section>
          )}
        </section>

        <aside
          aria-label="AI 评论"
          className="magic-notes-ai-pane"
          hidden={!aiPaneOpen}
          id="magic-notes-ai-pane"
        >
          <div className="magic-notes-pane-heading">
            <strong>AI 评论</strong>
            <button
              aria-label="关闭 AI 评论面板"
              className="icon-button"
              onClick={() => setAiPaneOpen(false)}
              title="关闭 AI 评论面板"
              type="button"
            >
              <PanelRightClose aria-hidden="true" size={15} />
            </button>
          </div>
          {libraryView === 'todos' ? (
            !selectedTodo ? (
              <p className="magic-notes-muted">选择待办后显示 AI 评论。</p>
            ) : selectedTodo.comments.length === 0 ? (
              <p className="magic-notes-muted">
                点击待办详情中的“AI 分析”，评论会显示在这里。
              </p>
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
            <p className="magic-notes-muted">选择笔记后显示 AI 评论。</p>
          ) : aiEntries.length === 0 ? (
            <p className="magic-notes-muted">
              在记录上点击“AI 分析”，评论会显示在这里。
            </p>
          ) : (
            <div className="magic-notes-ai-feed">
              {aiEntries.map((entry) => (
                <section className="magic-notes-ai-group" key={entry.id}>
                  <a href={`#magic-note-entry-${entry.id}`}>
                    {dateFormatter.format(new Date(entry.createdAt))} 的记录
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
