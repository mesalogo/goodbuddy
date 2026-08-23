import {
  AlertTriangle,
  ExternalLink,
  FileSearch,
  Save,
  Search,
  X
} from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  defaultKnowledgeRetrievalSettings,
  knowledgeRetrievalSettingsSchema,
  type KnowledgeRetrievalChannel as SharedKnowledgeRetrievalChannel,
  type KnowledgeRetrievalSettings
} from '../../shared/knowledge-contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { SegmentedControl } from './WorkspacePrimitives'

export type KnowledgeRetrievalChannel =
  SharedKnowledgeRetrievalChannel

export type KnowledgeRetrievalWorkbenchSettings = Omit<
  KnowledgeRetrievalSettings,
  'version'
>

export type KnowledgeRetrievalChannelDetail = {
  rank?: number
  score?: number
  similarity?: number
}

export type KnowledgeRetrievalWorkbenchResult = {
  chunkId: string
  documentId: string
  rank: number
  documentName: string
  sourceName: string
  locator?: string
  snippet: string
  fusedScore?: number
  relevance?: number
  channels: readonly KnowledgeRetrievalChannel[]
  channelDetails?: Partial<
    Record<KnowledgeRetrievalChannel, KnowledgeRetrievalChannelDetail>
  >
  rankBeforeRerank?: number
  contextText?: string
  contextCharacterCount?: number
  contextTruncated?: boolean
  diagnostics?: readonly string[]
}

export type KnowledgeRetrievalDiagnostics = {
  durationMs: number
  requestedChannels: readonly KnowledgeRetrievalChannel[]
  usedChannels: readonly KnowledgeRetrievalChannel[]
  degradedChannels?: readonly {
    channel: KnowledgeRetrievalChannel
    reason: string
  }[]
  candidateCounts?: Partial<Record<KnowledgeRetrievalChannel, number>>
  channelDurationsMs?: Partial<Record<KnowledgeRetrievalChannel, number>>
  vectorScannedCount?: number
  rerank?: {
    requested: 'none' | 'local' | 'learned'
    used: 'none' | 'local' | 'learned'
    status: 'skipped' | 'applied' | 'fallback' | 'failed'
    candidateCount: number
    durationMs: number
    model?: string
    reason?: string
  }
}

export type KnowledgeRetrievalContextSummary = {
  characterCount: number
  budget: number
  truncated: boolean
}

export type KnowledgeRetrievalZeroReason =
  | 'empty-library'
  | 'index-unavailable'
  | 'no-match'
  | 'filtered'

export type KnowledgeRetrievalWorkbenchResponse = {
  diagnostics: KnowledgeRetrievalDiagnostics
  results: readonly KnowledgeRetrievalWorkbenchResult[]
  context: KnowledgeRetrievalContextSummary
  zeroReason?: KnowledgeRetrievalZeroReason
}

export type KnowledgeRetrievalWorkbenchProps = {
  libraryName: string
  initialQuery?: string
  settings: KnowledgeRetrievalWorkbenchSettings
  graphAvailable?: boolean
  status?: 'idle' | 'running' | 'error' | 'success'
  error?: string
  response?: KnowledgeRetrievalWorkbenchResponse
  savingDefaults?: boolean
  onTest: (request: {
    query: string
    settings: KnowledgeRetrievalWorkbenchSettings
  }) => void | Promise<void>
  onViewContext: (result: KnowledgeRetrievalWorkbenchResult) => void
  onOpenSource: (result: KnowledgeRetrievalWorkbenchResult) => void
  onSaveDefaults: (
    settings: KnowledgeRetrievalWorkbenchSettings
  ) => void | Promise<void>
  onClose: () => void
}

type ValidationErrors = Partial<
  Record<keyof KnowledgeRetrievalWorkbenchSettings | 'query' | 'weights', string>
>

const channels: readonly KnowledgeRetrievalChannel[] = [
  'fts',
  'cjk',
  'vector',
  'graph'
]

