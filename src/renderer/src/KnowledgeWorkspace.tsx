import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CirclePause,
  Database,
  FilePlus2,
  FileText,
  FolderOpen,
  GitMerge,
  Link2,
  ListChecks,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
  UploadCloud,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  EmptyState,
  PageHeader,
  PageTabs,
  type PageTab
} from './WorkspacePrimitives'
import { KnowledgeGraphChart } from './KnowledgeGraphChart'
import { trapTabFocus } from './dialog-focus'

export type KnowledgeStorageMode = 'reference' | 'managed'
export type KnowledgeGraphStrategy =
  | 'rules'
  | 'model'
  | 'hybrid'
  | 'ask'
export type KnowledgeSourceKind = 'file' | 'directory' | 'url'
export type KnowledgeSourceStatus =
  | 'queued'
  | 'syncing'
  | 'paused'
  | 'ready'
  | 'failed'
export type KnowledgeDocumentStatus =
  | 'queued'
  | 'parsing'
  | 'indexing'
  | 'ready'
  | 'failed'

export type KnowledgeLibrary = {
  id: string
  name: string
  description?: string
  storageMode: KnowledgeStorageMode
  graphEnabled: boolean
  graphStrategy: KnowledgeGraphStrategy
  sourceCount: number
  documentCount: number
  indexedDocumentCount: number
  updatedAt?: string
}

export type CreateKnowledgeLibraryInput = {
  name: string
  description: string
  storageMode: KnowledgeStorageMode
  graphEnabled: boolean
  graphStrategy: KnowledgeGraphStrategy
}

export type KnowledgeSource = {
  id: string
  libraryId: string
  name: string
  kind: KnowledgeSourceKind
  location?: string
  status: KnowledgeSourceStatus
  progress?: number
  documentCount: number
  lastSyncedAt?: string
  error?: string
}

export type KnowledgeDocumentItem = {
  id: string
  libraryId: string
  sourceId?: string
  name: string
  path?: string
  status: KnowledgeDocumentStatus
  indexProgress?: number
  chunkCount?: number
  size?: number
  updatedAt?: string
  error?: string
}

export type KnowledgeGraphNode = {
  id: string
  label: string
  type: string
  description?: string
  aliases?: readonly string[]
  x: number
  y: number
  evidenceIds?: readonly string[]
}

export type KnowledgeGraphRelation = {
  id: string
  sourceId: string
  targetId: string
  type: string
  description?: string
  evidenceIds?: readonly string[]
}

export type KnowledgeEvidence = {
  id: string
  documentId: string
  documentName: string
  excerpt: string
  location?: string
}

export type KnowledgeTaskItem = {
  id: string
  libraryId: string
  sourceId?: string
  documentId?: string
  documentName: string
  kind: 'parsing' | 'embedding' | 'graph'
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
  progress: number
  message?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
}

export type KnowledgeEntityUpdate = {
  label: string
  type: string
  description: string
  aliases: string[]
}

export type KnowledgeRelationInput = {
  sourceId: string
  targetId: string
  type: string
  description: string
}

export type KnowledgeWorkspaceProps = {
  libraries: readonly KnowledgeLibrary[]
  selectedLibraryId?: string
  sources: readonly KnowledgeSource[]
  documents: readonly KnowledgeDocumentItem[]
  graphNodes: readonly KnowledgeGraphNode[]
  graphRelations: readonly KnowledgeGraphRelation[]
  evidence: readonly KnowledgeEvidence[]
  tasks?: readonly KnowledgeTaskItem[]
  loading?: boolean
  loadError?: string
  onRetryLoad: () => void | Promise<void>
  onSelectLibrary: (libraryId: string) => void
  onCreateLibrary: (
    input: CreateKnowledgeLibraryInput
  ) => void | Promise<void>
  onDeleteLibrary: (libraryId: string) => void | Promise<void>
  onUpdateLibrary: (
    libraryId: string,
    update: {
      name?: string
      description?: string
      graphEnabled?: boolean
      graphStrategy?: KnowledgeGraphStrategy
    }
  ) => void | Promise<void>
  onReextractGraph: (libraryId: string) => void | Promise<void>
  onImportFiles: (
    libraryId: string,
    files: File[],
    graphStrategy?: Exclude<KnowledgeGraphStrategy, 'ask'>
  ) => void | Promise<void>
  onImportDirectory: (
    libraryId: string,
    files: File[],
    graphStrategy?: Exclude<KnowledgeGraphStrategy, 'ask'>
  ) => void | Promise<void>
  onImportUrl: (
    libraryId: string,
    url: string,
    graphStrategy?: Exclude<KnowledgeGraphStrategy, 'ask'>
  ) => void | Promise<void>
  onSyncSource: (sourceId: string) => void | Promise<void>
  onPauseSource: (sourceId: string) => void | Promise<void>
  onRetrySource: (sourceId: string) => void | Promise<void>
  onRemoveSource: (sourceId: string) => void | Promise<void>
  onMoveNode: (
    nodeId: string,
    position: { x: number; y: number }
  ) => void
  onCreateEntity: (
    input: KnowledgeEntityUpdate
  ) => void | Promise<void>
  onUpdateEntity: (
    nodeId: string,
    update: KnowledgeEntityUpdate
  ) => void | Promise<void>
  onDeleteEntity: (nodeId: string) => void | Promise<void>
  onMergeEntities: (
    sourceNodeId: string,
    targetNodeId: string
  ) => void | Promise<void>
  onCreateRelation: (
    relation: KnowledgeRelationInput
  ) => void | Promise<void>
  onUpdateRelation: (
    relationId: string,
    relation: KnowledgeRelationInput
  ) => void | Promise<void>
  onDeleteRelation: (relationId: string) => void | Promise<void>
  onOpenEvidence?: (evidence: KnowledgeEvidence) => void
}

type WorkspaceTab = 'documents' | 'graph' | 'tasks' | 'settings'

const storageModeLabels: Record<KnowledgeStorageMode, string> = {
  reference: '引用原文件',
  managed: '托管副本'
}

const strategyLabels: Record<KnowledgeGraphStrategy, string> = {
  rules: '规则抽取',
  model: '模型抽取',
  hybrid: '规则与模型',
  ask: '按需询问'
}

const sourceStatusLabels: Record<KnowledgeSourceStatus, string> = {
  queued: '等待同步',
  syncing: '同步中',
  paused: '已暂停',
  ready: '已同步',
  failed: '同步失败'
}

const documentStatusLabels: Record<KnowledgeDocumentStatus, string> = {
  queued: '等待处理',
  parsing: '解析中',
  indexing: '索引中',
  ready: '索引完成',
  failed: '处理失败'
}

const styles = {
  workspace: {
    display: 'grid',
    overflow: 'hidden',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-card)',
    background: 'var(--surface-canvas)',
    color: 'var(--text-primary)'
  },
  surface: {
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-control)',
    background: 'var(--surface-raised)'
  },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-2)'
  },
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
    minHeight: 'var(--control-height)',
    padding: 'var(--space-2) var(--space-3)',
    border: '1px solid var(--border-control)',
    borderRadius: 'var(--radius-control)',
    background: 'var(--surface-raised)',
    color: 'var(--text-primary)',
    font: 'inherit'
  },
  label: {
    display: 'grid',
    gap: 'var(--space-2)',
    color: 'var(--text-secondary)',
    fontSize: 'var(--font-body)',
    fontWeight: 650
  },
  muted: {
    color: 'var(--text-muted)',
    fontSize: 'var(--font-body)',
    lineHeight: 1.55
  }
} as const

function clampProgress(progress: number | undefined): number {
  if (!Number.isFinite(progress)) {
    return 0
  }
  return Math.min(100, Math.max(0, progress ?? 0))
}

function formatTime(value: string | undefined): string {
  if (!value) {
    return '尚未同步'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '时间未知'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function formatSize(size: number | undefined): string {
  if (!Number.isFinite(size) || (size ?? 0) < 0) {
    return '大小未知'
  }
  const value = size ?? 0
  if (value < 1024) {
    return `${value} B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatDocumentLocation(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${url.pathname}`
    }
  } catch {
    // Local paths are intentionally reduced below.
  }
  const filename = value.split(/[\\/]/u).filter(Boolean).at(-1)
  return filename ? `本地文件 · ${filename}` : '本地文件'
}

function toErrorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : '操作未完成，请重试。'
}

