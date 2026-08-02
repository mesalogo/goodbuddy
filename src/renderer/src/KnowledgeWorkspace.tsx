import {
  AlertCircle,
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
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
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
  loading?: boolean
  onSelectLibrary: (libraryId: string) => void
  onCreateLibrary: (
    input: CreateKnowledgeLibraryInput
  ) => void | Promise<void>
  onDeleteLibrary: (libraryId: string) => void | Promise<void>
  onUpdateLibrary: (
    libraryId: string,
    update: {
      graphEnabled: boolean
      graphStrategy: KnowledgeGraphStrategy
    }
  ) => void | Promise<void>
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

type WorkspaceTab = 'documents' | 'graph'

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
    border: '1px solid #d9d9d9',
    borderRadius: 8,
    background: '#f5f5f5',
    color: '#1f1f1f',
    boxShadow: '0 2px 8px rgba(0, 0, 0, .06)'
  },
  sidebar: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
    background: '#fafafa'
  },
  surface: {
    border: '1px solid #d9d9d9',
    borderRadius: 8,
    background: '#ffffff'
  },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    minHeight: 36,
    padding: '8px 12px',
    border: '1px solid #d9d9d9',
    borderRadius: 6,
    background: '#ffffff',
    color: '#1f1f1f',
    cursor: 'pointer',
    font: 'inherit'
  },
  primaryButton: {
    background: '#1677ff',
    borderColor: '#1677ff',
    color: '#ffffff',
    fontWeight: 700
  },
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
    minHeight: 40,
    padding: '9px 11px',
    border: '1px solid #d9d9d9',
    borderRadius: 6,
    outline: 'none',
    background: '#ffffff',
    color: '#1f1f1f',
    font: 'inherit'
  },
  label: {
    display: 'grid',
    gap: 7,
    color: '#595959',
    fontSize: 13,
    fontWeight: 650
  },
  muted: {
    color: '#8c8c8c',
    fontSize: 13,
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
        background: '#f0f0f0'
      }}
    >
      <span
        style={{
          display: 'block',
          width: `${value}%`,
          height: '100%',
          background: value === 100 ? '#52c41a' : '#1677ff',
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
        <span style={{ color: '#1677ff', fontSize: 12, fontWeight: 800 }}>
          NEW KNOWLEDGE BASE
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
        <p aria-live="polite" role="alert" style={{ color: '#ff4d4f', margin: 0 }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onCancel} style={styles.button} type="button">
          取消
        </button>
        <button
          disabled={saving}
          style={{ ...styles.button, ...styles.primaryButton }}
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
      role="dialog"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        background: 'rgba(0, 0, 0, .45)'
      }}
    >
      <div
        style={{
          ...styles.surface,
          width: 'min(440px, 100%)',
          padding: 20,
          boxShadow: '0 6px 16px rgba(0, 0, 0, .08)'
        }}
      >
        <AlertCircle color="#ff4d4f" aria-hidden="true" size={26} />
        <h2 style={{ margin: '12px 0 8px' }}>删除“{library.name}”？</h2>
        <p style={{ ...styles.muted, margin: 0 }}>
          {library.storageMode === 'managed'
            ? '此知识库使用托管存储。删除后，应用保存的托管副本、索引和图谱都会被永久删除。'
            : '此知识库引用原文件。删除后只会移除索引和图谱，不会删除磁盘上的原文件。'}
        </p>
        {error && (
          <p aria-live="polite" role="alert" style={{ color: '#ff4d4f' }}>
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
          <button disabled={deleting} onClick={onCancel} style={styles.button}>
            取消
          </button>
          <button
            disabled={deleting}
            onClick={() => void confirm()}
            style={{
              ...styles.button,
              background: '#ff4d4f',
              borderColor: '#ff4d4f',
              color: '#ffffff'
            }}
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
              onClick={() => fileInputRef.current?.click()}
              style={styles.button}
              type="button"
            >
              <FilePlus2 aria-hidden="true" size={15} />
              导入文件
            </button>
            <button
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
              disabled={pending === 'url'}
              style={{ ...styles.button, ...styles.primaryButton }}
              type="submit"
            >
              导入
            </button>
            <button
              aria-label="关闭 URL 导入"
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
            border: `1px dashed ${dragging ? '#1677ff' : '#d9d9d9'}`,
            borderRadius: 8,
            textAlign: 'center',
            background: dragging ? '#e6f4ff' : '#fafafa',
            color: dragging ? '#1677ff' : '#8c8c8c'
          }}
        >
          <UploadCloud aria-hidden="true" size={22} />
          <div style={{ marginTop: 5 }}>
            将文件拖到这里，加入“{library.name}”
          </div>
        </div>

        {error && (
          <p aria-live="polite" role="alert" style={{ color: '#ff4d4f' }}>
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
                            ? '#fff2f0'
                            : source.status === 'ready'
                              ? '#f6ffed'
                              : '#e6f4ff',
                        color:
                          source.status === 'failed'
                            ? '#ff4d4f'
                            : source.status === 'ready'
                              ? '#52c41a'
                              : '#1677ff',
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
                    <div style={{ color: '#ff4d4f', fontSize: 12, marginTop: 5 }}>
                      {source.error}
                    </div>
                  )}
                </div>
                <div className="knowledge-source-row__actions">
                  {source.status === 'syncing' ? (
                    <button
                      aria-label={`暂停 ${source.name}`}
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
                    disabled={pending === source.id}
                    onClick={() =>
                      void run(source.id, () => onRemoveSource(source.id))
                    }
                    style={{ ...styles.button, padding: 8 }}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
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
              style={{ position: 'absolute', left: 11, color: '#8c8c8c' }}
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
                  color: '#595959',
                  textAlign: 'left',
                  background: '#fafafa'
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
                      borderTop: '1px solid #f0f0f0'
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
                              ? '#ff4d4f'
                              : document.status === 'ready'
                                ? '#52c41a'
                                : document.status === 'indexing'
                                  ? '#1677ff'
                                  : '#faad14'
                        }}
                      >
                        {documentStatusLabels[document.status]}
                      </span>
                      {document.error && (
                        <div style={{ color: '#ff4d4f', marginTop: 4 }}>
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
        <button style={{ ...styles.button, ...styles.primaryButton }}>
          {node ? '保存实体' : '新增实体'}
        </button>
        <button onClick={onCancel} style={styles.button} type="button">
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
        <button style={{ ...styles.button, ...styles.primaryButton }}>
          {relation ? '保存关系' : '新增关系'}
        </button>
        <button onClick={onCancel} style={styles.button} type="button">
          取消
        </button>
      </div>
    </form>
  )
}

