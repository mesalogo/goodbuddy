import type { KnowledgeGraphNode, KnowledgeGraphRelation, KnowledgeWorkspaceProps } from './types'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  Search,
  RefreshCw,
  Plus,
  ZoomOut,
  ZoomIn,
  RotateCcw,
  Network,
  X,
  Pencil,
  Trash2,
  GitMerge
} from 'lucide-react'
import { PageTabs } from '../WorkspacePrimitives'
import {
  type KnowledgeOntologySettings,
  getKnowledgeOntologyDisplayDefinitions,
  normalizeEntityTypeAlias,
  normalizeRelationTypeAlias
} from '../../../shared/knowledge-ontology'
import { resolvedLocale, formatPercent, formatNumber } from './formatting'
import { useMemo, useCallback, useState, useRef } from 'react'
import { type GraphDestructiveAction, GraphDestructiveDialog } from './GraphDestructiveDialog'
import { toErrorMessage } from './helpers'
import { InlineHelp } from '../InlineHelp'
import { KnowledgeGraphChartLoader } from './KnowledgeGraphChartLoader'
import { EntityEditor, RelationForm } from './GraphEditors'

type GraphSidebarTab = 'topology' | 'details'

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

export function GraphView({
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
  const [destructiveAction, setDestructiveAction] =
    useState<GraphDestructiveAction>()
  const entityPickerRef = useRef<HTMLSelectElement>(null)
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
    const typeFilteredNodes = graphNodes.filter(
      (node) =>
        typeFilter === 'all' ||
        normalizeEntityTypeAlias(node.type, ontology) === typeFilter
    )
    if (!normalized) {
      return typeFilteredNodes
    }
    const matchedIds = new Set(
      typeFilteredNodes
        .filter((node) =>
          `${node.label} ${node.type} ${node.description ?? ''} ${(node.aliases ?? []).join(' ')}`
            .toLocaleLowerCase(locale)
            .includes(normalized)
        )
        .map((node) => node.id)
    )
    const visibleIds = new Set(matchedIds)
    for (const relation of graphRelations) {
      if (matchedIds.has(relation.sourceId)) {
        visibleIds.add(relation.targetId)
      }
      if (matchedIds.has(relation.targetId)) {
        visibleIds.add(relation.sourceId)
      }
    }
    return typeFilteredNodes.filter((node) => visibleIds.has(node.id))
  }, [
    graphNodes,
    graphRelations,
    locale,
    ontology,
    query,
    typeFilter
  ])
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
    <div className="knowledge-graph">
      <section
        aria-label={t('graph.canvasAriaLabel')}
        className="knowledge-graph__canvas"
      >
        <div
          className="knowledge-graph__toolbar"
        >
          <label className="knowledge-graph__search">
            <Search
              aria-hidden="true"
              size={15}
            />
            <input
              aria-label={t('graph.searchAriaLabel')}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t('graph.searchPlaceholder')}
              type="search"
              value={query}
            />
          </label>
          <select
            aria-label={t('graph.typeFilterAriaLabel')}
            className="knowledge-graph__filter"
            onChange={(event) => setTypeFilter(event.currentTarget.value)}
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
            ref={entityPickerRef}
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
            type="button"
          >
            <Plus aria-hidden="true" size={15} />
            {t('actions.addEntity')}
          </button>
          <button
            aria-label={t('graph.zoomOutAriaLabel')}
            className="knowledge-graph__icon-button secondary-button"
            disabled={zoom <= 0.5}
            onClick={() =>
              setZoom((current) => Math.max(0.5, current - 0.15))
            }
            type="button"
          >
            <ZoomOut aria-hidden="true" size={16} />
          </button>
          <span
            aria-live="polite"
            className="knowledge-graph__zoom"
          >
            {formatPercent(zoom, locale)}
          </span>
          <button
            aria-label={t('graph.zoomInAriaLabel')}
            className="knowledge-graph__icon-button secondary-button"
            disabled={zoom >= 2}
            onClick={() =>
              setZoom((current) => Math.min(2, current + 0.15))
            }
            type="button"
          >
            <ZoomIn aria-hidden="true" size={16} />
          </button>
          <button
            className="secondary-button"
            onClick={() => setFitViewRequest((current) => current + 1)}
            type="button"
          >
            <RotateCcw aria-hidden="true" size={15} />
            {t('graph.fitView')}
          </button>
          <InlineHelp label={t('graph.canvasAriaLabel')}>{t('graph.interactionHint')}</InlineHelp>
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
          <div className="knowledge-graph__empty">
            <div>
              <Network aria-hidden="true" size={30} />
              <p>{t('graph.empty')}</p>
            </div>
          </div>
        ) : (
          <KnowledgeGraphChartLoader
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
            <h3>{t('actions.addEntity')}</h3>
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
          <div className="knowledge-graph__entity-heading">
            <div>
              <span>
                {entityTypeLabel(selectedNode.type)}
              </span>
              <h3>{selectedNode.label}</h3>
            </div>
            <button
              aria-label={t('graph.closeEntityDetailsAriaLabel')}
              className="knowledge-graph__icon-button secondary-button"
              onClick={() => {
                setSelectedNodeId(undefined)
                setSidebarTab('topology')
              }}
              type="button"
            >
              <X aria-hidden="true" size={15} />
            </button>
          </div>

          {editingEntity ? (
            <div className="knowledge-graph__entity-editor">
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
              <p className="knowledge-muted">
                {selectedNode.description || t('graph.noEntityDescription')}
              </p>
              {(selectedNode.aliases?.length ?? 0) > 0 && (
                <div className="knowledge-graph__aliases">
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
                  type="button"
                >
                  <Pencil aria-hidden="true" size={14} />
                  {t('actions.edit')}
                </button>
                <button
                  aria-label={t('graph.deleteEntityAriaLabel', {
                    name: selectedNode.label
                  })}
                  className="danger-button danger-button--quiet"
                  onClick={() =>
                    setDestructiveAction({
                      kind: 'delete-entity',
                      node: selectedNode,
                      relationCount: relatedRelations.length
                    })
                  }
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={14} />
                  {t('actions.delete')}
                </button>
              </div>
            </>
          )}

          <hr className="knowledge-graph__divider" />
          <div
            className="knowledge-graph__section-heading"
          >
            <strong>{t('graph.relations')}</strong>
            <button
              className="knowledge-graph__compact-button secondary-button"
              onClick={() => setRelationForm('new')}
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
                      className="knowledge-graph__compact-button secondary-button"
                      onClick={() => setRelationForm(relation)}
                      type="button"
                    >
                      <Pencil aria-hidden="true" size={13} />
                      {t('actions.edit')}
                    </button>
                    <button
                      aria-label={t('graph.deleteRelationAriaLabel', {
                        type: relation.type
                      })}
                      className="knowledge-graph__compact-button danger-button danger-button--quiet"
                      onClick={() =>
                        setDestructiveAction({
                          kind: 'delete-relation',
                          relation,
                          sourceLabel:
                            nodeMap.get(relation.sourceId)?.label ??
                            t('graph.unknownEntity'),
                          targetLabel:
                            nodeMap.get(relation.targetId)?.label ??
                            t('graph.unknownEntity'),
                          typeLabel: relationTypeLabel(relation.type)
                        })
                      }
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
              className="knowledge-graph__icon-button secondary-button"
              disabled={!mergeTargetId}
              onClick={() => {
                const mergeTarget = nodeMap.get(mergeTargetId)
                if (mergeTarget) {
                  setDestructiveAction({
                    kind: 'merge-entities',
                    source: selectedNode,
                    target: mergeTarget
                  })
                }
              }}
              type="button"
            >
              <GitMerge aria-hidden="true" size={15} />
            </button>
          </div>

          <hr className="knowledge-graph__divider" />
          <strong>
            {t('graph.evidence.title', {
              count: formatNumber(selectedEvidence.length, locale)
            })}
          </strong>
          {selectedEvidence.length === 0 ? (
            <p className="knowledge-muted">{t('graph.evidence.empty')}</p>
          ) : (
            <ol className="knowledge-graph__evidence-list">
              {selectedEvidence.map((item) => (
                <li key={item.id}>
                  {onOpenEvidence ? (
                    <button
                      className="knowledge-graph__evidence-button"
                      onClick={() => onOpenEvidence(item)}
                      type="button"
                    >
                      <strong>
                        {item.documentName}
                      </strong>
                      {item.location && (
                        <span className="knowledge-graph__evidence-location">
                          {item.location}
                        </span>
                      )}
                      <span className="knowledge-graph__evidence-excerpt">
                        {item.excerpt}
                      </span>
                    </button>
                  ) : (
                    <div>
                    <strong>
                      {item.documentName}
                    </strong>
                    {item.location && (
                      <span className="knowledge-graph__evidence-location">
                        {item.location}
                      </span>
                    )}
                    <span className="knowledge-graph__evidence-excerpt">
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
      {destructiveAction && (
        <GraphDestructiveDialog
          action={destructiveAction}
          onCancel={() => setDestructiveAction(undefined)}
          onConfirm={async () => {
            if (destructiveAction.kind === 'delete-entity') {
              await onDeleteEntity(destructiveAction.node.id)
              setSelectedNodeId(undefined)
              setSidebarTab('topology')
              requestAnimationFrame(() =>
                entityPickerRef.current?.focus()
              )
              return
            }
            if (destructiveAction.kind === 'delete-relation') {
              await onDeleteRelation(destructiveAction.relation.id)
              requestAnimationFrame(() =>
                entityPickerRef.current?.focus()
              )
              return
            }
            await onMergeEntities(
              destructiveAction.source.id,
              destructiveAction.target.id
            )
            setMergeTargetId('')
            setSelectedNodeId(destructiveAction.target.id)
            requestAnimationFrame(() =>
              entityPickerRef.current?.focus()
            )
          }}
        />
      )}
    </div>
  )
}