const weightKeys = [
  'ftsWeight',
  'vectorWeight',
  'graphWeight'
] as const
type WeightKey = (typeof weightKeys)[number]
type WeightPercentageInputs = Record<WeightKey, string>

function formatScore(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(4)
}

function percentageInput(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

function activeWeightKeys(graphAvailable: boolean): readonly WeightKey[] {
  return graphAvailable
    ? weightKeys
    : ['ftsWeight', 'vectorWeight']
}

function initialWeightPercentages(
  settings: KnowledgeRetrievalWorkbenchSettings,
  graphAvailable: boolean
): WeightPercentageInputs {
  const activeKeys = activeWeightKeys(graphAvailable)
  const values = activeKeys.map((key) => settings[key])
  const total = values.every(
    (value) => Number.isFinite(value) && value >= 0
  )
    ? values.reduce((sum, value) => sum + value, 0)
    : 0
  const percentages: WeightPercentageInputs = {
    ftsWeight: '0',
    vectorWeight: '0',
    graphWeight: ''
  }
  if (total <= 0) {
    for (const key of activeKeys) {
      percentages[key] = '0'
    }
    return percentages
  }
  let assignedTenths = 0
  activeKeys.forEach((key, index) => {
    const tenths =
      index === activeKeys.length - 1
        ? 1_000 - assignedTenths
        : Math.round((settings[key] / total) * 1_000)
    assignedTenths += tenths
    percentages[key] = percentageInput(tenths / 10)
  })
  return percentages
}

function validate(
  query: string,
  settings: KnowledgeRetrievalWorkbenchSettings,
  weightPercentages: WeightPercentageInputs,
  graphAvailable: boolean,
  t: (key: string, options?: Record<string, unknown>) => string
): ValidationErrors {
  const errors: ValidationErrors = {}
  const length = query.trim().length
  if (length === 0) {
    errors.query = t('retrieval.validation.queryRequired')
  } else if (query.length > 4_000) {
    errors.query = t('retrieval.validation.queryTooLong')
  }
  const parsedSettings = knowledgeRetrievalSettingsSchema.safeParse({
    ...defaultKnowledgeRetrievalSettings,
    ...settings
  })
  if (!parsedSettings.success) {
    for (const issue of parsedSettings.error.issues) {
      const key = issue.path[0]
      if (key === 'topK') {
        errors.topK = t('retrieval.validation.topK')
      } else if (key === 'candidateMultiplier') {
        errors.candidateMultiplier = t(
          'retrieval.validation.candidateMultiplier'
        )
      } else if (key === 'minimumVectorSimilarity') {
        errors.minimumVectorSimilarity = t(
          'retrieval.validation.vectorSimilarity'
        )
      } else if (
        key === 'ftsWeight' ||
        key === 'vectorWeight' ||
        key === 'graphWeight'
      ) {
        errors[key] = t('retrieval.validation.weight')
      } else if (key === 'contextMaxCharacters') {
        errors.contextMaxCharacters = t(
          'retrieval.validation.contextBudget'
        )
      } else if (key === 'adjacentChunkCount') {
        errors.adjacentChunkCount = t(
          'retrieval.validation.adjacentCount'
        )
      } else if (issue.path.length === 0) {
        errors.weights = t('retrieval.validation.activeWeight')
      }
    }
  }
  const activeWeight =
    settings.ftsWeight +
    settings.vectorWeight +
    (graphAvailable ? settings.graphWeight : 0)
  for (const key of activeWeightKeys(graphAvailable)) {
    const percentage = Number(weightPercentages[key])
    if (
      weightPercentages[key] === '' ||
      !Number.isFinite(percentage) ||
      percentage < 0 ||
      percentage > 100
    ) {
      errors[key] = t('retrieval.validation.weight')
    }
  }
  const percentageTotal = activeWeightKeys(graphAvailable).reduce(
    (sum, key) => sum + Number(weightPercentages[key]),
    0
  )
  if (
    Number.isFinite(percentageTotal) &&
    Math.abs(percentageTotal - 100) > 0.11
  ) {
    errors.weights = t('retrieval.validation.weightTotal')
  }
  if (activeWeight <= 0) {
    errors.weights = t('retrieval.validation.activeWeight')
  }
  return errors
}

export function KnowledgeRetrievalWorkbench({
  error,
  graphAvailable = true,
  initialQuery = '',
  libraryName,
  onClose,
  onOpenSource,
  onSaveDefaults,
  onTest,
  onViewContext,
  response,
  savingDefaults = false,
  settings,
  status = 'idle'
}: KnowledgeRetrievalWorkbenchProps): React.JSX.Element {
  const { i18n, t } = useTranslation('knowledge')
  const [query, setQuery] = useState(initialQuery)
  const [draftSettings, setDraftSettings] = useState(() => ({
    ...settings,
    minimumVectorSimilarity: Math.max(
      0,
      settings.minimumVectorSimilarity
    )
  }))
  const [vectorSimilarityPercent, setVectorSimilarityPercent] = useState(
    percentageInput(Math.max(0, settings.minimumVectorSimilarity) * 100)
  )
  const [weightPercentages, setWeightPercentages] =
    useState<WeightPercentageInputs>(() =>
      initialWeightPercentages(settings, graphAvailable)
    )
  const [showQueryValidation, setShowQueryValidation] = useState(false)
  const [showSettingsValidation, setShowSettingsValidation] =
    useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const queryRef = useRef<HTMLTextAreaElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const queryErrorId = useId()
  const settingsErrorId = useId()
  const percentFormatter = useMemo(
    () =>
      new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language, {
        style: 'percent',
        maximumFractionDigits: 1
      }),
    [i18n.language, i18n.resolvedLanguage]
  )

  useEffect(() => {
    return activateModalFocus(() => queryRef.current)
  }, [])

  const validationErrors = useMemo(
    () =>
      validate(
        query,
        draftSettings,
        weightPercentages,
        graphAvailable,
        t
      ),
    [draftSettings, graphAvailable, query, t, weightPercentages]
  )
  const hasValidationErrors = Object.keys(validationErrors).length > 0
  const hasSettingsValidationErrors = Object.entries(validationErrors).some(
    ([key]) => key !== 'query'
  )
  const running = status === 'running'
  const candidateLimit =
    Number.isSafeInteger(draftSettings.topK) &&
    Number.isSafeInteger(draftSettings.candidateMultiplier) &&
    draftSettings.topK > 0 &&
    draftSettings.candidateMultiplier > 0
      ? Math.min(
          100,
          draftSettings.topK * draftSettings.candidateMultiplier
        )
      : undefined

  const updateNumber = (
    key: keyof KnowledgeRetrievalWorkbenchSettings,
    value: string
  ): void => {
    setDraftSettings((current) => ({
      ...current,
      [key]: value === '' ? Number.NaN : Number(value)
    }))
  }

  const updateVectorSimilarity = (value: string): void => {
    setVectorSimilarityPercent(value)
    setDraftSettings((current) => ({
      ...current,
      minimumVectorSimilarity:
        value === '' ? Number.NaN : Number(value) / 100
    }))
  }

  const updateWeight = (key: WeightKey, value: string): void => {
    setWeightPercentages((current) => ({
      ...current,
      [key]: value
    }))
    setDraftSettings((current) => ({
      ...current,
      [key]: value === '' ? Number.NaN : Number(value) / 50
    }))
  }

  const formatPercent = (value: number | undefined): string =>
    value === undefined ? '—' : percentFormatter.format(value)

  const submitTest = (event: FormEvent): void => {
    event.preventDefault()
    setShowQueryValidation(true)
    setShowSettingsValidation(true)
    if (hasValidationErrors || running) {
      return
    }
    void onTest({ query: query.trim(), settings: draftSettings })
  }

  const saveDefaults = (): void => {
    setShowSettingsValidation(true)
    if (hasSettingsValidationErrors || savingDefaults) {
      return
    }
    void onSaveDefaults(draftSettings)
  }

  const channelLabel = (channel: KnowledgeRetrievalChannel): string =>
    t(`retrieval.channels.${channel}`)

  const results = response?.results ?? []

  return createPortal(
    <div className="knowledge-dialog-backdrop">
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="knowledge-dialog knowledge-retrieval-workbench"
        onKeyDown={(event) => {
          if (event.defaultPrevented) {
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          trapTabFocus(event, dialogRef.current)
        }}
        ref={dialogRef}
        role="dialog"
      >
        <header className="knowledge-dialog__header">
          <div>
            <span className="knowledge-dialog__eyebrow">
              {t('retrieval.eyebrow', { libraryName })}
            </span>
            <h2 id={titleId}>{t('retrieval.title')}</h2>
            <p id={descriptionId}>{t('retrieval.description')}</p>
          </div>
          <button
            aria-label={t('retrieval.close')}
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <form
          aria-busy={running}
          className="knowledge-dialog__content knowledge-retrieval-workbench__content"
          noValidate
          onSubmit={submitTest}
        >
          <section
            aria-labelledby={`${titleId}-query`}
            className="knowledge-workbench-section"
          >
            <div className="knowledge-workbench-section__heading">
              <div>
                <h3 id={`${titleId}-query`}>{t('retrieval.query.title')}</h3>
              </div>
              <span className="knowledge-character-count">
                {t('retrieval.query.count', { count: query.length })}
              </span>
            </div>
            <label className="field">
              <span>{t('retrieval.query.label')}</span>
              <textarea
                aria-describedby={
                  showQueryValidation && validationErrors.query
                    ? queryErrorId
                    : undefined
                }
                aria-invalid={
                  showQueryValidation && Boolean(validationErrors.query)
                }
                maxLength={4_001}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={t('retrieval.query.placeholder')}
                ref={queryRef}
                rows={3}
                value={query}
              />
            </label>
            {showQueryValidation && validationErrors.query && (
              <p className="knowledge-inline-error" id={queryErrorId}>
                {validationErrors.query}
              </p>
            )}
          </section>

          <details className="knowledge-workbench-settings" open>
            <summary>
              <span>
                <strong>{t('retrieval.settings.title')}</strong>
                <small>{t('retrieval.settings.temporary')}</small>
              </span>
            </summary>
            {showSettingsValidation && validationErrors.weights && (
              <p
                className="knowledge-inline-error"
                id={settingsErrorId}
                role="alert"
              >
                {validationErrors.weights}
              </p>
            )}
            <div
              aria-describedby={
                showSettingsValidation && validationErrors.weights
                  ? settingsErrorId
                  : undefined
              }
              className="knowledge-workbench-settings__groups"
            >
              <section
                aria-labelledby={`${titleId}-recall-settings`}
                className="knowledge-workbench-settings__group"
              >
                <div className="knowledge-workbench-settings__group-heading">
                  <span>1</span>
                  <div>
                    <h4 id={`${titleId}-recall-settings`}>
                      {t('retrieval.settings.groups.recall.title')}
                    </h4>
                  </div>
                </div>
                <div className="knowledge-workbench-settings__grid knowledge-workbench-settings__grid--three">
                  <label className="field">
                    <span>{t('retrieval.settings.candidateMultiplier')}</span>
                    <input
                      aria-invalid={
                        showSettingsValidation &&
                        Boolean(validationErrors.candidateMultiplier)
                      }
                      max={10}
                      min={2}
                      onChange={(event) =>
                        updateNumber(
                          'candidateMultiplier',
                          event.currentTarget.value
                        )
                      }
                      step={1}
                      type="number"
                      value={
                        Number.isNaN(draftSettings.candidateMultiplier)
                          ? ''
                          : draftSettings.candidateMultiplier
                      }
                    />
                    <small>
                      {showSettingsValidation &&
                      validationErrors.candidateMultiplier
                        ? validationErrors.candidateMultiplier
                        : t('retrieval.settings.candidateMultiplierHelp', {
                            count: candidateLimit ?? '—'
                          })}
                    </small>
                  </label>
                  <label className="field">
                    <span>{t('retrieval.settings.vectorSimilarity')}</span>
                    <span className="knowledge-percentage-input">
                      <input
                        aria-invalid={
                          showSettingsValidation &&
                          Boolean(validationErrors.minimumVectorSimilarity)
                        }
                        max={100}
                        min={0}
                        onChange={(event) =>
                          updateVectorSimilarity(event.currentTarget.value)
                        }
                        step={5}
                        type="number"
                        value={vectorSimilarityPercent}
                      />
                      <span aria-hidden="true">%</span>
                    </span>
                    <small>
                      {showSettingsValidation &&
                      validationErrors.minimumVectorSimilarity
                        ? validationErrors.minimumVectorSimilarity
                        : t('retrieval.settings.vectorSimilarityHelp')}
                    </small>
                  </label>
                </div>
                <div className="knowledge-workbench-settings__weights">
                  <span className="knowledge-workbench-settings__subheading">
                    {t('retrieval.settings.channelWeights')}
                  </span>
                  <div className="knowledge-workbench-settings__grid knowledge-workbench-settings__grid--three">
                    {(
                      weightKeys
                    ).map((key) => (
                      <label className="field" key={key}>
                        <span>{t(`retrieval.settings.${key}`)}</span>
                        <span className="knowledge-percentage-input">
                          <input
                            aria-invalid={
                              showSettingsValidation &&
                              Boolean(validationErrors[key])
                            }
                            disabled={key === 'graphWeight' && !graphAvailable}
                            max={100}
                            min={0}
                            onChange={(event) =>
                              updateWeight(key, event.currentTarget.value)
                            }
                            step={5}
                            type="number"
                            value={weightPercentages[key]}
                          />
                          <span aria-hidden="true">%</span>
                        </span>
                        <small>
                          {showSettingsValidation && validationErrors[key]
                            ? validationErrors[key]
                            : key === 'graphWeight' && !graphAvailable
                              ? t('retrieval.settings.graphUnavailable')
                              : t('retrieval.settings.weightHelp')}
                        </small>
                      </label>
                    ))}
                  </div>
                </div>
              </section>

              <section
                aria-labelledby={`${titleId}-output-settings`}
                className="knowledge-workbench-settings__group"
              >
                <div className="knowledge-workbench-settings__group-heading">
                  <span>2–4</span>
                  <div>
                    <h4 id={`${titleId}-output-settings`}>
                      {t('retrieval.settings.groups.output.title')}
                    </h4>
                  </div>
                </div>
                <div className="field">
                  <span>{t('retrieval.settings.rerankMode')}</span>
                  <SegmentedControl
                    ariaLabel={t('retrieval.settings.rerankMode')}
                    onChange={(rerankMode) => {
                      setDraftSettings((current) => ({
                        ...current,
                        rerankMode,
                        localRerankEnabled: rerankMode !== 'none'
                      }))
                    }}
                    options={[
                      {
                        label: t('retrieval.settings.rerankModes.none'),
                        value: 'none'
                      },
                      {
                        label: t('retrieval.settings.rerankModes.local'),
                        value: 'local'
                      },
                      {
                        label: t('retrieval.settings.rerankModes.learned'),
                        value: 'learned'
                      }
                    ]}
                    value={draftSettings.rerankMode}
                  />
                  <small>{t('retrieval.settings.rerankModeHelp')}</small>
                </div>
                <div className="knowledge-workbench-settings__grid knowledge-workbench-settings__grid--three">
                  <label className="field">
                    <span>{t('retrieval.settings.topK')}</span>
                    <input
                      aria-invalid={
                        showSettingsValidation &&
                        Boolean(validationErrors.topK)
                      }
                      max={20}
                      min={1}
                      onChange={(event) =>
                        updateNumber('topK', event.currentTarget.value)
                      }
                      step={1}
                      type="number"
                      value={
                        Number.isNaN(draftSettings.topK)
                          ? ''
                          : draftSettings.topK
                      }
                    />
                    <small>
                      {showSettingsValidation && validationErrors.topK
                        ? validationErrors.topK
                        : t('retrieval.settings.topKHelp')}
                    </small>
                  </label>
                  <label className="field">
                    <span>{t('retrieval.settings.contextBudget')}</span>
                    <input
                      aria-invalid={
                        showSettingsValidation &&
                        Boolean(validationErrors.contextMaxCharacters)
                      }
                      max={48_000}
                      min={2_000}
                      onChange={(event) =>
                        updateNumber(
                          'contextMaxCharacters',
                          event.currentTarget.value
                        )
                      }
                      step={1_000}
                      type="number"
                      value={
                        Number.isNaN(draftSettings.contextMaxCharacters)
                          ? ''
                          : draftSettings.contextMaxCharacters
                      }
                    />
                    <small>
                      {showSettingsValidation &&
                      validationErrors.contextMaxCharacters
                        ? validationErrors.contextMaxCharacters
                        : t('retrieval.settings.contextBudgetHelp')}
                    </small>
                  </label>
                  <label className="field">
                    <span>{t('retrieval.settings.adjacentCount')}</span>
                    <input
                      aria-invalid={
                        showSettingsValidation &&
                        Boolean(validationErrors.adjacentChunkCount)
                      }
                      max={2}
                      min={0}
                      onChange={(event) =>
                        updateNumber(
                          'adjacentChunkCount',
                          event.currentTarget.value
                        )
                      }
                      step={1}
                      type="number"
                      value={
                        Number.isNaN(draftSettings.adjacentChunkCount)
                          ? ''
                          : draftSettings.adjacentChunkCount
                      }
                    />
                    <small>
                      {showSettingsValidation &&
                      validationErrors.adjacentChunkCount
                        ? validationErrors.adjacentChunkCount
                        : t('retrieval.settings.adjacentCountHelp')}
                    </small>
                  </label>
                </div>
              </section>
            </div>
          </details>

          <div className="knowledge-retrieval-workbench__actions">
            <button
              className="secondary-button"
              disabled={savingDefaults}
              onClick={saveDefaults}
              type="button"
            >
              <Save aria-hidden="true" size={15} />
              {savingDefaults
                ? t('retrieval.actions.savingDefaults')
                : t('retrieval.actions.saveDefaults')}
            </button>
            <button className="primary-button" disabled={running} type="submit">
              <Search aria-hidden="true" size={15} />
              {running
                ? t('retrieval.actions.running')
                : t('retrieval.actions.test')}
            </button>
          </div>

          {status === 'error' && (
            <div className="knowledge-operation-state knowledge-operation-state--error" role="alert">
              <AlertTriangle aria-hidden="true" size={18} />
              <div>
                <strong>{t('retrieval.states.errorTitle')}</strong>
                <p>{error ?? t('retrieval.states.errorDescription')}</p>
              </div>
            </div>
          )}
          {running && (
            <div className="knowledge-operation-state" role="status">
              <FileSearch aria-hidden="true" size={18} />
              <div>
                <strong>{t('retrieval.states.runningTitle')}</strong>
                <p>{t('retrieval.states.runningDescription')}</p>
              </div>
            </div>
          )}

          {status === 'success' && response && (
            <section
              aria-labelledby={`${titleId}-results`}
              className="knowledge-retrieval-results"
            >
              <div className="knowledge-workbench-section__heading">
                <div>
                  <h3 id={`${titleId}-results`}>
                    {t('retrieval.results.title', { count: results.length })}
                  </h3>
                  <p>
                    {t('retrieval.results.contextSummary', {
                      count: response.context.characterCount,
                      budget: response.context.budget
                    })}
                  </p>
                </div>
                {response.context.truncated && (
                  <span className="knowledge-status-badge knowledge-status-badge--warning">
                    {t('retrieval.results.truncated')}
                  </span>
                )}
              </div>

              <div className="knowledge-retrieval-diagnostics">
                <dl>
                  <div>
                    <dt>{t('retrieval.diagnostics.duration')}</dt>
                    <dd>
                      {t('retrieval.diagnostics.milliseconds', {
                        count: response.diagnostics.durationMs
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('retrieval.diagnostics.requested')}</dt>
                    <dd>
                      {response.diagnostics.requestedChannels
                        .map(channelLabel)
                        .join(t('format.listSeparator'))}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('retrieval.diagnostics.used')}</dt>
                    <dd>
                      {response.diagnostics.usedChannels.length > 0
                        ? response.diagnostics.usedChannels
                            .map(channelLabel)
                            .join(t('format.listSeparator'))
                        : t('retrieval.diagnostics.none')}
                    </dd>
                  </div>
                  {response.diagnostics.vectorScannedCount !== undefined && (
                    <div>
                      <dt>{t('retrieval.diagnostics.vectorScanned')}</dt>
                      <dd>{response.diagnostics.vectorScannedCount}</dd>
                    </div>
                  )}
                  {response.diagnostics.rerank && (
                    <div>
                      <dt>{t('retrieval.diagnostics.rerank')}</dt>
                      <dd>
                        {t('retrieval.diagnostics.rerankSummary', {
                          requested: t(
                            `retrieval.settings.rerankModes.${response.diagnostics.rerank.requested}`
                          ),
                          used: t(
                            `retrieval.settings.rerankModes.${response.diagnostics.rerank.used}`
                          ),
                          status: t(
                            `retrieval.diagnostics.rerankStatuses.${response.diagnostics.rerank.status}`
                          ),
                          count: response.diagnostics.rerank.candidateCount,
                          duration: response.diagnostics.rerank.durationMs
                        })}
                        {response.diagnostics.rerank.model
                          ? ` · ${response.diagnostics.rerank.model}`
                          : ''}
                      </dd>
                    </div>
                  )}
                </dl>
                {response.diagnostics.rerank?.reason && (
                  <p className="knowledge-degraded-state" role="status">
                    {response.diagnostics.rerank.reason}
                  </p>
                )}
                <div className="knowledge-retrieval-diagnostics__channels">
                  {channels.map((channel) => (
                    <div key={channel}>
                      <strong>{channelLabel(channel)}</strong>
                      <span>
                        {t('retrieval.diagnostics.channelSummary', {
                          candidates:
                            response.diagnostics.candidateCounts?.[channel] ?? 0,
                          duration:
                            response.diagnostics.channelDurationsMs?.[channel] ??
                            0
                        })}
                      </span>
                    </div>
                  ))}
                </div>
                {(response.diagnostics.degradedChannels?.length ?? 0) > 0 && (
                  <div
                    className="knowledge-degraded-state"
                    role="status"
                  >
                    <AlertTriangle aria-hidden="true" size={18} />
                    <div>
                      <strong>{t('retrieval.diagnostics.degradedTitle')}</strong>
                      <ul>
                        {response.diagnostics.degradedChannels?.map(
                          (degraded) => (
                            <li key={`${degraded.channel}-${degraded.reason}`}>
                              {channelLabel(degraded.channel)}: {degraded.reason}
                            </li>
                          )
                        )}
                      </ul>
                    </div>
                  </div>
                )}
              </div>

              {results.length === 0 ? (
                <div className="knowledge-zero-state" role="status">
                  <strong>
                    {t(
                      `retrieval.zero.${response.zeroReason ?? 'no-match'}.title`
                    )}
                  </strong>
                  <p>
                    {t(
                      `retrieval.zero.${response.zeroReason ?? 'no-match'}.description`
                    )}
                  </p>
                </div>
              ) : (
                <ol
                  aria-label={t('retrieval.results.listAriaLabel')}
                  className="knowledge-retrieval-results__list"
                >
                  {results.map((result) => (
                    <li
                      className="knowledge-retrieval-result"
                      key={result.chunkId}
                    >
                      <article
                        aria-label={t('retrieval.results.resultAriaLabel', {
                          rank: result.rank,
                          documentName: result.documentName
                        })}
                      >
                        <header>
                          <span className="knowledge-retrieval-result__rank">
                            #{result.rank}
                          </span>
                          <div>
                            <h4>{result.documentName}</h4>
                            <p>{result.locator ?? t('retrieval.results.unknownLocator')}</p>
                          </div>
                          <div className="knowledge-retrieval-result__scores">
                            <span>
                              {t('retrieval.results.relevance')}{' '}
                              <strong>{formatPercent(result.relevance)}</strong>
                            </span>
                            <span>
                              {t('retrieval.results.fusedScore')}{' '}
                              <strong>{formatScore(result.fusedScore)}</strong>
                            </span>
                          </div>
                        </header>
                        <p className="knowledge-retrieval-result__snippet">
                          {result.snippet}
                        </p>
                        <dl className="knowledge-retrieval-result__metadata">
                          {result.channels.map((channel) => {
                            const detail = result.channelDetails?.[channel]
                            return (
                              <div key={channel}>
                                <dt>{channelLabel(channel)}</dt>
                                <dd>
                                  {t('retrieval.results.channelDetail', {
                                    rank: detail?.rank ?? '—',
                                    score: formatScore(detail?.score),
                                    similarity: formatPercent(detail?.similarity)
                                  })}
                                </dd>
                              </div>
                            )
                          })}
                          {result.rankBeforeRerank !== undefined && (
                            <div>
                              <dt>{t('retrieval.results.beforeRerank')}</dt>
                              <dd>#{result.rankBeforeRerank}</dd>
                            </div>
                          )}
                          <div>
                            <dt>{t('retrieval.results.context')}</dt>
                            <dd>
                              {t('retrieval.results.contextDetail', {
                                count: result.contextCharacterCount ?? 0,
                                truncated: result.contextTruncated
                                  ? t('retrieval.results.truncated')
                                  : t('retrieval.results.complete')
                              })}
                            </dd>
                          </div>
                        </dl>
                        {result.diagnostics &&
                          result.diagnostics.length > 0 && (
                            <details className="knowledge-result-details">
                              <summary>{t('retrieval.results.diagnostics')}</summary>
                              <ul>
                                {result.diagnostics.map((diagnostic) => (
                                  <li key={diagnostic}>{diagnostic}</li>
                                ))}
                              </ul>
                            </details>
                          )}
                        {result.contextText && (
                          <details className="knowledge-result-details">
                            <summary>{t('retrieval.results.actualContext')}</summary>
                            <p>{result.contextText}</p>
                          </details>
                        )}
                        <footer>
                          <button
                            className="secondary-button"
                            onClick={() => onViewContext(result)}
                            type="button"
                          >
                            <FileSearch aria-hidden="true" size={14} />
                            {t('retrieval.actions.viewContext')}
                          </button>
                          <button
                            className="secondary-button"
                            onClick={() => onOpenSource(result)}
                            type="button"
                          >
                            <ExternalLink aria-hidden="true" size={14} />
                            {t('retrieval.actions.openSource')}
                          </button>
                        </footer>
                      </article>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </form>
      </section>
    </div>,
    document.body
  )
}
