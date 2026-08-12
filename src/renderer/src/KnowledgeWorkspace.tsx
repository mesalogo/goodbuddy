import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  KnowledgeDocumentItem as SharedKnowledgeDocumentItem,
  KnowledgeEvidence as SharedKnowledgeEvidence,
  KnowledgeGraphNode as SharedKnowledgeGraphNode,
  KnowledgeGraphRelation as SharedKnowledgeGraphRelation,
  KnowledgeLibrary as SharedKnowledgeLibrary,
  KnowledgeSourceItem as SharedKnowledgeSource,
  KnowledgeTaskItem as SharedKnowledgeTaskItem
} from '../../shared/contracts'
import { stripKnowledgeHighlightTags } from '../../shared/knowledge-text'
import type {
  KnowledgeEmbeddingIndexSnapshot
} from '../../shared/embedding-contracts'
import {
  defaultKnowledgeChunkingSettings,
  defaultKnowledgeRetrievalSettings,
  type KnowledgeChunkPage,
  type KnowledgeChunkUpdateInput,
  type KnowledgeChunkingSettings,
  type KnowledgeRetrievalResponse,
  type KnowledgeRetrievalSettings
} from '../../shared/knowledge-contracts'
import {
  defaultKnowledgeOntologySettings,
  getKnowledgeOntologyDisplayDefinitions,
  isRelationEndpointAllowed,
  knowledgeOntologySettingsSchema,
  normalizeEntityTypeAlias,
  normalizeRelationTypeAlias,
  type KnowledgeOntologySettings
} from '../../shared/knowledge-ontology'
import {
  EmptyState,
  PageHeader,
  PageTabs,
  SegmentedControl,
  type PageTab
} from './WorkspacePrimitives'
import { KnowledgeGraphChart } from './KnowledgeGraphChart'
import {
  KnowledgeChunkManager
} from './KnowledgeChunkManager'
import {
  KnowledgeRetrievalWorkbench,
  type KnowledgeRetrievalWorkbenchResponse,
  type KnowledgeRetrievalWorkbenchSettings
} from './KnowledgeRetrievalWorkbench'
import { trapTabFocus } from './dialog-focus'
import { KnowledgeEmbeddingIndexSection } from './KnowledgeEmbeddingIndexSection'

export type KnowledgeLibrary = SharedKnowledgeLibrary
export type KnowledgeStorageMode = KnowledgeLibrary['storageMode']
export type KnowledgeGraphStrategy = KnowledgeLibrary['graphStrategy']
export type KnowledgeSource = SharedKnowledgeSource
export type KnowledgeSourceKind = KnowledgeSource['kind']
export type KnowledgeSourceStatus = KnowledgeSource['status']
export type KnowledgeDocumentItem = SharedKnowledgeDocumentItem
export type KnowledgeDocumentStatus = KnowledgeDocumentItem['status']

export type CreateKnowledgeLibraryInput = {
  name: string
  description: string
  storageMode: KnowledgeStorageMode
  graphEnabled: boolean
  graphStrategy: KnowledgeGraphStrategy
}

export type KnowledgeGraphNode = SharedKnowledgeGraphNode
export type KnowledgeGraphRelation = SharedKnowledgeGraphRelation
export type KnowledgeEvidence = SharedKnowledgeEvidence
export type KnowledgeTaskItem = SharedKnowledgeTaskItem

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
  onRetrieve: (
    libraryId: string,
    query: string,
    settings: KnowledgeRetrievalSettings
  ) => Promise<KnowledgeRetrievalResponse>
  onUpdateKnowledgeSettings: (
    libraryId: string,
    settings: {
      retrieval?: KnowledgeRetrievalSettings
      chunking?: KnowledgeChunkingSettings
      ontology?: KnowledgeOntologySettings
    }
  ) => void | Promise<void>
  onListChunks: (input: {
    libraryId: string
    documentId: string
    page: number
    pageSize: number
    search?: string
  }) => Promise<KnowledgeChunkPage>
  onUpdateChunk: (
    input: KnowledgeChunkUpdateInput
  ) => void | Promise<void>
  onDeleteChunk: (input: {
    knowledgeBaseId: string
    documentId: string
    chunkId: string
  }) => void | Promise<void>
  onRebuildDocument: (
    libraryId: string,
    documentId: string
  ) => void | Promise<void>
  onRebuildLibrary: (libraryId: string) => void | Promise<void>
  onCancelRebuild: (libraryId: string) => void | Promise<void>
  onGetEmbeddingIndex: (
    libraryId: string
  ) =>
    | KnowledgeEmbeddingIndexSnapshot
    | Promise<KnowledgeEmbeddingIndexSnapshot>
  onRebuildEmbeddingIndex: (
    libraryId: string
  ) => Promise<KnowledgeEmbeddingIndexSnapshot>
  onCancelTask: (taskId: string) => void | Promise<void>
  onRetryTask: (taskId: string) => void | Promise<void>
  onOpenReferenceSource: (input: {
    knowledgeBaseId: string
    documentId: string
    chunkId: string
  }) => void | Promise<void>
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
type GraphWorkspaceTab = 'explore' | 'settings'
type GraphSidebarTab = 'topology' | 'details'

const storageModeLabelKeys = {
  reference: 'storageModes.reference.label',
  managed: 'storageModes.managed.label'
} as const satisfies Record<KnowledgeStorageMode, string>

const strategyLabelKeys = {
  rules: 'strategies.rules',
  model: 'strategies.model',
  hybrid: 'strategies.hybrid',
  ask: 'strategies.ask'
} as const satisfies Record<KnowledgeGraphStrategy, string>

function parseAliases(value: string, limit?: number): string[] {
  const aliases = value
    .split(/[、,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
  return limit === undefined ? aliases : aliases.slice(0, limit)
}

const sourceStatusLabelKeys = {
  queued: 'sourceStatuses.queued',
  syncing: 'sourceStatuses.syncing',
  paused: 'sourceStatuses.paused',
  ready: 'sourceStatuses.ready',
  failed: 'sourceStatuses.failed'
} as const satisfies Record<KnowledgeSourceStatus, string>

const documentStatusLabelKeys = {
  queued: 'documentStatuses.queued',
  parsing: 'documentStatuses.parsing',
  indexing: 'documentStatuses.indexing',
  ready: 'documentStatuses.ready',
  failed: 'documentStatuses.failed'
} as const satisfies Record<KnowledgeDocumentStatus, string>

const taskKindLabelKeys = {
  'source-sync': 'taskKinds.sourceSync',
  'document-process': 'taskKinds.documentProcess',
  'document-rebuild': 'taskKinds.documentRebuild',
  'library-rebuild': 'taskKinds.libraryRebuild',
  'embedding-rebuild': 'taskKinds.embeddingRebuild',
  'graph-rebuild': 'taskKinds.graphRebuild',
  parsing: 'taskKinds.parsing',
  embedding: 'taskKinds.embedding',
  graph: 'taskKinds.graph'
} as const satisfies Record<KnowledgeTaskItem['kind'], string>

const taskStageLabelKeys = {
  queued: 'taskStages.queued',
  syncing: 'taskStages.syncing',
  reading: 'taskStages.reading',
  parsing: 'taskStages.parsing',
  chunking: 'taskStages.chunking',
  indexing: 'taskStages.indexing',
  embedding: 'taskStages.embedding',
  graph: 'taskStages.graph',
  finalizing: 'taskStages.finalizing'
} as const satisfies Record<KnowledgeTaskItem['stage'], string>

const taskStatusLabelKeys = {
  queued: 'taskStatuses.queued',
  running: 'taskStatuses.running',
  succeeded: 'taskStatuses.succeeded',
  failed: 'taskStatuses.failed',
  cancelled: 'taskStatuses.cancelled',
  skipped: 'taskStatuses.skipped',
  interrupted: 'taskStatuses.interrupted'
} as const satisfies Record<KnowledgeTaskItem['status'], string>

const taskScopeLabelKeys = {
  library: 'taskScopes.library',
  source: 'taskScopes.source',
  document: 'taskScopes.document'
} as const satisfies Record<KnowledgeTaskItem['scope'], string>

function toWorkbenchResponse(
  response: KnowledgeRetrievalResponse,
  libraryDocumentCount: number
): KnowledgeRetrievalWorkbenchResponse {
  const contextByChunkId = new Map(
    response.context.groups.map((group) => [
      group.resultChunkId,
      group
    ])
  )
  return {
    diagnostics: {
      durationMs: response.durationMs,
      requestedChannels: response.diagnostics.requestedChannels,
      usedChannels: response.diagnostics.usedChannels,
      degradedChannels: response.diagnostics.degradedChannels,
      candidateCounts: response.diagnostics.candidateCounts,
      channelDurationsMs: response.diagnostics.channelDurationMs,
      vectorScannedCount: response.diagnostics.vectorScannedCount,
      rerank: response.diagnostics.rerank
    },
    results: response.results.map((result) => {
      const context = contextByChunkId.get(result.chunkId)
      return {
        chunkId: result.chunkId,
        documentId: result.documentId,
        rank: result.rank,
        documentName: result.documentTitle,
        sourceName: result.sourceDisplayName,
        locator: result.location,
        snippet: stripKnowledgeHighlightTags(result.snippet),
        fusedScore: result.scores.fusedScore,
        relevance: result.relevance,
        channels: result.channels,
        channelDetails: {
          fts: {
            rank: result.scores.ftsRank
          },
          cjk: {
            rank: result.scores.cjkRank
          },
          vector: {
            rank: result.scores.vectorRank,
            similarity: result.scores.vectorSimilarity
          },
          graph: {
            rank: result.scores.graphRank
          }
        },
        rankBeforeRerank: result.preRerankRank,
        contextText: context?.content,
        contextCharacterCount: context?.characterCount,
        contextTruncated: context?.truncated
      }
    }),
    context: {
      characterCount: response.context.characterCount,
      budget: response.settings.contextMaxCharacters,
      truncated: response.context.truncated
    },
    zeroReason:
      response.results.length > 0
        ? undefined
        : libraryDocumentCount === 0
          ? 'empty-library'
          : response.diagnostics.filteredByThresholdCount > 0
            ? 'filtered'
            : response.diagnostics.degradedChannels.some(
                  (item) => item.channel === 'vector'
                ) &&
                response.diagnostics.usedChannels.length === 0
              ? 'index-unavailable'
              : 'no-match'
  }
}

function resolvedLocale(language: string): string {
  return language || 'zh-CN'
}

type LocaleFormatters = {
  compactDateTime: Intl.DateTimeFormat
  dateTime: Intl.DateTimeFormat
  decimal: Intl.NumberFormat
  integer: Intl.NumberFormat
  percent: Intl.NumberFormat
}

const localeFormatters = new Map<string, LocaleFormatters>()

function getLocaleFormatters(locale: string): LocaleFormatters {
  const existing = localeFormatters.get(locale)
  if (existing) {
    return existing
  }
  const formatters: LocaleFormatters = {
    compactDateTime: new Intl.DateTimeFormat(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }),
    dateTime: new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }),
    decimal: new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    }),
    integer: new Intl.NumberFormat(locale),
    percent: new Intl.NumberFormat(locale, {
      style: 'percent',
      maximumFractionDigits: 0
    })
  }
  localeFormatters.set(locale, formatters)
  return formatters
}

function formatNumber(value: number, locale: string): string {
  return getLocaleFormatters(locale).integer.format(value)
}

function formatPercent(value: number, locale: string): string {
  return getLocaleFormatters(locale).percent.format(value)
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

function formatTime(
  value: string | undefined,
  locale: string,
  t: TFunction<'knowledge'>
): string {
  if (!value) {
    return t('format.neverSynced')
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return t('format.unknownTime')
  }
  return getLocaleFormatters(locale).compactDateTime.format(date)
}

function formatDateTime(
  value: string,
  locale: string,
  t: TFunction<'knowledge'>
): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? t('format.unknownTime')
    : getLocaleFormatters(locale).dateTime.format(date)
}

