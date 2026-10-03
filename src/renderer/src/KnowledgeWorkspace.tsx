import type {
  KnowledgeStorageMode,
  KnowledgeWorkspaceProps,
  KnowledgeLibrary,
  KnowledgeDocumentItem
} from './knowledge-workspace/types'
import {
  type KnowledgeRetrievalResponse,
  type KnowledgeChunkPage,
  defaultKnowledgeRetrievalSettings
} from '../../shared/knowledge-contracts'
import {
  type KnowledgeRetrievalWorkbenchResponse,
  KnowledgeRetrievalWorkbench,
  type KnowledgeRetrievalWorkbenchSettings
} from './KnowledgeRetrievalWorkbench'
import { stripKnowledgeHighlightTags } from '../../shared/knowledge-text'
import { useTranslation } from 'react-i18next'
import { resolvedLocale, formatNumber } from './knowledge-workspace/formatting'
import { useState, useRef, useEffect, memo } from 'react'
import type { ExternalKnowledgeProvider } from '../../shared/external-knowledge-contracts'
import { type KnowledgeTaskContext, KnowledgeTasksView } from './knowledge-workspace/KnowledgeTasksView'
import { toErrorMessage, strategyLabelKeys } from './knowledge-workspace/helpers'
import { type PageTab, PageHeader, EmptyState, SegmentedControl, PageTabs } from './WorkspacePrimitives'
import {
  FileText,
  Network,
  ListChecks,
  Settings2,
  Database,
  Plus,
  BookOpen,
  RefreshCw,
  ArrowLeft,
  LoaderCircle,
  AlertCircle,
  MessageSquare,
  Search,
  Pencil,
  Trash2
} from 'lucide-react'
import {
  ExternalInstanceManager,
  externalProviderNames,
  externalLibraryStatus,
  ExternalBindingForm,
  ExternalLibraryDetail
} from './ExternalKnowledge'
import { CreateLibraryWizard, EditLibraryDialog, DeleteLibraryDialog } from './knowledge-workspace/LibraryDialogs'
import { DocumentsView } from './knowledge-workspace/DocumentsView'
import { GraphView } from './knowledge-workspace/GraphView'
import { defaultKnowledgeOntologySettings } from '../../shared/knowledge-ontology'
import { KnowledgeSettingsView } from './knowledge-workspace/KnowledgeSettingsView'
import { KnowledgeChunkManager } from './KnowledgeChunkManager'

type WorkspaceTab = 'documents' | 'graph' | 'tasks' | 'settings'

type GraphWorkspaceTab = 'explore' | 'settings'