function GraphView({
  evidence,
  graphNodes,
  graphRelations,
  onCreateEntity,
  onCreateRelation,
  onDeleteEntity,
  onDeleteRelation,
  onMergeEntities,
  onMoveNode,
  onOpenEvidence,
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
  | 'onUpdateEntity'
  | 'onUpdateRelation'
>): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [editingEntity, setEditingEntity] = useState(false)
  const [creatingEntity, setCreatingEntity] = useState(false)
  const [relationForm, setRelationForm] =
    useState<KnowledgeGraphRelation | 'new'>()
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [zoom, setZoom] = useState(1)
  const [draggingNode, setDraggingNode] = useState<{
    id: string
    offsetX: number
    offsetY: number
  }>()
  const svgRef = useRef<SVGSVGElement>(null)

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
  const visibleRelations = graphRelations.filter(
    (relation) =>
      visibleIds.has(relation.sourceId) &&
      visibleIds.has(relation.targetId)
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

  const pointerPosition = (
    event: React.PointerEvent<SVGElement>
  ): { x: number; y: number } | undefined => {
    const svg = svgRef.current
    if (!svg) {
      return undefined
    }
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height) {
      return undefined
    }
    return {
      x: ((event.clientX - rect.left) / rect.width) * 900 / zoom,
      y: ((event.clientY - rect.top) / rect.height) * 560 / zoom
    }
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
          gridTemplateRows: 'auto minmax(0, 1fr)',
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
          <button
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
            style={{ minWidth: 42, color: '#8c8c8c', fontSize: 12 }}
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            aria-label="放大图谱"
            disabled={zoom >= 2}
            onClick={() =>
              setZoom((current) => Math.min(2, current + 0.15))
            }
            style={{ ...styles.button, padding: 8 }}
            type="button"
          >
            <ZoomIn aria-hidden="true" size={16} />
          </button>
        </div>
        {graphNodes.length === 0 ? (
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              padding: 30,
              color: '#8c8c8c',
              textAlign: 'center'
            }}
          >
            <div>
              <Network aria-hidden="true" size={30} />
              <p>当前知识库尚未生成实体关系。</p>
            </div>
          </div>
        ) : (
          <svg
            aria-label="实体关系图"
            onPointerMove={(event) => {
              if (!draggingNode) {
                return
              }
              const point = pointerPosition(event)
              if (!point) {
                return
              }
              onMoveNode(draggingNode.id, {
                x: Math.max(38, Math.min(862, point.x - draggingNode.offsetX)),
                y: Math.max(28, Math.min(532, point.y - draggingNode.offsetY))
              })
            }}
            onPointerUp={(event) => {
              if (draggingNode) {
                event.currentTarget.releasePointerCapture(event.pointerId)
                setDraggingNode(undefined)
              }
            }}
            ref={svgRef}
            role="img"
            className="knowledge-graph__svg"
            style={{
              width: '100%',
              background: '#fafafa',
              touchAction: 'none'
            }}
            viewBox={`0 0 ${900 / zoom} ${560 / zoom}`}
          >
            <defs>
              <marker
                id="knowledge-arrow"
                markerHeight="7"
                markerWidth="7"
                orient="auto-start-reverse"
                refX="17"
                refY="3.5"
              >
                <polygon fill="#8c8c8c" points="0 0, 7 3.5, 0 7" />
              </marker>
            </defs>
            {visibleRelations.map((relation) => {
              const source = nodeMap.get(relation.sourceId)
              const target = nodeMap.get(relation.targetId)
              if (!source || !target) {
                return null
              }
              return (
                <g key={relation.id}>
                  <line
                    markerEnd="url(#knowledge-arrow)"
                    stroke="#8c8c8c"
                    strokeWidth="1.5"
                    x1={source.x}
                    x2={target.x}
                    y1={source.y}
                    y2={target.y}
                  />
                  <text
                    fill="#595959"
                    fontSize="11"
                    textAnchor="middle"
                    x={(source.x + target.x) / 2}
                    y={(source.y + target.y) / 2 - 6}
                  >
                    {relation.type}
                  </text>
                </g>
              )
            })}
            {visibleNodes.map((node) => {
              const selected = selectedNodeId === node.id
              return (
                <g
                  aria-label={`实体 ${node.label}`}
                  key={node.id}
                  onClick={() => {
                    setSelectedNodeId(node.id)
                    setCreatingEntity(false)
                    setEditingEntity(false)
                    setRelationForm(undefined)
                  }}
                  onPointerDown={(event) => {
                    const point = pointerPosition(event)
                    if (!point) {
                      return
                    }
                    event.currentTarget.ownerSVGElement?.setPointerCapture(
                      event.pointerId
                    )
                    setDraggingNode({
                      id: node.id,
                      offsetX: point.x - node.x,
                      offsetY: point.y - node.y
                    })
                  }}
                  role="button"
                  style={{ cursor: 'grab', outline: 'none' }}
                  tabIndex={0}
                  transform={`translate(${node.x} ${node.y})`}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      setSelectedNodeId(node.id)
                      setCreatingEntity(false)
                    }
                  }}
                >
                  <circle
                    fill={selected ? '#bae0ff' : '#e6f4ff'}
                    r={selected ? 30 : 26}
                    stroke={selected ? '#1677ff' : '#4096ff'}
                    strokeWidth={selected ? 3 : 2}
                  />
                  <text
                    fill="#1f1f1f"
                    fontSize="12"
                    fontWeight="700"
                    textAnchor="middle"
                    y="4"
                  >
                    {node.label.length > 8
                      ? `${node.label.slice(0, 8)}…`
                      : node.label}
                  </text>
                  <text
                    fill="#595959"
                    fontSize="10"
                    textAnchor="middle"
                    y="44"
                  >
                    {node.type}
                  </text>
                </g>
              )
            })}
          </svg>
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
              <span style={{ color: '#1677ff', fontSize: 12 }}>
                {selectedNode.type}
              </span>
              <h3 style={{ margin: '4px 0 0' }}>{selectedNode.label}</h3>
            </div>
            <button
              aria-label="关闭实体详情"
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
                  onClick={() => setEditingEntity(true)}
                  style={styles.button}
                  type="button"
                >
                  <Pencil aria-hidden="true" size={14} />
                  编辑
                </button>
                <button
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
              borderTop: '1px solid #f0f0f0'
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
                      onClick={() => setRelationForm(relation)}
                      style={{ ...styles.button, padding: 6 }}
                      type="button"
                    >
                      <Pencil aria-hidden="true" size={13} />
                    </button>
                    <button
                      aria-label={`删除关系 ${relation.type}`}
                      onClick={() => void onDeleteRelation(relation.id)}
                      style={{ ...styles.button, padding: 6 }}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={13} />
                    </button>
                    {other && (
                      <button
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
              borderTop: '1px solid #f0f0f0'
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
                color: '#595959'
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
  loading = false,
  onSelectLibrary,
  onCreateLibrary,
  onDeleteLibrary,
  onUpdateLibrary,
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
  const [tab, setTab] = useState<WorkspaceTab>('documents')
  const [deletingLibrary, setDeletingLibrary] =
    useState<KnowledgeLibrary>()
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

  useEffect(() => {
    if (
      selectedLibrary &&
      selectedLibrary.id !== selectedLibraryId
    ) {
      onSelectLibrary(selectedLibrary.id)
    }
  }, [onSelectLibrary, selectedLibrary, selectedLibraryId])
  const visibleTab =
    selectedLibrary?.graphEnabled === false ? 'documents' : tab

  return (
    <section
      aria-busy={loading}
      aria-label="知识工作区"
      className="knowledge-workspace"
      style={styles.workspace}
    >
      <aside className="knowledge-workspace__sidebar" style={styles.sidebar}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10
          }}
        >
          <span
            style={{
              display: 'grid',
              width: 34,
              height: 34,
              placeItems: 'center',
              borderRadius: 10,
              background: '#1677ff',
              color: '#ffffff'
            }}
          >
            <Database aria-hidden="true" size={18} />
          </span>
          <div>
            <strong style={{ display: 'block' }}>知识工作区</strong>
            <span style={styles.muted}>{libraries.length} 个知识库</span>
          </div>
        </div>
        <button
          onClick={() => setCreating(true)}
          style={{ ...styles.button, ...styles.primaryButton, width: '100%' }}
          type="button"
        >
          <Plus aria-hidden="true" size={16} />
          新建知识库
        </button>
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
                color: '#8c8c8c',
                fontSize: 13,
                lineHeight: 1.55
              }}
            >
              创建知识库，为不同项目独立管理来源、索引和实体关系。
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
                      }}
                      style={{
                        width: '100%',
                        padding: 11,
                        border: `1px solid ${
                          selected
                            ? '#1677ff'
                            : 'transparent'
                        }`,
                        borderRadius: 6,
                        background: selected
                          ? '#e6f4ff'
                          : 'transparent',
                        color: selected ? '#1677ff' : '#1f1f1f',
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

      <main
        className="knowledge-workspace__main"
        style={{ minWidth: 0, background: '#ffffff' }}
      >
        {creating ? (
          <CreateLibraryWizard
            onCancel={() => setCreating(false)}
            onCreate={onCreateLibrary}
          />
        ) : !selectedLibrary ? (
          <div
            style={{
              display: 'grid',
              minHeight: 620,
              placeItems: 'center',
              padding: 30,
              textAlign: 'center'
            }}
          >
            <div>
              <BookOpen
                aria-hidden="true"
                color="#1677ff"
                size={42}
              />
              <h2>建立第一个知识库</h2>
              <p style={styles.muted}>
                按项目组织文件、目录和网页来源，并生成可追溯的索引与图谱。
              </p>
              <button
                onClick={() => setCreating(true)}
                style={{
                  ...styles.button,
                  ...styles.primaryButton,
                  marginTop: 8
                }}
                type="button"
              >
                <Plus aria-hidden="true" size={16} />
                创建知识库
              </button>
            </div>
          </div>
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
                    color: '#1677ff',
                    fontSize: 12,
                    fontWeight: 750
                  }}
                >
                  <Database aria-hidden="true" size={13} />
                  {storageModeLabels[selectedLibrary.storageMode]}
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
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    color: '#595959',
                    fontSize: 12,
                    gap: 6
                  }}
                >
                  <input
                    checked={selectedLibrary.graphEnabled}
                    onChange={(event) =>
                      void onUpdateLibrary(selectedLibrary.id, {
                        graphEnabled: event.currentTarget.checked,
                        graphStrategy: selectedLibrary.graphStrategy
                      })
                    }
                    type="checkbox"
                  />
                  知识图谱
                </label>
                {selectedLibrary.graphEnabled && (
                  <select
                    aria-label="知识图谱抽取策略"
                    className="knowledge-workspace__strategy"
                    onChange={(event) =>
                      void onUpdateLibrary(selectedLibrary.id, {
                        graphEnabled: true,
                        graphStrategy:
                          event.currentTarget
                            .value as KnowledgeGraphStrategy
                      })
                    }
                    style={styles.input}
                    value={selectedLibrary.graphStrategy}
                  >
                    {Object.entries(strategyLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  aria-label={`删除知识库 ${selectedLibrary.name}`}
                  onClick={() => setDeletingLibrary(selectedLibrary)}
                  style={styles.button}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={15} />
                  删除知识库
                </button>
              </div>
            </header>
            <div
              aria-label="知识库视图"
              className="knowledge-workspace__tabs"
              role="tablist"
            >
              <button
                aria-selected={visibleTab === 'documents'}
                onClick={() => setTab('documents')}
                role="tab"
                style={{
                  ...styles.button,
                  background:
                    visibleTab === 'documents'
                      ? '#e6f4ff'
                      : 'transparent',
                  borderColor:
                    visibleTab === 'documents' ? '#1677ff' : 'transparent',
                  color:
                    visibleTab === 'documents' ? '#1677ff' : '#595959'
                }}
                type="button"
              >
                <FileText aria-hidden="true" size={15} />
                文档与来源
              </button>
              {selectedLibrary.graphEnabled && (
                <button
                  aria-selected={visibleTab === 'graph'}
                  onClick={() => setTab('graph')}
                  role="tab"
                  style={{
                    ...styles.button,
                    background:
                      visibleTab === 'graph'
                        ? '#e6f4ff'
                        : 'transparent',
                    borderColor:
                      visibleTab === 'graph' ? '#1677ff' : 'transparent',
                    color:
                      visibleTab === 'graph' ? '#1677ff' : '#595959'
                  }}
                  type="button"
                >
                  <Network aria-hidden="true" size={15} />
                  知识图谱
                </button>
              )}
            </div>
            <div className="knowledge-workspace__body">
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
              ) : (
                <GraphView
                  evidence={evidence}
                  graphNodes={graphNodes}
                  graphRelations={graphRelations}
                  onCreateEntity={onCreateEntity}
                  onCreateRelation={onCreateRelation}
                  onDeleteEntity={onDeleteEntity}
                  onDeleteRelation={onDeleteRelation}
                  onMergeEntities={onMergeEntities}
                  onMoveNode={onMoveNode}
                  onOpenEvidence={onOpenEvidence}
                  onUpdateEntity={onUpdateEntity}
                  onUpdateRelation={onUpdateRelation}
                />
              )}
            </div>
          </>
        )}
      </main>
      {deletingLibrary && (
        <DeleteLibraryDialog
          library={deletingLibrary}
          onCancel={() => setDeletingLibrary(undefined)}
          onConfirm={() => onDeleteLibrary(deletingLibrary.id)}
        />
      )}
    </section>
  )
}
