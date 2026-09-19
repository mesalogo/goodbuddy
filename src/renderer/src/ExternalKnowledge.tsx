import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { InlineHelp } from './InlineHelp'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Database, Eye, EyeOff, FolderOpen, RefreshCw, X } from 'lucide-react'
import type { KnowledgeLibrary, KnowledgeSnapshot } from '../../shared/contracts'
import {
  externalKnowledgeBindingTestInputSchema,
  externalKnowledgeInstanceSaveInputSchema,
  type ExternalKnowledgeProvider,
  type ExternalKnowledgeProviderConfig,
  type ExternalKnowledgeCommonConfig,
  type ExternalKnowledgeCatalogItem,
  type ExternalKnowledgeCatalogPage,
  type ExternalKnowledgeInstanceSaveInput,
  type ExternalKnowledgeInstanceSummary,
  type ExternalKnowledgeTestResult
} from '../../shared/external-knowledge-contracts'
import { EmptyState, PageTabs, ScopeBadge, SegmentedControl } from './WorkspacePrimitives'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import type { AppNotificationInput } from './notifications'
import './external-knowledge.css'

export const externalProviderNames = { dify: 'Dify', fastgpt: 'FastGPT', ragflow: 'RAGFlow' }
export function externalLibraryStatus(library: KnowledgeLibrary, instances: ExternalKnowledgeInstanceSummary[]): 'ready' | 'untested' | 'instance-disabled' | 'credential-error' | 'temporarily-unavailable' {
  const instance = instances.find(item => item.id === library.external?.instanceId)
  if (!instance) return 'temporarily-unavailable'
  if (!instance.enabled) return 'instance-disabled'
  if (instance.credentialStatus !== 'configured' || instance.probeStatus === 'auth-failed') return 'credential-error'
  if (['failed', 'unreachable'].includes(instance.probeStatus)) return 'temporarily-unavailable'
  return library.external?.lastVerifiedAt ? 'ready' : 'untested'
}
type Notify = (input: AppNotificationInput) => void
type Changed = (snapshot?: KnowledgeSnapshot, createdId?: string) => void | Promise<void>
const commonDefaults: ExternalKnowledgeCommonConfig = { resultLimit: 6, requestTimeoutMs: 15000, maxSnippetCharacters: 4000 }
export function externalProviderDefaults(provider: ExternalKnowledgeProvider): ExternalKnowledgeProviderConfig {
  if (provider === 'dify') return { provider, useDatasetDefaults: true }
  if (provider === 'fastgpt') return { provider, searchMode: 'embedding', tokenLimit: 5000, similarity: 0, usingRerank: false }
  return { provider, similarityThreshold: 0.2, vectorSimilarityWeight: 0.3, knnTopK: 1024, useKg: false, includeKnowledgeCompilation: false }
}
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

function Field({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return <label className="field"><span>{label}</span>{children}</label>
}
function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }): React.JSX.Element {
  return <label className="toggle-row"><span>{label}</span><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} /></label>
}

function InstanceSelect({ instances, value, onChange }: { instances: ExternalKnowledgeInstanceSummary[]; value: string; onChange: (value: string) => void }): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      const selected = items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0]
      items.forEach(item => { item.tabIndex = item === selected ? 0 : -1 })
      selected?.focus()
    })
    const dismiss = (event: Event): void => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss) }
  }, [open])
  return <div className="field external-knowledge__instance-select" ref={root}>
    <span id={`${id}-label`}>{t('external.instance')}</span>
    <button type="button" className="model-button" ref={trigger} aria-labelledby={`${id}-label`} aria-describedby={`${id}-value`} aria-expanded={open} aria-haspopup="menu" aria-controls={open ? id : undefined} onClick={() => setOpen(!open)} onKeyDown={event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true) }
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false) }
    }}><span className="model-button__label" id={`${id}-value`}>{instances.find(item => item.id === value)?.name ?? t('external.selectInstance')}</span><ChevronDown size={14} aria-hidden="true" /></button>
    {open && <div className="runtime-picker__menu composer-picker__menu" role="menu" aria-labelledby={`${id}-label`} id={id} ref={menu} onKeyDown={event => {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : undefined
      if (next !== undefined && items[next]) { event.preventDefault(); items.forEach((item, i) => { item.tabIndex = i === next ? 0 : -1 }); items[next].focus() }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
    }}>
      {!instances.length && <p className="external-knowledge__help">{t('external.noInstancesHelp')}</p>}
      {instances.map(item => <button type="button" role="menuitemradio" key={item.id} aria-checked={item.id === value} disabled={!item.enabled || item.credentialStatus !== 'configured'} tabIndex={-1} onClick={() => { onChange(item.id); setOpen(false); trigger.current?.focus() }}>
        <span>{item.name}</span><small>{new URL(item.baseUrl).origin} · {item.enabled ? t(`external.credentials.${item.credentialStatus}`) : t('external.states.instance-disabled')}</small>
      </button>)}
    </div>}
  </div>
}

