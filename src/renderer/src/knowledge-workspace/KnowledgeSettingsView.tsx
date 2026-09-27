import type { KnowledgeLibrary, KnowledgeWorkspaceProps, KnowledgeGraphStrategy } from './types'
import { useTranslation } from 'react-i18next'
import { useState, useCallback, useEffect } from 'react'
import type { KnowledgeEmbeddingIndexSnapshot } from '../../../shared/embedding-contracts'
import { defaultKnowledgeChunkingSettings, type KnowledgeChunkingSettings } from '../../../shared/knowledge-contracts'
import {
  type KnowledgeOntologySettings,
  defaultKnowledgeOntologySettings,
  knowledgeOntologySettingsSchema
} from '../../../shared/knowledge-ontology'
import { toErrorMessage, strategyLabelKeys, parseAliases } from './helpers'
import { InlineHelp } from '../InlineHelp'
import { Search, RefreshCw } from 'lucide-react'
import { KnowledgeEmbeddingIndexSection } from '../KnowledgeEmbeddingIndexSection'

export function KnowledgeSettingsView({
  library,
  mode,
  onCancelRebuild,
  onGetEmbeddingIndex,
  onOpenModelSettings,
  onOpenRetrieval,
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
  onOpenModelSettings: KnowledgeWorkspaceProps['onOpenModelSettings']
  onOpenRetrieval: () => void
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
        <section className="knowledge-settings__section">
          <div className="inline-help-label">
            <h3>{t('settings.retrieval.title')}</h3>
            <InlineHelp label={t('settings.retrieval.title')}>
              {t('settings.retrieval.description')}
            </InlineHelp>
          </div>
          <div className="knowledge-settings__actions">
            <button
              className="primary-button"
              onClick={onOpenRetrieval}
              type="button"
            >
              <Search aria-hidden="true" size={15} />
              {t('settings.retrieval.action')}
            </button>
          </div>
        </section>
      )}
      {mode === 'index' && (
        <KnowledgeEmbeddingIndexSection
          loading={embeddingIndexLoading}
          onGoToSettings={onOpenModelSettings}
          onRebuild={() => void rebuildEmbeddingIndex()}
          onViewTasks={onViewTasks}
          snapshot={embeddingIndex}
        />
      )}
      {mode === 'index' && (
      <section
        className="knowledge-settings__section"
      >
        <label
          className={`knowledge-settings__toggle toggle-row${
            saving ? ' knowledge-settings__toggle--pending' : ''
          }`}
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
            <strong>{t('graph.enable')}</strong>
            <span className="knowledge-muted">
              {t('settings.enableDescription')}
            </span>
          </span>
        </label>
      </section>
      )}
      {mode === 'graph' && (
      <section
        aria-labelledby="knowledge-graph-settings-title"
        className="knowledge-settings__section"
      >
        <div>
          <h3 id="knowledge-graph-settings-title">
            {t('settings.graphConfiguration.title')}
          </h3>
          <p className="knowledge-section-description">
            {t('settings.graphConfiguration.description')}
          </p>
        </div>
        <label className="knowledge-field">
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
            value={library.graphStrategy}
          >
            {Object.entries(strategyLabelKeys).map(([value, key]) => (
              <option key={value} value={value}>
                {t(key)}
              </option>
            ))}
          </select>
          <span className="knowledge-muted">
            {t('settings.askDescription')}
          </span>
        </label>
      </section>
      )}
      {mode === 'index' && (
      <section
        aria-labelledby="knowledge-chunking-settings-title"
        className="knowledge-settings__section"
      >
        <div>
          <h3
            id="knowledge-chunking-settings-title"
          >
            {t('settings.chunking.title')}
          </h3>
          <p className="knowledge-section-description">
            {t('settings.chunking.description')}
          </p>
        </div>
        <label className="knowledge-field">
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
          <label className="knowledge-field">
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
              type="number"
              value={chunking.targetCharacters}
            />
          </label>
          <label className="knowledge-field">
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
              type="number"
              value={chunking.overlapCharacters}
            />
          </label>
          {chunking.mode === 'parent-child' && (
            <>
              <label className="knowledge-field">
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
                  type="number"
                  value={chunking.parentCharacters}
                />
              </label>
              <label className="knowledge-field">
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
        className="knowledge-settings__ontology knowledge-settings__section"
      >
        <div className="inline-help-label">
          <h3 id="knowledge-ontology-settings-title">
            {t('settings.ontology.title')}
          </h3>
          <InlineHelp label={t('settings.ontology.title')}>
            {t('settings.ontology.description')}
          </InlineHelp>
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
        <p className="knowledge-inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