function formatSize(
  size: number | undefined,
  locale: string,
  t: TFunction<'knowledge'>
): string {
  if (!Number.isFinite(size) || (size ?? 0) < 0) {
    return t('format.unknownSize')
  }
  const value = size ?? 0
  const formatters = getLocaleFormatters(locale)
  if (value < 1024) {
    return `${formatters.integer.format(value)} B`
  }
  if (value < 1024 * 1024) {
    return `${formatters.decimal.format(value / 1024)} KB`
  }
  return `${formatters.decimal.format(value / 1024 / 1024)} MB`
}

function formatDocumentLocation(
  value: string,
  t: TFunction<'knowledge'>
): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${url.pathname}`
    }
  } catch {
    // Local paths are intentionally reduced below.
  }
  const filename = value.split(/[\\/]/u).filter(Boolean).at(-1)
  return filename
    ? t('format.localFileNamed', { filename })
    : t('format.localFile')
}

function toErrorMessage(
  reason: unknown,
  t: TFunction<'knowledge'>
): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : t('errors.operationFailed')
}

function CreateLibraryWizard({
  onCancel,
  onCreate
}: {
  onCancel: () => void
  onCreate: KnowledgeWorkspaceProps['onCreateLibrary']
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [storageMode, setStorageMode] =
    useState<KnowledgeStorageMode>('reference')
  const [graphEnabled, setGraphEnabled] = useState(false)
  const [graphStrategy, setGraphStrategy] =
    useState<KnowledgeGraphStrategy>('rules')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    if (!name.trim()) {
      setError(t('validation.libraryNameRequired'))
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
      setError(toErrorMessage(reason, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      aria-label={t('create.ariaLabel')}
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
          {t('create.eyebrow')}
        </span>
        <h2 style={{ margin: '5px 0 0', fontSize: 22 }}>
          {t('create.title')}
        </h2>
      </div>
      <label style={styles.label}>
        {t('fields.name')}
        <input
          autoFocus
          onChange={(event) => setName(event.currentTarget.value)}
          style={styles.input}
          value={name}
        />
      </label>
      <label style={styles.label}>
        {t('fields.description')}
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
        <legend style={{ ...styles.label, marginBottom: 8 }}>
          {t('fields.storageMode')}
        </legend>
        {(
          [
            [
              'reference',
              t('storageModes.reference.label'),
              t('storageModes.reference.description')
            ],
            [
              'managed',
              t('storageModes.managed.label'),
              t('storageModes.managed.description')
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
        className="toggle-row"
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
          role="switch"
          type="checkbox"
        />
        <span>
          <strong style={{ display: 'block' }}>
            {t('graph.enable')}
          </strong>
          <span style={styles.muted}>{t('graph.enableDescription')}</span>
        </span>
      </label>
      {graphEnabled && (
        <label style={styles.label}>
          {t('fields.graphGenerationStrategy')}
          <select
            onChange={(event) =>
              setGraphStrategy(
                event.currentTarget.value as KnowledgeGraphStrategy
              )
            }
            style={styles.input}
            value={graphStrategy}
          >
            {Object.entries(strategyLabelKeys).map(([value, key]) => (
              <option key={value} value={value}>
                {t(key)}
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
          {t('actions.cancel')}
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
          {saving ? t('actions.creating') : t('actions.createLibrary')}
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
  const { t } = useTranslation('knowledge')
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
      setError(t('validation.libraryNameRequired'))
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
      setError(toErrorMessage(reason, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      aria-label={t('edit.ariaLabel')}
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
        aria-label={t('edit.formAriaLabel')}
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
          <h2 style={{ margin: 0 }}>{t('edit.title')}</h2>
          <p style={{ ...styles.muted, margin: '6px 0 0' }}>
            {t('edit.description')}
          </p>
        </div>
        <label style={styles.label}>
          {t('fields.name')}
          <input
            onChange={(event) => setName(event.currentTarget.value)}
            ref={nameRef}
            style={styles.input}
            value={name}
          />
        </label>
        <label style={styles.label}>
          {t('fields.description')}
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
            {t('actions.cancel')}
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
            {saving ? t('actions.saving') : t('actions.saveChanges')}
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
  const { t } = useTranslation('knowledge')
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
      setError(toErrorMessage(reason, t))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      aria-label={t('delete.ariaLabel')}
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
        <h2 style={{ margin: '12px 0 8px' }}>
          {t('delete.title', { name: library.name })}
        </h2>
        <p style={{ ...styles.muted, margin: 0 }}>
          {library.storageMode === 'managed'
            ? t('delete.managedDescription')
            : t('delete.referenceDescription')}
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
            {t('actions.cancel')}
          </button>
          <button
            className="danger-button"
            disabled={deleting}
            onClick={() => void confirm()}
            style={styles.button}
            type="button"
          >
            <Trash2 aria-hidden="true" size={15} />
            {deleting ? t('actions.deleting') : t('actions.confirmDelete')}
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
  onManageChunks,
  onRemoveSource,
  onRetrySource,
  onSyncSource,
  onViewTasks,
  sources,
  tasks
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
  | 'tasks'
> & {
  library: KnowledgeLibrary
  onManageChunks: (document: KnowledgeDocumentItem) => void
  onViewTasks: (context: {
    documentId?: string
    sourceId?: string
  }) => void
}): React.JSX.Element {
  const { i18n, t } = useTranslation('knowledge')
  const locale = resolvedLocale(i18n.resolvedLanguage ?? i18n.language)
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
      setError(toErrorMessage(reason, t))
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
    const normalized = query.trim().toLocaleLowerCase(locale)
    if (!normalized) {
      return documents
    }
    return documents.filter((document) =>
      `${document.name} ${document.path ?? ''}`
        .toLocaleLowerCase(locale)
        .includes(normalized)
    )
  }, [documents, locale, query])

  return (
    <div className="knowledge-documents" style={{ display: 'grid', gap: 18 }}>
      <section aria-labelledby="sources-title">
        <div
          className="knowledge-documents__section-heading"
        >
          <div>
            <h3 id="sources-title" style={{ margin: 0 }}>
              {t('documents.sources.title')}
            </h3>
            <p style={{ ...styles.muted, margin: '5px 0 0' }}>
              {t(
                library.graphEnabled
                  ? 'documents.sources.descriptionWithGraph'
                  : 'documents.sources.description'
              )}
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
              {t('actions.importFiles')}
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
              {t('actions.importDirectory')}
            </button>
            <button
              className="secondary-button"
              onClick={() => setUrlOpen((current) => !current)}
              style={styles.button}
              type="button"
            >
              <Link2 aria-hidden="true" size={15} />
              {t('actions.importUrl')}
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
            {t('documents.importStrategy')}
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
              <option value="rules">
                {t('documents.importStrategies.rules')}
              </option>
              <option value="model">
                {t('documents.importStrategies.model')}
              </option>
              <option value="hybrid">
                {t('documents.importStrategies.hybrid')}
              </option>
            </select>
          </label>
        )}

        {urlOpen && (
          <form
            aria-label={t('documents.urlImport.ariaLabel')}
            className="knowledge-documents__url-form"
            onSubmit={(event) => {
              event.preventDefault()
              const value = url.trim()
              if (!value) {
                setError(t('validation.urlRequired'))
                return
              }
              let parsed: URL
              try {
                parsed = new URL(value)
              } catch {
                setError(t('validation.urlInvalid'))
                return
              }
              if (!['http:', 'https:'].includes(parsed.protocol)) {
                setError(t('validation.urlProtocol'))
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
              aria-label={t('documents.urlImport.addressAriaLabel')}
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
              {t('actions.import')}
            </button>
            <button
              aria-label={t('documents.urlImport.closeAriaLabel')}
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
            {t('documents.dropFiles', { name: library.name })}
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
            <strong>{t('documents.sources.emptyTitle')}</strong>
            <p style={{ ...styles.muted, marginBottom: 0 }}>
              {t('documents.sources.emptyDescription')}
            </p>
          </div>
        ) : (
          <ul
            aria-label={t('documents.sources.listAriaLabel')}
            style={{
              display: 'grid',
              gap: 9,
              margin: '12px 0 0',
              padding: 0,
              listStyle: 'none'
            }}
          >
            {sources.map((source) => {
              const relatedTasks = tasks?.filter(
                (task) => task.sourceId === source.id
              ) ?? []
              return (
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
                      {t(sourceStatusLabelKeys[source.status])}
                      {source.status === 'syncing' &&
                      source.progress !== undefined
                        ? ` · ${formatPercent(
                            clampProgress(source.progress) / 100,
                            locale
                          )}`
                        : ''}
                    </span>
                  </div>
                  <div style={{ ...styles.muted, marginTop: 5 }}>
                    {t('documents.sourceMeta', {
                      count: formatNumber(source.documentCount, locale),
                      time: formatTime(source.lastSyncedAt, locale, t)
                    })}
                  </div>
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
                  {relatedTasks.length > 0 && (
                    <button
                      className="secondary-button"
                      onClick={() =>
                        onViewTasks({ sourceId: source.id })
                      }
                      type="button"
                    >
                      <ListChecks aria-hidden="true" size={14} />
                      {t('actions.viewTasks')}
                    </button>
                  )}
                  {source.status === 'syncing' ? (
                    <button
                      aria-label={t('documents.actions.pauseSource', {
                        name: source.name
                      })}
                      className="secondary-button"
                      disabled={pending === source.id}
                      onClick={() =>
                        void run(source.id, () => onPauseSource(source.id))
                      }
                      style={styles.button}
                      type="button"
                    >
                      <CirclePause aria-hidden="true" size={14} />
                      {t('actions.pause')}
                    </button>
                  ) : source.status === 'failed' ? (
                    <button
                      aria-label={t('documents.actions.retrySource', {
                        name: source.name
                      })}
                      className="secondary-button"
                      disabled={pending === source.id}
                      onClick={() =>
                        void run(source.id, () => onRetrySource(source.id))
                      }
                      style={styles.button}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" size={14} />
                      {t('actions.retry')}
                    </button>
                  ) : (
                    <button
                      aria-label={t('documents.actions.syncSource', {
                        name: source.name
                      })}
                      className="secondary-button"
                      disabled={pending === source.id}
                      onClick={() =>
                        void run(source.id, () => onSyncSource(source.id))
                      }
                      style={styles.button}
                      type="button"
                    >
                      <RefreshCw aria-hidden="true" size={14} />
                      {t('actions.sync')}
                    </button>
                  )}
                  <button
                    aria-label={t('documents.actions.removeSource', {
                      name: source.name
                    })}
                    className="danger-button danger-button--quiet"
                    disabled={pending === source.id}
                    onClick={() =>
                      void run(source.id, () => onRemoveSource(source.id))
                    }
                    style={styles.button}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    {t('actions.remove')}
                  </button>
                </div>
              </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="documents-title">
        <div
          className="knowledge-documents__section-heading"
        >
          <h3 id="documents-title" style={{ margin: 0 }}>
            {t('documents.table.title')}
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
              {t('documents.search.label')}
            </span>
            <input
              aria-label={t('documents.search.label')}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t('documents.search.placeholder')}
              style={{ ...styles.input, paddingLeft: 34 }}
              type="search"
              value={query}
            />
          </label>
        </div>
        {filteredDocuments.length === 0 ? (
          <div style={{ ...styles.surface, marginTop: 12, padding: 18 }}>
            {documents.length === 0
              ? t('documents.table.empty')
              : t('documents.table.noResults')}
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
                  <th style={{ padding: '9px 10px' }}>
                    {t('documents.table.columns.document')}
                  </th>
                  <th style={{ padding: '9px 10px' }}>
                    {t('documents.table.columns.processingStatus')}
                  </th>
                  <th style={{ padding: '9px 10px' }}>
                    {t('documents.table.columns.chunks')}
                  </th>
                  <th style={{ padding: '9px 10px' }}>
                    {t('documents.table.columns.size')}
                  </th>
                  <th style={{ padding: '9px 10px' }}>
                    {t('documents.table.columns.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredDocuments.map((document) => {
                  const relatedTasks = tasks?.filter(
                    (task) => task.documentId === document.id
                  ) ?? []
                  const activeTask = relatedTasks.find(
                    (task) =>
                      task.status === 'queued' ||
                      task.status === 'running'
                  )
                  return (
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
                          {formatDocumentLocation(document.path, t)}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: 10 }}>
                      <div className="knowledge-document-status">
                        <span
                          className={`knowledge-document-status__durable knowledge-document-status__durable--${document.status}`}
                        >
                          {t(documentStatusLabelKeys[document.status])}
                        </span>
                        {activeTask && (
                          <span className="knowledge-document-status__active">
                            {t(taskStageLabelKeys[activeTask.stage])}
                            {' · '}
                            {formatPercent(
                              clampProgress(activeTask.progress) / 100,
                              locale
                            )}
                          </span>
                        )}
                      </div>
                      {document.error && (
                        <div
                          style={{ color: 'var(--danger)', marginTop: 4 }}
                        >
                          {document.error}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: 10 }}>
                      {document.chunkCount === undefined
                        ? '—'
                        : formatNumber(document.chunkCount, locale)}
                    </td>
                    <td style={{ padding: 10 }}>
                      {formatSize(document.size, locale, t)}
                    </td>
                    <td style={{ padding: 10 }}>
                      <div className="knowledge-document-actions">
                        {relatedTasks.length > 0 && (
                          <button
                            className="secondary-button"
                            onClick={() =>
                              onViewTasks({ documentId: document.id })
                            }
                            type="button"
                          >
                            <ListChecks aria-hidden="true" size={14} />
                            {t('actions.viewTasks')}
                          </button>
                        )}
                        <button
                          className="secondary-button"
                          disabled={document.status !== 'ready'}
                          onClick={() => onManageChunks(document)}
                          type="button"
                        >
                          {t('chunks.title')}
                        </button>
                      </div>
                    </td>
                  </tr>
                  )
                })}
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
  ontology,
  onCancel,
  onSave
}: {
  node?: KnowledgeGraphNode
  ontology: KnowledgeOntologySettings
  onCancel: () => void
  onSave: (update: KnowledgeEntityUpdate) => void | Promise<void>
}): React.JSX.Element {
  const { i18n, t } = useTranslation('knowledge')
  const display = useMemo(
    () =>
      getKnowledgeOntologyDisplayDefinitions(
        ontology,
        resolvedLocale(i18n.resolvedLanguage ?? i18n.language) === 'zh-CN'
          ? 'zh'
          : 'en'
      ),
    [i18n.language, i18n.resolvedLanguage, ontology]
  )
  const [label, setLabel] = useState(node?.label ?? '')
  const [type, setType] = useState(
    normalizeEntityTypeAlias(node?.type, ontology)
  )
  const [description, setDescription] = useState(node?.description ?? '')
  const [aliases, setAliases] = useState(
    (node?.aliases ?? []).join(t('format.listSeparator'))
  )

  return (
    <form
      aria-label={
        node ? t('entityEditor.editAriaLabel') : t('entityEditor.addAriaLabel')
      }
      onSubmit={(event) => {
        event.preventDefault()
        void onSave({
          label: label.trim(),
          type: type.trim(),
          description: description.trim(),
          aliases: parseAliases(aliases)
        })
      }}
      style={{ display: 'grid', gap: 10 }}
    >
      <label style={styles.label}>
        {t('fields.name')}
        <input
          onChange={(event) => setLabel(event.currentTarget.value)}
          required
          style={styles.input}
          value={label}
        />
      </label>
      <label style={styles.label}>
        {t('fields.type')}
        <select
          onChange={(event) => setType(event.currentTarget.value)}
          required
          style={styles.input}
          value={type}
        >
          {display.entityTypes.map((definition) => (
            <option key={definition.id} value={definition.id}>
              {definition.label} ({definition.id})
            </option>
          ))}
        </select>
      </label>
      <label style={styles.label}>
        {t('fields.description')}
        <textarea
          onChange={(event) => setDescription(event.currentTarget.value)}
          rows={3}
          style={{ ...styles.input, resize: 'vertical' }}
          value={description}
        />
      </label>
      <label style={styles.label}>
        {t('fields.aliases')}
        <input
          onChange={(event) => setAliases(event.currentTarget.value)}
          style={styles.input}
          value={aliases}
        />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary-button" style={styles.button}>
          {node ? t('actions.saveEntity') : t('actions.addEntity')}
        </button>
        <button
          className="secondary-button"
          onClick={onCancel}
          style={styles.button}
          type="button"
        >
          {t('actions.cancel')}
        </button>
      </div>
    </form>
  )
}

function RelationForm({
  nodes,
  ontology,
  onCancel,
  onSave,
  relation,
  sourceId
}: {
  nodes: readonly KnowledgeGraphNode[]
  ontology: KnowledgeOntologySettings
  onCancel: () => void
  onSave: (
    input: KnowledgeRelationInput
  ) => void | Promise<void>
  relation?: KnowledgeGraphRelation
  sourceId: string
}): React.JSX.Element {
  const { i18n, t } = useTranslation('knowledge')
  const display = useMemo(
    () =>
      getKnowledgeOntologyDisplayDefinitions(
        ontology,
        resolvedLocale(i18n.resolvedLanguage ?? i18n.language) === 'zh-CN'
          ? 'zh'
          : 'en'
      ),
    [i18n.language, i18n.resolvedLanguage, ontology]
  )
  const [source, setSource] = useState(relation?.sourceId ?? sourceId)
  const [target, setTarget] = useState(
    relation?.targetId ??
      nodes.find((node) => node.id !== sourceId)?.id ??
      ''
  )
  const [type, setType] = useState(
    normalizeRelationTypeAlias(relation?.type, ontology) ?? ''
  )
  const [description, setDescription] = useState(
    relation?.description ?? ''
  )
  const sourceNode = nodes.find((node) => node.id === source)
  const targetNode = nodes.find((node) => node.id === target)
  const allowedRelationTypes = display.relationTypes.filter(
    (definition) =>
      !sourceNode ||
      !targetNode ||
      isRelationEndpointAllowed(
        definition.id,
        sourceNode.type,
        targetNode.type,
        ontology
      )
  )
  const selectedType = allowedRelationTypes.some(
    (definition) => definition.id === type
  )
    ? type
    : ''

  return (
    <form
      aria-label={
        relation
          ? t('relationEditor.editAriaLabel')
          : t('relationEditor.addAriaLabel')
      }
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
        {t('fields.source')}
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
        {t('fields.target')}
        <select
          onChange={(event) => setTarget(event.currentTarget.value)}
          required
          style={styles.input}
          value={target}
        >
          <option disabled value="">
            {t('graph.selectEntity')}
          </option>
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.label}
            </option>
          ))}
        </select>
      </label>
      <label style={styles.label}>
        {t('fields.relationType')}
        <select
          onChange={(event) => setType(event.currentTarget.value)}
          required
          style={styles.input}
          value={selectedType}
        >
          <option disabled value="">
            {t('relationEditor.selectType')}
          </option>
          {allowedRelationTypes.map((definition) => (
            <option key={definition.id} value={definition.id}>
              {definition.label} ({definition.id})
            </option>
          ))}
        </select>
        {allowedRelationTypes.length === 0 && (
          <span className="knowledge-settings__field-help">
            {t('relationEditor.noCompatibleTypes')}
          </span>
        )}
      </label>
      <label style={styles.label}>
        {t('fields.notes')}
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
          {relation ? t('actions.saveRelation') : t('actions.addRelation')}
        </button>
        <button
          className="secondary-button"
          onClick={onCancel}
          style={styles.button}
          type="button"
        >
          {t('actions.cancel')}
        </button>
      </div>
    </form>
  )
}

function KnowledgeSettingsView({
  library,
  mode,
  onCancelRebuild,
  onGetEmbeddingIndex,
  onRebuildLibrary,
  onRebuildEmbeddingIndex,
  onViewTasks,
  onUpdateKnowledgeSettings,
  onUpdateLibrary
}: {
  library: KnowledgeLibrary
  mode: 'index' | 'graph'
  onCancelRebuild: KnowledgeWorkspaceProps['onCancelRebuild']
  onGetEmbeddingIndex: KnowledgeWorkspaceProps['onGetEmbeddingIndex']
  onRebuildLibrary: KnowledgeWorkspaceProps['onRebuildLibrary']
  onRebuildEmbeddingIndex:
    KnowledgeWorkspaceProps['onRebuildEmbeddingIndex']
  onViewTasks: () => void
  onUpdateKnowledgeSettings:
    KnowledgeWorkspaceProps['onUpdateKnowledgeSettings']
  onUpdateLibrary: KnowledgeWorkspaceProps['onUpdateLibrary']
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [saving, setSaving] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [embeddingIndexLoading, setEmbeddingIndexLoading] =
    useState(true)
  const [embeddingIndex, setEmbeddingIndex] =
    useState<KnowledgeEmbeddingIndexSnapshot>()
  const [error, setError] = useState<string>()
  const [chunking, setChunking] = useState(
    library.chunkingSettings ?? defaultKnowledgeChunkingSettings
  )
  const [ontology, setOntology] = useState<KnowledgeOntologySettings>(
    library.ontologySettings ?? defaultKnowledgeOntologySettings
  )
  const [ontologyError, setOntologyError] = useState<string>()

  const requestEmbeddingIndex = useCallback(
    () => Promise.resolve(onGetEmbeddingIndex(library.id)),
    [library.id, onGetEmbeddingIndex]
  )
  const updateEmbeddingIndex = useCallback(
    (snapshot: KnowledgeEmbeddingIndexSnapshot): void => {
      setEmbeddingIndex((current) => {
        const currentJob = current?.indexStatus.job
        const nextJob = snapshot.indexStatus.job
        return current &&
          current.knowledgeBaseId === snapshot.knowledgeBaseId &&
          current.enabled === snapshot.enabled &&
          current.configuration?.provider ===
            snapshot.configuration?.provider &&
          current.configuration?.model === snapshot.configuration?.model &&
          current.configuration?.endpoint ===
            snapshot.configuration?.endpoint &&
          current.configuration?.credentialConfigured ===
            snapshot.configuration?.credentialConfigured &&
          current.coverage.total === snapshot.coverage.total &&
          current.coverage.indexed === snapshot.coverage.indexed &&
          current.coverage.missing === snapshot.coverage.missing &&
          current.coverage.error === snapshot.coverage.error &&
          currentJob?.id === nextJob?.id &&
          currentJob?.status === nextJob?.status &&
          currentJob?.progress.completed ===
            nextJob?.progress.completed &&
          currentJob?.progress.total === nextJob?.progress.total &&
          currentJob?.progress.percent === nextJob?.progress.percent &&
          currentJob?.completedAt === nextJob?.completedAt &&
          currentJob?.error?.code === nextJob?.error?.code &&
          currentJob?.error?.message === nextJob?.error?.message &&
          currentJob?.error?.remedy === nextJob?.error?.remedy
          ? current
          : snapshot
      })
    },
    []
  )

  useEffect(() => {
    if (mode !== 'index') {
      return
    }
    let active = true
    void requestEmbeddingIndex()
      .then((snapshot) => {
        if (active && snapshot.knowledgeBaseId === library.id) {
          updateEmbeddingIndex(snapshot)
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(toErrorMessage(reason, t))
        }
      })
      .finally(() => {
        if (active) {
          setEmbeddingIndexLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [library.id, mode, requestEmbeddingIndex, t, updateEmbeddingIndex])

  useEffect(() => {
    if (mode !== 'index') {
      return
    }
    const active =
      embeddingIndex?.indexStatus.job?.status === 'queued' ||
      embeddingIndex?.indexStatus.job?.status === 'running'
    if (!active) {
      return
    }
    let mounted = true
    let timeout: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      void requestEmbeddingIndex()
        .then((snapshot) => {
          if (!mounted || snapshot.knowledgeBaseId !== library.id) {
            return
          }
          updateEmbeddingIndex(snapshot)
        })
        .catch(() => undefined)
        .finally(() => {
          if (mounted) {
            timeout = setTimeout(() => {
              void poll()
            }, 350)
          }
        })
    }
    timeout = setTimeout(() => {
      void poll()
    }, 350)
    return () => {
      mounted = false
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }, [
    embeddingIndex?.indexStatus.job?.status,
    library.id,
    mode,
    requestEmbeddingIndex,
    updateEmbeddingIndex
  ])

  const update = async (
    change: Parameters<KnowledgeWorkspaceProps['onUpdateLibrary']>[1]
  ): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      await onUpdateLibrary(library.id, change)
    } catch (reason) {
      setError(toErrorMessage(reason, t))
    } finally {
      setSaving(false)
    }
  }

  const saveChunking = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      await onUpdateKnowledgeSettings(library.id, { chunking })
    } catch (reason) {
      setError(toErrorMessage(reason, t))
    } finally {
      setSaving(false)
    }
  }

  const saveOntology = async (): Promise<void> => {
    const parsed = knowledgeOntologySettingsSchema.safeParse(ontology)
    if (!parsed.success) {
      setOntologyError(t('settings.ontology.validation'))
      return
    }
    setSaving(true)
    setError(undefined)
    setOntologyError(undefined)
    try {
      await onUpdateKnowledgeSettings(library.id, {
        ontology: parsed.data
      })
    } catch (reason) {
      setError(toErrorMessage(reason, t))
    } finally {
      setSaving(false)
    }
  }

  const rebuildLibrary = async (): Promise<void> => {
    setRebuilding(true)
    setError(undefined)
    try {
      await onRebuildLibrary(library.id)
    } catch (reason) {
      setError(toErrorMessage(reason, t))
    } finally {
      setRebuilding(false)
    }
  }

  const cancelRebuild = async (): Promise<void> => {
    setError(undefined)
    try {
      await onCancelRebuild(library.id)
    } catch (reason) {
      setError(toErrorMessage(reason, t))
    }
  }

  const rebuildEmbeddingIndex = async (): Promise<void> => {
    setError(undefined)
    try {
      setEmbeddingIndex(
        await onRebuildEmbeddingIndex(library.id)
      )
    } catch (reason) {
      setError(toErrorMessage(reason, t))
    }
  }

  return (
    <div
      className={`knowledge-settings knowledge-settings--${mode}`}
    >
      {mode === 'index' && (
        <KnowledgeEmbeddingIndexSection
          loading={embeddingIndexLoading}
          onRebuild={() => void rebuildEmbeddingIndex()}
          onViewTasks={onViewTasks}
          snapshot={embeddingIndex}
        />
      )}
      {mode === 'index' && (
      <section
        aria-labelledby="knowledge-graph-capability-title"
        style={{ ...styles.surface, padding: 16 }}
      >
        <div>
          <h3 id="knowledge-graph-capability-title" style={{ margin: 0 }}>
            {t('settings.graphCapability.title')}
          </h3>
          <p style={{ ...styles.muted, margin: '6px 0 0' }}>
            {t('settings.graphCapability.description')}
          </p>
        </div>
        <label
          className="knowledge-settings__toggle toggle-row"
          style={{ ...styles.surface, cursor: saving ? 'wait' : 'pointer' }}
        >
          <input
            checked={library.graphEnabled}
            disabled={saving}
            onChange={(event) =>
              void update({ graphEnabled: event.currentTarget.checked })
            }
            role="switch"
            type="checkbox"
          />
          <span>
            <strong style={{ display: 'block' }}>{t('graph.enable')}</strong>
            <span style={styles.muted}>
              {library.graphEnabled
                ? t('settings.graphCapability.enabledDescription')
                : t('settings.graphCapability.disabledDescription')}
            </span>
          </span>
        </label>
      </section>
      )}
      {mode === 'graph' && (
      <section
        aria-labelledby="knowledge-graph-settings-title"
        style={{ ...styles.surface, padding: 16 }}
      >
        <div>
          <h3 id="knowledge-graph-settings-title" style={{ margin: 0 }}>
            {t('settings.graphConfiguration.title')}
          </h3>
          <p style={{ ...styles.muted, margin: '6px 0 0' }}>
            {t('settings.graphConfiguration.description')}
          </p>
        </div>
        <label style={styles.label}>
          {t('fields.graphExtractionStrategy')}
          <select
            aria-label={t('settings.strategyAriaLabel')}
            disabled={saving}
            onChange={(event) =>
              void update({
                graphStrategy:
                  event.currentTarget.value as KnowledgeGraphStrategy
              })
            }
            style={styles.input}
            value={library.graphStrategy}
          >
            {Object.entries(strategyLabelKeys).map(([value, key]) => (
              <option key={value} value={value}>
                {t(key)}
              </option>
            ))}
          </select>
          <span style={styles.muted}>
            {t('settings.askDescription')}
          </span>
        </label>
      </section>
      )}
      {mode === 'index' && (
      <section
        aria-labelledby="knowledge-chunking-settings-title"
        style={{ ...styles.surface, padding: 16 }}
      >
        <div>
          <h3
            id="knowledge-chunking-settings-title"
            style={{ margin: 0 }}
          >
            {t('settings.chunking.title')}
          </h3>
          <p style={{ ...styles.muted, margin: '6px 0 0' }}>
            {t('settings.chunking.description')}
          </p>
        </div>
        <label style={styles.label}>
          {t('settings.chunking.mode')}
          <select
            disabled={saving || rebuilding}
            onChange={(event) =>
              setChunking((current) => ({
                ...current,
                mode: event.currentTarget
                  .value as KnowledgeChunkingSettings['mode']
              }))
            }
            style={styles.input}
            value={chunking.mode}
          >
            <option value="fixed">
              {t('settings.chunking.modes.fixed')}
            </option>
            <option value="structure">
              {t('settings.chunking.modes.structure')}
            </option>
            <option value="parent-child">
              {t('settings.chunking.modes.parentChild')}
            </option>
          </select>
        </label>
        <label className="toggle-row">
          <span>
            <strong>{t('settings.chunking.contextualIndexing')}</strong>
            <small>
              {t('settings.chunking.contextualIndexingDescription')}
            </small>
          </span>
          <input
            checked={chunking.contextualIndexingEnabled}
            disabled={saving || rebuilding}
            onChange={(event) =>
              setChunking((current) => ({
                ...current,
                contextualIndexingEnabled: event.currentTarget.checked
              }))
            }
            role="switch"
            type="checkbox"
          />
        </label>
        <div className="knowledge-settings__chunking-grid">
          <label style={styles.label}>
            {t('settings.chunking.targetCharacters')}
            <input
              disabled={saving || rebuilding}
              max={8_000}
              min={400}
              onChange={(event) =>
                setChunking((current) => ({
                  ...current,
                  targetCharacters: Number(event.currentTarget.value)
                }))
              }
              style={styles.input}
              type="number"
              value={chunking.targetCharacters}
            />
          </label>
          <label style={styles.label}>
            {t('settings.chunking.overlapCharacters')}
            <input
              disabled={saving || rebuilding}
              max={3_200}
              min={0}
              onChange={(event) =>
                setChunking((current) => ({
                  ...current,
                  overlapCharacters: Number(event.currentTarget.value)
                }))
              }
              style={styles.input}
              type="number"
              value={chunking.overlapCharacters}
            />
          </label>
          {chunking.mode === 'parent-child' && (
            <>
              <label style={styles.label}>
                {t('settings.chunking.parentCharacters')}
                <input
                  disabled={saving || rebuilding}
                  max={16_000}
                  min={1_600}
                  onChange={(event) =>
                    setChunking((current) => ({
                      ...current,
                      parentCharacters: Number(
                        event.currentTarget.value
                      )
                    }))
                  }
                  style={styles.input}
                  type="number"
                  value={chunking.parentCharacters}
                />
              </label>
              <label style={styles.label}>
                {t('settings.chunking.childCharacters')}
                <input
                  disabled={saving || rebuilding}
                  max={4_000}
                  min={300}
                  onChange={(event) =>
                    setChunking((current) => ({
                      ...current,
                      childCharacters: Number(
                        event.currentTarget.value
                      )
                    }))
                  }
                  style={styles.input}
                  type="number"
                  value={chunking.childCharacters}
                />
              </label>
            </>
          )}
        </div>
        {library.chunkingRebuildRequired && (
          <p className="knowledge-settings__rebuild-note" role="status">
            {t('settings.chunking.rebuildRequired')}
          </p>
        )}
        <div className="knowledge-settings__actions">
          <button
            className="primary-button"
            disabled={saving || rebuilding}
            onClick={() => void saveChunking()}
            type="button"
          >
            {saving
              ? t('settings.chunking.saving')
              : t('settings.chunking.save')}
          </button>
          <button
            className="secondary-button"
            disabled={saving}
            onClick={() =>
              void (
                rebuilding ? cancelRebuild() : rebuildLibrary()
              )
            }
            type="button"
          >
            <RefreshCw aria-hidden="true" size={15} />
            {rebuilding
              ? t('settings.chunking.cancelRebuild')
              : t('settings.chunking.rebuild')}
          </button>
        </div>
      </section>
      )}
      {mode === 'graph' && (
      <section
        aria-labelledby="knowledge-ontology-settings-title"
        className="knowledge-settings__ontology"
        style={{ ...styles.surface, padding: 16 }}
      >
        <div>
          <h3 id="knowledge-ontology-settings-title" style={{ margin: 0 }}>
            {t('settings.ontology.title')}
          </h3>
          <p style={{ ...styles.muted, margin: '6px 0 0' }}>
            {t('settings.ontology.description')}
          </p>
        </div>
        {library.ontologyRebuildRequired && (
          <p className="knowledge-settings__rebuild-note" role="status">
            {t('settings.ontology.rebuildRequired')}
          </p>
        )}
        <div className="knowledge-settings__definition-group">
          <h4>{t('settings.ontology.entityTypes')}</h4>
          {ontology.entityTypes.map((definition, index) => (
            <fieldset
              className="knowledge-settings__definition"
              key={`${definition.id}-${index}`}
            >
              <legend>{definition.id}</legend>
              <div className="knowledge-settings__definition-grid">
                <label>
                  {t('settings.ontology.id')}
                  <input
                    disabled={saving || definition.id === 'CONCEPT'}
                    maxLength={64}
                    onChange={(event) => {
                      const id = event.currentTarget.value
                        .toLocaleUpperCase('en-US')
                        .replace(/[^A-Z0-9_]/g, '')
                      setOntology((current) => ({
                        ...current,
                        entityTypes: current.entityTypes.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, id } : item
                        ),
                        relationTypes: current.relationTypes.map((relation) => ({
                          ...relation,
                          sourceTypes: relation.sourceTypes?.map((typeId) =>
                            typeId === definition.id ? id : typeId
                          ),
                          targetTypes: relation.targetTypes?.map((typeId) =>
                            typeId === definition.id ? id : typeId
                          )
                        }))
                      }))
                    }}
                    value={definition.id}
                  />
                </label>
                <label>
                  {t('settings.ontology.nameZh')}
                  <input
                    disabled={saving}
                    maxLength={80}
                    onChange={(event) => {
                      const value = event.currentTarget.value
                      setOntology((current) => ({
                        ...current,
                        entityTypes: current.entityTypes.map((item, itemIndex) =>
                          itemIndex === index
                            ? {
                                ...item,
                                name: {
                                  ...item.name,
                                  zh: value
                                }
                              }
                            : item
                        )
                      }))
                    }}
                    value={definition.name.zh}
                  />
                </label>
                <label>
                  {t('settings.ontology.nameEn')}
                  <input
                    disabled={saving}
                    maxLength={80}
                    onChange={(event) => {
                      const value = event.currentTarget.value
                      setOntology((current) => ({
                        ...current,
                        entityTypes: current.entityTypes.map((item, itemIndex) =>
                          itemIndex === index
                            ? {
                                ...item,
                                name: {
                                  ...item.name,
                                  en: value
                                }
                              }
                            : item
                        )
                      }))
                    }}
                    value={definition.name.en}
                  />
                </label>
                <label>
                  {t('settings.ontology.aliases')}
                  <input
                    defaultValue={definition.aliases.join(', ')}
                    disabled={saving}
                    maxLength={2592}
                    onBlur={(event) => {
                      const value = event.currentTarget.value
                      setOntology((current) => ({
                        ...current,
                        entityTypes: current.entityTypes.map((item, itemIndex) =>
                          itemIndex === index
                            ? {
                                ...item,
                                aliases: parseAliases(value, 32)
                              }
                            : item
                        )
                      }))
                    }}
                  />
                </label>
              </div>
            </fieldset>
          ))}
        </div>
        <div className="knowledge-settings__definition-group">
          <h4>{t('settings.ontology.relationTypes')}</h4>
          {ontology.relationTypes.map((definition, index) => (
            <fieldset
              className="knowledge-settings__definition"
              key={`${definition.id}-${index}`}
            >
              <legend>{definition.id}</legend>
              <div className="knowledge-settings__definition-grid">
                <label>
                  {t('settings.ontology.id')}
                  <input
                    disabled={saving}
                    maxLength={64}
                    onChange={(event) => {
                      const id = event.currentTarget.value
                        .toLocaleUpperCase('en-US')
                        .replace(/[^A-Z0-9_]/g, '')
                      setOntology((current) => ({
                        ...current,
                        relationTypes: current.relationTypes.map(
                          (item, itemIndex) =>
                            itemIndex === index ? { ...item, id } : item
                        )
                      }))
                    }}
                    value={definition.id}
                  />
                </label>
                <label>
                  {t('settings.ontology.nameZh')}
                  <input
                    disabled={saving}
                    maxLength={80}
                    onChange={(event) => {
                      const value = event.currentTarget.value
                      setOntology((current) => ({
                        ...current,
                        relationTypes: current.relationTypes.map(
                          (item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  name: {
                                    ...item.name,
                                    zh: value
                                  }
                                }
                              : item
                        )
                      }))
                    }}
                    value={definition.name.zh}
                  />
                </label>
                <label>
                  {t('settings.ontology.nameEn')}
                  <input
                    disabled={saving}
                    maxLength={80}
                    onChange={(event) => {
                      const value = event.currentTarget.value
                      setOntology((current) => ({
                        ...current,
                        relationTypes: current.relationTypes.map(
                          (item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  name: {
                                    ...item.name,
                                    en: value
                                  }
                                }
                              : item
                        )
                      }))
                    }}
                    value={definition.name.en}
                  />
                </label>
                <label>
                  {t('settings.ontology.aliases')}
                  <input
                    defaultValue={definition.aliases.join(', ')}
                    disabled={saving}
                    maxLength={2592}
                    onBlur={(event) => {
                      const value = event.currentTarget.value
                      setOntology((current) => ({
                        ...current,
                        relationTypes: current.relationTypes.map(
                          (item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  aliases: parseAliases(value, 32)
                                }
                              : item
                        )
                      }))
                    }}
                  />
                </label>
              </div>
              <div className="knowledge-settings__endpoint-grid">
                {(['sourceTypes', 'targetTypes'] as const).map((field) => (
                  <fieldset key={field}>
                    <legend>
                      {t(
                        field === 'sourceTypes'
                          ? 'settings.ontology.sourceTypes'
                          : 'settings.ontology.targetTypes'
                      )}
                    </legend>
                    <label className="knowledge-settings__all-endpoints">
                      <input
                        checked={!definition[field]}
                        disabled={saving}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked
                          setOntology((current) => ({
                            ...current,
                            relationTypes: current.relationTypes.map(
                              (item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      [field]: checked
                                        ? undefined
                                        : [current.entityTypes[0]!.id]
                                    }
                                  : item
                            )
                          }))
                        }}
                        type="checkbox"
                      />
                      {t('settings.ontology.anyEndpoint')}
                    </label>
                    {!definition[field] &&
                      <span className="knowledge-settings__field-help">
                        {t('settings.ontology.anyEndpointHelp')}
                      </span>}
                    {definition[field] &&
                      ontology.entityTypes.map((entityType) => (
                        <label key={entityType.id}>
                          <input
                            checked={definition[field]?.includes(
                              entityType.id
                            )}
                            disabled={
                              saving ||
                              (definition[field]?.length === 1 &&
                                definition[field]?.[0] === entityType.id)
                            }
                            onChange={(event) => {
                              const checked = event.currentTarget.checked
                              setOntology((current) => ({
                                ...current,
                                relationTypes: current.relationTypes.map(
                                  (item, itemIndex) =>
                                    itemIndex === index
                                      ? {
                                          ...item,
                                          [field]: checked
                                            ? [
                                                ...(item[field] ?? []),
                                                entityType.id
                                              ]
                                            : item[field]?.filter(
                                                (typeId) =>
                                                  typeId !== entityType.id
                                              )
                                        }
                                      : item
                                )
                              }))
                            }}
                            type="checkbox"
                          />
                          {entityType.name.zh} / {entityType.name.en}
                        </label>
                      ))}
                  </fieldset>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        {ontologyError && <p role="alert">{ontologyError}</p>}
        <div className="knowledge-settings__actions">
          <button
            className="primary-button"
            disabled={saving || rebuilding}
            onClick={() => void saveOntology()}
            type="button"
          >
            {saving
              ? t('settings.ontology.saving')
              : t('settings.ontology.save')}
          </button>
        </div>
        <p className="knowledge-settings__field-help">
          {t('settings.ontology.noImplicitRebuild')}
        </p>
      </section>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  )
}

type KnowledgeTaskFilter = 'all' | 'active' | 'failed' | 'history'
type KnowledgeTaskContext = {
  documentId?: string
  sourceId?: string
}
type KnowledgeTaskAction = 'cancel' | 'retry'
type KnowledgeTaskActionError = {
  action: KnowledgeTaskAction
  message: string
}

function KnowledgeTasksView({
  context,
  onCancelTask,
  onClearContext,
  onRetryTask,
  tasks
}: {
  context?: KnowledgeTaskContext
  onCancelTask: KnowledgeWorkspaceProps['onCancelTask']
  onClearContext: () => void
  onRetryTask: KnowledgeWorkspaceProps['onRetryTask']
  tasks: readonly KnowledgeTaskItem[]
}): React.JSX.Element {
  const { i18n, t } = useTranslation('knowledge')
  const locale = resolvedLocale(i18n.resolvedLanguage ?? i18n.language)
  const [filter, setFilter] = useState<KnowledgeTaskFilter>('all')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        tasks
          .filter(
            (task) =>
              task.status === 'queued' || task.status === 'running'
          )
          .map((task) => task.parentTaskId)
          .filter((id): id is string => Boolean(id))
      )
  )
  const [pendingActions, setPendingActions] = useState<
    ReadonlyMap<string, KnowledgeTaskAction>
  >(() => new Map())
  const [actionErrors, setActionErrors] = useState<
    ReadonlyMap<string, KnowledgeTaskActionError>
  >(() => new Map())
  const activeCount = tasks.filter(
    (task) => task.status === 'queued' || task.status === 'running'
  ).length
  const failedCount = tasks.filter(
    (task) =>
      task.status === 'failed' || task.status === 'interrupted'
  ).length
  const historyCount = tasks.length - activeCount - failedCount
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks]
  )
  const childrenByParent = useMemo(() => {
    const result = new Map<string, KnowledgeTaskItem[]>()
    for (const task of tasks) {
      if (!task.parentTaskId || !taskById.has(task.parentTaskId)) {
        continue
      }
      const children = result.get(task.parentTaskId) ?? []
      children.push(task)
      result.set(task.parentTaskId, children)
    }
    return result
  }, [taskById, tasks])
  const contextTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (!context?.documentId ||
            task.documentId === context.documentId) &&
          (!context?.sourceId || task.sourceId === context.sourceId)
      ),
    [context, tasks]
  )
  const directMatches = useMemo(
    () =>
      contextTasks.filter((task) => {
        if (filter === 'active') {
          return task.status === 'queued' || task.status === 'running'
        }
        if (filter === 'failed') {
          return (
            task.status === 'failed' ||
            task.status === 'interrupted'
          )
        }
        if (filter === 'history') {
          return ![
            'queued',
            'running',
            'failed',
            'interrupted'
          ].includes(task.status)
        }
        return true
      }),
    [contextTasks, filter]
  )
  const visibleIds = useMemo(() => {
    const result = new Set(directMatches.map((task) => task.id))
    for (const task of directMatches) {
      let parentId = task.parentTaskId
      while (parentId && taskById.has(parentId)) {
        result.add(parentId)
        parentId = taskById.get(parentId)?.parentTaskId
      }
    }
    return result
  }, [directMatches, taskById])
  const topLevelTasks = tasks.filter(
    (task) =>
      visibleIds.has(task.id) &&
      (!task.parentTaskId || !taskById.has(task.parentTaskId))
  )
  const filterOptions = [
    { value: 'all', label: t('tasks.filters.all') },
    { value: 'active', label: t('tasks.filters.active') },
    { value: 'failed', label: t('tasks.filters.failed') },
    { value: 'history', label: t('tasks.filters.history') }
  ] as const
  const runTaskAction = async (
    taskId: string,
    action: KnowledgeTaskAction,
    invoke: (taskId: string) => void | Promise<void>
  ): Promise<void> => {
    setPendingActions((current) => {
      const next = new Map(current)
      next.set(taskId, action)
      return next
    })
    setActionErrors((current) => {
      if (!current.has(taskId)) {
        return current
      }
      const next = new Map(current)
      next.delete(taskId)
      return next
    })
    try {
      await invoke(taskId)
    } catch (reason) {
      setActionErrors((current) => {
        const next = new Map(current)
        next.set(taskId, {
          action,
          message: toErrorMessage(reason, t)
        })
        return next
      })
    } finally {
      setPendingActions((current) => {
        const next = new Map(current)
        next.delete(taskId)
        return next
      })
    }
  }

  const renderTask = (
    task: KnowledgeTaskItem,
    nested = false
  ): React.JSX.Element => {
    const children = (childrenByParent.get(task.id) ?? []).filter(
      (child) => visibleIds.has(child.id)
    )
    const hasChildren = children.length > 0
    const isExpanded = expanded.has(task.id)
    const detailsId = `knowledge-task-${task.id}-details`
    const actionErrorId = `knowledge-task-${task.id}-action-error`
    const pendingAction = pendingActions.get(task.id)
    const actionError = actionErrors.get(task.id)
    const time =
      task.completedAt ??
      task.updatedAt ??
      task.startedAt ??
      task.createdAt
    return (
      <li
        className={`knowledge-task${
          nested ? ' knowledge-task--child' : ''
        }`}
        data-status={task.status}
        key={task.id}
      >
        <div className="knowledge-task__heading">
          <div className="knowledge-task__identity">
            {hasChildren ? (
              <button
                aria-controls={detailsId}
                aria-expanded={isExpanded}
                aria-label={t(
                  isExpanded
                    ? 'tasks.actions.collapse'
                    : 'tasks.actions.expand',
                  { name: task.documentName }
                )}
                className="knowledge-task__disclosure"
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(task.id)) {
                      next.delete(task.id)
                    } else {
                      next.add(task.id)
                    }
                    return next
                  })
                }
                type="button"
              >
                {isExpanded ? (
                  <ChevronDown aria-hidden="true" size={16} />
                ) : (
                  <ChevronRight aria-hidden="true" size={16} />
                )}
              </button>
            ) : (
              <span
                aria-hidden="true"
                className="knowledge-task__disclosure-placeholder"
              />
            )}
            <div>
              <strong>{task.documentName}</strong>
              <span>
                <span>{t(taskKindLabelKeys[task.kind])}</span>
                {' · '}
                <span>{t(taskScopeLabelKeys[task.scope])}</span>
              </span>
            </div>
          </div>
          <span
            className={`knowledge-task__status knowledge-task__status--${task.status}`}
          >
            {t(taskStatusLabelKeys[task.status])}
          </span>
        </div>
        <div className="knowledge-task__stage">
          <strong>{t('tasks.currentStage')}</strong>
          <span>{t(taskStageLabelKeys[task.stage])}</span>
          {task.completedItems !== undefined &&
            task.totalItems !== undefined && (
              <span>
                {t('tasks.itemProgress', {
                  completed: formatNumber(task.completedItems, locale),
                  total: formatNumber(task.totalItems, locale)
                })}
              </span>
            )}
        </div>
        <div className="knowledge-task__progress">
          <progress
            aria-label={t('tasks.progressAriaLabel', {
              name: task.documentName,
              kind: t(taskKindLabelKeys[task.kind])
            })}
            max={100}
            value={clampProgress(task.progress)}
          />
          <span>
            {formatPercent(clampProgress(task.progress) / 100, locale)}
          </span>
        </div>
        <div className="knowledge-task__meta">
          <span>{task.message || t('tasks.waiting')}</span>
          <time dateTime={time}>
            {formatDateTime(time, locale, t)}
          </time>
        </div>
        {task.error && (
          <div className="knowledge-task__error">
            <strong>{t('tasks.errorTitle')}</strong>
            <span>{task.error.message}</span>
            <span>
              {task.error.remedy ?? t('tasks.defaultRemedy')}
            </span>
          </div>
        )}
        {(task.canCancel || task.canRetry) && (
          <div
            aria-describedby={actionError ? actionErrorId : undefined}
            className="knowledge-task__actions"
          >
            {task.canCancel && (
              <button
                className="secondary-button"
                disabled={pendingAction !== undefined}
                onClick={() =>
                  void runTaskAction(
                    task.id,
                    'cancel',
                    onCancelTask
                  )
                }
                type="button"
              >
                {pendingAction === 'cancel' ? (
                  <LoaderCircle aria-hidden="true" size={14} />
                ) : (
                  <X aria-hidden="true" size={14} />
                )}
                {pendingAction === 'cancel'
                  ? t('tasks.actions.cancelling')
                  : t('tasks.actions.cancel')}
              </button>
            )}
            {task.canRetry && (
              <button
                className="secondary-button"
                disabled={pendingAction !== undefined}
                onClick={() =>
                  void runTaskAction(task.id, 'retry', onRetryTask)
                }
                type="button"
              >
                {pendingAction === 'retry' ? (
                  <LoaderCircle aria-hidden="true" size={14} />
                ) : (
                  <RotateCcw aria-hidden="true" size={14} />
                )}
                {pendingAction === 'retry'
                  ? t('tasks.actions.retrying')
                  : t('tasks.actions.retry')}
              </button>
            )}
          </div>
        )}
        {actionError && (
          <div
            className="knowledge-task__action-error"
            id={actionErrorId}
            role="alert"
          >
            <strong>
              {t(
                actionError.action === 'cancel'
                  ? 'tasks.actionErrors.cancelTitle'
                  : 'tasks.actionErrors.retryTitle'
              )}
            </strong>
            <span>{actionError.message}</span>
            <span>{t('tasks.actionErrors.recovery')}</span>
          </div>
        )}
        {hasChildren && isExpanded && (
          <ol className="knowledge-task__children" id={detailsId}>
            {children.map((child) => renderTask(child, true))}
          </ol>
        )}
      </li>
    )
  }

  if (tasks.length === 0) {
    return (
      <EmptyState
        description={t('tasks.emptyDescription')}
        icon={<ListChecks size={30} />}
        level="section"
        title={t('tasks.emptyTitle')}
      />
    )
  }

  return (
    <section
      aria-labelledby="knowledge-tasks-title"
      className="knowledge-tasks"
    >
      <div className="knowledge-tasks__summary">
        <div>
          <h3 id="knowledge-tasks-title" style={{ margin: 0 }}>
            {t('tasks.title')}
          </h3>
          <p style={{ ...styles.muted, margin: '5px 0 0' }}>
            {t('tasks.totalCount', {
              count: formatNumber(tasks.length, locale)
            })}
          </p>
        </div>
        <div className="knowledge-tasks__metrics">
          <span>
            {t('tasks.activeCount', {
              count: formatNumber(activeCount, locale)
            })}
          </span>
          <span>
            {t('tasks.failedCount', {
              count: formatNumber(failedCount, locale)
            })}
          </span>
          <span>
            {t('tasks.historyCount', {
              count: formatNumber(historyCount, locale)
            })}
          </span>
        </div>
      </div>
      <div className="knowledge-tasks__toolbar">
        <SegmentedControl
          ariaLabel={t('tasks.filters.ariaLabel')}
          onChange={setFilter}
          options={filterOptions}
          value={filter}
        />
        {context && (
          <div className="knowledge-tasks__context">
            <span>{t('tasks.context.active')}</span>
            <button
              className="secondary-button"
              onClick={onClearContext}
              type="button"
            >
              {t('tasks.context.clear')}
            </button>
          </div>
        )}
      </div>
      {topLevelTasks.length === 0 ? (
        <EmptyState
          description={t('tasks.noResultsDescription')}
          icon={<ListChecks size={28} />}
          level="section"
          title={t('tasks.noResultsTitle')}
        />
      ) : (
      <ol className="knowledge-task-list">
        {topLevelTasks.map((task) => renderTask(task))}
      </ol>
      )}
    </section>
  )
}

function GraphRelationPath({
  nodeMap,
  onSelectNode,
  relation,
  relationLabel
}: {
  nodeMap: ReadonlyMap<string, KnowledgeGraphNode>
  onSelectNode: (nodeId: string) => void
  relation: KnowledgeGraphRelation
  relationLabel: (type: string) => string
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const source = nodeMap.get(relation.sourceId)
  const target = nodeMap.get(relation.targetId)

  return (
    <div className="knowledge-graph__relation-path">
      <button
        className="knowledge-graph__entity-link"
        disabled={!source}
        onClick={() => source && onSelectNode(source.id)}
        type="button"
      >
        {source?.label ?? t('graph.unknownEntity')}
      </button>
      <span className="knowledge-graph__relation-type">
        <ArrowRight aria-hidden="true" size={13} />
        {relationLabel(relation.type)}
      </span>
      <button
        className="knowledge-graph__entity-link"
        disabled={!target}
        onClick={() => target && onSelectNode(target.id)}
        type="button"
      >
        {target?.label ?? t('graph.unknownEntity')}
      </button>
    </div>
  )
}

function GraphSidebarNavigation({
  onChange,
  relationCount,
  value
}: {
  onChange: (value: GraphSidebarTab) => void
  relationCount: number
  value: GraphSidebarTab
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  return (
    <PageTabs
      ariaLabel={t('graph.sidebar.ariaLabel')}
      idPrefix="knowledge-graph-sidebar"
      onChange={onChange}
      tabs={[
        {
          id: 'topology',
          label: t('graph.sidebar.topology'),
          count: relationCount
        },
        {
          id: 'details',
          label: t('graph.sidebar.details')
        }
      ]}
      value={value}
      variant="segmented"
    />
  )
}

function GraphView({
  evidence,
  graphNodes,
  graphRelations,
  libraryId,
  ontology,
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
  ontology: KnowledgeOntologySettings
}): React.JSX.Element {
  const { i18n, t } = useTranslation('knowledge')
  const locale = resolvedLocale(i18n.resolvedLanguage ?? i18n.language)
  const ontologyDisplay = useMemo(
    () =>
      getKnowledgeOntologyDisplayDefinitions(
        ontology,
        locale === 'zh-CN' ? 'zh' : 'en'
      ),
    [locale, ontology]
  )
  const entityTypeLabel = useCallback(
    (type: string) => {
      const canonical = normalizeEntityTypeAlias(type, ontology)
      const definition = ontologyDisplay.entityTypes.find(
        (candidate) => candidate.id === canonical
      )
      return definition ? `${definition.label} (${definition.id})` : type
    },
    [ontology, ontologyDisplay.entityTypes]
  )
  const relationTypeLabel = useCallback(
    (type: string) => {
      const canonical = normalizeRelationTypeAlias(type, ontology)
      const definition = ontologyDisplay.relationTypes.find(
        (candidate) => candidate.id === canonical
      )
      return definition ? `${definition.label} (${definition.id})` : type
    },
    [ontology, ontologyDisplay.relationTypes]
  )
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [editingEntity, setEditingEntity] = useState(false)
  const [creatingEntity, setCreatingEntity] = useState(false)
  const [relationForm, setRelationForm] =
    useState<KnowledgeGraphRelation | 'new'>()
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [zoom, setZoom] = useState(1)
  const [fitViewRequest, setFitViewRequest] = useState(0)
  const [sidebarTab, setSidebarTab] =
    useState<GraphSidebarTab>('topology')
  const [reextracting, setReextracting] = useState(false)
  const [reextractError, setReextractError] = useState<string>()

  const nodeMap = useMemo(
    () => new Map(graphNodes.map((node) => [node.id, node])),
    [graphNodes]
  )
  const types = useMemo(
    () =>
      Array.from(
        new Set(
          graphNodes.map((node) =>
            normalizeEntityTypeAlias(node.type, ontology)
          )
        )
      ).sort((left, right) =>
        entityTypeLabel(left).localeCompare(entityTypeLabel(right), locale)
      ),
    [entityTypeLabel, graphNodes, locale, ontology]
  )
  const visibleNodes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale)
    return graphNodes.filter(
      (node) =>
        (typeFilter === 'all' ||
          normalizeEntityTypeAlias(node.type, ontology) === typeFilter) &&
        (!normalized ||
          `${node.label} ${node.type} ${node.description ?? ''} ${(node.aliases ?? []).join(' ')}`
            .toLocaleLowerCase(locale)
            .includes(normalized))
    )
  }, [graphNodes, locale, ontology, query, typeFilter])
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
    setSidebarTab('details')
    setCreatingEntity(false)
    setEditingEntity(false)
    setRelationForm(undefined)
  }

  return (
    <div className="knowledge-graph knowledge-graph--with-details">
      <section
        aria-label={t('graph.canvasAriaLabel')}
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
              aria-label={t('graph.searchAriaLabel')}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t('graph.searchPlaceholder')}
              style={{ ...styles.input, paddingLeft: 34 }}
              type="search"
              value={query}
            />
          </label>
          <select
            aria-label={t('graph.typeFilterAriaLabel')}
            className="knowledge-graph__filter"
            onChange={(event) => setTypeFilter(event.currentTarget.value)}
            style={styles.input}
            value={typeFilter}
          >
            <option value="all">{t('graph.allTypes')}</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {entityTypeLabel(type)}
              </option>
            ))}
          </select>
          <select
            aria-label={t('graph.entityPickerAriaLabel')}
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
            <option value="">{t('graph.selectEntity')}</option>
            {visibleNodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label} · {entityTypeLabel(node.type)}
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
                .catch((reason) =>
                  setReextractError(toErrorMessage(reason, t))
                )
                .finally(() => setReextracting(false))
            }}
            style={styles.button}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={15} />
            {reextracting
              ? t('actions.reextracting')
              : t('actions.reextract')}
          </button>
          <button
            className="secondary-button"
            onClick={() => {
              setSelectedNodeId(undefined)
              setCreatingEntity(true)
              setSidebarTab('details')
            }}
            style={styles.button}
            type="button"
          >
            <Plus aria-hidden="true" size={15} />
            {t('actions.addEntity')}
          </button>
          <button
            aria-label={t('graph.zoomOutAriaLabel')}
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
            {formatPercent(zoom, locale)}
          </span>
          <button
            aria-label={t('graph.zoomInAriaLabel')}
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
          <button
            className="secondary-button"
            onClick={() => setFitViewRequest((current) => current + 1)}
            style={styles.button}
            type="button"
          >
            <RotateCcw aria-hidden="true" size={15} />
            {t('graph.fitView')}
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
              <p>{t('graph.empty')}</p>
            </div>
          </div>
        ) : (
          <KnowledgeGraphChart
            fitViewRequest={fitViewRequest}
            nodes={visibleNodes}
            onMoveNode={onMoveNode}
            onSelectNode={selectNode}
            onZoomChange={setZoom}
            relations={visibleRelations}
            selectedNodeId={selectedNodeId}
            zoom={zoom}
          />
        )}
      </section>

      {sidebarTab === 'topology' && (
        <aside
          aria-label={t('graph.topologyAriaLabel')}
          className="knowledge-graph__detail"
        >
          <GraphSidebarNavigation
            onChange={setSidebarTab}
            relationCount={visibleRelations.length}
            value={sidebarTab}
          />
          <section
            aria-labelledby="knowledge-graph-sidebar-tab-topology"
            className="knowledge-graph__detail-panel"
            id="knowledge-graph-sidebar-panel-topology"
            role="tabpanel"
          >
            <div className="knowledge-graph__panel-heading">
              <div>
                <h3>{t('graph.visibleRelations.title')}</h3>
                <p>{t('graph.visibleRelations.description')}</p>
              </div>
              <span>
                {t('graph.visibleRelations.count', {
                  count: formatNumber(visibleRelations.length, locale)
                })}
              </span>
            </div>
            <p className="knowledge-graph__interaction-hint">
              {t('graph.interactionHint')}
            </p>
            {visibleRelations.length === 0 ? (
              <p className="knowledge-graph__panel-empty">
                {t('graph.visibleRelations.empty')}
              </p>
            ) : (
              <ul
                aria-label={t('graph.visibleRelations.listAriaLabel')}
                className="knowledge-graph__topology-list"
              >
                {visibleRelations.map((relation) => (
                  <li
                    className="knowledge-graph__relation-card"
                    key={relation.id}
                  >
                    <GraphRelationPath
                      nodeMap={nodeMap}
                      onSelectNode={selectNode}
                      relation={relation}
                      relationLabel={relationTypeLabel}
                    />
                    {relation.description && (
                      <p>{relation.description}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      )}

      {sidebarTab === 'details' && creatingEntity && (
        <aside
          aria-label={t('graph.addEntityPanelAriaLabel')}
          className="knowledge-graph__detail"
        >
          <GraphSidebarNavigation
            onChange={setSidebarTab}
            relationCount={visibleRelations.length}
            value={sidebarTab}
          />
          <section
            aria-labelledby="knowledge-graph-sidebar-tab-details"
            className="knowledge-graph__detail-panel"
            id="knowledge-graph-sidebar-panel-details"
            role="tabpanel"
          >
            <h3 style={{ marginTop: 0 }}>{t('actions.addEntity')}</h3>
            <EntityEditor
              ontology={ontology}
              onCancel={() => {
                setCreatingEntity(false)
                setSidebarTab('topology')
              }}
              onSave={async (input) => {
                await onCreateEntity(input)
                setCreatingEntity(false)
                setSidebarTab('topology')
              }}
            />
          </section>
        </aside>
      )}

      {sidebarTab === 'details' && selectedNode && (
        <aside
          aria-label={t('graph.entityDetailsAriaLabel')}
          className="knowledge-graph__detail"
        >
          <GraphSidebarNavigation
            onChange={setSidebarTab}
            relationCount={visibleRelations.length}
            value={sidebarTab}
          />
          <section
            aria-labelledby="knowledge-graph-sidebar-tab-details"
            className="knowledge-graph__detail-panel"
            id="knowledge-graph-sidebar-panel-details"
            role="tabpanel"
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
                {entityTypeLabel(selectedNode.type)}
              </span>
              <h3 style={{ margin: '4px 0 0' }}>{selectedNode.label}</h3>
            </div>
            <button
              aria-label={t('graph.closeEntityDetailsAriaLabel')}
              className="secondary-button"
              onClick={() => {
                setSelectedNodeId(undefined)
                setSidebarTab('topology')
              }}
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
                ontology={ontology}
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
                {selectedNode.description || t('graph.noEntityDescription')}
              </p>
              {(selectedNode.aliases?.length ?? 0) > 0 && (
                <div style={{ ...styles.muted, marginBottom: 12 }}>
                  {t('graph.aliases', {
                    aliases: selectedNode.aliases?.join(
                      t('format.listSeparator')
                    )
                  })}
                </div>
              )}
              <div className="knowledge-graph__entity-actions">
                <button
                  className="secondary-button"
                  onClick={() => setEditingEntity(true)}
                  style={styles.button}
                  type="button"
                >
                  <Pencil aria-hidden="true" size={14} />
                  {t('actions.edit')}
                </button>
                <button
                  className="danger-button danger-button--quiet"
                  onClick={() => void onDeleteEntity(selectedNode.id)}
                  style={styles.button}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={14} />
                  {t('actions.delete')}
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
            className="knowledge-graph__section-heading"
          >
            <strong>{t('graph.relations')}</strong>
            <button
              className="secondary-button"
              onClick={() => setRelationForm('new')}
              style={{ ...styles.button, padding: '6px 9px' }}
              type="button"
            >
              <Plus aria-hidden="true" size={14} />
              {t('actions.add')}
            </button>
          </div>
          {relationForm && (
            <RelationForm
              nodes={graphNodes}
              ontology={ontology}
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
            className="knowledge-graph__entity-relations"
          >
            {relatedRelations.map((relation) => {
              return (
                <li
                  className="knowledge-graph__relation-card"
                  key={relation.id}
                >
                  <GraphRelationPath
                    nodeMap={nodeMap}
                    onSelectNode={selectNode}
                    relation={relation}
                    relationLabel={relationTypeLabel}
                  />
                  {relation.description && (
                    <p>{relation.description}</p>
                  )}
                  <div className="knowledge-graph__relation-actions">
                    <button
                      aria-label={t('graph.editRelationAriaLabel', {
                        type: relation.type
                      })}
                      className="secondary-button"
                      onClick={() => setRelationForm(relation)}
                      style={{ ...styles.button, padding: 6 }}
                      type="button"
                    >
                      <Pencil aria-hidden="true" size={13} />
                      {t('actions.edit')}
                    </button>
                    <button
                      aria-label={t('graph.deleteRelationAriaLabel', {
                        type: relation.type
                      })}
                      className="danger-button danger-button--quiet"
                      onClick={() => void onDeleteRelation(relation.id)}
                      style={{ ...styles.button, padding: 6 }}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={13} />
                      {t('actions.delete')}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>

          <strong>{t('graph.merge.title')}</strong>
          <div className="knowledge-graph__merge">
            <select
              aria-label={t('graph.merge.targetAriaLabel')}
              onChange={(event) => setMergeTargetId(event.currentTarget.value)}
              style={styles.input}
              value={mergeTargetId}
            >
              <option value="">{t('graph.merge.targetPlaceholder')}</option>
              {graphNodes
                .filter((node) => node.id !== selectedNode.id)
                .map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label}
                  </option>
                ))}
            </select>
            <button
              aria-label={t('graph.merge.actionAriaLabel')}
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
          <strong>
            {t('graph.evidence.title', {
              count: formatNumber(selectedEvidence.length, locale)
            })}
          </strong>
          {selectedEvidence.length === 0 ? (
            <p style={styles.muted}>{t('graph.evidence.empty')}</p>
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
          </section>
        </aside>
      )}

      {sidebarTab === 'details' && !selectedNode && !creatingEntity && (
        <aside
          aria-label={t('graph.detailsAriaLabel')}
          className="knowledge-graph__detail"
        >
          <GraphSidebarNavigation
            onChange={setSidebarTab}
            relationCount={visibleRelations.length}
            value={sidebarTab}
          />
          <section
            aria-labelledby="knowledge-graph-sidebar-tab-details"
            className="knowledge-graph__detail-panel"
            id="knowledge-graph-sidebar-panel-details"
            role="tabpanel"
          >
            <p className="knowledge-graph__panel-empty">
              {t('graph.detailsPrompt')}
            </p>
          </section>
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
  onRetrieve,
  onUpdateKnowledgeSettings,
  onListChunks,
  onUpdateChunk,
  onDeleteChunk,
  onRebuildDocument,
  onRebuildLibrary,
  onCancelRebuild,
  onGetEmbeddingIndex,
  onRebuildEmbeddingIndex,
  onCancelTask,
  onRetryTask,
  onOpenReferenceSource,
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
  const { i18n, t } = useTranslation('knowledge')
  const locale = resolvedLocale(i18n.resolvedLanguage ?? i18n.language)
  const [creating, setCreating] = useState(false)
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [tab, setTab] = useState<WorkspaceTab>('documents')
  const [graphTab, setGraphTab] =
    useState<GraphWorkspaceTab>('explore')
  const [taskContext, setTaskContext] =
    useState<KnowledgeTaskContext>()
  const [editingLibrary, setEditingLibrary] =
    useState<KnowledgeLibrary>()
  const [deletingLibrary, setDeletingLibrary] =
    useState<KnowledgeLibrary>()
  const [retrievalOpen, setRetrievalOpen] = useState(false)
  const [retrievalStatus, setRetrievalStatus] =
    useState<'idle' | 'running' | 'error' | 'success'>('idle')
  const [retrievalError, setRetrievalError] = useState<string>()
  const [retrievalResponse, setRetrievalResponse] =
    useState<KnowledgeRetrievalWorkbenchResponse>()
  const [savingRetrievalSettings, setSavingRetrievalSettings] =
    useState(false)
  const [chunkDocument, setChunkDocument] =
    useState<KnowledgeDocumentItem>()
  const [chunkPage, setChunkPage] = useState<KnowledgeChunkPage>({
    items: [],
    page: 1,
    pageSize: 50,
    totalItems: 0
  })
  const [chunkQuery, setChunkQuery] = useState('')
  const [selectedChunkId, setSelectedChunkId] = useState<string>()
  const [chunkLoading, setChunkLoading] = useState(false)
  const [chunkError, setChunkError] = useState<string>()
  const [savingChunkId, setSavingChunkId] = useState<string>()
  const [deletingChunkId, setDeletingChunkId] = useState<string>()
  const [rebuildingDocument, setRebuildingDocument] = useState(false)
  const chunkRequestIdRef = useRef(0)
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

  const loadChunks = async (
    document: KnowledgeDocumentItem,
    page: number,
    search: string
  ): Promise<void> => {
    const requestId = ++chunkRequestIdRef.current
    setChunkLoading(true)
    setChunkError(undefined)
    try {
      const result = await onListChunks({
        libraryId: document.libraryId,
        documentId: document.id,
        page,
        pageSize: chunkPage.pageSize,
        search: search || undefined
      })
      if (requestId !== chunkRequestIdRef.current) {
        return
      }
      setChunkPage(result)
      setChunkQuery(search)
    } catch (reason) {
      if (requestId === chunkRequestIdRef.current) {
        setChunkError(toErrorMessage(reason, t))
      }
    } finally {
      if (requestId === chunkRequestIdRef.current) {
        setChunkLoading(false)
      }
    }
  }

  const openChunkManager = (
    document: KnowledgeDocumentItem,
    chunkId?: string,
    search = ''
  ): void => {
    setChunkDocument(document)
    setSelectedChunkId(chunkId)
    setChunkPage((current) => ({
      items: [],
      page: 1,
      pageSize: current.pageSize,
      totalItems: 0
    }))
    setChunkQuery(search)
    void loadChunks(document, 1, search)
  }

  useEffect(() => {
    if (
      selectedLibrary &&
      selectedLibrary.id !== selectedLibraryId
    ) {
      onSelectLibrary(selectedLibrary.id)
    }
  }, [onSelectLibrary, selectedLibrary, selectedLibraryId])
  const visibleTab =
    tab === 'graph' && !selectedLibrary?.graphEnabled
      ? 'settings'
      : tab
  const workspaceTabs: ReadonlyArray<PageTab<WorkspaceTab>> = [
    {
      id: 'documents',
      label: t('tabs.documents'),
      icon: <FileText aria-hidden="true" size={15} />
    },
    ...(selectedLibrary?.graphEnabled
      ? [{
          id: 'graph' as const,
          label: t('tabs.graph'),
          icon: <Network aria-hidden="true" size={15} />
        }]
      : []),
    {
      id: 'tasks',
      label: t('tabs.tasks'),
      icon: <ListChecks aria-hidden="true" size={15} />
    },
    {
      id: 'settings',
      label: t('tabs.settings'),
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
            {t('actions.newLibrary')}
          </button>
        }
        description={t('page.description')}
        eyebrow={t('page.eyebrow')}
        headingId="knowledge-workspace-title"
        icon={<Database size={20} />}
        scope={{ kind: 'global' }}
        title={t('page.title')}
      />
      <section
        aria-busy={loading}
        aria-label={t('workspace.ariaLabel')}
        className={`knowledge-workspace${
          mobileListOpen ? ' knowledge-workspace--mobile-list' : ''
        }`}
        style={styles.workspace}
      >
        <aside className="knowledge-workspace__sidebar">
          <div className="knowledge-workspace__sidebar-heading">
            <span>
              <BookOpen aria-hidden="true" size={16} />
              <strong>{t('workspace.libraryList')}</strong>
            </span>
            <small>
              {formatNumber(libraries.length, locale)}
            </small>
          </div>
          <nav
            aria-label={t('workspace.libraryList')}
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
                {t('workspace.libraryListEmpty')}
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
                          setGraphTab('explore')
                          setTaskContext(undefined)
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
                          {t('workspace.libraryMeta', {
                            count: formatNumber(
                              library.documentCount,
                              locale
                            ),
                            storageMode: t(
                              storageModeLabelKeys[library.storageMode]
                            )
                          })}
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
        aria-label={t('workspace.detailsAriaLabel')}
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
            <strong>{t('errors.refreshTitle')}</strong>
            <p style={{ margin: 'var(--space-2) 0' }}>{loadError}</p>
            <button
              className="secondary-button"
              onClick={() => void onRetryLoad()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={14} />
              {t('actions.retry')}
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
            {t('actions.backToLibraryList')}
          </button>
        )}
        {loading && libraries.length === 0 ? (
          <EmptyState
            description={t('loading.description')}
            icon={<LoaderCircle size={28} />}
            level="page"
            title={t('loading.title')}
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
                {t('actions.retry')}
              </button>
            }
            description={loadError}
            icon={<AlertCircle size={28} />}
            level="page"
            title={t('errors.loadTitle')}
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
                {t('actions.createLibrary')}
              </button>
            }
            description={t('empty.description')}
            icon={<BookOpen size={34} />}
            level="page"
            title={t('empty.title')}
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
                  {t('workspace.scopeGlobal')} ·{' '}
                  {t(storageModeLabelKeys[selectedLibrary.storageMode])}
                  {selectedLibrary.graphEnabled &&
                    ` · ${t(
                      strategyLabelKeys[selectedLibrary.graphStrategy]
                    )}`}
                </span>
                <h2 style={{ margin: '6px 0 3px' }}>
                  {selectedLibrary.name}
                </h2>
                <p style={{ ...styles.muted, margin: 0 }}>
                  {selectedLibrary.description ||
                    t('workspace.librarySummary', {
                      sourceCount: formatNumber(
                        selectedLibrary.sourceCount,
                        locale
                      ),
                      indexedCount: formatNumber(
                        selectedLibrary.indexedDocumentCount,
                        locale
                      ),
                      documentCount: formatNumber(
                        selectedLibrary.documentCount,
                        locale
                      )
                    })}
                </p>
              </div>
              <div
                className="knowledge-workspace__header-actions"
              >
                <button
                  className="secondary-button"
                  onClick={() => {
                    setRetrievalStatus('idle')
                    setRetrievalError(undefined)
                    setRetrievalResponse(undefined)
                    setRetrievalOpen(true)
                  }}
                  style={styles.button}
                  type="button"
                >
                  <Search aria-hidden="true" size={15} />
                  {t('retrieval.title')}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => setEditingLibrary(selectedLibrary)}
                  ref={editLibraryTriggerRef}
                  style={styles.button}
                  type="button"
                >
                  <Pencil aria-hidden="true" size={15} />
                  {t('actions.edit')}
                </button>
                <button
                  aria-label={t('delete.triggerAriaLabel', {
                    name: selectedLibrary.name
                  })}
                  className="danger-button danger-button--quiet"
                  onClick={() => setDeletingLibrary(selectedLibrary)}
                  ref={deleteLibraryTriggerRef}
                  style={styles.button}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={15} />
                  {t('actions.delete')}
                </button>
              </div>
            </header>
            <div className="knowledge-workspace__tabs">
              <PageTabs
                ariaLabel={t('workspace.tabsAriaLabel')}
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
                  onManageChunks={openChunkManager}
                  onPauseSource={onPauseSource}
                  onRemoveSource={onRemoveSource}
                  onRetrySource={onRetrySource}
                  onSyncSource={onSyncSource}
                  onViewTasks={(context) => {
                    setTaskContext(context)
                    setTab('tasks')
                  }}
                  sources={librarySources}
                  tasks={libraryTasks}
                />
              ) : visibleTab === 'graph' ? (
                <div className="knowledge-graph-workspace">
                  <PageTabs
                    ariaLabel={t('graph.workspace.tabsAriaLabel')}
                    idPrefix="knowledge-graph-workspace"
                    onChange={setGraphTab}
                    tabs={[
                      {
                        id: 'explore',
                        label: t('graph.workspace.explore'),
                        icon: <Network aria-hidden="true" size={15} />
                      },
                      {
                        id: 'settings',
                        label: t('graph.workspace.settings'),
                        icon: <Settings2 aria-hidden="true" size={15} />
                      }
                    ]}
                    value={graphTab}
                    variant="segmented"
                  />
                  <div
                    aria-labelledby={`knowledge-graph-workspace-tab-${graphTab}`}
                    id={`knowledge-graph-workspace-panel-${graphTab}`}
                    role="tabpanel"
                  >
                    {graphTab === 'explore' ? (
                      <GraphView
                        evidence={evidence}
                        graphNodes={graphNodes}
                        graphRelations={graphRelations}
                        libraryId={selectedLibrary.id}
                        ontology={
                          selectedLibrary.ontologySettings ??
                          defaultKnowledgeOntologySettings
                        }
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
                    ) : (
                      <KnowledgeSettingsView
                        key={`${selectedLibrary.id}:graph:${selectedLibrary.updatedAt ?? ''}`}
                        library={selectedLibrary}
                        mode="graph"
                        onCancelRebuild={onCancelRebuild}
                        onGetEmbeddingIndex={onGetEmbeddingIndex}
                        onRebuildLibrary={onRebuildLibrary}
                        onRebuildEmbeddingIndex={onRebuildEmbeddingIndex}
                        onViewTasks={() => {
                          setTaskContext(undefined)
                          setTab('tasks')
                        }}
                        onUpdateKnowledgeSettings={
                          onUpdateKnowledgeSettings
                        }
                        onUpdateLibrary={onUpdateLibrary}
                      />
                    )}
                  </div>
                </div>
              ) : visibleTab === 'tasks' ? (
                <KnowledgeTasksView
                  context={taskContext}
                  onCancelTask={onCancelTask}
                  onClearContext={() => setTaskContext(undefined)}
                  onRetryTask={onRetryTask}
                  tasks={libraryTasks}
                />
              ) : (
                <KnowledgeSettingsView
                  key={`${selectedLibrary.id}:index:${selectedLibrary.updatedAt ?? ''}`}
                  library={selectedLibrary}
                  mode="index"
                  onCancelRebuild={onCancelRebuild}
                  onGetEmbeddingIndex={onGetEmbeddingIndex}
                  onRebuildLibrary={onRebuildLibrary}
                  onRebuildEmbeddingIndex={onRebuildEmbeddingIndex}
                  onViewTasks={() => {
                    setTaskContext(undefined)
                    setTab('tasks')
                  }}
                  onUpdateKnowledgeSettings={
                    onUpdateKnowledgeSettings
                  }
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
      {retrievalOpen && selectedLibrary && (
        <KnowledgeRetrievalWorkbench
          error={retrievalError}
          graphAvailable={selectedLibrary.graphEnabled}
          libraryName={selectedLibrary.name}
          onClose={() => setRetrievalOpen(false)}
          onOpenSource={(result) => {
            void Promise.resolve(
              onOpenReferenceSource({
                knowledgeBaseId: selectedLibrary.id,
                documentId: result.documentId,
                chunkId: result.chunkId
              })
            ).catch((reason) => {
              setRetrievalError(toErrorMessage(reason, t))
              setRetrievalStatus('error')
            })
          }}
          onSaveDefaults={async (settings) => {
            setSavingRetrievalSettings(true)
            setRetrievalError(undefined)
            try {
              await onUpdateKnowledgeSettings(selectedLibrary.id, {
                retrieval: {
                  ...(
                    selectedLibrary.retrievalSettings ??
                    defaultKnowledgeRetrievalSettings
                  ),
                  ...settings
                }
              })
            } catch (reason) {
              setRetrievalError(toErrorMessage(reason, t))
              setRetrievalStatus('error')
            } finally {
              setSavingRetrievalSettings(false)
            }
          }}
          onTest={async ({ query, settings }) => {
            setRetrievalStatus('running')
            setRetrievalError(undefined)
            try {
              const response = await onRetrieve(
                selectedLibrary.id,
                query,
                {
                  ...(
                    selectedLibrary.retrievalSettings ??
                    defaultKnowledgeRetrievalSettings
                  ),
                  ...settings
                }
              )
              setRetrievalResponse(
                toWorkbenchResponse(
                  response,
                  selectedLibrary.documentCount
                )
              )
              setRetrievalStatus('success')
            } catch (reason) {
              setRetrievalError(toErrorMessage(reason, t))
              setRetrievalStatus('error')
            }
          }}
          onViewContext={(result) => {
            const document = libraryDocuments.find(
              (item) => item.id === result.documentId
            )
            if (!document) {
              setRetrievalError(t('chunks.documentUnavailable'))
              setRetrievalStatus('error')
              return
            }
            setRetrievalOpen(false)
            openChunkManager(document, result.chunkId)
          }}
          response={retrievalResponse}
          savingDefaults={savingRetrievalSettings}
          settings={
            (selectedLibrary.retrievalSettings ??
              defaultKnowledgeRetrievalSettings) satisfies
              KnowledgeRetrievalWorkbenchSettings
          }
          status={retrievalStatus}
        />
      )}
      {chunkDocument && (
        <KnowledgeChunkManager
          deletingChunkId={deletingChunkId}
          documentId={chunkDocument.id}
          documentName={chunkDocument.name}
          error={chunkError}
          loading={chunkLoading}
          maxChunkCharacters={48_000}
          onClose={() => {
            chunkRequestIdRef.current += 1
            setChunkDocument(undefined)
          }}
          onDeleteChunk={async (chunkId) => {
            setDeletingChunkId(chunkId)
            setChunkError(undefined)
            try {
              await onDeleteChunk({
                knowledgeBaseId: chunkDocument.libraryId,
                documentId: chunkDocument.id,
                chunkId
              })
              setSelectedChunkId(undefined)
              await loadChunks(
                chunkDocument,
                chunkPage.page,
                chunkQuery
              )
            } catch (reason) {
              setChunkError(toErrorMessage(reason, t))
              throw reason
            } finally {
              setDeletingChunkId(undefined)
            }
          }}
          onList={({ page, query }) =>
            loadChunks(chunkDocument, page, query)
          }
          onRebuildDocument={async () => {
            setRebuildingDocument(true)
            setChunkError(undefined)
            try {
              await onRebuildDocument(
                chunkDocument.libraryId,
                chunkDocument.id
              )
              setSelectedChunkId(undefined)
              await loadChunks(chunkDocument, 1, '')
            } catch (reason) {
              setChunkError(toErrorMessage(reason, t))
            } finally {
              setRebuildingDocument(false)
            }
          }}
          onSelectChunk={setSelectedChunkId}
          onUpdateChunk={async (chunkId, update) => {
            setSavingChunkId(chunkId)
            setChunkError(undefined)
            try {
              await onUpdateChunk({
                knowledgeBaseId: chunkDocument.libraryId,
                documentId: chunkDocument.id,
                chunkId,
                ...update
              })
              await loadChunks(
                chunkDocument,
                chunkPage.page,
                chunkQuery
              )
            } catch (reason) {
              setChunkError(toErrorMessage(reason, t))
            } finally {
              setSavingChunkId(undefined)
            }
          }}
          page={chunkPage}
          query={chunkQuery}
          rebuilding={rebuildingDocument}
          savingChunkId={savingChunkId}
          selectedChunkId={selectedChunkId}
        />
      )}
      </section>
    </div>
  )
}