function ExternalTime({ value }: { value: string }): React.JSX.Element {
  const { i18n, t } = useTranslation('knowledge')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return <>{t('format.unknownTime')}</>
  const label = date.toLocaleString(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' })
  return <time dateTime={value} title={date.toLocaleString(i18n.resolvedLanguage)}>{label}</time>
}

export function ExternalConfig({ common, config, detail, onCommon, onConfig }: {
  common: ExternalKnowledgeCommonConfig; config: ExternalKnowledgeProviderConfig; detail?: ExternalKnowledgeCatalogItem
  onCommon: (value: ExternalKnowledgeCommonConfig) => void; onConfig: (value: ExternalKnowledgeProviderConfig) => void
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const number = (label: string, value: number, min: number, max: number, change: (value: number) => void, step = 1): ReactNode =>
    <Field label={label}><input type="number" required min={min} max={max} step={step} value={value} onChange={event => change(event.currentTarget.valueAsNumber)} /></Field>
  const text = (label: string, value: string, change: (value: string) => void): ReactNode =>
    <Field label={label}><input required value={value} onChange={event => change(event.currentTarget.value)} /></Field>
  return <section className="external-knowledge__fields">
    <fieldset className="external-knowledge__group">
    <legend>{t('external.common')}</legend>
    {number(t('external.resultLimit'), common.resultLimit, 1, 20, value => onCommon({ ...common, resultLimit: value }))}
    {number(t('external.timeout'), common.requestTimeoutMs, 1000, 60000, value => onCommon({ ...common, requestTimeoutMs: value }), 1000)}
    {number(t('external.snippetLimit'), common.maxSnippetCharacters, 100, 8000, value => onCommon({ ...common, maxSnippetCharacters: value }))}
    </fieldset>
    <fieldset className="external-knowledge__group">
    <legend>{externalProviderNames[config.provider]} · {t('external.config')}</legend>
    {config.provider === 'dify' && <>
      <Switch label={t('external.datasetDefaults')} checked={config.useDatasetDefaults} onChange={value => onConfig(value ? { provider: 'dify', useDatasetDefaults: true } : { provider: 'dify', useDatasetDefaults: false, retrievalModel: { search_method: 'semantic_search', top_k: 6, reranking_enable: false, score_threshold_enabled: false } })} />
      {config.useDatasetDefaults ? <p className="knowledge-muted">{t('external.datasetDefaultsHelp')}</p> : (() => {
        const model = config.retrievalModel
        const update = (value: Partial<typeof model>): void => onConfig({ ...config, retrievalModel: { ...model, ...value } })
        return <>
          <Field label={t('external.searchMethod')}><select value={model.search_method} onChange={event => update({ search_method: event.currentTarget.value as typeof model.search_method })}>{['keyword_search', 'semantic_search', 'full_text_search', 'hybrid_search'].map(value => <option key={value}>{value}</option>)}</select></Field>
          {number(t('external.topK'), model.top_k, 1, 20, value => update({ top_k: value }))}
          <Switch label={t('external.thresholdEnabled')} checked={model.score_threshold_enabled} onChange={value => update({ score_threshold_enabled: value, score_threshold: model.score_threshold ?? 0.5 })} />
          {model.score_threshold_enabled && number(t('external.threshold'), model.score_threshold ?? 0.5, 0, 1, value => update({ score_threshold: value }), 0.01)}
          <Switch label={t('external.rerank')} checked={model.reranking_enable} onChange={value => update(value ? { reranking_enable: true, reranking_mode: model.reranking_mode ?? 'reranking_model' } : { reranking_enable: false, reranking_mode: undefined, reranking_model: undefined, weights: undefined })} />
          {model.reranking_enable && <>
            <Field label={t('external.rerankMode')}><select value={model.reranking_mode ?? 'reranking_model'} onChange={event => update({ reranking_mode: event.currentTarget.value as 'weighted_score' | 'reranking_model', reranking_model: undefined, weights: undefined })}><option value="reranking_model">{t('external.rerankModel')}</option><option value="weighted_score">{t('external.weightedScore')}</option></select></Field>
            {model.reranking_mode !== 'weighted_score' ? <>
              {text(t('external.rerankProvider'), model.reranking_model?.reranking_provider_name ?? '', value => update({ reranking_model: { reranking_provider_name: value, reranking_model_name: model.reranking_model?.reranking_model_name ?? '' } }))}
              {text(t('external.rerankModel'), model.reranking_model?.reranking_model_name ?? '', value => update({ reranking_model: { reranking_provider_name: model.reranking_model?.reranking_provider_name ?? '', reranking_model_name: value } }))}
            </> : (() => {
              const weights = model.weights ?? { weight_type: 'customized' as const, vector_setting: { vector_weight: 0.5, embedding_provider_name: '', embedding_model_name: '' }, keyword_setting: { keyword_weight: 0.5 } }
              return <>
                {number(t('external.vectorWeight'), weights.vector_setting.vector_weight, 0, 1, value => update({ weights: { ...weights, vector_setting: { ...weights.vector_setting, vector_weight: value }, keyword_setting: { keyword_weight: 1 - value } } }), 0.01)}
                <p>{t('external.keywordWeight')}: {Number(weights.keyword_setting.keyword_weight.toFixed(2))}</p>
                {text(t('external.embeddingProvider'), weights.vector_setting.embedding_provider_name, value => update({ weights: { ...weights, vector_setting: { ...weights.vector_setting, embedding_provider_name: value } } }))}
                {text(t('external.embeddingModel'), weights.vector_setting.embedding_model_name, value => update({ weights: { ...weights, vector_setting: { ...weights.vector_setting, embedding_model_name: value } } }))}
              </>
            })()}
          </>}
        </>
      })()}
    </>}
    {config.provider === 'fastgpt' && <>
      <Field label={t('external.searchMethod')}><select value={config.searchMode} onChange={event => onConfig({ ...config, searchMode: event.currentTarget.value as typeof config.searchMode })}>{['embedding', 'fullTextRecall', 'mixedRecall'].map(value => <option key={value}>{value}</option>)}</select></Field>
      {number(t('external.tokenLimit'), config.tokenLimit, 1, 30000, value => onConfig({ ...config, tokenLimit: value }))}
      {number(t('external.threshold'), config.similarity, 0, 1, value => onConfig({ ...config, similarity: value }), 0.01)}
      <Switch label={t('external.rerank')} checked={config.usingRerank} onChange={value => onConfig({ ...config, usingRerank: value })} />
    </>}
    {config.provider === 'ragflow' && <>
      {number(t('external.threshold'), config.similarityThreshold, 0, 1, value => onConfig({ ...config, similarityThreshold: value }), 0.01)}
      {number(t('external.vectorWeight'), config.vectorSimilarityWeight, 0, 1, value => onConfig({ ...config, vectorSimilarityWeight: value }), 0.01)}
      {number(t('external.knnTopK'), config.knnTopK, 1, 2048, value => onConfig({ ...config, knnTopK: value }))}
      <Switch label={t('external.graph')} checked={config.useKg} disabled={!config.useKg && !detail?.graphEnabled} onChange={value => onConfig({ ...config, useKg: value })} />
      <p className="knowledge-muted">{t(detail?.graphEnabled ? 'external.graphHelp' : 'external.graphUnknown')}</p>
      <Switch label={t('external.compilation')} checked={config.includeKnowledgeCompilation} disabled={!config.includeKnowledgeCompilation && !detail?.knowledgeCompilationEnabled} onChange={value => onConfig({ ...config, includeKnowledgeCompilation: value })} />
      {!detail?.knowledgeCompilationEnabled && <p className="knowledge-muted">{t('external.compilationUnavailable')}</p>}
    </>}
    </fieldset>
    <p className="external-knowledge__help">{t('external.localOnly')}</p>
    <button className="secondary-button" type="button" onClick={() => { onCommon(commonDefaults); onConfig(externalProviderDefaults(config.provider)) }}>{t('external.defaults')}</button>
  </section>
}

function TestResults({ result }: { result: ExternalKnowledgeTestResult }): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  return <section className="external-knowledge__results" aria-live="polite">
    <p>{t('external.tested', { count: result.results.length })} · {t('external.elapsed', { ms: result.durationMs })}</p>
    <ol>{result.results.map((item, index) => <li key={`${item.remoteChunkId ?? item.remoteDocumentId ?? index}:${index}`}>
      <strong>{item.documentTitle}</strong><small>{item.sourceDisplayName} {item.location}</small>
      <p>{item.snippet}</p>
      {item.providerScore !== undefined && <small>{t('external.providerScore')}: {item.providerScore}</small>}
      {item.providerScores?.map((score, scoreIndex) => <small key={scoreIndex}>{t('external.providerScore')} · {score.type}{score.index === undefined ? '' : ` [${score.index}]`}: {score.value}</small>)}
      {item.remoteDocumentId && <small>{t('external.documentId')}: {item.remoteDocumentId}</small>}
      {item.remoteChunkId && <small>{t('external.chunkId')}: {item.remoteChunkId}</small>}
    </li>)}</ol>
  </section>
}

export function ExternalBindingForm({ provider, instances, libraries, library, onCancel, onChanged, notify, onManage }: {
  provider: ExternalKnowledgeProvider; instances: ExternalKnowledgeInstanceSummary[]; libraries: readonly KnowledgeLibrary[]; library?: KnowledgeLibrary
  onCancel: () => void; onChanged: Changed; notify: Notify; onManage: () => void
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const binding = library?.external
  const [instanceId, setInstanceId] = useState(binding?.instanceId ?? '')
  const [remoteId, setRemoteId] = useState(binding?.remoteKnowledgeBaseId ?? '')
  const [name, setName] = useState(library?.name ?? '')
  const [nameEdited, setNameEdited] = useState(Boolean(library))
  const [detail, setDetail] = useState<ExternalKnowledgeCatalogItem>()
  const [common, setCommon] = useState(binding?.commonConfig ?? commonDefaults)
  const [config, setConfig] = useState(binding?.providerConfig ?? externalProviderDefaults(provider))
  const [manual, setManual] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [parentId, setParentId] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<ExternalKnowledgeCatalogPage>()
  const [catalogError, setCatalogError] = useState<string>()
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ExternalKnowledgeTestResult>()
  const [testedInstance, setTestedInstance] = useState<string>()
  const [rebindConfirmed, setRebindConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [operationError, setOperationError] = useState<string>()
  const generation = useRef(0)
  const errorId = useId()
  const activeInstance = instances.find(item => item.id === instanceId)
  const instanceVersion = JSON.stringify(activeInstance)
  const validInstance = activeInstance?.provider === provider && activeInstance.enabled && activeInstance.credentialStatus === 'configured'
  const verifiedResult = testedInstance === instanceVersion ? result : undefined
  const duplicate = libraries.some(item => item.id !== library?.id && item.external?.instanceId === instanceId && item.external.remoteKnowledgeBaseId === remoteId.trim())
  const invalidate = (): void => { generation.current++; setResult(undefined); setOperationError(undefined); setBusy(false); setRebindConfirmed(false) }
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setCatalog(undefined); setCatalogError(undefined)
      if (!instanceId || !validInstance || manual) { setCatalogLoading(false); return }
      setCatalogLoading(true)
      const value = await window.goodbuddy.knowledge.externalCatalogList({ instanceId, page, pageSize: 30, parentId, search })
      if (active) setCatalog(value)
    }).catch(error => { if (active) setCatalogError(errorMessage(error)) }).finally(() => { if (active) setCatalogLoading(false) })
    return () => { active = false }
  }, [instanceId, validInstance, instanceVersion, page, parentId, search, manual, refresh])
  useEffect(() => {
    let active = true
    if (!validInstance || !remoteId.trim()) return
    void window.goodbuddy.knowledge.externalCatalogGet({ instanceId, remoteKnowledgeBaseId: remoteId }).then(value => { if (active) setDetail(value) }).catch(() => { /* Retrieval remains available when a deployment has no detail endpoint. */ })
    return () => { active = false }
  }, [instanceId, remoteId, validInstance, instanceVersion, refresh])
  const testInput = { instanceId, remoteKnowledgeBaseId: remoteId, commonConfig: common, providerConfig: config, testQuery: query }
  const valid = validInstance && !duplicate && externalKnowledgeBindingTestInputSchema.safeParse(testInput).success
  const rebinding = binding && (binding.instanceId !== instanceId || binding.remoteKnowledgeBaseId !== remoteId.trim())
  const remoteName = detail?.name || (!rebinding ? binding?.remoteName : undefined) || name.trim()
  const run = async (save: boolean): Promise<void> => {
    if (busy || !valid || (save && (!verifiedResult || !name.trim() || (rebinding && !rebindConfirmed)))) return
    const current = ++generation.current
    setBusy(true)
    setSaving(save)
    setOperationError(undefined)
    try {
      if (save) {
        const input = { ...testInput, name: name.trim(), remoteName, description: library?.description }
        const snapshot = library
          ? await window.goodbuddy.knowledge.externalBindingsUpdate({ ...input, knowledgeBaseId: library.id })
          : await window.goodbuddy.knowledge.externalBindingsCreate(input)
        if (current !== generation.current) return
        const created = snapshot.libraries.find(item => item.external?.instanceId === instanceId && item.external.remoteKnowledgeBaseId === remoteId.trim())
        await onChanged(snapshot, library ? undefined : created?.id)
        notify({ tone: 'success', message: t('external.saved') }); onCancel()
      } else {
        setResult(undefined)
        const value = await window.goodbuddy.knowledge.externalRetrievalTest(testInput)
        if (current === generation.current) { setResult(value); setTestedInstance(instanceVersion) }
      }
    } catch (error) { if (current === generation.current) setOperationError(errorMessage(error)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  return <form className="external-knowledge" onSubmit={event => { event.preventDefault(); void run(true) }}>
    <fieldset disabled={busy} className="external-knowledge__fieldset" aria-describedby={operationError ? errorId : undefined}>
    <div className="external-knowledge__columns">
      <section className="external-knowledge__fields">
        <h3>{t('external.source')}</h3>
        <InstanceSelect instances={instances.filter(item => item.provider === provider)} value={instanceId} onChange={value => { invalidate(); setDetail(undefined); setInstanceId(value); setRemoteId(''); if (!nameEdited) setName(''); setConfig(externalProviderDefaults(provider)); setPage(1); setParentId(null); setSearch('') }} />
        <button type="button" className="secondary-button" onClick={onManage}>{t('external.manage')}</button>
        <SegmentedControl ariaLabel={t('external.remote')} value={manual ? 'manual' : 'catalog'} options={[{ value: 'catalog', label: t('external.browse') }, { value: 'manual', label: t('external.manual') }]} onChange={value => setManual(value === 'manual')} />
        {manual ? <Field label={t('external.remoteId')}><input maxLength={512} value={remoteId} disabled={busy} aria-invalid={duplicate || undefined} aria-describedby={duplicate ? `${errorId}-duplicate` : undefined} onChange={event => { invalidate(); setDetail(undefined); setRemoteId(event.currentTarget.value); if (!nameEdited) setName('') }} /></Field> : <>
          <Field label={t('external.search')}><input type="search" maxLength={512} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(1) }} /></Field>
          <div className="external-knowledge__actions"><button type="button" className="secondary-button" aria-label={t('external.refresh')} title={t('external.refresh')} onClick={() => { invalidate(); setRefresh(value => value + 1) }}><RefreshCw size={15} /></button>
            {parentId && <button type="button" className="secondary-button" onClick={() => { setParentId(null); setPage(1) }}>{t('external.root')}</button>}</div>
          {catalogLoading && <p role="status">{t('external.loading')}</p>}
          {catalogError && <div role="alert"><p>{catalogError}</p><button type="button" className="secondary-button" onClick={() => setRefresh(value => value + 1)}>{t('actions.retry')}</button></div>}
          {catalog && <div className="external-knowledge__catalog" aria-label={t('external.remote')}>
            {catalog.items.length === 0 && <EmptyState icon={<Database size={20} />} title={t(search ? 'external.noResults' : 'external.empty')} description={t(search ? 'external.noResultsHelp' : 'external.emptyHelp')} action={<button type="button" className="secondary-button" onClick={() => { if (search) { setSearch(''); setPage(1) } else setManual(true) }}>{t(search ? 'external.clearSearch' : 'external.manual')}</button>} />}
            {catalog.items.map(item => {
              const bound = libraries.some(candidate => candidate.id !== library?.id && candidate.external?.instanceId === instanceId && candidate.external.remoteKnowledgeBaseId === item.id)
              return <button type="button" className="external-knowledge__target" key={item.id} aria-pressed={item.kind === 'folder' ? undefined : remoteId === item.id} disabled={bound || busy} onClick={() => {
                if (item.kind === 'folder') { setParentId(item.id); setPage(1); return }
                invalidate(); setRemoteId(item.id); setDetail(item); if (!nameEdited) setName(item.name)
              }}>{item.kind === 'folder' ? <FolderOpen size={15} /> : <Database size={15} />}<span><strong>{item.name}</strong><small>{item.id}{bound ? ` · ${t('external.alreadyBound')}` : ''}</small></span></button>
            })}
            <div className="external-knowledge__actions"><button type="button" className="secondary-button" disabled={page === 1} onClick={() => setPage(value => value - 1)}>{t('external.previous')}</button><span>{page}</span><button type="button" className="secondary-button" disabled={!catalog.hasMore} onClick={() => setPage(value => value + 1)}>{t('external.next')}</button></div>
          </div>}
        </>}
        {remoteId && <p className="external-knowledge__identifier">{remoteName}<br />{remoteId}</p>}
        {duplicate && <p role="alert" id={`${errorId}-duplicate`}>{t('external.alreadyBound')}</p>}
        <Field label={t('fields.name')}><input required maxLength={512} value={name} onChange={event => { setName(event.currentTarget.value); setNameEdited(true) }} /></Field>
        <Field label={t('external.query')}><textarea required maxLength={4000} value={query} onChange={event => { invalidate(); setQuery(event.currentTarget.value) }} /></Field>
      </section>
      <ExternalConfig common={common} config={config} detail={detail} onCommon={value => { invalidate(); setCommon(value) }} onConfig={value => { invalidate(); setConfig(value) }} />
    </div>
    <p className="knowledge-muted">{t('external.queryNote')}</p>
    {operationError && <p id={errorId} role="alert">{operationError}</p>}
    {verifiedResult ? <TestResults result={verifiedResult} /> : <p role="status">{t('external.untested')}</p>}
    {rebinding && <label><input type="checkbox" checked={rebindConfirmed} onChange={event => setRebindConfirmed(event.currentTarget.checked)} />{t('external.rebindConfirm')}</label>}
    <footer className="external-knowledge__actions external-knowledge__footer"><ScopeBadge scope={{ kind: 'global' }} />
      <button type="button" className="secondary-button" onClick={() => { invalidate(); onCancel() }}>{t('actions.cancel')}</button>
      <button type="button" className="secondary-button" disabled={busy || !valid} onClick={() => void run(false)}>{t(busy && !saving ? 'external.testing' : 'external.test')}</button>
      <button type="submit" className="primary-button" disabled={busy || !verifiedResult || !valid || !name.trim() || (!!rebinding && !rebindConfirmed)}>{t(busy && saving ? 'actions.saving' : library ? 'external.saveConfig' : 'external.add')}</button>
    </footer>
    </fieldset>
  </form>
}