function ProgressBar({
  label,
  progress
}: {
  label: string
  progress: number | undefined
}): React.JSX.Element {
  const value = clampProgress(progress)
  return (
    <div
      aria-label={`${label} ${Math.round(value)}%`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={value}
      role="progressbar"
      style={{
        height: 5,
        overflow: 'hidden',
        borderRadius: 999,
        background: 'var(--surface-muted)'
      }}
    >
      <span
        style={{
          display: 'block',
          width: `${value}%`,
          height: '100%',
          background:
            value === 100 ? 'var(--success)' : 'var(--accent)',
          transition: 'width .2s ease'
        }}
      />
    </div>
  )
}

function CreateLibraryWizard({
  onCancel,
  onCreate
}: {
  onCancel: () => void
  onCreate: KnowledgeWorkspaceProps['onCreateLibrary']
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [storageMode, setStorageMode] =
    useState<KnowledgeStorageMode>('reference')
  const [graphEnabled, setGraphEnabled] = useState(true)
  const [graphStrategy, setGraphStrategy] =
    useState<KnowledgeGraphStrategy>('rules')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    if (!name.trim()) {
      setError('请输入知识库名称。')
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim(),
        storageMode,
        graphEnabled,
        graphStrategy
      })
      onCancel()
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      aria-label="创建知识库"
      onSubmit={(event) => void submit(event)}
      style={{
        ...styles.surface,
        display: 'grid',
        gap: 14,
        padding: 16,
        margin: 20
      }}
    >
      <div>
        <span style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 800 }}>
          新建知识库
        </span>
        <h2 style={{ margin: '5px 0 0', fontSize: 22 }}>创建知识库</h2>
      </div>
      <label style={styles.label}>
        名称
        <input
          autoFocus
          onChange={(event) => setName(event.currentTarget.value)}
          style={styles.input}
          value={name}
        />
      </label>
      <label style={styles.label}>
        描述
        <textarea
          onChange={(event) =>
            setDescription(event.currentTarget.value)
          }
          rows={3}
          style={{ ...styles.input, resize: 'vertical' }}
          value={description}
        />
      </label>
      <fieldset
        style={{
          display: 'grid',
          gap: 8,
          margin: 0,
          padding: 0,
          border: 0
        }}
      >
        <legend style={{ ...styles.label, marginBottom: 8 }}>存储方式</legend>
        {(
          [
            [
              'reference',
              '引用原文件',
              '仅记录文件位置；删除知识库不会删除原文件。'
            ],
            [
              'managed',
              '托管副本',
              '将内容复制到应用管理的存储空间。'
            ]
          ] as const
        ).map(([value, title, detail]) => (
          <label
            key={value}
            style={{
              ...styles.surface,
              display: 'flex',
              gap: 10,
              padding: 11,
              cursor: 'pointer'
            }}
          >
            <input
              checked={storageMode === value}
              name="storage-mode"
              onChange={() => setStorageMode(value)}
              type="radio"
            />
            <span>
              <strong style={{ display: 'block' }}>{title}</strong>
              <span style={styles.muted}>{detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label
        style={{
          ...styles.surface,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: 12,
          cursor: 'pointer'
        }}
      >
        <input
          checked={graphEnabled}
          onChange={(event) => setGraphEnabled(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>
          <strong style={{ display: 'block' }}>启用知识图谱</strong>
          <span style={styles.muted}>从文档中提取实体、关系与证据。</span>
        </span>
      </label>
      {graphEnabled && (
        <label style={styles.label}>
          图谱生成策略
          <select
            onChange={(event) =>
              setGraphStrategy(
                event.currentTarget.value as KnowledgeGraphStrategy
              )
            }
            style={styles.input}
            value={graphStrategy}
          >
            {Object.entries(strategyLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p
          aria-live="polite"
          role="alert"
          style={{ color: 'var(--danger)', margin: 0 }}
        >
          {error}
        </p>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          className="secondary-button"
          onClick={onCancel}
          style={styles.button}
          type="button"
        >
          取消
        </button>
        <button
          className="primary-button"
          disabled={saving}
          style={styles.button}
          type="submit"
        >
          {saving ? (
            <LoaderCircle aria-hidden="true" size={16} />
          ) : (
            <Check aria-hidden="true" size={16} />
          )}
          {saving ? '创建中…' : '创建知识库'}
        </button>
      </div>
    </form>
  )
}

function EditLibraryDialog({
  library,
  onCancel,
  onConfirm
}: {
  library: KnowledgeLibrary
  onCancel: () => void
  onConfirm: (update: {
    name: string
    description: string
  }) => void | Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(library.name)
  const [description, setDescription] = useState(library.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const submit = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    const normalizedName = name.trim()
    if (!normalizedName) {
      setError('请输入知识库名称')
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await onConfirm({
        name: normalizedName,
        description: description.trim()
      })
      onCancel()
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      aria-label="编辑知识库"
      aria-modal="true"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.preventDefault()
          onCancel()
          return
        }
        trapTabFocus(event, dialogRef.current)
      }}
      ref={dialogRef}
      role="dialog"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        background: 'var(--overlay-backdrop)'
      }}
    >
      <form
        aria-label="编辑知识库表单"
        onSubmit={(event) => void submit(event)}
        style={{
          ...styles.surface,
          display: 'grid',
          width: 'min(480px, 100%)',
          padding: 20,
          boxShadow: 'var(--shadow-dialog)',
          gap: 14
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>编辑知识库</h2>
          <p style={{ ...styles.muted, margin: '6px 0 0' }}>
            修改名称和说明不会改变来源、索引或知识图谱。
          </p>
        </div>
        <label style={styles.label}>
          名称
          <input
            onChange={(event) => setName(event.currentTarget.value)}
            ref={nameRef}
            style={styles.input}
            value={name}
          />
        </label>
        <label style={styles.label}>
          描述
          <textarea
            onChange={(event) => setDescription(event.currentTarget.value)}
            rows={4}
            style={{ ...styles.input, resize: 'vertical' }}
            value={description}
          />
        </label>
        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
            {error}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            className="secondary-button"
            disabled={saving}
            onClick={onCancel}
            style={styles.button}
            type="button"
          >
            取消
          </button>
          <button
            className="primary-button"
            disabled={saving}
            style={styles.button}
            type="submit"
          >
            {saving ? (
              <LoaderCircle aria-hidden="true" size={15} />
            ) : (
              <Check aria-hidden="true" size={15} />
            )}
            {saving ? '保存中…' : '保存修改'}
          </button>
        </div>
      </form>
    </div>
  )
}

function DeleteLibraryDialog({
  library,
  onCancel,
  onConfirm
}: {
  library: KnowledgeLibrary
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}): React.JSX.Element {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const confirm = async (): Promise<void> => {
    setDeleting(true)
    setError(undefined)
    try {
      await onConfirm()
      onCancel()
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      aria-label="删除知识库确认"
      aria-modal="true"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !deleting) {
          event.preventDefault()
          onCancel()
          return
        }
        trapTabFocus(event, dialogRef.current)
      }}
      ref={dialogRef}
      role="dialog"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        background: 'var(--overlay-backdrop)'
      }}
    >
      <div
        style={{
          ...styles.surface,
          width: 'min(440px, 100%)',
          padding: 20,
          boxShadow: 'var(--shadow-dialog)'
        }}
      >
        <AlertCircle color="var(--danger)" aria-hidden="true" size={26} />
        <h2 style={{ margin: '12px 0 8px' }}>删除“{library.name}”？</h2>
        <p style={{ ...styles.muted, margin: 0 }}>
          {library.storageMode === 'managed'
            ? '此知识库使用托管存储。删除后，应用保存的托管副本、索引和图谱都会被永久删除。'
            : '此知识库引用原文件。删除后只会移除索引和图谱，不会删除磁盘上的原文件。'}
        </p>
        {error && (
          <p
            aria-live="polite"
            role="alert"
            style={{ color: 'var(--danger)' }}
          >
            {error}
          </p>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 18
          }}
        >
          <button
            className="secondary-button"
            disabled={deleting}
            onClick={onCancel}
            ref={cancelRef}
            style={styles.button}
            type="button"
          >
            取消
          </button>
          <button
            className="danger-button"
            disabled={deleting}
            onClick={() => void confirm()}
            style={styles.button}
            type="button"
          >
            <Trash2 aria-hidden="true" size={15} />
            {deleting ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DocumentsView({
  documents,
  library,
  onImportDirectory,
  onImportFiles,
  onImportUrl,
  onPauseSource,
  onRemoveSource,
  onRetrySource,
  onSyncSource,
  sources
}: Pick<
  KnowledgeWorkspaceProps,
  | 'documents'
  | 'onImportDirectory'
  | 'onImportFiles'
  | 'onImportUrl'
  | 'onPauseSource'
  | 'onRemoveSource'
  | 'onRetrySource'
  | 'onSyncSource'
  | 'sources'
> & {
  library: KnowledgeLibrary
}): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [urlOpen, setUrlOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const [askStrategy, setAskStrategy] =
    useState<Exclude<KnowledgeGraphStrategy, 'ask'>>('hybrid')
  const importGraphStrategy =
    library.graphStrategy === 'ask' ? askStrategy : undefined

  const run = async (
    id: string,
    action: () => void | Promise<void>
  ): Promise<boolean> => {
    setPending(id)
    setError(undefined)
    try {
      await action()
      return true
    } catch (reason) {
      setError(toErrorMessage(reason))
      return false
    } finally {
      setPending(undefined)
    }
  }

  const importFiles = (files: File[]): void => {
    if (files.length === 0) {
      return
    }
    void run('files', () =>
      onImportFiles(library.id, files, importGraphStrategy)
    )
  }

  const filteredDocuments = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    if (!normalized) {
      return documents
    }
    return documents.filter((document) =>
      `${document.name} ${document.path ?? ''}`
        .toLocaleLowerCase('zh-CN')
        .includes(normalized)
    )
  }, [documents, query])

  return (
    <div className="knowledge-documents" style={{ display: 'grid', gap: 18 }}>
      <section aria-labelledby="sources-title">
        <div
          className="knowledge-documents__section-heading"
        >
          <div>
            <h3 id="sources-title" style={{ margin: 0 }}>
              内容来源
            </h3>
            <p style={{ ...styles.muted, margin: '5px 0 0' }}>
              导入内容后会自动解析、建立索引并更新图谱。
            </p>
          </div>
          <div className="knowledge-documents__import-actions">
            <button
              className="secondary-button"
              onClick={() => fileInputRef.current?.click()}
              style={styles.button}
              type="button"
            >
              <FilePlus2 aria-hidden="true" size={15} />
              导入文件
            </button>
            <button
              className="secondary-button"
              onClick={() =>
                void run('directory', () =>
                  onImportDirectory(
                    library.id,
                    [],
                    importGraphStrategy
                  )
                )
              }
              style={styles.button}
              type="button"
            >
              <FolderOpen aria-hidden="true" size={15} />
              导入目录
            </button>
            <button
              className="secondary-button"
              onClick={() => setUrlOpen((current) => !current)}
              style={styles.button}
              type="button"
            >
              <Link2 aria-hidden="true" size={15} />
              导入 URL
            </button>
            <input
              hidden
              multiple
              onChange={(event) => {
                importFiles(Array.from(event.currentTarget.files ?? []))
                event.currentTarget.value = ''
              }}
              ref={fileInputRef}
              type="file"
            />
          </div>
        </div>

        {library.graphEnabled && library.graphStrategy === 'ask' && (
          <label
            style={{
              ...styles.label,
              maxWidth: 320,
              marginTop: 14
            }}
          >
            本次导入的图谱抽取策略
            <select
              onChange={(event) =>
                setAskStrategy(
                  event.currentTarget.value as Exclude<
                    KnowledgeGraphStrategy,
                    'ask'
                  >
                )
              }
              style={styles.input}
              value={askStrategy}
            >
              <option value="rules">仅本地规则</option>
              <option value="model">仅使用模型</option>
              <option value="hybrid">规则优先并由模型补全</option>
            </select>
          </label>
        )}

        {urlOpen && (
          <form
            aria-label="导入 URL"
            className="knowledge-documents__url-form"
            onSubmit={(event) => {
              event.preventDefault()
              const value = url.trim()
              if (!value) {
                setError('请输入 URL。')
                return
              }
              let parsed: URL
              try {
                parsed = new URL(value)
              } catch {
                setError('请输入有效的 URL。')
                return
              }
              if (!['http:', 'https:'].includes(parsed.protocol)) {
                setError('仅支持 HTTP 或 HTTPS URL。')
                return
              }
              void run(
                'url',
                () =>
                  onImportUrl(
                    library.id,
                    parsed.href,
                    importGraphStrategy
                  )
              ).then((succeeded) => {
                if (succeeded) {
                  setUrl('')
                  setUrlOpen(false)
                }
              })
            }}
            style={{
              ...styles.surface,
              marginTop: 12,
              padding: 12
            }}
          >
            <input
              aria-label="URL 地址"
              onChange={(event) => setUrl(event.currentTarget.value)}
              placeholder="https://"
              style={styles.input}
              type="url"
              value={url}
            />
            <button
              className="primary-button"
              disabled={pending === 'url'}
              style={styles.button}
              type="submit"
            >
              导入
            </button>
            <button
              aria-label="关闭 URL 导入"
              className="secondary-button"
              onClick={() => setUrlOpen(false)}
              style={styles.button}
              type="button"
            >
              <X aria-hidden="true" size={15} />
            </button>
          </form>
        )}

        <div
          onDragEnter={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) {
              setDragging(false)
            }
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            importFiles(Array.from(event.dataTransfer.files))
          }}
          style={{
            marginTop: 12,
            padding: 18,
            border: `1px dashed ${
              dragging ? 'var(--accent)' : 'var(--border-default)'
            }`,
            borderRadius: 8,
            textAlign: 'center',
            background: dragging
              ? 'var(--accent-subtle)'
              : 'var(--surface-subtle)',
            color: dragging ? 'var(--accent)' : 'var(--text-muted)'
          }}
        >
          <UploadCloud aria-hidden="true" size={22} />
          <div style={{ marginTop: 5 }}>
            将文件拖到这里，加入“{library.name}”
          </div>
        </div>

        {error && (
          <p
            aria-live="polite"
            role="alert"
            style={{ color: 'var(--danger)' }}
          >
            {error}
          </p>
        )}

        {sources.length === 0 ? (
          <div style={{ ...styles.surface, marginTop: 12, padding: 18 }}>
            <strong>尚未连接内容来源</strong>
            <p style={{ ...styles.muted, marginBottom: 0 }}>
              可选择文件、目录或 URL；也可以直接将文件拖入上方区域。
            </p>
          </div>
        ) : (
          <ul
            aria-label="内容来源列表"
            style={{
              display: 'grid',
              gap: 9,
              margin: '12px 0 0',
              padding: 0,
              listStyle: 'none'
            }}
          >
            {sources.map((source) => (
              <li
                className="knowledge-source-row"
                key={source.id}
                style={{
                  ...styles.surface,
                  display: 'grid',
                  gap: 12,
                  padding: 12
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      minWidth: 0
                    }}
                  >
                    {source.kind === 'url' ? (
                      <Link2 aria-hidden="true" size={16} />
                    ) : source.kind === 'directory' ? (
                      <FolderOpen aria-hidden="true" size={16} />
                    ) : (
                      <FileText aria-hidden="true" size={16} />
                    )}
                    <strong
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                      title={source.name}
                    >
                      {source.name}
                    </strong>
                    <span
                      style={{
                        padding: '2px 7px',
                        borderRadius: 999,
                        background:
                          source.status === 'failed'
                            ? 'var(--danger-subtle)'
                            : source.status === 'ready'
                              ? 'var(--success-subtle)'
                              : 'var(--accent-subtle)',
                        color:
                          source.status === 'failed'
                            ? 'var(--danger)'
                            : source.status === 'ready'
                              ? 'var(--success)'
                              : 'var(--accent)',
                        fontSize: 12
                      }}
                    >
                      {sourceStatusLabels[source.status]}
                    </span>
                  </div>
                  <div style={{ ...styles.muted, marginTop: 5 }}>
                    {source.documentCount} 个文档 ·{' '}
                    {formatTime(source.lastSyncedAt)}
                  </div>
                  {source.status === 'syncing' && (
                    <div style={{ marginTop: 8 }}>
                      <ProgressBar
                        label={`${source.name} 同步进度`}
                        progress={source.progress}
                      />
                    </div>
                  )}
                  {source.error && (
                    <div
                      style={{
                        color: 'var(--danger)',
                        fontSize: 12,
                        marginTop: 5
                      }}
                    >
                      {source.error}
                    </div>
                  )}
                </div>
                <div className="knowledge-source-row__actions">
                  {source.status === 'syncing' ? (
                    <button
                      aria-label={`暂停 ${source.name}`}
                      className="secondary-button"
                      disabled={pending === source.id}
                      onClick={() =>
                        void run(source.id, () => onPauseSource(source.id))
                      }
                      style={styles.button}
                      type="button"
                    >
                      <CirclePause aria-hidden="true" size={14} />
                      暂停
                    </button>
                  ) : source.status === 'failed' ? (
                    <button
                      aria-label={`重试 ${source.name}`}
                      className="secondary-button"
                      disabled={pending === source.id}
                      onClick={() =>
                        void run(source.id, () => onRetrySource(source.id))
                      }
                      style={styles.button}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" size={14} />
                      重试
                    </button>
                  ) : (
                    <button
                      aria-label={`同步 ${source.name}`}
                      className="secondary-button"
                      disabled={pending === source.id}
                      onClick={() =>
                        void run(source.id, () => onSyncSource(source.id))
                      }
                      style={styles.button}
                      type="button"
                    >
                      <RefreshCw aria-hidden="true" size={14} />
                      同步
                    </button>
                  )}
                  <button
                    aria-label={`移除来源 ${source.name}`}
                    className="danger-button danger-button--quiet"
                    disabled={pending === source.id}
                    onClick={() =>
                      void run(source.id, () => onRemoveSource(source.id))
                    }
                    style={{ ...styles.button, padding: 8 }}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="documents-title">
        <div
          className="knowledge-documents__section-heading"
        >
          <h3 id="documents-title" style={{ margin: 0 }}>
            文档与索引
          </h3>
          <label
            className="knowledge-documents__search"
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center'
            }}
          >
            <Search
              aria-hidden="true"
              size={15}
              style={{
                position: 'absolute',
                left: 11,
                color: 'var(--text-muted)'
              }}
            />
            <span style={{ position: 'absolute', clip: 'rect(0 0 0 0)' }}>
              搜索文档
            </span>
            <input
              aria-label="搜索文档"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="搜索名称或路径"
              style={{ ...styles.input, paddingLeft: 34 }}
              type="search"
              value={query}
            />
          </label>
        </div>
        {filteredDocuments.length === 0 ? (
          <div style={{ ...styles.surface, marginTop: 12, padding: 18 }}>
            {documents.length === 0
              ? '尚无文档。导入内容来源后，处理状态会显示在这里。'
              : '没有与搜索条件匹配的文档。'}
          </div>
        ) : (
          <div className="knowledge-documents__table-scroll">
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13
              }}
            >
              <thead
                style={{
                  color: 'var(--text-secondary)',
                  textAlign: 'left',
                  background: 'var(--surface-subtle)'
                }}
              >
                <tr>
                  <th style={{ padding: '9px 10px' }}>文档</th>
                  <th style={{ padding: '9px 10px' }}>状态</th>
                  <th style={{ padding: '9px 10px' }}>索引进度</th>
                  <th style={{ padding: '9px 10px' }}>分块</th>
                  <th style={{ padding: '9px 10px' }}>大小</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocuments.map((document) => (
                  <tr
                    key={document.id}
                    style={{
                      borderTop: '1px solid var(--border-subtle)'
                    }}
                  >
                    <td style={{ padding: 10 }}>
                      <strong>{document.name}</strong>
                      {document.path && (
                        <div
                          style={{
                            ...styles.muted,
                            maxWidth: 360,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {formatDocumentLocation(document.path)}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: 10 }}>
                      <span
                        style={{
                          color:
                            document.status === 'failed'
                              ? 'var(--danger)'
                              : document.status === 'ready'
                                ? 'var(--success)'
                                : document.status === 'indexing'
                                  ? 'var(--accent)'
                                  : 'var(--warning)'
                        }}
                      >
                        {documentStatusLabels[document.status]}
                      </span>
                      {document.error && (
                        <div
                          style={{ color: 'var(--danger)', marginTop: 4 }}
                        >
                          {document.error}
                        </div>
                      )}
                    </td>
                    <td style={{ minWidth: 140, padding: 10 }}>
                      <ProgressBar
                        label={`${document.name} 索引进度`}
                        progress={
                          document.status === 'ready'
                            ? 100
                            : document.indexProgress
                        }
                      />
                    </td>
                    <td style={{ padding: 10 }}>
                      {document.chunkCount ?? '—'}
                    </td>
                    <td style={{ padding: 10 }}>{formatSize(document.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function EntityEditor({
  node,
  onCancel,
  onSave
}: {
  node?: KnowledgeGraphNode
  onCancel: () => void
  onSave: (update: KnowledgeEntityUpdate) => void | Promise<void>
}): React.JSX.Element {
  const [label, setLabel] = useState(node?.label ?? '')
  const [type, setType] = useState(node?.type ?? '')
  const [description, setDescription] = useState(node?.description ?? '')
  const [aliases, setAliases] = useState((node?.aliases ?? []).join('、'))

  return (
    <form
      aria-label={node ? '编辑实体' : '新增实体'}
      onSubmit={(event) => {
        event.preventDefault()
        void onSave({
          label: label.trim(),
          type: type.trim(),
          description: description.trim(),
          aliases: aliases
            .split(/[、,，]/)
            .map((item) => item.trim())
            .filter(Boolean)
        })
      }}
      style={{ display: 'grid', gap: 10 }}
    >
      <label style={styles.label}>
        名称
        <input
          onChange={(event) => setLabel(event.currentTarget.value)}
          required
          style={styles.input}
          value={label}
        />
      </label>
      <label style={styles.label}>
        类型
        <input
          onChange={(event) => setType(event.currentTarget.value)}
          required
          style={styles.input}
          value={type}
        />
      </label>
      <label style={styles.label}>
        描述
        <textarea
          onChange={(event) => setDescription(event.currentTarget.value)}
          rows={3}
          style={{ ...styles.input, resize: 'vertical' }}
          value={description}
        />
      </label>
      <label style={styles.label}>
        别名（使用逗号分隔）
        <input
          onChange={(event) => setAliases(event.currentTarget.value)}
          style={styles.input}
          value={aliases}
        />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary-button" style={styles.button}>
          {node ? '保存实体' : '新增实体'}
        </button>
        <button
          className="secondary-button"
          onClick={onCancel}
          style={styles.button}
          type="button"
        >
          取消
        </button>
      </div>
    </form>
  )
}

function RelationForm({
  nodes,
  onCancel,
  onSave,
  relation,
  sourceId
}: {
  nodes: readonly KnowledgeGraphNode[]
  onCancel: () => void
  onSave: (
    input: KnowledgeRelationInput
  ) => void | Promise<void>
  relation?: KnowledgeGraphRelation
  sourceId: string
}): React.JSX.Element {
  const [source, setSource] = useState(relation?.sourceId ?? sourceId)
  const [target, setTarget] = useState(
    relation?.targetId ??
      nodes.find((node) => node.id !== sourceId)?.id ??
      ''
  )
  const [type, setType] = useState(relation?.type ?? '')
  const [description, setDescription] = useState(
    relation?.description ?? ''
  )

  return (
    <form
      aria-label={relation ? '编辑关系' : '新增关系'}
      onSubmit={(event) => {
        event.preventDefault()
        void onSave({
          sourceId: source,
          targetId: target,
          type: type.trim(),
          description: description.trim()
        })
      }}
      style={{
        ...styles.surface,
        display: 'grid',
        gap: 9,
        padding: 12,
        marginTop: 10
      }}
    >
      <label style={styles.label}>
        起点
        <select
          onChange={(event) => setSource(event.currentTarget.value)}
          required
          style={styles.input}
          value={source}
        >
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.label}
            </option>
          ))}
        </select>
      </label>
      <label style={styles.label}>
        终点
        <select
          onChange={(event) => setTarget(event.currentTarget.value)}
          required
          style={styles.input}
          value={target}
        >
          <option disabled value="">
            选择实体
          </option>
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.label}
            </option>
          ))}
        </select>
      </label>
      <label style={styles.label}>
        关系类型
        <input
          onChange={(event) => setType(event.currentTarget.value)}
          required
          style={styles.input}
          value={type}
        />
      </label>
      <label style={styles.label}>
        说明
        <input
          onChange={(event) =>
            setDescription(event.currentTarget.value)
          }
          style={styles.input}
          value={description}
        />
      </label>
      <div style={{ display: 'flex', gap: 7 }}>
        <button className="primary-button" style={styles.button}>
          {relation ? '保存关系' : '新增关系'}
        </button>
        <button
          className="secondary-button"
          onClick={onCancel}
          style={styles.button}
          type="button"
        >
          取消
        </button>
      </div>
    </form>
  )
}

function KnowledgeSettingsView({
  library,
  onUpdateLibrary
}: {
  library: KnowledgeLibrary
  onUpdateLibrary: KnowledgeWorkspaceProps['onUpdateLibrary']
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const update = async (
    change: Parameters<KnowledgeWorkspaceProps['onUpdateLibrary']>[1]
  ): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      await onUpdateLibrary(library.id, change)
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="knowledge-settings">
      <section
        aria-labelledby="knowledge-graph-settings-title"
        style={{ ...styles.surface, padding: 16 }}
      >
        <div>
          <h3 id="knowledge-graph-settings-title" style={{ margin: 0 }}>
            知识图谱
          </h3>
          <p style={{ ...styles.muted, margin: '6px 0 0' }}>
            控制是否从知识库文档中抽取实体、关系和证据。
          </p>
        </div>
        <label
          className="knowledge-settings__toggle"
          style={{ ...styles.surface, cursor: saving ? 'wait' : 'pointer' }}
        >
          <input
            checked={library.graphEnabled}
            disabled={saving}
            onChange={(event) =>
              void update({ graphEnabled: event.currentTarget.checked })
            }
            type="checkbox"
          />
          <span>
            <strong style={{ display: 'block' }}>启用知识图谱</strong>
            <span style={styles.muted}>
              启用后，新导入和重新同步的文档会按所选策略抽取图谱。
            </span>
          </span>
        </label>
        <label style={styles.label}>
          图谱抽取策略
          <select
            aria-label="知识图谱抽取策略"
            disabled={!library.graphEnabled || saving}
            onChange={(event) =>
              void update({
                graphStrategy:
                  event.currentTarget.value as KnowledgeGraphStrategy
              })
            }
            style={styles.input}
            value={library.graphStrategy}
          >
            {Object.entries(strategyLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span style={styles.muted}>
            “按需询问”不会自动生成图谱，也不能执行重新抽取。
          </span>
        </label>
        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
            {error}
          </p>
        )}
      </section>
    </div>
  )
}

const taskKindLabels: Record<KnowledgeTaskItem['kind'], string> = {
  parsing: '文档解析',
  embedding: '向量化',
  graph: '图谱抽取'
}

const taskStatusLabels: Record<KnowledgeTaskItem['status'], string> = {
  queued: '等待中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  skipped: '已跳过'
}

function KnowledgeTasksView({
  tasks
}: {
  tasks: readonly KnowledgeTaskItem[]
}): React.JSX.Element {
  const activeCount = tasks.filter(
    (task) => task.status === 'queued' || task.status === 'running'
  ).length
  const failedCount = tasks.filter(
    (task) => task.status === 'failed'
  ).length

  if (tasks.length === 0) {
    return (
      <EmptyState
        description="导入或同步文档后，可以在这里查看解析、向量化和图谱抽取进度。"
        icon={<ListChecks size={30} />}
        level="section"
        title="还没有知识任务"
      />
    )
  }

  return (
    <section aria-labelledby="knowledge-tasks-title">
      <div className="knowledge-tasks__summary">
        <div>
          <h3 id="knowledge-tasks-title" style={{ margin: 0 }}>
            任务中心
          </h3>
          <p style={{ ...styles.muted, margin: '5px 0 0' }}>
            最近 {tasks.length} 个任务
          </p>
        </div>
        <div className="knowledge-tasks__metrics">
          <span>进行中 {activeCount}</span>
          <span>失败 {failedCount}</span>
        </div>
      </div>
      <ol className="knowledge-task-list">
        {tasks.map((task) => (
          <li className="knowledge-task" key={task.id}>
            <div className="knowledge-task__heading">
              <div>
                <strong>{task.documentName}</strong>
                <span>{taskKindLabels[task.kind]}</span>
              </div>
              <span
                className={`knowledge-task__status knowledge-task__status--${task.status}`}
              >
                {taskStatusLabels[task.status]}
              </span>
            </div>
            <div className="knowledge-task__progress">
              <progress
                aria-label={`${task.documentName} ${taskKindLabels[task.kind]}进度`}
                max={100}
                value={task.progress}
              />
              <span>{task.progress}%</span>
            </div>
            <div className="knowledge-task__meta">
              <span>{task.message || '等待处理'}</span>
              <time dateTime={task.completedAt ?? task.startedAt ?? task.createdAt}>
                {new Date(
                  task.completedAt ?? task.startedAt ?? task.createdAt
                ).toLocaleString('zh-CN')}
              </time>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function GraphView({
  evidence,
  graphNodes,
  graphRelations,
  libraryId,
  onCreateEntity,
  onCreateRelation,
  onDeleteEntity,
  onDeleteRelation,
  onMergeEntities,
  onMoveNode,
  onOpenEvidence,
  onReextractGraph,
  onUpdateEntity,
  onUpdateRelation
}: Pick<
  KnowledgeWorkspaceProps,
  | 'evidence'
  | 'graphNodes'
  | 'graphRelations'
  | 'onCreateEntity'
  | 'onCreateRelation'
  | 'onDeleteEntity'
  | 'onDeleteRelation'
  | 'onMergeEntities'
  | 'onMoveNode'
  | 'onOpenEvidence'
  | 'onReextractGraph'
  | 'onUpdateEntity'
  | 'onUpdateRelation'
> & {
  libraryId: string
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [editingEntity, setEditingEntity] = useState(false)
  const [creatingEntity, setCreatingEntity] = useState(false)
  const [relationForm, setRelationForm] =
    useState<KnowledgeGraphRelation | 'new'>()
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [zoom, setZoom] = useState(1)
  const [relationsExpanded, setRelationsExpanded] = useState(false)
  const [reextracting, setReextracting] = useState(false)
  const [reextractError, setReextractError] = useState<string>()

  const nodeMap = useMemo(
    () => new Map(graphNodes.map((node) => [node.id, node])),
    [graphNodes]
  )
  const types = useMemo(
    () => Array.from(new Set(graphNodes.map((node) => node.type))).sort(),
    [graphNodes]
  )
  const visibleNodes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return graphNodes.filter(
      (node) =>
        (typeFilter === 'all' || node.type === typeFilter) &&
        (!normalized ||
          `${node.label} ${node.type} ${node.description ?? ''} ${(node.aliases ?? []).join(' ')}`
            .toLocaleLowerCase('zh-CN')
            .includes(normalized))
    )
  }, [graphNodes, query, typeFilter])
  const visibleIds = useMemo(
    () => new Set(visibleNodes.map((node) => node.id)),
    [visibleNodes]
  )
  const visibleRelations = useMemo(
    () =>
      graphRelations.filter(
        (relation) =>
          visibleIds.has(relation.sourceId) &&
          visibleIds.has(relation.targetId)
      ),
    [graphRelations, visibleIds]
  )
  const selectedNode = selectedNodeId
    ? nodeMap.get(selectedNodeId)
    : undefined
  const relatedRelations = selectedNode
    ? graphRelations.filter(
        (relation) =>
          relation.sourceId === selectedNode.id ||
          relation.targetId === selectedNode.id
      )
    : []
  const selectedEvidenceIds = new Set([
    ...(selectedNode?.evidenceIds ?? []),
    ...relatedRelations.flatMap((relation) => relation.evidenceIds ?? [])
  ])
  const selectedEvidence = evidence.filter((item) =>
    selectedEvidenceIds.has(item.id)
  )

  const selectNode = (nodeId: string): void => {
    setSelectedNodeId(nodeId)
    setCreatingEntity(false)
    setEditingEntity(false)
    setRelationForm(undefined)
  }

  return (
    <div
      className={
        selectedNode || creatingEntity
          ? 'knowledge-graph knowledge-graph--with-details'
          : 'knowledge-graph'
      }
    >
      <section
        aria-label="知识图谱画布"
        className="knowledge-graph__canvas"
        style={{
          ...styles.surface,
          display: 'grid',
          gridTemplateRows: 'auto minmax(0, 1fr) auto',
          overflow: 'hidden'
        }}
      >
        <div
          className="knowledge-graph__toolbar"
        >
          <label
            className="knowledge-graph__search"
            style={{ position: 'relative' }}
          >
            <Search
              aria-hidden="true"
              size={15}
              style={{ position: 'absolute', left: 11, top: 12 }}
            />
            <input
              aria-label="搜索图谱实体"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="搜索实体"
              style={{ ...styles.input, paddingLeft: 34 }}
              type="search"
              value={query}
            />
          </label>
          <select
            aria-label="筛选实体类型"
            className="knowledge-graph__filter"
            onChange={(event) => setTypeFilter(event.currentTarget.value)}
            style={styles.input}
            value={typeFilter}
          >
            <option value="all">全部类型</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <select
            aria-label="选择图谱实体"
            className="knowledge-graph__entity-picker"
            onChange={(event) => {
              if (event.currentTarget.value) {
                selectNode(event.currentTarget.value)
              }
            }}
            value={
              selectedNodeId && visibleIds.has(selectedNodeId)
                ? selectedNodeId
                : ''
            }
          >
            <option value="">选择实体</option>
            {visibleNodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label} · {node.type}
              </option>
            ))}
          </select>
          <button
            className="secondary-button"
            disabled={reextracting}
            onClick={() => {
              setReextracting(true)
              setReextractError(undefined)
              void Promise.resolve(onReextractGraph(libraryId))
                .catch((reason) => setReextractError(toErrorMessage(reason)))
                .finally(() => setReextracting(false))
            }}
            style={styles.button}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={15} />
            {reextracting ? '重新抽取中…' : '重新抽取'}
          </button>
          <button
            className="secondary-button"
            onClick={() => {
              setSelectedNodeId(undefined)
              setCreatingEntity(true)
            }}
            style={styles.button}
            type="button"
          >
            <Plus aria-hidden="true" size={15} />
            新增实体
          </button>
          <button
            aria-label="缩小图谱"
            className="secondary-button"
            disabled={zoom <= 0.5}
            onClick={() =>
              setZoom((current) => Math.max(0.5, current - 0.15))
            }
            style={{ ...styles.button, padding: 8 }}
            type="button"
          >
            <ZoomOut aria-hidden="true" size={16} />
          </button>
          <span
            aria-live="polite"
            className="knowledge-graph__zoom"
            style={{
              minWidth: 42,
              color: 'var(--text-muted)'
            }}
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            aria-label="放大图谱"
            className="secondary-button"
            disabled={zoom >= 2}
            onClick={() =>
              setZoom((current) => Math.min(2, current + 0.15))
            }
            style={{ ...styles.button, padding: 8 }}
            type="button"
          >
            <ZoomIn aria-hidden="true" size={16} />
          </button>
          {reextractError && (
            <span
              className="knowledge-graph__toolbar-error"
              role="alert"
            >
              {reextractError}
            </span>
          )}
        </div>
        {graphNodes.length === 0 ? (
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              padding: 30,
              color: 'var(--text-muted)',
              textAlign: 'center'
            }}
          >
            <div>
              <Network aria-hidden="true" size={30} />
              <p>当前知识库尚未生成实体关系。</p>
            </div>
          </div>
        ) : (
          <>
            <KnowledgeGraphChart
              nodes={visibleNodes}
              onMoveNode={onMoveNode}
              onSelectNode={selectNode}
              onZoomChange={setZoom}
              relations={visibleRelations}
              selectedNodeId={selectedNodeId}
              zoom={zoom}
            />
            {visibleRelations.length > 0 && (
              <details
                className="knowledge-graph__accessible-surface"
                onToggle={(event) =>
                  setRelationsExpanded(event.currentTarget.open)
                }
                open={relationsExpanded}
              >
                <summary>
                  可见关系 {visibleRelations.length} 条
                </summary>
                {relationsExpanded && (
                  <ul
                    aria-label="可见关系列表"
                    className="knowledge-graph__relation-list"
                  >
                    {visibleRelations.map((relation) => (
                      <li key={relation.id}>
                        <span>
                          {nodeMap.get(relation.sourceId)?.label}
                        </span>
                        <ArrowRight aria-hidden="true" size={12} />
                        <strong>{relation.type}</strong>
                        <ArrowRight aria-hidden="true" size={12} />
                        <span>
                          {nodeMap.get(relation.targetId)?.label}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            )}
          </>
        )}
      </section>

      {creatingEntity && (
        <aside
          aria-label="新增实体面板"
          className="knowledge-graph__detail"
          style={{
            ...styles.surface,
            padding: 15,
            overflowY: 'auto'
          }}
        >
          <h3 style={{ marginTop: 0 }}>新增实体</h3>
          <EntityEditor
            onCancel={() => setCreatingEntity(false)}
            onSave={async (input) => {
              await onCreateEntity(input)
              setCreatingEntity(false)
            }}
          />
        </aside>
      )}

      {selectedNode && (
        <aside
          aria-label="实体详情"
          className="knowledge-graph__detail"
          style={{
            ...styles.surface,
            padding: 15,
            overflowY: 'auto'
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 8
            }}
          >
            <div>
              <span style={{ color: 'var(--accent)', fontSize: 12 }}>
                {selectedNode.type}
              </span>
              <h3 style={{ margin: '4px 0 0' }}>{selectedNode.label}</h3>
            </div>
            <button
              aria-label="关闭实体详情"
              className="secondary-button"
              onClick={() => setSelectedNodeId(undefined)}
              style={{ ...styles.button, padding: 7 }}
              type="button"
            >
              <X aria-hidden="true" size={15} />
            </button>
          </div>

          {editingEntity ? (
            <div style={{ marginTop: 14 }}>
              <EntityEditor
                node={selectedNode}
                onCancel={() => setEditingEntity(false)}
                onSave={async (update) => {
                  await onUpdateEntity(selectedNode.id, update)
                  setEditingEntity(false)
                }}
              />
            </div>
          ) : (
            <>
              <p style={styles.muted}>
                {selectedNode.description || '该实体没有附加描述。'}
              </p>
              {(selectedNode.aliases?.length ?? 0) > 0 && (
                <div style={{ ...styles.muted, marginBottom: 12 }}>
                  别名：{selectedNode.aliases?.join('、')}
                </div>
              )}
              <div style={{ display: 'flex', gap: 7 }}>
                <button
                  className="secondary-button"
                  onClick={() => setEditingEntity(true)}
                  style={styles.button}
                  type="button"
                >
                  <Pencil aria-hidden="true" size={14} />
                  编辑
                </button>
                <button
                  className="danger-button danger-button--quiet"
                  onClick={() => void onDeleteEntity(selectedNode.id)}
                  style={styles.button}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={14} />
                  删除
                </button>
              </div>
            </>
          )}

          <hr
            style={{
              margin: '16px 0',
              border: 0,
              borderTop: '1px solid var(--border-subtle)'
            }}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <strong>关系</strong>
            <button
              className="secondary-button"
              onClick={() => setRelationForm('new')}
              style={{ ...styles.button, padding: '6px 9px' }}
              type="button"
            >
              <Plus aria-hidden="true" size={14} />
              新增
            </button>
          </div>
          {relationForm && (
            <RelationForm
              nodes={graphNodes}
              onCancel={() => setRelationForm(undefined)}
              onSave={async (input) => {
                if (relationForm === 'new') {
                  await onCreateRelation(input)
                } else {
                  await onUpdateRelation(relationForm.id, input)
                }
                setRelationForm(undefined)
              }}
              relation={
                relationForm === 'new' ? undefined : relationForm
              }
              sourceId={selectedNode.id}
            />
          )}
          <ul
            style={{
              display: 'grid',
              gap: 8,
              padding: 0,
              listStyle: 'none'
            }}
          >
            {relatedRelations.map((relation) => {
              const otherId =
                relation.sourceId === selectedNode.id
                  ? relation.targetId
                  : relation.sourceId
              const other = nodeMap.get(otherId)
              return (
                <li
                  key={relation.id}
                  style={{ ...styles.surface, padding: 10 }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 13
                    }}
                  >
                    <span>{nodeMap.get(relation.sourceId)?.label}</span>
                    <ArrowRight
                      aria-label={relation.type}
                      size={13}
                    />
                    <span>{nodeMap.get(relation.targetId)?.label}</span>
                  </div>
                  <div style={{ ...styles.muted, marginTop: 4 }}>
                    {relation.type}
                    {relation.description
                      ? ` · ${relation.description}`
                      : ''}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                    <button
                      aria-label={`编辑关系 ${relation.type}`}
                      className="secondary-button"
                      onClick={() => setRelationForm(relation)}
                      style={{ ...styles.button, padding: 6 }}
                      type="button"
                    >
                      <Pencil aria-hidden="true" size={13} />
                    </button>
                    <button
                      aria-label={`删除关系 ${relation.type}`}
                      className="danger-button danger-button--quiet"
                      onClick={() => void onDeleteRelation(relation.id)}
                      style={{ ...styles.button, padding: 6 }}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={13} />
                      删除
                    </button>
                    {other && (
                      <button
                        className="secondary-button"
                        onClick={() => setSelectedNodeId(other.id)}
                        style={{
                          ...styles.button,
                          minHeight: 30,
                          padding: '5px 8px',
                          marginLeft: 'auto'
                        }}
                        type="button"
                      >
                        查看 {other.label}
                        <ChevronRight aria-hidden="true" size={13} />
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>

          <strong>合并实体</strong>
          <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
            <select
              aria-label="选择合并目标"
              onChange={(event) => setMergeTargetId(event.currentTarget.value)}
              style={styles.input}
              value={mergeTargetId}
            >
              <option value="">选择保留的实体</option>
              {graphNodes
                .filter((node) => node.id !== selectedNode.id)
                .map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label}
                  </option>
                ))}
            </select>
            <button
              aria-label="合并到目标实体"
              className="secondary-button"
              disabled={!mergeTargetId}
              onClick={() => {
                void onMergeEntities(selectedNode.id, mergeTargetId)
                setMergeTargetId('')
              }}
              style={{ ...styles.button, padding: 8 }}
              type="button"
            >
              <GitMerge aria-hidden="true" size={15} />
            </button>
          </div>

          <hr
            style={{
              margin: '16px 0',
              border: 0,
              borderTop: '1px solid var(--border-subtle)'
            }}
          />
          <strong>证据 ({selectedEvidence.length})</strong>
          {selectedEvidence.length === 0 ? (
            <p style={styles.muted}>此实体和相关关系没有关联证据。</p>
          ) : (
            <ol
              style={{
                display: 'grid',
                gap: 8,
                paddingLeft: 20,
                color: 'var(--text-secondary)'
              }}
            >
              {selectedEvidence.map((item) => (
                <li key={item.id}>
                  {onOpenEvidence ? (
                    <button
                      onClick={() => onOpenEvidence(item)}
                      style={{
                        width: '100%',
                        padding: 0,
                        border: 0,
                        background: 'transparent',
                        color: 'inherit',
                        textAlign: 'left',
                        cursor: 'pointer'
                      }}
                      type="button"
                    >
                      <strong style={{ fontSize: 13 }}>
                        {item.documentName}
                      </strong>
                      {item.location && (
                        <span style={{ ...styles.muted, marginLeft: 5 }}>
                          {item.location}
                        </span>
                      )}
                      <span
                        style={{
                          ...styles.muted,
                          display: 'block',
                          marginTop: 4
                        }}
                      >
                        {item.excerpt}
                      </span>
                    </button>
                  ) : (
                    <div>
                    <strong style={{ fontSize: 13 }}>
                      {item.documentName}
                    </strong>
                    {item.location && (
                      <span style={{ ...styles.muted, marginLeft: 5 }}>
                        {item.location}
                      </span>
                    )}
                    <span
                      style={{
                        ...styles.muted,
                        display: 'block',
                        marginTop: 4
                      }}
                    >
                      {item.excerpt}
                    </span>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </aside>
      )}
    </div>
  )
}

export function KnowledgeWorkspace({
  libraries,
  selectedLibraryId,
  sources,
  documents,
  graphNodes,
  graphRelations,
  evidence,
  tasks = [],
  loading = false,
  loadError,
  onRetryLoad,
  onSelectLibrary,
  onCreateLibrary,
  onDeleteLibrary,
  onUpdateLibrary,
  onReextractGraph,
  onImportFiles,
  onImportDirectory,
  onImportUrl,
  onSyncSource,
  onPauseSource,
  onRetrySource,
  onRemoveSource,
  onMoveNode,
  onCreateEntity,
  onUpdateEntity,
  onDeleteEntity,
  onMergeEntities,
  onCreateRelation,
  onUpdateRelation,
  onDeleteRelation,
  onOpenEvidence
}: KnowledgeWorkspaceProps): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [tab, setTab] = useState<WorkspaceTab>('documents')
  const [editingLibrary, setEditingLibrary] =
    useState<KnowledgeLibrary>()
  const [deletingLibrary, setDeletingLibrary] =
    useState<KnowledgeLibrary>()
  const editLibraryTriggerRef = useRef<HTMLButtonElement>(null)
  const deleteLibraryTriggerRef = useRef<HTMLButtonElement>(null)
  const selectedLibrary =
    libraries.find((library) => library.id === selectedLibraryId) ??
    libraries[0]
  const librarySources = selectedLibrary
    ? sources.filter((source) => source.libraryId === selectedLibrary.id)
    : []
  const libraryDocuments = selectedLibrary
    ? documents.filter(
        (document) => document.libraryId === selectedLibrary.id
      )
    : []
  const libraryTasks = selectedLibrary
    ? tasks.filter((task) => task.libraryId === selectedLibrary.id)
    : []

  useEffect(() => {
    if (
      selectedLibrary &&
      selectedLibrary.id !== selectedLibraryId
    ) {
      onSelectLibrary(selectedLibrary.id)
    }
  }, [onSelectLibrary, selectedLibrary, selectedLibraryId])
  const visibleTab = tab
  const workspaceTabs: ReadonlyArray<PageTab<WorkspaceTab>> = [
    {
      id: 'documents',
      label: '文档与来源',
      icon: <FileText aria-hidden="true" size={15} />
    },
    {
      id: 'graph',
      label: '知识图谱',
      icon: <Network aria-hidden="true" size={15} />
    },
    {
      id: 'tasks',
      label: '任务中心',
      icon: <ListChecks aria-hidden="true" size={15} />
    },
    {
      id: 'settings',
      label: '设置',
      icon: <Settings2 aria-hidden="true" size={15} />
    }
  ]
  const closeEditDialog = (): void => {
    setEditingLibrary(undefined)
    requestAnimationFrame(() =>
      editLibraryTriggerRef.current?.focus()
    )
  }
  const closeDeleteDialog = (): void => {
    setDeletingLibrary(undefined)
    requestAnimationFrame(() =>
      deleteLibraryTriggerRef.current?.focus()
    )
  }

  return (
    <div className="knowledge-page">
      <PageHeader
        actions={
          <button
            className="primary-button"
            disabled={loading}
            onClick={() => {
              setCreating(true)
              setMobileListOpen(false)
            }}
            style={styles.button}
            type="button"
          >
            <Plus aria-hidden="true" size={16} />
            新建知识库
          </button>
        }
        description="集中组织文件、目录和网页来源，建立可追溯、可跨项目使用的索引与图谱。"
        eyebrow="KNOWLEDGE"
        headingId="knowledge-workspace-title"
        icon={<Database size={20} />}
        scope={{ kind: 'global' }}
        title="知识库"
      />
      <section
        aria-busy={loading}
        aria-label="知识工作区"
        className={`knowledge-workspace${
          mobileListOpen ? ' knowledge-workspace--mobile-list' : ''
        }`}
        style={styles.workspace}
      >
        <aside className="knowledge-workspace__sidebar">
          <div className="knowledge-workspace__sidebar-heading">
            <span>
              <BookOpen aria-hidden="true" size={16} />
              <strong>知识库列表</strong>
            </span>
            <small>{libraries.length}</small>
          </div>
          <nav
            aria-label="知识库列表"
            className="knowledge-workspace__library-nav"
            style={{ flex: 1 }}
          >
            {libraries.length === 0 ? (
              <div
                style={{
                  ...styles.surface,
                  padding: 13,
                  color: 'var(--text-muted)',
                  fontSize: 13,
                  lineHeight: 1.55
                }}
              >
                创建知识库，集中管理可跨项目使用的来源、索引和实体关系。
              </div>
            ) : (
              <ul
                style={{
                  display: 'grid',
                  gap: 7,
                  margin: 0,
                  padding: 0,
                  listStyle: 'none'
                }}
              >
                {libraries.map((library) => {
                  const selected = library.id === selectedLibrary?.id
                  return (
                    <li key={library.id}>
                      <button
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => {
                          onSelectLibrary(library.id)
                          setTab('documents')
                          setMobileListOpen(false)
                        }}
                        style={{
                          width: '100%',
                          padding: 11,
                          border: `1px solid ${
                            selected
                              ? 'var(--accent)'
                              : 'transparent'
                          }`,
                          borderRadius: 'var(--radius-control)',
                          background: selected
                            ? 'var(--accent-subtle)'
                            : 'transparent',
                          color: selected
                            ? 'var(--accent)'
                            : 'var(--text-primary)',
                          textAlign: 'left',
                          cursor: 'pointer'
                        }}
                        type="button"
                      >
                        <span
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 7
                          }}
                        >
                          <BookOpen aria-hidden="true" size={15} />
                          <strong
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {library.name}
                          </strong>
                        </span>
                        <span
                          style={{
                            ...styles.muted,
                            display: 'block',
                            marginTop: 5
                          }}
                        >
                          {library.documentCount} 个文档 ·{' '}
                          {storageModeLabels[library.storageMode]}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </nav>
        </aside>

      <section
        aria-label="知识库详情"
        className="knowledge-workspace__main"
        style={{ minWidth: 0, background: 'var(--surface-raised)' }}
      >
        {loadError && libraries.length > 0 && (
          <div
            role="alert"
            style={{
              ...styles.surface,
              margin: 'var(--space-4)',
              padding: 'var(--space-3)',
              color: 'var(--danger)'
            }}
          >
            <strong>知识库刷新失败</strong>
            <p style={{ margin: 'var(--space-2) 0' }}>{loadError}</p>
            <button
              className="secondary-button"
              onClick={() => void onRetryLoad()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={14} />
              重试
            </button>
          </div>
        )}
        {selectedLibrary && !creating && !loading && (
          <button
            className="knowledge-workspace__mobile-back secondary-button"
            onClick={() => setMobileListOpen(true)}
            type="button"
          >
            <ArrowLeft aria-hidden="true" size={15} />
            返回知识库列表
          </button>
        )}
        {loading && libraries.length === 0 ? (
          <EmptyState
            description="正在读取知识库、来源和索引状态。"
            icon={<LoaderCircle size={28} />}
            level="page"
            title="正在加载知识库"
          />
        ) : loadError && libraries.length === 0 ? (
          <EmptyState
            action={
              <button
                className="secondary-button"
                onClick={() => void onRetryLoad()}
                style={styles.button}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={14} />
                重试
              </button>
            }
            description={loadError}
            icon={<AlertCircle size={28} />}
            level="page"
            title="知识库加载失败"
          />
        ) : creating ? (
          <CreateLibraryWizard
            onCancel={() => setCreating(false)}
            onCreate={onCreateLibrary}
          />
        ) : !selectedLibrary ? (
          <EmptyState
            action={
              <button
                className="primary-button"
                onClick={() => setCreating(true)}
                style={styles.button}
                type="button"
              >
                <Plus aria-hidden="true" size={16} />
                创建知识库
              </button>
            }
            description="集中组织文件、目录和网页来源，并生成可追溯、可跨项目使用的索引与图谱。"
            icon={<BookOpen size={34} />}
            level="page"
            title="建立第一个知识库"
          />
        ) : (
          <>
            <header
              className="knowledge-workspace__header"
            >
              <div>
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    color: 'var(--accent)',
                    fontSize: 12,
                    fontWeight: 750
                  }}
                >
                  <Database aria-hidden="true" size={13} />
                  全局 · {storageModeLabels[selectedLibrary.storageMode]}
                  {selectedLibrary.graphEnabled &&
                    ` · ${strategyLabels[selectedLibrary.graphStrategy]}`}
                </span>
                <h2 style={{ margin: '6px 0 3px' }}>
                  {selectedLibrary.name}
                </h2>
                <p style={{ ...styles.muted, margin: 0 }}>
                  {selectedLibrary.description ||
                    `${selectedLibrary.sourceCount} 个来源，${selectedLibrary.indexedDocumentCount}/${selectedLibrary.documentCount} 个文档已完成索引。`}
                </p>
              </div>
              <div
                className="knowledge-workspace__header-actions"
              >
                <button
                  className="secondary-button"
                  onClick={() => setEditingLibrary(selectedLibrary)}
                  ref={editLibraryTriggerRef}
                  style={styles.button}
                  type="button"
                >
                  <Pencil aria-hidden="true" size={15} />
                  编辑
                </button>
                <button
                  aria-label={`删除知识库 ${selectedLibrary.name}`}
                  className="danger-button danger-button--quiet"
                  onClick={() => setDeletingLibrary(selectedLibrary)}
                  ref={deleteLibraryTriggerRef}
                  style={styles.button}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={15} />
                  删除
                </button>
              </div>
            </header>
            <div className="knowledge-workspace__tabs">
              <PageTabs
                ariaLabel="知识库视图"
                idPrefix="knowledge"
                onChange={setTab}
                tabs={workspaceTabs}
                value={visibleTab}
              />
            </div>
            <div
              aria-labelledby={`knowledge-tab-${visibleTab}`}
              className="knowledge-workspace__body"
              id={`knowledge-panel-${visibleTab}`}
              role="tabpanel"
            >
              {visibleTab === 'documents' ? (
                <DocumentsView
                  documents={libraryDocuments}
                  library={selectedLibrary}
                  onImportDirectory={onImportDirectory}
                  onImportFiles={onImportFiles}
                  onImportUrl={onImportUrl}
                  onPauseSource={onPauseSource}
                  onRemoveSource={onRemoveSource}
                  onRetrySource={onRetrySource}
                  onSyncSource={onSyncSource}
                  sources={librarySources}
                />
              ) : visibleTab === 'graph' &&
                selectedLibrary.graphEnabled ? (
                <GraphView
                  evidence={evidence}
                  graphNodes={graphNodes}
                  graphRelations={graphRelations}
                  libraryId={selectedLibrary.id}
                  onCreateEntity={onCreateEntity}
                  onCreateRelation={onCreateRelation}
                  onDeleteEntity={onDeleteEntity}
                  onDeleteRelation={onDeleteRelation}
                  onMergeEntities={onMergeEntities}
                  onMoveNode={onMoveNode}
                  onOpenEvidence={onOpenEvidence}
                  onReextractGraph={onReextractGraph}
                  onUpdateEntity={onUpdateEntity}
                  onUpdateRelation={onUpdateRelation}
                />
              ) : visibleTab === 'graph' ? (
                <EmptyState
                  action={
                    <button
                      className="secondary-button"
                      onClick={() => setTab('settings')}
                      style={styles.button}
                      type="button"
                    >
                      <Settings2 aria-hidden="true" size={15} />
                      前往设置
                    </button>
                  }
                  description="在“设置”中启用知识图谱后，可以查看实体关系并重新抽取。"
                  icon={<Network size={30} />}
                  level="section"
                  title="知识图谱未启用"
                />
              ) : visibleTab === 'tasks' ? (
                <KnowledgeTasksView tasks={libraryTasks} />
              ) : (
                <KnowledgeSettingsView
                  library={selectedLibrary}
                  onUpdateLibrary={onUpdateLibrary}
                />
              )}
            </div>
          </>
        )}
      </section>
      {editingLibrary && (
        <EditLibraryDialog
          library={editingLibrary}
          onCancel={closeEditDialog}
          onConfirm={(update) =>
            onUpdateLibrary(editingLibrary.id, update)
          }
        />
      )}
      {deletingLibrary && (
        <DeleteLibraryDialog
          library={deletingLibrary}
          onCancel={closeDeleteDialog}
          onConfirm={() => onDeleteLibrary(deletingLibrary.id)}
        />
      )}
      </section>
    </div>
  )
}
