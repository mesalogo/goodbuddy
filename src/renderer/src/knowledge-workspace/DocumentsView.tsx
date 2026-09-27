import type {
  KnowledgeSourceStatus,
  KnowledgeDocumentStatus,
  KnowledgeWorkspaceProps,
  KnowledgeLibrary,
  KnowledgeDocumentItem,
  KnowledgeSource,
  KnowledgeGraphStrategy
} from './types'
import type { TFunction } from 'i18next'
import { getLocaleFormatters, resolvedLocale, formatPercent, formatNumber } from './formatting'
import { useTranslation } from 'react-i18next'
import { useRef, useState, useMemo } from 'react'
import { toErrorMessage, clampProgress, taskStageLabelKeys } from './helpers'
import { ScopeBadge } from '../WorkspacePrimitives'
import { DocumentResultPreview } from '../DocumentResultPreview'
import {
  FilePlus2,
  FolderOpen,
  Link2,
  X,
  UploadCloud,
  FileText,
  ListChecks,
  CirclePause,
  RotateCcw,
  RefreshCw,
  Trash2,
  Search
} from 'lucide-react'
import { RemoveSourceDialog } from './RemoveSourceDialog'

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

export function DocumentsView({
  documents,
  library,
  onImportDirectory,
  onImportFiles,
  onImportUrl,
  onOpenDocumentSource,
  onPauseSource,
  onManageChunks,
  onRemoveSource,
  onRebuildDocument,
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
  | 'onOpenDocumentSource'
  | 'onPauseSource'
  | 'onRemoveSource'
  | 'onRebuildDocument'
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
  const [viewedDocumentId, setViewedDocumentId] = useState<string>()
  const previewBackRef = useRef<HTMLButtonElement>(null)
  const previewOriginRef = useRef<{ trigger: HTMLElement; scroll?: HTMLElement; top: number } | undefined>(undefined)
  const [urlOpen, setUrlOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const [removingSource, setRemovingSource] =
    useState<KnowledgeSource>()
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

  const rows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale)
    const matches = (value: string): boolean => value.toLocaleLowerCase(locale).includes(normalized)
    const bySource = new Map<string, KnowledgeDocumentItem[]>()
    const sourceIds = new Set(sources.map((source) => source.id))
    const result: { key: string; source?: KnowledgeSource; document?: KnowledgeDocumentItem; grouped?: boolean }[] = []
    for (const document of documents) {
      if (document.sourceId && sourceIds.has(document.sourceId)) {
        const group = bySource.get(document.sourceId) ?? []
        group.push(document)
        bySource.set(document.sourceId, group)
      }
    }
    for (const source of sources) {
      const related = bySource.get(source.id) ?? []
      const sourceMatches = matches(`${source.name} ${source.location}`)
      const visible = sourceMatches ? related : related.filter((document) => matches(`${document.name} ${document.path ?? ''}`))
      if (!sourceMatches && visible.length === 0) continue
      // Decide from the full group so filtering never changes source ownership.
      if (source.kind !== 'directory' && related.length === 1) {
        result.push({ key: `source:${source.id}`, source, document: related[0] })
      } else {
        result.push({ key: `source:${source.id}`, source })
        for (const document of visible) result.push({ key: `document:${document.id}`, document, grouped: true })
      }
    }
    for (const document of documents) {
      if ((!document.sourceId || !sourceIds.has(document.sourceId)) && matches(`${document.name} ${document.path ?? ''}`)) {
        result.push({ key: `document:${document.id}`, document })
      }
    }
    return result
  }, [documents, sources, locale, query])
  const viewedDocument = useMemo(() => documents.find((document) => document.id === viewedDocumentId), [documents, viewedDocumentId])

  const sourceStatus = (source: KnowledgeSource): React.JSX.Element => (
    <span className={`knowledge-source-row__status knowledge-source-row__status--${source.status}`}>
      {t(sourceStatusLabelKeys[source.status])}
      {source.status === 'syncing' && source.progress !== undefined
        ? ` · ${formatPercent(clampProgress(source.progress) / 100, locale)}` : ''}
    </span>
  )

  const sourceActions = (source: KnowledgeSource): React.JSX.Element => (
    <div className="knowledge-source-row__actions">
      <button
        aria-label={t(source.status === 'syncing' ? 'documents.actions.pauseSource' : source.status === 'failed' ? 'documents.actions.retrySource' : 'documents.actions.syncSource', { name: source.name })}
        className="secondary-button"
        disabled={pending === source.id}
        onClick={() => void run(source.id, () => source.status === 'syncing' ? onPauseSource(source.id) : source.status === 'failed' ? onRetrySource(source.id) : onSyncSource(source.id))}
        type="button"
      >
        {source.status === 'syncing' ? <CirclePause aria-hidden="true" size={14} /> : source.status === 'failed' ? <RotateCcw aria-hidden="true" size={14} /> : <RefreshCw aria-hidden="true" size={14} />}
        {t(source.status === 'syncing' ? 'actions.pause' : source.status === 'failed' ? 'actions.retry' : 'actions.sync')}
      </button>
      <button
        aria-label={t('documents.actions.removeSource', { name: source.name })}
        className="danger-button danger-button--quiet"
        disabled={pending === source.id}
        onClick={() => setRemovingSource(source)}
        type="button"
      >
        <Trash2 aria-hidden="true" size={14} />{t('actions.remove')}
      </button>
    </div>
  )

  return (
    <div className="knowledge-documents">
      {viewedDocument?.resultId && <section aria-label={t('documents.previewLabel', { name: viewedDocument.name })}>
        <div className="document-result-actions">
          <button ref={previewBackRef} type="button" className="secondary-button" onClick={() => {
            setViewedDocumentId(undefined)
            requestAnimationFrame(() => {
              previewOriginRef.current?.trigger.focus()
              if (previewOriginRef.current?.scroll) previewOriginRef.current.scroll.scrollTop = previewOriginRef.current.top
            })
          }}>{t('documents.backToList')}</button>
          <strong>{library.name} · {viewedDocument.name}</strong><ScopeBadge scope={{ kind: 'global' }} />
          <button type="button" className="secondary-button" disabled={Boolean(pending)} onClick={() => void run(`retry:${viewedDocument.id}`, () => onRebuildDocument(library.id, viewedDocument.id))}>{t('documents.reparse')}</button>
        </div>
        {pending && <p role="status">{t('documents.reparsing')}</p>}
        {error && <p role="alert">{t('documents.reparseFailed', { error })}</p>}
        <DocumentResultPreview key={viewedDocument.resultId} resultId={viewedDocument.resultId} allowAddImages />
      </section>}
      <div hidden={Boolean(viewedDocument?.resultId)}>
      <section aria-labelledby="documents-title">
        <div
          className="knowledge-documents__section-heading"
        >
          <div>
            <h3 id="documents-title">
              {t('documents.table.title')}
            </h3>
            <p className="knowledge-section-description">
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
              type="button"
            >
              <FolderOpen aria-hidden="true" size={15} />
              {t('actions.importDirectory')}
            </button>
            <button
              className="secondary-button"
              onClick={() => setUrlOpen((current) => !current)}
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
          <label className="knowledge-documents__import-strategy knowledge-field">
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
          >
            <input
              aria-label={t('documents.urlImport.addressAriaLabel')}
              onChange={(event) => setUrl(event.currentTarget.value)}
              placeholder="https://"
              type="url"
              value={url}
            />
            <button
              className="primary-button"
              disabled={pending === 'url'}
              type="submit"
            >
              {t('actions.import')}
            </button>
            <button
              aria-label={t('documents.urlImport.closeAriaLabel')}
              className="secondary-button"
              onClick={() => setUrlOpen(false)}
              type="button"
            >
              <X aria-hidden="true" size={15} />
            </button>
          </form>
        )}

        <div
          className={`knowledge-documents__drop-zone${
            dragging ? ' knowledge-documents__drop-zone--dragging' : ''
          }`}
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
        >
          <UploadCloud aria-hidden="true" size={16} />
          <div>
            {t('documents.dropFiles', { name: library.name })}
          </div>
        </div>

        {error && (
          <p
            aria-live="polite"
            className="knowledge-inline-error"
            role="alert"
          >
            {error}
          </p>
        )}

        <div
          className="knowledge-documents__toolbar"
        >
          <label
            className="knowledge-documents__search"
          >
            <Search
              aria-hidden="true"
              size={15}
            />
            <span className="sr-only">
              {t('documents.search.label')}
            </span>
            <input
              aria-label={t('documents.search.label')}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t('documents.search.placeholder')}
              type="search"
              value={query}
            />
          </label>
        </div>
        {rows.length === 0 ? (
          <div className="knowledge-documents__empty">
            {documents.length === 0 && sources.length === 0
              ? t('documents.table.empty')
              : t('documents.table.noResults')}
          </div>
        ) : (
          <div className="knowledge-documents__table-scroll">
            <table aria-label={t('documents.table.title')}>
              <thead>
                <tr>
                  <th>
                    {t('documents.table.columns.document')}
                  </th>
                  <th>
                    {t('documents.table.columns.processingStatus')}
                  </th>
                  <th className="knowledge-document-metric">
                    {t('documents.table.columns.chunks')}
                  </th>
                  <th className="knowledge-document-metric">
                    {t('documents.table.columns.size')}
                  </th>
                  <th>
                    {t('documents.table.columns.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ key, source, document, grouped }) => {
                  if (!document && source) return (
                    <tr key={key} className="knowledge-source-group">
                      <td colSpan={5}>
                        <div className="knowledge-source-row">
                          <div className="knowledge-source-row__main">
                            <div className="knowledge-source-row__identity">
                              {source.kind === 'directory' ? <FolderOpen aria-hidden="true" size={16} /> : source.kind === 'url' ? <Link2 aria-hidden="true" size={16} /> : <FileText aria-hidden="true" size={16} />}
                              <strong title={source.name}>{source.name}</strong>
                              {sourceStatus(source)}
                            </div>
                            <div className="knowledge-source-row__meta">{t('documents.sourceMeta', {
                              count: formatNumber(source.documentCount, locale),
                              time: formatTime(source.lastSyncedAt, locale, t)
                            })}</div>
                            {source.error && <div className="knowledge-source-row__error">{source.error}</div>}
                          </div>
                          <div className="knowledge-document-actions">
                            {tasks?.some((task) => task.sourceId === source.id) && <button type="button" className="secondary-button" onClick={() => onViewTasks({ sourceId: source.id })}><ListChecks aria-hidden="true" size={14} />{t('actions.viewTasks')}</button>}
                            {sourceActions(source)}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )
                  if (!document) return null
                  const relatedTasks = tasks?.filter(
                    (task) => task.documentId === document.id || (source && task.sourceId === source.id)
                  ) ?? []
                  const activeTask = relatedTasks.find(
                    (task) =>
                       task.documentId === document.id &&
                       (task.status === 'queued' || task.status === 'running')
                  )
                  return (
                   <tr key={key} className={grouped ? 'knowledge-document-row--grouped' : undefined}>
                     <td>
                       <strong>{document.name}</strong>
                       {document.path && !source && (
                        <div className="knowledge-document-path">
                          {formatDocumentLocation(document.path, t)}
                        </div>
                       )}
                       {source && <div className="knowledge-source-row__meta">{t('documents.lastSynced', { time: formatTime(source.lastSyncedAt, locale, t) })}</div>}
                     </td>
                     <td>
                       <div className="knowledge-document-status">
                         {source && sourceStatus(source)}
                        <span
                          className={`knowledge-document-status__durable knowledge-document-status__durable--${document.status}`}
                        >
                          {t(documentStatusLabelKeys[document.status])}
                        </span>
                        <span className="knowledge-document-status__channels">
                          <span>
                            {t(
                              `indexStatuses.text.${
                                document.textIndexStatus ??
                                (document.status === 'ready'
                                  ? 'ready'
                                  : document.status === 'failed'
                                    ? 'failed'
                                    : 'waiting')
                              }`
                            )}
                          </span>
                          <span>
                            {t(
                              `indexStatuses.vector.${
                                document.vectorIndexStatus ?? 'disabled'
                              }`
                            )}
                          </span>
                          {document.graphIndexStatus !== undefined && (
                            <span>
                              {t(
                                `indexStatuses.graph.${document.graphIndexStatus}`
                              )}
                            </span>
                          )}
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
                        <div className="knowledge-document-error">
                          {document.error}
                        </div>
                       )}
                       {source?.error && source.error !== document.error && <div className="knowledge-source-row__error">{source.error}</div>}
                     </td>
                     <td className="knowledge-document-metric">
                      {document.chunkCount === undefined
                        ? '—'
                        : formatNumber(document.chunkCount, locale)}
                    </td>
                     <td className="knowledge-document-metric">
                      {formatSize(document.size, locale, t)}
                    </td>
                    <td>
                      <div className="knowledge-document-actions">
                        {document.resultId && <button type="button" className="secondary-button" onClick={(event) => {
                          const scroll = event.currentTarget.closest<HTMLElement>('.workspace-panel-scroll') ?? undefined
                          previewOriginRef.current = { trigger: event.currentTarget, scroll, top: scroll?.scrollTop ?? 0 }
                          setViewedDocumentId(document.id)
                          requestAnimationFrame(() => { previewBackRef.current?.focus(); if (scroll) scroll.scrollTop = 0 })
                         }}>{t('documents.viewResult')}</button>}
                        {relatedTasks.length > 0 && (
                          <button
                            className="secondary-button"
                            onClick={() =>
                                onViewTasks({ documentId: document.id, ...(source ? { sourceId: source.id } : {}) })
                            }
                            type="button"
                          >
                            <ListChecks aria-hidden="true" size={14} />
                            {t('actions.viewTasks')}
                          </button>
                        )}
                        <button
                          aria-label={t(
                            'documents.actions.openDocumentSource',
                            { name: document.name }
                          )}
                          className="secondary-button"
                          disabled={pending === `open:${document.id}`}
                          onClick={() =>
                            void run(`open:${document.id}`, () =>
                              onOpenDocumentSource(
                                library.id,
                                document.id
                              )
                            )
                          }
                          type="button"
                        >
                          {t('actions.openSource')}
                        </button>
                        {document.status === 'failed' && (
                          <button
                            aria-label={t(
                              'documents.actions.retryDocument',
                              { name: document.name }
                            )}
                            className="secondary-button"
                            disabled={pending === `retry:${document.id}`}
                            onClick={() =>
                              void run(`retry:${document.id}`, () =>
                                onRebuildDocument(
                                  library.id,
                                  document.id
                                )
                              )
                            }
                            type="button"
                          >
                            <RotateCcw aria-hidden="true" size={14} />
                            {t('actions.retryDocument')}
                          </button>
                        )}
                        <button
                          className="secondary-button"
                          disabled={(document.chunkCount ?? 0) === 0}
                          onClick={() => onManageChunks(document)}
                          type="button"
                        >
                          {t('chunks.title')}
                        </button>
                       </div>
                       {(source || (document.resultId && document.status !== 'failed')) && <details className="knowledge-document-more">
                         <summary>{t('documents.moreActions')}</summary>
                         <div className="knowledge-document-actions">
                           {document.resultId && document.status !== 'failed' && <button type="button" className="secondary-button" disabled={Boolean(activeTask) || pending === `retry:${document.id}`} onClick={() => void run(`retry:${document.id}`, () => onRebuildDocument(library.id, document.id))}>{t('documents.reparse')}</button>}
                           {source && sourceActions(source)}
                         </div>
                       </details>}
                     </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {removingSource && (
        <RemoveSourceDialog
          onCancel={() => setRemovingSource(undefined)}
          onConfirm={() => onRemoveSource(removingSource.id)}
          source={removingSource}
          storageMode={library.storageMode}
        />
      )}
      </div>
    </div>
  )
}