export function ExternalInstanceManager({ instances, libraries, onClose, onChanged, notify }: {
  instances: ExternalKnowledgeInstanceSummary[]; libraries: readonly KnowledgeLibrary[]; onClose: () => void; onChanged: Changed; notify: Notify
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [draft, setDraft] = useState<ExternalKnowledgeInstanceSaveInput>()
  const [showKey, setShowKey] = useState(false)
  const [deleting, setDeleting] = useState<ExternalKnowledgeInstanceSummary>()
  const [busy, setBusy] = useState(false)
  const [clearConfirmed, setClearConfirmed] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const generation = useRef(0)
  const keyId = useId()
  useEffect(() => activateModalFocus(() => closeRef.current), [])
  useEffect(() => () => { generation.current++ }, [])
  const run = async (action: () => Promise<unknown>, message?: string): Promise<void> => {
    const current = ++generation.current; setBusy(true)
    try { await action(); if (current !== generation.current) return; await onChanged(); if (message) notify({ tone: 'success', message }) }
    catch (error) { if (current === generation.current) notify({ tone: 'error', message: errorMessage(error) }) }
    finally { if (current === generation.current) setBusy(false) }
  }
  const edit = (instance?: ExternalKnowledgeInstanceSummary): void => {
    setDraft(instance ? { id: instance.id, name: instance.name, provider: instance.provider, baseUrl: instance.baseUrl, enabled: instance.enabled, credential: { action: 'keep' } } : { name: '', provider: 'dify', baseUrl: '', enabled: true, credential: { action: 'replace', value: '' } })
    setClearConfirmed(false); setShowKey(false)
  }
  const change = (value: Partial<ExternalKnowledgeInstanceSaveInput>): void => { if (draft) setDraft({ ...draft, ...value }); setClearConfirmed(false) }
  return createPortal(<div className="external-knowledge-modal" role="dialog" aria-modal="true" aria-labelledby="external-instance-title" ref={dialogRef} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }; trapTabFocus(event, dialogRef.current) }}>
    <section className="external-knowledge-modal__surface">
      <header><div><h2 id="external-instance-title">{deleting ? t('external.deleteInstanceTitle', { name: deleting.name }) : t(draft ? draft.id ? 'external.editInstance' : 'external.addInstance' : 'external.instances')}</h2><ScopeBadge scope={{ kind: 'global' }} /></div><button type="button" className="icon-button" ref={closeRef} disabled={busy} aria-label={t('external.close')} title={t('external.close')} onClick={onClose}><X size={16} /></button></header>
      <div className="external-knowledge-modal__body">
        {draft ? <form className="external-knowledge__fields" onSubmit={event => { event.preventDefault(); if (busy || (draft.credential.action === 'clear' && !clearConfirmed)) return; void run(async () => { await window.goodbuddy.knowledge.externalInstancesSave(draft); setDraft(undefined) }, t('external.saved')) }}>
          <fieldset disabled={busy} className="external-knowledge__fieldset">
          <div className="external-knowledge__columns">
          <Field label={t('fields.name')}><input autoFocus required value={draft.name} onChange={event => change({ name: event.currentTarget.value })} /></Field>
          <Field label={t('external.provider')}><select disabled={!!draft.id && instances.some(item => item.id === draft.id && item.bindingCount > 0)} value={draft.provider} onChange={event => change({ provider: event.currentTarget.value as ExternalKnowledgeProvider })}>{Object.entries(externalProviderNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          </div>
          <Field label={t('external.address')}><input type="url" required value={draft.baseUrl} aria-describedby={/^http:\/\//i.test(draft.baseUrl) ? `${keyId}-transport` : undefined} onChange={event => change({ baseUrl: event.currentTarget.value })} /></Field>
          {/^http:\/\//i.test(draft.baseUrl) && <p className="external-knowledge__help" id={`${keyId}-transport`}>{t('external.transportNote')}</p>}
          <fieldset className="external-knowledge__group">
          <legend><span className="inline-help-label">{t('external.authentication')}<InlineHelp label={t('external.authentication')}>{t('external.credentialNote')}</InlineHelp></span></legend>
          {draft.id && <Field label={t('external.credentialAction')}><select value={draft.credential.action} onChange={event => { setShowKey(false); change({ credential: event.currentTarget.value === 'replace' ? { action: 'replace', value: '' } : { action: event.currentTarget.value as 'keep' | 'clear' } }) }}>
            {draft.id && <option value="keep">{t('external.keep')}</option>}<option value="replace">{t('external.replace')}</option>{draft.id && <option value="clear">{t('external.clear')}</option>}
          </select></Field>}
          {draft.credential.action === 'replace' && <div className="field">
            <span><label htmlFor={keyId}>{t('external.credential')}</label></span>
            <div className="external-knowledge__password"><input id={keyId} type={showKey ? 'text' : 'password'} autoComplete="new-password" required aria-describedby={`${keyId}-note`} value={draft.credential.value} onChange={event => change({ credential: { action: 'replace', value: event.currentTarget.value } })} />
              <button type="button" className="icon-button" aria-label={t(showKey ? 'external.hideKey' : 'external.showKey')} title={t(showKey ? 'external.hideKey' : 'external.showKey')} aria-pressed={showKey} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </div>
          </div>}
          <span className="sr-only" id={`${keyId}-note`}>{t('external.credentialNote')}</span>
          {draft.credential.action === 'clear' && <label><input type="checkbox" checked={clearConfirmed} onChange={event => setClearConfirmed(event.currentTarget.checked)} />{t('external.clearConfirm')}</label>}
          </fieldset>
          <div className="external-knowledge__fields">
            <Switch label={t('external.enabled')} checked={draft.enabled} onChange={value => change({ enabled: value })} />
            <p className="external-knowledge__help">{t('external.enabledHelp')}</p>
          </div>
          <details className="external-knowledge__help"><summary>{t('external.connectionHelp')}</summary><p>{t('external.saveThenTest')}</p></details>
          <footer className="external-knowledge__actions external-knowledge__footer"><ScopeBadge scope={{ kind: 'global' }} /><button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(undefined)}>{t('actions.cancel')}</button><button type="submit" className="primary-button" disabled={busy || (draft.credential.action === 'clear' && !clearConfirmed) || !URL.canParse(draft.baseUrl) || !externalKnowledgeInstanceSaveInputSchema.safeParse(draft).success}>{t(busy ? 'actions.saving' : 'external.saveInstance')}</button></footer>
          </fieldset>
        </form> : deleting ? <section className="external-knowledge__fields" aria-labelledby="external-instance-title">
          <p>{t('external.deleteInstanceConfirm', { count: libraries.filter(item => item.external?.instanceId === deleting.id).length })}</p>
          <ul>{libraries.filter(item => item.external?.instanceId === deleting.id).map(item => <li key={item.id}>{item.name}</li>)}</ul>
          {deleteError && <p role="alert" id="external-delete-error">{deleteError}</p>}
          <footer className="external-knowledge__actions external-knowledge__footer"><ScopeBadge scope={{ kind: 'global' }} /><button type="button" className="secondary-button" autoFocus disabled={busy} onClick={() => setDeleting(undefined)}>{t('actions.cancel')}</button><button type="button" className="danger-button" disabled={busy} aria-describedby={deleteError ? 'external-delete-error' : undefined} onClick={() => {
            setBusy(true); setDeleteError(undefined)
            void (async () => {
              try {
                for (const item of libraries.filter(item => item.external?.instanceId === deleting.id)) await window.goodbuddy.knowledge.deleteLibrary(item.id)
                await window.goodbuddy.knowledge.externalInstancesDelete({ instanceId: deleting.id })
                setDeleting(undefined); notify({ tone: 'success', message: t('external.removed') })
              } catch (error) { setDeleteError(errorMessage(error)) }
              finally {
                // A failed later deletion must still refresh bindings already removed.
                try { await onChanged() } catch (error) { notify({ tone: 'error', message: errorMessage(error) }) }
                setBusy(false)
              }
            })()
          }}>{t('external.deleteInstance')}</button></footer>
        </section> : <>
          <button type="button" className="primary-button" disabled={busy} onClick={() => edit()}>{t('external.addInstance')}</button>
          {!instances.length && <EmptyState title={t('external.noInstances')} description={t('external.noInstancesHelp')} icon={<Database size={24} />} />}
          <ul className="external-knowledge__instances">{instances.map(instance => <li key={instance.id}>
            <div><strong>{instance.name}</strong><p>{externalProviderNames[instance.provider]} · {new URL(instance.baseUrl).origin}</p><small>{instance.enabled ? t(`external.probe.${instance.probeStatus}`) : t('external.states.instance-disabled')} · {t(`external.credentials.${instance.credentialStatus}`)} · {t('external.boundCount', { count: instance.bindingCount })}</small>{instance.lastTestedAt && <small>{t('external.lastTest')}: <ExternalTime value={instance.lastTestedAt} /></small>}</div>
            <div className="external-knowledge__actions"><Switch label={`${t('external.enabled')}: ${instance.name}`} checked={instance.enabled} disabled={busy} onChange={enabled => void run(() => window.goodbuddy.knowledge.externalInstancesSetEnabled({ instanceId: instance.id, enabled }))} />
              <button type="button" className="secondary-button" disabled={busy || !instance.enabled || instance.credentialStatus !== 'configured'} onClick={() => void run(async () => { const value = await window.goodbuddy.knowledge.externalInstancesTest({ instanceId: instance.id }); notify({ tone: value.probeStatus === 'auth-failed' || value.probeStatus === 'failed' || value.probeStatus === 'unreachable' ? 'error' : 'info', message: `${instance.name}: ${t(`external.probe.${value.probeStatus}`)}` }) })}>{t('external.testConnection')}</button>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => edit(instance)}>{t('actions.edit')}</button><button type="button" className="danger-ghost" disabled={busy} onClick={() => setDeleting(instance)}>{t('actions.remove')}</button>
            </div>
          </li>)}</ul>
        </>}
      </div>
    </section>
  </div>, document.body)
}

