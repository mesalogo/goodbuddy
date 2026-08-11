import {
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  Mic,
  Square,
  Trash2,
  Upload
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  SpeechModelCatalogEntry,
  SpeechModelOperation,
  SpeechModelSnapshot
} from '../../shared/speech-model-contracts'
import type { AppNotificationInput } from './notifications'

type SpeechModelSettingsSectionProps = {
  onNotify?: (notification: AppNotificationInput) => void
  persistedSelectedModelId?: string | null
  selectedModelId?: string | null
  onSelectedModelIdChange?: (
    modelId: string,
    changed: boolean
  ) => void
  onSelectionInvalidated?: (modelId: string | null) => void
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function catalogSize(entry: SpeechModelCatalogEntry): number | undefined {
  const downloads = entry.files.map((file) => file.download)
  return downloads.every(Boolean)
    ? downloads.reduce(
        (total, download) => total + (download?.size ?? 0),
        0
      )
    : undefined
}

function progressPercent(operation: SpeechModelOperation): number | undefined {
  return operation.totalBytes && operation.totalBytes > 0
    ? Math.min(
        100,
        (operation.completedBytes / operation.totalBytes) * 100
      )
    : undefined
}

function operationLabel(
  operation: SpeechModelOperation,
  t: TFunction<'settingsSections'>
): string {
  if (operation.phase === 'installing') {
    return t('speech.operations.installing')
  }
  if (operation.phase === 'preparing') {
    return operation.kind === 'import'
      ? t('speech.operations.preparingImport')
      : t('speech.operations.preparingDownload')
  }
  return operation.kind === 'import'
    ? t('speech.operations.importing')
    : t('speech.operations.downloading')
}

export function SpeechModelSettingsSection({
  onNotify,
  persistedSelectedModelId,
  selectedModelId,
  onSelectedModelIdChange,
  onSelectionInvalidated
}: SpeechModelSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [snapshot, setSnapshot] = useState<SpeechModelSnapshot>()
  const [localSelectedModelId, setLocalSelectedModelId] = useState<
    string | null | undefined
  >()
  const [viewedModelId, setViewedModelId] = useState<string>()
  const [busyModelId, setBusyModelId] = useState<string>()
  const [confirmingRemove, setConfirmingRemove] = useState<string>()
  const [error, setError] = useState<string>()
  const mountedRef = useRef(false)
  const synchronizedSelectionRef = useRef<string | null | undefined>(
    undefined
  )

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.goodbuddy.speechModels
    if (!api) {
      throw new Error(t('speech.errors.serviceUnavailable'))
    }
    const next = await api.getSnapshot()
    if (mountedRef.current) {
      setSnapshot(next)
    }
  }, [t])

  useEffect(() => {
    const api = window.goodbuddy.speechModels
    let active = true
    mountedRef.current = true
    void (async () => {
      if (!api) {
        throw new Error(t('speech.errors.serviceUnavailable'))
      }
      return api.getSnapshot()
    })()
      .then((next) => {
        if (active) {
          setSnapshot(next)
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : t('speech.errors.readFailed')
          )
        }
      })
    return () => {
      active = false
      mountedRef.current = false
    }
  }, [t])

  const shouldPoll =
    busyModelId !== undefined || Boolean(snapshot?.operations.length)

  useEffect(() => {
    if (!shouldPoll) {
      return
    }
    let active = true
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      await refresh().catch(() => undefined)
      if (active) {
        timer = window.setTimeout(poll, 750)
      }
    }
    timer = window.setTimeout(poll, 750)
    return () => {
      active = false
      if (timer !== undefined) {
        window.clearTimeout(timer)
      }
    }
  }, [refresh, shouldPoll])

  const run = async (
    modelId: string,
    operation: () => Promise<SpeechModelSnapshot | undefined>,
    successMessage: string,
    selectAfterSuccess = false
  ): Promise<void> => {
    setBusyModelId(modelId)
    setError(undefined)
    try {
      const next = await operation()
      if (next && mountedRef.current) {
        setSnapshot(next)
        const draftSelectedModelId =
          selectedModelId === undefined
            ? localSelectedModelId
            : selectedModelId
        if (
          selectAfterSuccess &&
          next.installed.some((model) => model.id === modelId)
        ) {
          const effectivePersistedModelId =
            persistedSelectedModelId === undefined
              ? next.selectedModelId
              : persistedSelectedModelId
          setLocalSelectedModelId(modelId)
          onSelectedModelIdChange?.(
            modelId,
            modelId !== effectivePersistedModelId
          )
        } else if (
          draftSelectedModelId &&
          !next.installed.some(
            (model) => model.id === draftSelectedModelId
          )
        ) {
          setLocalSelectedModelId(next.selectedModelId)
          onSelectionInvalidated?.(next.selectedModelId)
        }
        onNotify?.({
          tone: 'success',
          message: successMessage,
          dedupeKey: `speech-model-${modelId}`
        })
      }
    } catch (reason) {
      if (mountedRef.current) {
        setError(
          reason instanceof Error
            ? reason.message
            : t('speech.errors.operationFailed')
        )
      }
    } finally {
      if (mountedRef.current) {
        setBusyModelId(undefined)
        void refresh().catch(() => undefined)
      }
    }
  }

  const remove = async (modelId: string): Promise<void> => {
    const api = window.goodbuddy.speechModels
    if (!api) {
      return
    }
    if (confirmingRemove !== modelId) {
      setConfirmingRemove(modelId)
      return
    }
    setConfirmingRemove(undefined)
    await run(
      modelId,
      () => api.remove(modelId),
      t('speech.notifications.removed')
    )
  }

  const draftSelectedModelId =
    selectedModelId === undefined
      ? localSelectedModelId
      : selectedModelId
  const effectiveSelectedModelId =
    draftSelectedModelId === undefined
      ? snapshot?.selectedModelId
      : draftSelectedModelId

  useEffect(() => {
    if (
      !snapshot ||
      effectiveSelectedModelId === undefined ||
      synchronizedSelectionRef.current === effectiveSelectedModelId
    ) {
      return
    }
    synchronizedSelectionRef.current = effectiveSelectedModelId
    setViewedModelId(effectiveSelectedModelId ?? undefined)
  }, [effectiveSelectedModelId, snapshot])

  if (!snapshot) {
    return (
      <div className="settings-section">
        <p className={error ? 'settings-warning' : 'settings-empty'}>
          {error ?? t('speech.loading')}
        </p>
      </div>
    )
  }

  const installedById = new Map(
    snapshot.installed.map((model) => [model.id, model])
  )
  const operationsById = new Map(
    snapshot.operations.map((operation) => [
      operation.modelId,
      operation
    ])
  )
  const effectivePersistedModelId =
    persistedSelectedModelId === undefined
      ? snapshot.selectedModelId
      : persistedSelectedModelId
  const model =
    snapshot.catalog.find((entry) => entry.id === viewedModelId) ??
    snapshot.catalog.find((entry) => operationsById.has(entry.id)) ??
    snapshot.catalog.find(
      (entry) => entry.id === effectiveSelectedModelId
    ) ??
    snapshot.catalog[0]
  const displayName = model
    ? t(`speech.catalog.${model.id}.displayName`, {
        defaultValue: model.displayName
      })
    : ''
  const description = model
    ? t(`speech.catalog.${model.id}.description`, {
        defaultValue: model.description
      })
    : ''
  const installed = model
    ? installedById.get(model.id)
    : undefined
  const operation = model
    ? operationsById.get(model.id)
    : undefined
  const percent = operation
    ? progressPercent(operation)
    : undefined
  const size = model ? catalogSize(model) : undefined
  const selected = model?.id === effectiveSelectedModelId
  const inUse = model?.id === effectivePersistedModelId
  const pendingSelection =
    Boolean(selected) &&
    draftSelectedModelId !== undefined &&
    draftSelectedModelId !== effectivePersistedModelId
  const status = operation
    ? operationLabel(operation, t)
    : pendingSelection
      ? t('speech.status.pendingSave')
      : inUse
        ? t('speech.status.inUse')
        : installed
          ? t('speech.status.installed')
          : model?.manualOnly
            ? t('speech.status.manualImport')
            : t('speech.status.availableToDownload')

  return (
    <section
      aria-labelledby="speech-model-settings-heading"
      className="settings-section speech-model-settings"
    >
      <div className="settings-section__title settings-section__title--actions">
        <Mic aria-hidden="true" size={17} />
        <div>
          <strong id="speech-model-settings-heading">
            {t('speech.title')}
          </strong>
          <small>{t('speech.description')}</small>
        </div>
        <button
          className="secondary-button"
          onClick={() =>
            void window.goodbuddy.speechModels?.openModelsDirectory()
          }
          type="button"
        >
          <FolderOpen aria-hidden="true" size={13} />
          {t('speech.openModelsDirectory')}
        </button>
      </div>

      <p className="settings-notice">
        {t('speech.storagePrefix')}{' '}
        <code>{snapshot.rootDirectory}</code>
        {t('speech.storageSuffix')}
      </p>
      {error && <p className="settings-warning" role="alert">{error}</p>}

      <label className="field document-ocr-model-selector">
        <span>{t('speech.modelSelector')}</span>
        <select
          aria-label={t('speech.modelSelector')}
          onChange={(event) => {
            const modelId = event.target.value
            setViewedModelId(modelId)
            if (installedById.has(modelId)) {
              setLocalSelectedModelId(modelId)
              onSelectedModelIdChange?.(
                modelId,
                modelId !== effectivePersistedModelId
              )
            }
          }}
          value={model?.id ?? ''}
        >
          {snapshot.catalog.map((entry) => {
            const optionName = t(
              'speech.catalog.' + entry.id + '.displayName',
              { defaultValue: entry.displayName }
            )
            return (
              <option key={entry.id} value={entry.id}>
                {optionName} ·{' '}
                {installedById.has(entry.id)
                  ? t('speech.status.installed')
                  : t('speech.status.availableToDownload')}
              </option>
            )
          })}
        </select>
        <small>
          {pendingSelection
            ? t('speech.pendingSelection')
            : installed
              ? t('speech.modelSelectorDescription')
              : t('speech.modelSelectorDownloadDescription')}
        </small>
      </label>

      {model ? (
        <article className="document-ocr-model speech-model-card">
          <div className="document-ocr-model__header">
            <div className="document-ocr-model__summary">
              <div className="document-ocr-model__name">
                <strong>{displayName}</strong>
                {model.recommended && (
                  <span className="speech-model-tag speech-model-tag--recommended">
                    {t('speech.tags.recommended')}
                  </span>
                )}
                <button
                  aria-label={t(
                    'speech.accessibility.openRepository',
                    { name: displayName }
                  )}
                  className="icon-button speech-model-card__repository"
                  onClick={() =>
                    void window.goodbuddy.speechModels?.openRepository(
                      model.id
                    )
                  }
                  title={t(
                    'speech.accessibility.openRepository',
                    { name: displayName }
                  )}
                  type="button"
                >
                  <ExternalLink aria-hidden="true" size={13} />
                </button>
              </div>
              <p>{description}</p>
              <div className="document-ocr-model__tags">
                <span className="speech-model-tag">
                  {t('speech.family.' + model.family)}
                </span>
                <span className="speech-model-tag">
                  {model.languages
                    .map((language) =>
                      t('speech.languages.' + language, {
                        defaultValue: language
                      })
                    )
                    .join(' / ')}
                </span>
                <span className="speech-model-tag">
                  {model.quantization.toUpperCase()}
                </span>
                <span className="speech-model-tag">
                  {t('speech.quality.' + model.quality)}
                </span>
                <span className="speech-model-tag">
                  {t('speech.speed.' + model.speed)}
                </span>
                <span className="speech-model-tag">
                  {size
                    ? formatBytes(size)
                    : t('speech.status.unknownSize')}
                </span>
                <span className="speech-model-tag">
                  {model.license.name}
                </span>
              </div>
            </div>
          </div>

          <div className="document-ocr-model__state">
            <span
              className={
                'document-ocr-model__status' +
                (installed
                  ? ' document-ocr-model__status--installed'
                  : '')
              }
            >
              {installed && <CheckCircle2 aria-hidden="true" size={13} />}
              {status}
            </span>
          </div>

          <div className="document-ocr-model__actions">
            {operation ? (
              <button
                aria-label={t('speech.accessibility.cancelOperation', {
                  name: displayName
                })}
                className="secondary-button"
                onClick={() =>
                  void window.goodbuddy.speechModels
                    ?.cancel(model.id)
                    .then(() => refresh())
                }
                type="button"
              >
                <Square aria-hidden="true" size={12} />
                {t('speech.actions.cancel')}
              </button>
            ) : installed ? (
              <>
                <button
                  aria-label={t(
                    'speech.accessibility.exportModelZip',
                    { name: displayName }
                  )}
                  className="secondary-button"
                  disabled={busyModelId === model.id}
                  onClick={() =>
                    void run(
                      model.id,
                      () =>
                        window.goodbuddy.speechModels!
                          .exportArchive(model.id),
                      t('speech.notifications.exportedZip', {
                        name: displayName
                      })
                    )
                  }
                  type="button"
                >
                  <Download aria-hidden="true" size={13} />
                  {t('speech.actions.exportZip')}
                </button>
                <button
                  aria-label={t('speech.accessibility.deleteModel', {
                    name: displayName
                  })}
                  className={
                    confirmingRemove === model.id
                      ? 'danger-button'
                      : 'danger-ghost'
                  }
                  disabled={busyModelId === model.id}
                  onClick={() => void remove(model.id)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={12} />
                  {confirmingRemove === model.id
                    ? t('speech.actions.confirmDelete')
                    : t('speech.actions.delete')}
                </button>
              </>
            ) : (
              <>
                {!model.manualOnly && (
                  <button
                    aria-label={t(
                      'speech.accessibility.downloadModel',
                      { name: displayName }
                    )}
                    className="primary-button"
                    disabled={busyModelId === model.id}
                    onClick={() =>
                      void run(
                        model.id,
                        () =>
                          window.goodbuddy.speechModels!.install(
                            model.id
                          ),
                        t('speech.notifications.installed', {
                          name: displayName
                        }),
                        true
                      )
                    }
                    type="button"
                  >
                    <Download aria-hidden="true" size={13} />
                    {t('speech.actions.download')}
                  </button>
                )}
                <button
                  aria-label={t(
                    'speech.accessibility.importModelZip',
                    { name: displayName }
                  )}
                  className="secondary-button"
                  disabled={busyModelId === model.id}
                  onClick={() =>
                    void run(
                      model.id,
                      () =>
                        window.goodbuddy.speechModels!.importArchive(
                          model.id
                        ),
                      t('speech.notifications.importedZip', {
                        name: displayName
                      }),
                      true
                    )
                  }
                  type="button"
                >
                  <Upload aria-hidden="true" size={13} />
                  {t('speech.actions.importZip')}
                </button>
              </>
            )}
          </div>

          {operation && (
            <div
              aria-live="polite"
              className="document-ocr-model__operation"
            >
              <progress
                aria-label={t(
                  'speech.accessibility.downloadProgress',
                  { name: displayName }
                )}
                max={100}
                {...(percent === undefined ? {} : { value: percent })}
              />
              <small>
                {operation.currentFile
                  ? t('speech.operations.processingFile', {
                      file: operation.currentFile
                    })
                  : operationLabel(operation, t) + '…'}
                {percent === undefined
                  ? ''
                  : ' · ' + percent.toFixed(0) + '%'}
              </small>
            </div>
          )}
        </article>
      ) : (
        <p className="settings-warning">
          {t('speech.catalogUnavailable')}
        </p>
      )}
    </section>
  )
}
