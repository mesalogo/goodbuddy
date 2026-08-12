import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileSearch,
  FileText,
  FolderOpen,
  ScanText,
  ShieldCheck,
  Square,
  Trash2,
  TriangleAlert,
  Upload,
  X
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DocumentParsingDiagnostic,
  DocumentOcrModelCatalogEntry,
  DocumentOcrModelOperation,
  DocumentParsingSettings,
  DocumentParsingSnapshot,
  DocumentParsingTestPurpose
} from '../../shared/document-parsing-contracts'
import type { AppNotificationInput } from './notifications'
import { SettingsCategoryHeader } from './SettingsPrimitives'

type DocumentParsingSettingsSectionProps = {
  onNotify?: (notification: AppNotificationInput) => void
}

function errorMessage(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) {
    return fallback
  }
  return reason.message.replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/u,
    ''
  )
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`
}

function catalogSize(entry: DocumentOcrModelCatalogEntry): number {
  return entry.files.reduce(
    (total, file) => total + file.download.size,
    0
  )
}

function progressPercent(
  operation: DocumentOcrModelOperation
): number | undefined {
  return operation.totalBytes && operation.totalBytes > 0
    ? Math.min(
        100,
        (operation.completedBytes / operation.totalBytes) * 100
      )
    : undefined
}

function StatusRow({
  available,
  detail,
  label
}: {
  available: boolean
  detail: string
  label: string
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className="document-parsing-status__row">
      {available ? (
        <CheckCircle2 aria-hidden="true" size={16} />
      ) : (
        <TriangleAlert aria-hidden="true" size={16} />
      )}
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <span
        className={`document-parsing-status__badge${
          available
            ? ' document-parsing-status__badge--available'
            : ''
        }`}
      >
        {available
          ? t('documentParsing.status.available')
          : t('documentParsing.status.unavailable')}
      </span>
    </div>
  )
}

function DiagnosticDialog({
  diagnostic,
  onClose
}: {
  diagnostic: DocumentParsingDiagnostic
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
  }, [])
  return (
    <div
      className="document-parsing-diagnostic-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          onClose()
        }
      }}
    >
      <section
        aria-labelledby="document-parsing-diagnostic-title"
        aria-modal="true"
        className="document-parsing-diagnostic"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose()
          }
        }}
        role="dialog"
      >
        <header>
          <div>
            <strong id="document-parsing-diagnostic-title">
              {t('documentParsing.diagnostic.title')}
            </strong>
            <small>{diagnostic.fileName}</small>
          </div>
          <button
            aria-label={t('documentParsing.diagnostic.close')}
            className="icon-button"
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <dl>
          <div>
            <dt>{t('documentParsing.diagnostic.format')}</dt>
            <dd>{diagnostic.sourceFormat}</dd>
          </div>
          <div>
            <dt>{t('documentParsing.diagnostic.method')}</dt>
            <dd>
              {t(
                `documentParsing.diagnostic.methods.${diagnostic.method}`
              )}
            </dd>
          </div>
          <div>
            <dt>{t('documentParsing.diagnostic.pages')}</dt>
            <dd>{diagnostic.pageCount}</dd>
          </div>
          <div>
            <dt>{t('documentParsing.diagnostic.ocrPages')}</dt>
            <dd>{diagnostic.ocrPageCount}</dd>
          </div>
          <div>
            <dt>{t('documentParsing.diagnostic.characters')}</dt>
            <dd>{diagnostic.characterCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>{t('documentParsing.diagnostic.duration')}</dt>
            <dd>{(diagnostic.durationMs / 1_000).toFixed(1)}s</dd>
          </div>
        </dl>
        <div className="document-parsing-diagnostic__preview">
          <strong>{t('documentParsing.diagnostic.preview')}</strong>
          <pre>{diagnostic.preview}</pre>
        </div>
        {diagnostic.warnings.length > 0 && (
          <div className="settings-warning">
            <strong>{t('documentParsing.diagnostic.warnings')}</strong>
            <ul>
              {diagnostic.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}

export function DocumentParsingSettingsSection({
  onNotify
}: DocumentParsingSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [snapshot, setSnapshot] = useState<DocumentParsingSnapshot>()
  const [draft, setDraft] = useState<DocumentParsingSettings>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [testingPurpose, setTestingPurpose] =
    useState<DocumentParsingTestPurpose>()
  const [busyModelId, setBusyModelId] = useState<string>()
  const [confirmingRemove, setConfirmingRemove] = useState<string>()
  const [diagnostic, setDiagnostic] =
    useState<DocumentParsingDiagnostic>()
  const mountedRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.goodbuddy.documentParsing
    if (!api) {
      throw new Error(t('errors.documentParsingUnavailable'))
    }
    const next = await api.getSnapshot()
    if (mountedRef.current) {
      setSnapshot(next)
    }
  }, [t])

  useEffect(() => {
    const api = window.goodbuddy.documentParsing
    let active = true
    mountedRef.current = true
    if (!api) {
      return () => {
        active = false
        mountedRef.current = false
      }
    }
    void api.getSnapshot().then(
      (next) => {
        if (active) {
          setSnapshot(next)
          setDraft(next.settings)
        }
      },
      (reason: unknown) => {
        if (active) {
          setError(
            errorMessage(reason, t('errors.readDocumentParsing'))
          )
        }
      }
    )
    return () => {
      active = false
      mountedRef.current = false
    }
  }, [t])

  const shouldPoll =
    busyModelId !== undefined ||
    Boolean(snapshot?.ocrModels.operations.length)

  useEffect(() => {
    if (!shouldPoll) {
      return
    }
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined)
    }, 300)
    return () => window.clearInterval(timer)
  }, [refresh, shouldPoll])

  const updateDraft = <Key extends keyof DocumentParsingSettings>(
    key: Key,
    value: DocumentParsingSettings[Key]
  ): void => {
    setDraft((current) =>
      current ? { ...current, [key]: value } : current
    )
  }

  const save = async (): Promise<DocumentParsingSnapshot | undefined> => {
    const api = window.goodbuddy.documentParsing
    if (!api || !draft) {
      return undefined
    }
    setSaving(true)
    setError(undefined)
    try {
      const next = await api.update(draft)
      setSnapshot(next)
      setDraft(next.settings)
      onNotify?.({
        tone: 'success',
        message: t('notifications.documentParsingSaved'),
        dedupeKey: 'document-parsing-saved'
      })
      return next
    } catch (reason) {
      setError(
        errorMessage(reason, t('errors.saveDocumentParsing'))
      )
      return undefined
    } finally {
      setSaving(false)
    }
  }

  const runModelOperation = async (
    modelId: string,
    operation: () => Promise<DocumentParsingSnapshot | undefined>,
    successMessage: string
  ): Promise<void> => {
    setBusyModelId(modelId)
    setConfirmingRemove(undefined)
    setError(undefined)
    try {
      const next = await operation()
      if (next && mountedRef.current) {
        setSnapshot(next)
        onNotify?.({
          tone: 'success',
          message: successMessage,
          dedupeKey: `document-ocr-model-${modelId}`
        })
      }
    } catch (reason) {
      if (mountedRef.current) {
        setError(
          errorMessage(
            reason,
            t('errors.manageDocumentOcrModel')
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setBusyModelId(undefined)
        void refresh().catch(() => undefined)
      }
    }
  }

  const removeModel = async (modelId: string): Promise<void> => {
    const api = window.goodbuddy.documentParsing
    if (!api) {
      return
    }
    if (confirmingRemove !== modelId) {
      setConfirmingRemove(modelId)
      return
    }
    await runModelOperation(
      modelId,
      () => api.removeOcrModel(modelId),
      t('documentParsing.ocr.notifications.removed')
    )
  }

  const testParsing = async (
    purpose: DocumentParsingTestPurpose
  ): Promise<void> => {
    const api = window.goodbuddy.documentParsing
    if (!api) {
      setError(t('errors.documentParsingUnavailable'))
      return
    }
    setTestingPurpose(purpose)
    setError(undefined)
    try {
      const result = await api.test(purpose)
      if (result) {
        setDiagnostic(result)
        onNotify?.({
          tone: 'success',
          message: t('notifications.documentParsingTestSucceeded'),
          dedupeKey: 'document-parsing-test'
        })
      }
    } catch (reason) {
      setError(
        errorMessage(reason, t('errors.testDocumentParsing'))
      )
    } finally {
      setTestingPurpose(undefined)
    }
  }

  if (!snapshot || !draft) {
    const unavailableError = window.goodbuddy.documentParsing
      ? undefined
      : t('errors.documentParsingUnavailable')
    return (
      <>
        <SettingsCategoryHeader
          category="document-parsing"
          error={error ?? unavailableError}
        />
        {!error && !unavailableError && (
          <p className="settings-empty">Loading…</p>
        )}
      </>
    )
  }

  const model = snapshot.ocrModels.catalog.find(
    (entry) => entry.id === draft.localOcrModelId
  )
  const selectedModelInCatalog = model !== undefined
  const currentModelInCatalog = snapshot.ocrModels.catalog.some(
    (entry) => entry.id === snapshot.settings.localOcrModelId
  )
  const installedModel = snapshot.ocrModels.installed.find(
    (entry) => entry.id === draft.localOcrModelId
  )
  const modelOperation = snapshot.ocrModels.operations.find(
    (operation) => operation.modelId === draft.localOcrModelId
  )
  const modelProgress = modelOperation
    ? progressPercent(modelOperation)
    : undefined
  const pendingModelSelection =
    draft.localOcrModelId !== snapshot.settings.localOcrModelId
  const settingsDirty =
    JSON.stringify(draft) !== JSON.stringify(snapshot.settings)
  const selectedModelReady = installedModel !== undefined
  const invalidPendingModel =
    pendingModelSelection && !selectedModelReady
  const testing = testingPurpose !== undefined

  return (
    <>
      <SettingsCategoryHeader
        actions={
          <button
            className="primary-button"
            disabled={
              saving || testing || !settingsDirty || invalidPendingModel
            }
            onClick={() => void save()}
            type="button"
          >
            {saving
              ? t('actions.saving')
              : t('actions.saveSettings')}
          </button>
        }
        category="document-parsing"
        error={error}
      />
      {settingsDirty && (
        <p
          className="settings-notice"
          id="document-parsing-unsaved-notice"
        >
          {t('documentParsing.workflows.unsavedNotice')}
        </p>
      )}

      <section
        aria-labelledby="document-parsing-status-title"
        className="settings-section document-parsing-status"
      >
        <div className="settings-section__title">
          <ShieldCheck aria-hidden="true" size={17} />
          <div>
            <strong id="document-parsing-status-title">
              {t('documentParsing.status.title')}
            </strong>
            <small>{t('documentParsing.status.description')}</small>
          </div>
        </div>
        <div className="document-parsing-status__list">
          <StatusRow
            available={snapshot.status.nativeParsingAvailable}
            detail={t('documentParsing.status.nativeDetail')}
            label={t('documentParsing.status.native')}
          />
          <StatusRow
            available={snapshot.status.localOcr.available}
            detail={t(
              snapshot.status.localOcr.available
                ? 'documentParsing.status.ocrReady'
                : currentModelInCatalog
                  ? 'documentParsing.status.ocrUnavailable'
                  : 'documentParsing.ocr.selectedModelUnavailable'
            )}
            label={t('documentParsing.status.localOcrModel', {
              name: snapshot.status.localOcr.displayName
            })}
          />
          <StatusRow
            available={snapshot.status.conversionAvailable}
            detail={t(
              'documentParsing.status.conversionUnavailable'
            )}
            label={t('documentParsing.status.conversion')}
          />
        </div>
        <p className="settings-notice">
          {t('documentParsing.status.partialNotice')}
        </p>
      </section>

      <section
        aria-labelledby="document-parsing-workflows-title"
        className="settings-section document-parsing-workflows"
      >
        <div className="settings-section__title">
          <FileText aria-hidden="true" size={17} />
          <div>
            <strong id="document-parsing-workflows-title">
              {t('documentParsing.workflows.title')}
            </strong>
            <small>{t('documentParsing.workflows.description')}</small>
          </div>
        </div>
        <div className="document-parsing-grid">
          <div className="field">
            <label htmlFor="document-parsing-chat-workflow">
              {t('documentParsing.workflows.chat')}
            </label>
            <select
              aria-label={t('documentParsing.workflows.chat')}
              id="document-parsing-chat-workflow"
              onChange={(event) =>
                updateDraft(
                  'chatWorkflow',
                  event.target
                    .value as DocumentParsingSettings['chatWorkflow']
                )
              }
              value={draft.chatWorkflow}
            >
              <option value="auto">
                {t('documentParsing.workflows.chatOptions.auto')}
              </option>
              <option value="fast-text">
                {t('documentParsing.workflows.chatOptions.fastText')}
              </option>
              <option value="high-fidelity">
                {t(
                  'documentParsing.workflows.chatOptions.highFidelity'
                )}
              </option>
            </select>
            <small>
              {t(
                `documentParsing.workflows.chatDescriptions.${draft.chatWorkflow}`
              )}
            </small>
            <button
              aria-describedby={
                settingsDirty
                  ? 'document-parsing-unsaved-notice'
                  : undefined
              }
              className="secondary-button document-parsing-workflow-test"
              disabled={saving || testing || settingsDirty}
              onClick={() =>
                void testParsing('chat-attachment')
              }
              type="button"
            >
              <FileSearch aria-hidden="true" size={14} />
              {testingPurpose === 'chat-attachment'
                ? t('actions.testingParsing')
                : t('documentParsing.workflows.testChat')}
            </button>
          </div>
          <div className="field">
            <label htmlFor="document-parsing-knowledge-workflow">
              {t('documentParsing.workflows.knowledge')}
            </label>
            <select
              aria-label={t('documentParsing.workflows.knowledge')}
              id="document-parsing-knowledge-workflow"
              onChange={(event) =>
                updateDraft(
                  'knowledgeWorkflow',
                  event.target
                    .value as DocumentParsingSettings['knowledgeWorkflow']
                )
              }
              value={draft.knowledgeWorkflow}
            >
              <option value="complete-index">
                {t(
                  'documentParsing.workflows.knowledgeOptions.completeIndex'
                )}
              </option>
              <option value="fast-index">
                {t(
                  'documentParsing.workflows.knowledgeOptions.fastIndex'
                )}
              </option>
              <option value="high-fidelity">
                {t(
                  'documentParsing.workflows.knowledgeOptions.highFidelity'
                )}
              </option>
            </select>
            <small>
              {t(
                `documentParsing.workflows.knowledgeDescriptions.${draft.knowledgeWorkflow}`
              )}
            </small>
            <button
              aria-describedby={
                settingsDirty
                  ? 'document-parsing-unsaved-notice'
                  : undefined
              }
              className="secondary-button document-parsing-workflow-test"
              disabled={saving || testing || settingsDirty}
              onClick={() =>
                void testParsing('knowledge-index')
              }
              type="button"
            >
              <FileSearch aria-hidden="true" size={14} />
              {testingPurpose === 'knowledge-index'
                ? t('actions.testingParsing')
                : t('documentParsing.workflows.testKnowledge')}
            </button>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="document-parsing-ocr-title"
        className="settings-section document-ocr-settings"
      >
        <div className="settings-section__title settings-section__title--actions">
          <ScanText aria-hidden="true" size={17} />
          <div>
            <strong id="document-parsing-ocr-title">
              {t('documentParsing.ocr.title')}
            </strong>
            <small>{t('documentParsing.ocr.description')}</small>
          </div>
          <button
            className="secondary-button"
            onClick={() =>
              void window.goodbuddy.documentParsing
                ?.openOcrModelsDirectory()
            }
            type="button"
          >
            <FolderOpen aria-hidden="true" size={13} />
            {t('documentParsing.ocr.openModelsDirectory')}
          </button>
        </div>

        <label className="field document-ocr-model-selector">
          <span>{t('documentParsing.ocr.modelSelector')}</span>
          <select
            aria-label={t('documentParsing.ocr.modelSelector')}
            onChange={(event) =>
              updateDraft('localOcrModelId', event.target.value)
            }
            value={draft.localOcrModelId}
          >
            {!selectedModelInCatalog && (
              <option value={draft.localOcrModelId}>
                {draft.localOcrModelId} ·{' '}
                {t('documentParsing.ocr.unavailableOption')}
              </option>
            )}
            {snapshot.ocrModels.catalog.map((entry) => {
              const installed = snapshot.ocrModels.installed.some(
                (candidate) => candidate.id === entry.id
              )
              return (
                <option key={entry.id} value={entry.id}>
                  {entry.displayName} ·{' '}
                  {installed
                    ? t('documentParsing.ocr.installedOption')
                    : t('documentParsing.ocr.downloadableOption')}
                </option>
              )
            })}
          </select>
          <small>
            {invalidPendingModel
              ? t('documentParsing.ocr.installBeforeSelecting')
              : pendingModelSelection
              ? t('documentParsing.ocr.pendingSelection')
              : t('documentParsing.ocr.modelSelectorDescription')}
          </small>
        </label>

        <p className="settings-notice document-ocr-settings__storage">
          {t('documentParsing.ocr.storagePrefix')}{' '}
          <code>{snapshot.ocrModels.rootDirectory}</code>
          {t('documentParsing.ocr.storageSuffix')}
        </p>

        {model ? (
          <article className="document-ocr-model">
            <div className="document-ocr-model__header">
              <div className="document-ocr-model__summary">
                <div className="document-ocr-model__name">
                  <strong>{model.displayName}</strong>
                  {model.recommended && (
                    <span className="speech-model-tag speech-model-tag--recommended">
                      {t('documentParsing.ocr.recommended')}
                    </span>
                  )}
                </div>
                <p>{model.description}</p>
                <div className="document-ocr-model__tags">
                  <span className="speech-model-tag">ModelScope</span>
                  <span className="speech-model-tag">
                    {model.languages.join(' / ')}
                  </span>
                  <span className="speech-model-tag">
                    {model.runtime}
                  </span>
                  <span className="speech-model-tag">
                    {t('documentParsing.ocr.quality.label', {
                      value: t(
                        `documentParsing.ocr.quality.values.${model.quality}`
                      )
                    })}
                  </span>
                  <span className="speech-model-tag">
                    {t('documentParsing.ocr.speed.label', {
                      value: t(
                        `documentParsing.ocr.speed.values.${model.speed}`
                      )
                    })}
                  </span>
                  <span className="speech-model-tag">
                    {formatBytes(catalogSize(model))}
                  </span>
                  <span className="speech-model-tag">
                    {model.license.name}
                  </span>
                </div>
              </div>
              <button
                aria-label={t(
                  'documentParsing.ocr.accessibility.openRepository',
                  { name: model.displayName }
                )}
                className="secondary-button document-ocr-model__repository"
                onClick={() =>
                  void window.goodbuddy.documentParsing
                    ?.openOcrModelRepository(model.id)
                }
                type="button"
              >
                <ExternalLink aria-hidden="true" size={13} />
                {t('documentParsing.ocr.openRepository')}
              </button>
            </div>

            {(modelOperation || installedModel) && (
              <div className="document-ocr-model__state">
                <span
                  className={`document-ocr-model__status${
                    installedModel
                      ? ' document-ocr-model__status--installed'
                      : ''
                  }`}
                >
                  {installedModel && (
                    <CheckCircle2 aria-hidden="true" size={13} />
                  )}
                  {modelOperation
                    ? t(
                        modelOperation.phase === 'installing'
                          ? 'documentParsing.ocr.operations.installing'
                          : modelOperation.kind === 'import'
                            ? 'documentParsing.ocr.operations.importing'
                            : 'documentParsing.ocr.operations.downloading'
                      )
                    : t('documentParsing.ocr.installed')}
                </span>
              </div>
            )}

            <div className="document-ocr-model__actions">
              {modelOperation ? (
                <button
                  aria-label={t(
                    'documentParsing.ocr.accessibility.cancelOperation',
                    { name: model.displayName }
                  )}
                  className="secondary-button"
                  onClick={() =>
                    void window.goodbuddy.documentParsing
                      ?.cancelOcrModelOperation(model.id)
                      .then(() => refresh())
                  }
                  type="button"
                >
                  <Square aria-hidden="true" size={12} />
                  {t('documentParsing.ocr.cancel')}
                </button>
              ) : installedModel ? (
                <>
                  <button
                    aria-label={t(
                      'documentParsing.ocr.accessibility.exportModelZip',
                      { name: model.displayName }
                    )}
                    className="secondary-button"
                    disabled={busyModelId === model.id}
                    onClick={() =>
                      void runModelOperation(
                        model.id,
                        () =>
                          window.goodbuddy.documentParsing!
                            .exportOcrModelArchive(model.id),
                        t(
                          'documentParsing.ocr.notifications.exportedZip',
                          { name: model.displayName }
                        )
                      )
                    }
                    type="button"
                  >
                    <Download aria-hidden="true" size={13} />
                    {t('documentParsing.ocr.exportZip')}
                  </button>
                  <button
                    aria-label={t(
                      'documentParsing.ocr.accessibility.deleteModel',
                      { name: model.displayName }
                    )}
                    className={
                      confirmingRemove === model.id
                        ? 'danger-button'
                        : 'danger-ghost'
                    }
                    disabled={busyModelId === model.id}
                    onClick={() => void removeModel(model.id)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={12} />
                    {confirmingRemove === model.id
                      ? t('documentParsing.ocr.confirmDelete')
                      : t('documentParsing.ocr.delete')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    aria-label={t(
                      'documentParsing.ocr.accessibility.downloadModel',
                      { name: model.displayName }
                    )}
                    className="primary-button"
                    disabled={busyModelId === model.id}
                    onClick={() =>
                      void runModelOperation(
                        model.id,
                        async () => {
                          const installed =
                            await window.goodbuddy.documentParsing!
                              .installOcrModel(model.id)
                          if (!pendingModelSelection) {
                            return installed
                          }
                          return window.goodbuddy.documentParsing!
                            .update(draft)
                        },
                        t(
                          pendingModelSelection
                            ? 'documentParsing.ocr.notifications.installedAndSelected'
                            : 'documentParsing.ocr.notifications.installed',
                          { name: model.displayName }
                        )
                      )
                    }
                    type="button"
                  >
                    <Download aria-hidden="true" size={13} />
                    {pendingModelSelection
                      ? t('documentParsing.ocr.downloadAndSelect')
                      : t('documentParsing.ocr.download')}
                  </button>
                  <button
                    aria-label={t(
                      'documentParsing.ocr.accessibility.importModelZip',
                      { name: model.displayName }
                    )}
                    className="secondary-button"
                    disabled={busyModelId === model.id}
                    onClick={() =>
                      void runModelOperation(
                        model.id,
                        async () => {
                          const imported =
                            await window.goodbuddy.documentParsing!
                              .importOcrModelArchive(model.id)
                          if (!imported || !pendingModelSelection) {
                            return imported
                          }
                          return window.goodbuddy.documentParsing!
                            .update(draft)
                        },
                        t(
                          pendingModelSelection
                            ? 'documentParsing.ocr.notifications.importedAndSelected'
                            : 'documentParsing.ocr.notifications.importedZip',
                          { name: model.displayName }
                        )
                      )
                    }
                    type="button"
                  >
                    <Upload aria-hidden="true" size={13} />
                    {t('documentParsing.ocr.importZip')}
                  </button>
                </>
              )}
            </div>

            {modelOperation && (
              <div
                aria-live="polite"
                className="document-ocr-model__operation"
              >
                <progress
                  aria-label={t(
                    'documentParsing.ocr.accessibility.downloadProgress',
                    { name: model.displayName }
                  )}
                  max={100}
                  {...(modelProgress === undefined
                    ? {}
                    : { value: modelProgress })}
                />
                <small>
                  {modelOperation.currentFile ??
                    t('documentParsing.ocr.operations.preparing')}
                  {modelProgress === undefined
                    ? ''
                    : ` · ${modelProgress.toFixed(0)}%`}
                </small>
              </div>
            )}
          </article>
        ) : (
          <p className="settings-warning">
            {t(
              snapshot.ocrModels.catalog.length === 0
                ? 'documentParsing.ocr.catalogUnavailable'
                : 'documentParsing.ocr.selectedModelUnavailable'
            )}
          </p>
        )}

        <p className="settings-notice">
          {t('documentParsing.ocr.privacyNotice')}
        </p>
      </section>

      <details className="settings-section">
        <summary>{t('documentParsing.advanced.title')}</summary>
        <div className="document-parsing-grid">
          <label className="field">
            <span>{t('documentParsing.advanced.maximumPages')}</span>
            <input
              max={500}
              min={1}
              onChange={(event) =>
                updateDraft(
                  'maximumPages',
                  Number(event.target.value)
                )
              }
              type="number"
              value={draft.maximumPages}
            />
          </label>
          <label className="field">
            <span>{t('documentParsing.advanced.timeout')}</span>
            <input
              max={300}
              min={10}
              onChange={(event) =>
                updateDraft(
                  'pageTimeoutSeconds',
                  Number(event.target.value)
                )
              }
              type="number"
              value={draft.pageTimeoutSeconds}
            />
          </label>
        </div>
        <small>{t('documentParsing.advanced.description')}</small>
      </details>

      {diagnostic && (
        <DiagnosticDialog
          diagnostic={diagnostic}
          onClose={() => setDiagnostic(undefined)}
        />
      )}
    </>
  )
}