function ExternalRetrievalTest({ library, instance }: { library: KnowledgeLibrary; instance?: ExternalKnowledgeInstanceSummary }): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ExternalKnowledgeTestResult>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const errorId = useId()
  useEffect(() => () => { generation.current++ }, [])
  const binding = library.external!
  const available = instance?.enabled && instance.credentialStatus === 'configured'
  return <form className="external-knowledge__fields" onSubmit={event => {
    event.preventDefault()
    if (busy || !available || !query.trim()) return
    const current = ++generation.current
    setBusy(true); setError(undefined); setResult(undefined)
    void window.goodbuddy.knowledge.externalRetrievalTest({ instanceId: binding.instanceId, remoteKnowledgeBaseId: binding.remoteKnowledgeBaseId, commonConfig: binding.commonConfig, providerConfig: binding.providerConfig, testQuery: query }).then(value => { if (current === generation.current) setResult(value) }).catch(reason => { if (current === generation.current) setError(errorMessage(reason)) }).finally(() => { if (current === generation.current) setBusy(false) })
  }}>
    <p>{externalProviderNames[binding.provider]} · {instance?.name} · {binding.remoteName}</p>
    <p>{t('external.queryNote')}</p>
    {!available && <p role="status">{t(`external.states.${externalLibraryStatus(library, instance ? [instance] : [])}`)}</p>}
    <Field label={t('external.query')}><textarea required disabled={busy} maxLength={4000} value={query} aria-describedby={error ? errorId : undefined} onChange={event => { generation.current++; setError(undefined); setResult(undefined); setQuery(event.currentTarget.value) }} /></Field>
    <button type="submit" className="secondary-button" disabled={busy || !available || !query.trim()}>{t(busy ? 'external.testing' : 'external.test')}</button>
    {error && <p role="alert" id={errorId}>{error}</p>}
    {result && <TestResults result={result} />}
  </form>
}