const storageModeLabelKeys = {
  reference: 'storageModes.reference.label',
  managed: 'storageModes.managed.label'
} as const satisfies Record<KnowledgeStorageMode, string>

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
      const context = result.chunkId ? contextByChunkId.get(result.chunkId) : undefined
      return {
        external: result.external,
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

function KnowledgeWorkspaceView({
  externalInstances = [],
  onExternalChanged = () => {},
  notify = () => {},
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
  onOpenDocumentSource,
  onOpenModelSettings,
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
  onUseInChat,
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
  const [creationType, setCreationType] = useState<'local' | ExternalKnowledgeProvider>('local')
  const [managingExternal, setManagingExternal] = useState(false)
  const [librarySearch, setLibrarySearch] = useState('')
  const [librarySource, setLibrarySource] = useState('all')
  const filteredLibraries = libraries.filter(library => {
    if (librarySource !== 'all' && (library.external?.provider ?? 'local') !== librarySource) return false
    const instanceName = externalInstances.find(instance => instance.id === library.external?.instanceId)?.name ?? ''
    return [library.name, library.external?.remoteName, library.external?.provider ?? t('external.local'), instanceName].join(' ').toLocaleLowerCase(locale).includes(librarySearch.trim().toLocaleLowerCase(locale))
  })
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
      {managingExternal && <ExternalInstanceManager instances={externalInstances} libraries={libraries} onClose={() => setManagingExternal(false)} onChanged={onExternalChanged} notify={notify} />}
      <PageHeader
        actions={
          <>
          <button type="button" className="secondary-button" onClick={() => setManagingExternal(true)}><Database size={16} />{t('external.manage')}</button>
          <button
            className="primary-button"
            disabled={loading}
            onClick={() => {
              setCreating(true)
              setMobileListOpen(false)
            }}
            type="button"
          >
            <Plus aria-hidden="true" size={16} />
            {t('actions.newLibrary')}
          </button>
          </>
        }
        description={t('page.description')}
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
      >
        <aside className="knowledge-workspace__sidebar">
          <div className="knowledge-workspace__sidebar-heading">
            <span>
              <BookOpen aria-hidden="true" size={16} />
              <strong>{t('workspace.libraryList')}</strong>
            </span>
            <small>
              {formatNumber(filteredLibraries.length, locale)}
            </small>
          </div>
          <div className="external-knowledge__filters">
            <label className="knowledge-field">{t('external.searchLibraries')}<input type="search" value={librarySearch} onChange={event => setLibrarySearch(event.currentTarget.value)} /></label>
            <label className="knowledge-field">{t('external.sourceFilter')}<select value={librarySource} onChange={event => setLibrarySource(event.currentTarget.value)}><option value="all">{t('external.allSources')}</option><option value="local">{t('external.local')}</option>{Object.entries(externalProviderNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <nav
            aria-label={t('workspace.libraryList')}
            className="knowledge-workspace__library-nav"
          >
            {(loading || loadError) && libraries.length === 0 ? null : filteredLibraries.length === 0 ? (
              <div className="knowledge-workspace__library-empty">
                {t(libraries.length ? 'external.noResults' : 'workspace.libraryListEmpty')}
                {(librarySearch || librarySource !== 'all') && <button type="button" className="secondary-button" onClick={() => { setLibrarySearch(''); setLibrarySource('all') }}>{t('external.clearFilters')}</button>}
              </div>
            ) : (
              <ul className="knowledge-workspace__library-list">
                {filteredLibraries.map((library) => {
                  const selected = library.id === selectedLibrary?.id
                  const libraryMeta = library.external ? `${externalProviderNames[library.external.provider]} · ${externalInstances.find(instance => instance.id === library.external?.instanceId)?.name ?? library.external.instanceId} · ${t(`external.states.${externalLibraryStatus(library, externalInstances)}`)}` : t('workspace.libraryMeta', {
                    ready: formatNumber(
                      library.indexedDocumentCount,
                      locale
                    ),
                    failed: formatNumber(
                      library.failedDocumentCount ?? 0,
                      locale
                    )
                  })
                  return (
                    <li key={library.id}>
                      <button
                        aria-current={selected ? 'page' : undefined}
                        aria-label={`${library.name} ${libraryMeta}`}
                        className={`knowledge-workspace__library-button${
                          selected
                            ? ' knowledge-workspace__library-button--selected'
                            : ''
                        }`}
                        onClick={() => {
                          onSelectLibrary(library.id)
                          setTab('documents')
                          setGraphTab('explore')
                          setTaskContext(undefined)
                          setMobileListOpen(false)
                        }}
                        type="button"
                      >
                        <span className="knowledge-workspace__library-identity">
                          <BookOpen aria-hidden="true" size={15} />
                          <strong>
                            {library.name}
                          </strong>
                        </span>
                        <span className="knowledge-workspace__library-meta">
                          {libraryMeta}
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
      >
        {loadError && libraries.length > 0 && (
          <div className="knowledge-workspace__refresh-error" role="alert">
            <strong>{t('errors.refreshTitle')}</strong>
            <p>{loadError}</p>
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
            variant="loading"
          />
        ) : loadError && libraries.length === 0 ? (
          <EmptyState
            action={
              <button
                className="secondary-button"
                onClick={() => void onRetryLoad()}
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
          <>
          <SegmentedControl ariaLabel={t('external.type')} value={creationType} onChange={setCreationType} options={[{ value: 'local', label: t('external.local') }, ...Object.entries(externalProviderNames).map(([value, label]) => ({ value: value as ExternalKnowledgeProvider, label }))]} />
          {creationType === 'local' ?
          <CreateLibraryWizard
            onCancel={() => setCreating(false)}
            onCreate={onCreateLibrary}
          />
          : <ExternalBindingForm key={creationType} provider={creationType} instances={externalInstances} libraries={libraries} onCancel={() => setCreating(false)} onChanged={onExternalChanged} notify={notify} onManage={() => setManagingExternal(true)} />}
          </>
        ) : !selectedLibrary ? (
          <EmptyState
            description={t('empty.description')}
            icon={<BookOpen size={34} />}
            level="page"
            title={t('empty.title')}
          />
        ) : selectedLibrary.external ? (
          <ExternalLibraryDetail key={selectedLibrary.id} library={selectedLibrary} instances={externalInstances} libraries={libraries} onChanged={onExternalChanged} notify={notify} onManage={() => setManagingExternal(true)} onUseInChat={onUseInChat} />
        ) : (
          <>
            <header
              className="knowledge-workspace__header"
            >
              <div>
                <span className="knowledge-workspace__scope">
                  <Database aria-hidden="true" size={13} />
                  {t('workspace.scopeGlobal')} ·{' '}
                  {t(storageModeLabelKeys[selectedLibrary.storageMode])}
                  {selectedLibrary.graphEnabled &&
                    ` · ${t(
                      strategyLabelKeys[selectedLibrary.graphStrategy]
                    )}`}
                </span>
                <h2>
                  {selectedLibrary.name}
                </h2>
                {selectedLibrary.description && (
                  <p className="knowledge-workspace__description">
                    {selectedLibrary.description}
                  </p>
                )}
                <p className="knowledge-workspace__description">
                  {t('workspace.librarySummary', {
                    ready: formatNumber(
                      selectedLibrary.indexedDocumentCount,
                      locale
                    ),
                    processing: formatNumber(
                      selectedLibrary.processingDocumentCount ?? 0,
                      locale
                    ),
                    failed: formatNumber(
                      selectedLibrary.failedDocumentCount ?? 0,
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
                  disabled={selectedLibrary.indexedDocumentCount === 0}
                  onClick={() => onUseInChat(selectedLibrary.id)}
                  title={t(
                    selectedLibrary.indexedDocumentCount > 0
                      ? 'workspace.readyForQuestions'
                      : 'workspace.waitingForDocuments'
                  )}
                  type="button"
                >
                  <MessageSquare aria-hidden="true" size={15} />
                  {t('actions.useInChat')}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => {
                    setRetrievalStatus('idle')
                    setRetrievalError(undefined)
                    setRetrievalResponse(undefined)
                    setRetrievalOpen(true)
                  }}
                  type="button"
                >
                  <Search aria-hidden="true" size={15} />
                  {t('retrieval.title')}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => setEditingLibrary(selectedLibrary)}
                  ref={editLibraryTriggerRef}
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
                  onOpenDocumentSource={onOpenDocumentSource}
                  onManageChunks={openChunkManager}
                  onPauseSource={onPauseSource}
                  onRemoveSource={onRemoveSource}
                  onRebuildDocument={onRebuildDocument}
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
                        onOpenModelSettings={onOpenModelSettings}
                        onOpenRetrieval={() => {
                          setRetrievalStatus('idle')
                          setRetrievalError(undefined)
                          setRetrievalResponse(undefined)
                          setRetrievalOpen(true)
                        }}
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
                  onOpenModelSettings={onOpenModelSettings}
                  onOpenRetrieval={() => {
                    setRetrievalStatus('idle')
                    setRetrievalError(undefined)
                    setRetrievalResponse(undefined)
                    setRetrievalOpen(true)
                  }}
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
            if (result.external || !result.documentId || !result.chunkId) return
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
            if (result.external || !result.documentId || !result.chunkId) return
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

/** Memoized: App re-renders on chat updates; this view re-renders only when its props change. */
export const KnowledgeWorkspace = memo(KnowledgeWorkspaceView)
