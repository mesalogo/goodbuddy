import {
  CheckCircle2,
  ChevronDown,
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
  const [busyModelId, setBusyModelId] = useState<string>()
  const [confirmingRemove, setConfirmingRemove] = useState<string>()
  const [error, setError] = useState<string>()
  const mountedRef = useRef(false)

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
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined)
    }, 300)
    return () => window.clearInterval(timer)
  }, [refresh, shouldPoll])

  const run = async (
    modelId: string,
    operation: () => Promise<SpeechModelSnapshot | undefined>,
    successMessage: string
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

      <div
        aria-label={t('speech.availableModels')}
        className="speech-model-settings__list"
        role="list"
      >
        {snapshot.catalog.map((entry) => {
          const displayName = t(
            `speech.catalog.${entry.id}.displayName`,
            { defaultValue: entry.displayName }
          )
          const description = t(
            `speech.catalog.${entry.id}.description`,
            { defaultValue: entry.description }
          )
          const installed = installedById.get(entry.id)
          const operation = operationsById.get(entry.id)
          const percent = operation
            ? progressPercent(operation)
            : undefined
          const size = catalogSize(entry)
          const draftSelectedModelId =
            selectedModelId === undefined
              ? localSelectedModelId
              : selectedModelId
          const effectiveSelectedModelId =
            draftSelectedModelId === undefined
              ? snapshot.selectedModelId
              : draftSelectedModelId
          const selected = effectiveSelectedModelId === entry.id
          const effectivePersistedModelId =
            persistedSelectedModelId === undefined
              ? snapshot.selectedModelId
              : persistedSelectedModelId
          const inUse = effectivePersistedModelId === entry.id
          const pendingSelection =
            selected &&
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
                : entry.manualOnly
                  ? t('speech.status.manualImport')
                  : t('speech.status.availableToDownload')
          return (
            <article
              className={`speech-model-row${selected ? ' speech-model-row--selected' : ''}`}
              key={entry.id}
              role="listitem"
            >
              <div className="speech-model-row__selection">
                <input
                  aria-label={
                    installed
                      ? t('speech.accessibility.selectModel', {
                          name: displayName
                        })
                      : t('speech.accessibility.notInstalled', {
                          name: displayName
                        })
                  }
                  checked={selected}
                  disabled={!installed || operation !== undefined}
                  name="selected-speech-model"
                  onChange={() => {
                    setLocalSelectedModelId(entry.id)
                    onSelectedModelIdChange?.(
                      entry.id,
                      entry.id !== effectivePersistedModelId
                    )
                  }}
                  type="radio"
                />
              </div>

              <div className="speech-model-row__summary">
                <div className="speech-model-row__name">
                  <strong>{displayName}</strong>
                  {entry.recommended && (
                    <span className="speech-model-tag speech-model-tag--recommended">
                      {t('speech.tags.recommended')}
                    </span>
                  )}
                </div>
                <p>{description}</p>
                <div className="speech-model-row__tags">
                  <span className="speech-model-tag">
                    {t(`speech.family.${entry.family}`)}
                  </span>
                  <span className="speech-model-tag">
                    {entry.languages
                      .map((language) =>
                        t(`speech.languages.${language}`, {
                          defaultValue: language
                        })
                      )
                      .join(' / ')}
                  </span>
                  <span className="speech-model-tag">
                    {entry.quantization.toUpperCase()}
                  </span>
                </div>
              </div>

              <div className="speech-model-row__profile">
                <span>{t(`speech.quality.${entry.quality}`)}</span>
                <span>{t(`speech.speed.${entry.speed}`)}</span>
                <span>
                  {size ? formatBytes(size) : t('speech.status.unknownSize')}
                </span>
              </div>

              <div className="speech-model-row__state">
                <span
                  className={`speech-model-status${
                    selected || inUse
                      ? ' speech-model-status--selected'
                      : installed
                        ? ' speech-model-status--installed'
                        : ''
                  }`}
                >
                  {inUse && <CheckCircle2 aria-hidden="true" size={13} />}
                  {status}
                </span>
              </div>

              <div className="speech-model-row__actions">
                {operation ? (
                  <button
                    aria-label={t('speech.accessibility.cancelOperation', {
                      name: displayName
                    })}
                    className="secondary-button"
                    onClick={() =>
                      void window.goodbuddy.speechModels
                        ?.cancel(entry.id)
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
                      disabled={busyModelId === entry.id}
                      onClick={() =>
                        void run(
                          entry.id,
                          () =>
                            window.goodbuddy.speechModels!
                              .exportArchive(entry.id),
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
                        confirmingRemove === entry.id
                          ? 'danger-button'
                          : 'danger-ghost'
                      }
                      disabled={busyModelId === entry.id}
                      onClick={() => void remove(entry.id)}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={12} />
                      {confirmingRemove === entry.id
                        ? t('speech.actions.confirmDelete')
                        : t('speech.actions.delete')}
                    </button>
                  </>
                ) : (
                  <>
                    {!entry.manualOnly && (
                      <button
                        aria-label={t(
                          'speech.accessibility.downloadModel',
                          { name: displayName }
                        )}
                        className="primary-button"
                        disabled={busyModelId === entry.id}
                        onClick={() =>
                          void run(
                            entry.id,
                            () =>
                              window.goodbuddy.speechModels!.install(
                                entry.id
                              ),
                            t('speech.notifications.installed', {
                              name: displayName
                            })
                          )
                        }
                        type="button"
                      >
                        <Download aria-hidden="true" size={13} />
                        {t('speech.actions.download')}
                      </button>
                    )}
                    <button
                      aria-label={t('speech.accessibility.importModelZip', {
                        name: displayName
                      })}
                      className="secondary-button"
                      disabled={busyModelId === entry.id}
                      onClick={() =>
                        void run(
                          entry.id,
                          () =>
                            window.goodbuddy.speechModels!
                              .importArchive(entry.id),
                          t('speech.notifications.importedZip', {
                            name: displayName
                          })
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
                <div aria-live="polite" className="speech-model-operation">
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
                      : `${operationLabel(operation, t)}…`}
                    {percent === undefined
                      ? ''
                      : ` · ${percent.toFixed(0)}%`}
                  </small>
                </div>
              )}

              <details className="speech-model-row__details">
                <summary>
                  <ChevronDown aria-hidden="true" size={13} />
                  {t('speech.actions.modelDetails')}
                </summary>
                <div>
                  {entry.manualOnly &&
                    entry.manualReason &&
                    !installed && (
                      <p>{entry.manualReason}</p>
                    )}
                  <p>
                    {t('speech.details.license')}
                    <strong>{entry.license.name}</strong>
                    {t('speech.details.licenseSeparator')}
                    {entry.license.notice}
                  </p>
                  <button
                    aria-label={t(
                      'speech.accessibility.openRepository',
                      { name: displayName }
                    )}
                    className="secondary-button"
                    onClick={() =>
                      void window.goodbuddy.speechModels?.openRepository(
                        entry.id
                      )
                    }
                    type="button"
                  >
                    <ExternalLink aria-hidden="true" size={13} />
                    {t('speech.actions.openRepository')}
                  </button>
                </div>
              </details>
            </article>
          )
        })}
      </div>
    </section>
  )
}