export function ExternalLibraryDetail({ library, instances, libraries, onChanged, notify, onManage, onUseInChat }: {
  library: KnowledgeLibrary; instances: ExternalKnowledgeInstanceSummary[]; libraries: readonly KnowledgeLibrary[]; onChanged: Changed; notify: Notify; onManage: () => void; onUseInChat: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [tab, setTab] = useState<'overview' | 'config' | 'test'>('overview')
  const [configVisited, setConfigVisited] = useState(false)
  const selectTab = (value: typeof tab): void => { if (value === 'config') setConfigVisited(true); setTab(value) }
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [remoteDetail, setRemoteDetail] = useState<ExternalKnowledgeCatalogItem>()
  const [detailError, setDetailError] = useState<string>()
  const detailGeneration = useRef(0)
  useEffect(() => () => { detailGeneration.current++ }, [])
  const binding = library.external!
  const instance = instances.find(item => item.id === binding.instanceId)
  return <div className="external-knowledge">
    <header><h2>{library.name}</h2><p>{externalProviderNames[binding.provider]} · {instance?.name} · {binding.remoteName}</p><ScopeBadge scope={{ kind: 'global' }} /></header>
    <PageTabs idPrefix={`external-${library.id}`} ariaLabel={library.name} value={tab} onChange={selectTab} tabs={[{ id: 'overview', label: t('external.overview') }, { id: 'config', label: t('external.config') }, { id: 'test', label: t('external.test') }]} />
    {tab !== 'config' && <div role="tabpanel" id={`external-${library.id}-panel-${tab}`} aria-labelledby={`external-${library.id}-tab-${tab}`}>
      {tab === 'overview' ? <section className="external-knowledge__fields">
        <dl><dt>{t('external.remoteId')}</dt><dd className="external-knowledge__identifier">{binding.remoteKnowledgeBaseId}</dd><dt>{t('external.status')}</dt><dd>{t(`external.states.${externalLibraryStatus(library, instances)}`)}</dd><dt>{t('external.lastTest')}</dt><dd>{binding.lastVerifiedAt ? <ExternalTime value={binding.lastVerifiedAt} /> : t('external.never')}</dd></dl>
        <p>{t('external.remoteData')}</p><p>{t('external.localOnly')}</p>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => {
          const current = ++detailGeneration.current
          setBusy(true); setDetailError(undefined)
          void window.goodbuddy.knowledge.externalCatalogGet({ instanceId: binding.instanceId, remoteKnowledgeBaseId: binding.remoteKnowledgeBaseId }).then(value => { if (current === detailGeneration.current) setRemoteDetail(value) }).catch(error => { if (current === detailGeneration.current) setDetailError(errorMessage(error)) }).finally(() => { if (current === detailGeneration.current) setBusy(false) })
        }}>{t('external.refreshDetail')}</button>
        {detailError && <p role="alert">{detailError}</p>}
        {remoteDetail && <p role="status">{remoteDetail.name} · {remoteDetail.description}</p>}
        <div className="external-knowledge__actions"><button type="button" className="primary-button" disabled={externalLibraryStatus(library, instances) !== 'ready'} onClick={() => onUseInChat(library.id)}>{t('actions.useInChat')}</button><button type="button" className="secondary-button" onClick={() => selectTab('config')}>{t('external.rebind')}</button><button type="button" className="secondary-button" onClick={onManage}>{t('external.manage')}</button><button type="button" className="danger-ghost" onClick={() => setRemoving(true)}>{t('external.remove')}</button></div>
        {removing && <div className="external-knowledge__group"><p>{t('external.removeBindingConfirm')}</p><div className="external-knowledge__actions"><button type="button" className="secondary-button" autoFocus disabled={busy} onClick={() => setRemoving(false)}>{t('actions.cancel')}</button><button type="button" className="danger-button" disabled={busy} onClick={() => { setBusy(true); void window.goodbuddy.knowledge.deleteLibrary(library.id).then(async () => { await onChanged(); notify({ tone: 'success', message: t('external.removed') }) }).catch(error => notify({ tone: 'error', message: errorMessage(error) })).finally(() => setBusy(false)) }}>{t('external.remove')}</button></div></div>}
      </section> : <ExternalRetrievalTest key={JSON.stringify([binding, instance])} library={library} instance={instance} />}
    </div>}
    {configVisited && <div hidden={tab !== 'config'} role="tabpanel" id={`external-${library.id}-panel-config`} aria-labelledby={`external-${library.id}-tab-config`}><ExternalBindingForm provider={binding.provider} instances={instances} libraries={libraries} library={library} onCancel={() => { setConfigVisited(false); setTab('overview') }} onChanged={onChanged} notify={notify} onManage={onManage} /></div>}
  </div>
}
