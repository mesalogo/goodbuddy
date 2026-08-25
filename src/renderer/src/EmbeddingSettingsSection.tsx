import {
  Activity,
  CheckCircle2,
  Download,
  FlaskConical,
  Plus,
  Square,
  Trash2,
  Upload
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type {
  EmbeddingDiagnosticResult,
  EmbeddingModelSnapshot
} from '../../shared/embedding-contracts'
import { formatMediumDateTime } from './locale-formatters'
import {
  formatModelPackageBytes,
  modelOperationPercent
} from './model-download-presentation'

export interface EmbeddingConnectionPresentation {
  id: string
  name: string
  kind: 'builtin' | 'openai-compatible'
  model: string
  endpoint?: string
  authentication?: 'api-key' | 'none'
  apiKey?: string
  apiKeyConfigured?: boolean
  clearApiKey?: boolean
  statusText?: string
  installed?: boolean
}

export interface EmbeddingSettingsSectionProps {
  connections: readonly EmbeddingConnectionPresentation[]
  currentConnectionId: string
  selectedConnectionId?: string
  diagnostic?: EmbeddingDiagnosticResult | null
  diagnosticRunning?: boolean
  models?: EmbeddingModelSnapshot
  pendingOperation?: {
    modelId: string
    kind: EmbeddingModelSnapshot['operations'][number]['kind']
  }
  enabled: boolean
  secureStorageAvailable: boolean
  busy?: boolean
  onEnabledChange: (enabled: boolean) => void
  onAddConnection: () => void
  onSelectConnection: (connectionId: string) => void
  onSetCurrent: (connectionId: string) => void
  onUpdateConnection: (
    connectionId: string,
    changes: Partial<EmbeddingConnectionPresentation>
  ) => void
  onDeleteConnection: (connectionId: string) => void
  onDownloadBuiltin: (modelId: string) => void
  onCancelBuiltin: (modelId: string) => void
  onImportBuiltin: (modelId: string) => void
  onRemoveBuiltin: (modelId: string) => void
  onOpenModelDownloadSourceSettings?: () => void
  onTestConnection: (connectionId: string) => void
}

function operationLabel(
  operation: EmbeddingModelSnapshot['operations'][number],
  t: TFunction<'settingsSections'>
): string {
  if (operation.phase === 'installing') {
    return t('embedding.operations.installing')
  }
  if (operation.phase === 'preparing') {
    return operation.kind === 'import'
      ? t('embedding.operations.preparingImport')
      : t('embedding.operations.preparingDownloadFrom', {
          source: t(
            `modelDownloadSources.${operation.downloadSource}`
          )
        })
  }
  return operation.kind === 'import'
    ? t('embedding.operations.importing')
    : t('embedding.operations.downloadingFrom', {
        source: t(
          `modelDownloadSources.${operation.downloadSource}`
        )
      })
}

function embeddingEndpointDestination(endpoint: string | undefined):
  | { kind: 'local'; host: string }
  | { kind: 'network'; host: string }
  | undefined {
  if (!endpoint?.trim()) {
    return undefined
  }
  try {
    const url = new URL(endpoint)
    const hostname = url.hostname.toLowerCase()
    return {
      kind:
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]' ||
        hostname === '::1'
          ? 'local'
          : 'network',
      host: url.host
    }
  } catch {
    return undefined
  }
}

function DiagnosticResult({
  result
}: {
  result: EmbeddingDiagnosticResult
}): React.JSX.Element {
  const { i18n, t } = useTranslation('settingsSections')
  const locale = i18n.resolvedLanguage ?? i18n.language
  if (result.status === 'available') {
    return (
      <div aria-live="polite" className="capability-diagnostic__result">
        <strong>{t('embedding.diagnostic.success')}</strong>
        <p>
          {t('embedding.diagnostic.result', {
            dimensions: result.dimensions,
            latency: result.latencyMs
          })}
        </p>
        <small>
          {t('embedding.diagnostic.checkedAt', {
            date: formatMediumDateTime(result.checkedAt, locale)
          })}
        </small>
      </div>
    )
  }
  return (
    <div
      aria-live="assertive"
      className="capability-diagnostic__result"
      role="alert"
    >
      <strong>{t('embedding.diagnostic.failed')}</strong>
      <p>{result.error.message}</p>
      {result.error.remedy && (
        <p>
          {t('embedding.diagnostic.remedy', {
            remedy: result.error.remedy
          })}
        </p>
      )}
    </div>
  )
}

export function EmbeddingSettingsSection({
  connections,
  currentConnectionId,
  selectedConnectionId,
  diagnostic,
  diagnosticRunning = false,
  models,
  pendingOperation,
  enabled,
  secureStorageAvailable,
  busy = false,
  onEnabledChange,
  onAddConnection,
  onSelectConnection,
  onSetCurrent,
  onUpdateConnection,
  onDeleteConnection,
  onDownloadBuiltin,
  onCancelBuiltin,
  onImportBuiltin,
  onRemoveBuiltin,
  onOpenModelDownloadSourceSettings,
  onTestConnection
}: EmbeddingSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const selected =
    connections.find((connection) => connection.id === selectedConnectionId) ??
    connections.find((connection) => connection.id === currentConnectionId) ??
    connections[0]
  const selectedEndpointDestination =
    selected?.kind === 'openai-compatible'
      ? embeddingEndpointDestination(selected.endpoint)
      : undefined
  const selectedModel =
    selected?.kind === 'builtin'
      ? models?.catalog.find((model) => model.id === selected.model)
      : undefined
  const installedModel =
    selected?.kind === 'builtin'
      ? models?.installed.find((model) => model.id === selected.model)
      : undefined
  const activeOperation =
    selected?.kind === 'builtin'
      ? models?.operations.find(
          (operation) => operation.modelId === selected.model
        )
      : undefined
  const optimisticOperation =
    selected?.kind === 'builtin' &&
    !activeOperation &&
    pendingOperation?.modelId === selected.model
      ? {
          modelId: selected.model,
          kind: pendingOperation.kind,
          phase: 'preparing' as const,
          currentFile: null,
          completedBytes: 0,
          totalBytes: null,
          ...(pendingOperation.kind === 'download' && models
            ? { downloadSource: models.selectedDownloadSource }
            : {})
        }
      : undefined
  const operation = activeOperation ?? optimisticOperation
  const percent = operation
    ? modelOperationPercent(operation)
    : undefined
  const downloadAvailability = selectedModel?.downloadAvailability.find(
    (availability) =>
      availability.source === models?.selectedDownloadSource
  )
  const sourceAvailable =
    models === undefined ||
    (selectedModel !== undefined &&
      downloadAvailability?.available === true)
  const modelSize =
    installedModel?.files.reduce(
      (total, file) => total + file.size,
      0
    ) ??
    downloadAvailability?.totalBytes ??
    selectedModel?.files.reduce(
      (total, file) => total + file.size,
      0
    )
  const modelDisplayName = selectedModel?.displayName ?? selected?.name ?? ''
  const modelInstalled = Boolean(installedModel || selected?.installed)
  const modelStatus =
    operation
      ? operationLabel(operation, t)
      : modelInstalled
        ? t('embedding.status.installed')
        : selectedModel && !sourceAvailable
          ? t('embedding.status.sourceUnavailable')
          : selected?.statusText ??
            t('embedding.status.availableToDownload')

  return (
    <section
      aria-label={t('embedding.label')}
      className="embedding-settings settings-section"
    >
      <div className="settings-section__title settings-section__title--actions">
        <Activity aria-hidden="true" size={17} />
        <div>
          <strong>{t('embedding.title')}</strong>
          <small>{t('embedding.description')}</small>
        </div>
        <label className="toggle-row">
          <input
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
            role="switch"
            type="checkbox"
          />
          <span>{t('embedding.enabled')}</span>
        </label>
        <button
          className="secondary-button model-connection-add"
          onClick={onAddConnection}
          type="button"
        >
          <Plus aria-hidden="true" size={14} />
          {t('embedding.actions.addCustom')}
        </button>
      </div>

      <div className="model-connection-manager">
        <aside
          aria-label={t('embedding.connections.listLabel')}
          className="model-connection-list"
        >
          <div className="model-connection-list__header">
            <strong>{t('embedding.connections.heading')}</strong>
            <span>{connections.length}</span>
          </div>
          <div
            aria-label={t('embedding.connections.listLabel')}
            role="list"
          >
            {connections.map((connection) => (
              <div key={connection.id} role="listitem">
                <button
                  aria-current={
                    selected?.id === connection.id ? 'page' : undefined
                  }
                  aria-label={t('embedding.accessibility.select', {
                    name: connection.name
                  })}
                  onClick={() => onSelectConnection(connection.id)}
                  type="button"
                >
                  <span className="model-connection-list__name">
                    <strong>{connection.name}</strong>
                    <small>{connection.model}</small>
                  </span>
                  <span className="model-connection-list__badges">
                    {currentConnectionId === connection.id && (
                      <span>{t('embedding.connections.current')}</span>
                    )}
                  </span>
                </button>
              </div>
            ))}
          </div>
        </aside>

        {selected && (
          <div
            aria-labelledby={`embedding-connection-${selected.id}`}
            className="model-connection-detail"
          >
            <div className="settings-section__title">
              <div>
                <strong id={`embedding-connection-${selected.id}`}>
                  {selected.name}
                </strong>
                <small>
                  {t(`embedding.connections.types.${selected.kind}`)}
                </small>
              </div>
              <label className="check-field">
                <input
                  checked={currentConnectionId === selected.id}
                  disabled={!enabled}
                  name="current-embedding-connection"
                  onChange={() => onSetCurrent(selected.id)}
                  type="radio"
                />
                <span>{t('embedding.currentConnection')}</span>
              </label>
              {selected.kind === 'openai-compatible' && (
                <button
                  aria-label={t('embedding.accessibility.delete', {
                    name: selected.name
                  })}
                  className="danger-button danger-button--quiet"
                  onClick={() => onDeleteConnection(selected.id)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={14} />
                  {t('embedding.actions.delete')}
                </button>
              )}
            </div>

            {selected.kind === 'builtin' ? (
              <article className="document-ocr-model speech-model-card embedding-model-card">
                <div className="document-ocr-model__header">
                  <div className="document-ocr-model__summary">
                    <div className="document-ocr-model__name">
                      <strong>{modelDisplayName}</strong>
                      {selectedModel?.recommended && (
                        <span className="speech-model-tag speech-model-tag--recommended">
                          {t('embedding.tags.recommended')}
                        </span>
                      )}
                    </div>
                    {selectedModel?.description && (
                      <p>{selectedModel.description}</p>
                    )}
                    <div className="document-ocr-model__tags">
                      {models && (
                        <span className="speech-model-tag">
                          {t(
                            `modelDownloadSources.${models.selectedDownloadSource}`
                          )}
                        </span>
                      )}
                      <span className="speech-model-tag">
                        {selected.model}
                      </span>
                      {selectedModel && (
                        <>
                          <span className="speech-model-tag">
                            {t('embedding.metadata.dimensions', {
                              count: selectedModel.dimensions
                            })}
                          </span>
                          <span className="speech-model-tag">
                            {selectedModel.quantization.toUpperCase()}
                          </span>
                          <span className="speech-model-tag">
                            {t('embedding.metadata.contextTokens', {
                              count: selectedModel.contextTokens
                            })}
                          </span>
                          <span className="speech-model-tag">
                            {modelSize
                              ? formatModelPackageBytes(modelSize)
                              : t('embedding.status.unknownSize')}
                          </span>
                          <span className="speech-model-tag">
                            {selectedModel.license.name}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="document-ocr-model__state">
                  <span
                    className={
                      'document-ocr-model__status' +
                      (modelInstalled
                        ? ' document-ocr-model__status--installed'
                        : '')
                    }
                  >
                    {modelInstalled && (
                      <CheckCircle2 aria-hidden="true" size={13} />
                    )}
                    {modelStatus}
                  </span>
                </div>

                <div className="document-ocr-model__actions">
                  <button
                    aria-label={t('embedding.accessibility.test', {
                      name: selected.name
                    })}
                    className="secondary-button"
                    disabled={!enabled || busy || diagnosticRunning}
                    onClick={() => onTestConnection(selected.id)}
                    type="button"
                  >
                    <FlaskConical aria-hidden="true" size={13} />
                    {diagnosticRunning
                      ? t('embedding.diagnostic.testing')
                      : t('embedding.actions.test')}
                  </button>
                  {operation ? (
                    <button
                      aria-label={t('embedding.accessibility.cancel', {
                        name: modelDisplayName
                      })}
                      className="secondary-button"
                      onClick={() => onCancelBuiltin(selected.model)}
                      type="button"
                    >
                      <Square aria-hidden="true" size={12} />
                      {t('embedding.actions.cancel')}
                    </button>
                  ) : modelInstalled ? (
                    <button
                      aria-label={t('embedding.accessibility.remove', {
                        name: modelDisplayName
                      })}
                      className="danger-ghost"
                      disabled={busy}
                      onClick={() => onRemoveBuiltin(selected.model)}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={13} />
                      {t('embedding.actions.remove')}
                    </button>
                  ) : (
                    <>
                      {sourceAvailable && (
                        <button
                          aria-label={t(
                            'embedding.accessibility.download',
                            { name: modelDisplayName }
                          )}
                          className="primary-button"
                          disabled={busy}
                          onClick={() => onDownloadBuiltin(selected.model)}
                          type="button"
                        >
                          <Download aria-hidden="true" size={13} />
                          {t('embedding.actions.download')}
                        </button>
                      )}
                      {!sourceAvailable &&
                        onOpenModelDownloadSourceSettings && (
                          <button
                            className="secondary-button"
                            onClick={onOpenModelDownloadSourceSettings}
                            type="button"
                          >
                            {t(
                              'embedding.actions.openDownloadSourceSettings'
                            )}
                          </button>
                        )}
                      <button
                        aria-label={t('embedding.accessibility.import', {
                          name: modelDisplayName
                        })}
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => onImportBuiltin(selected.model)}
                        type="button"
                      >
                        <Upload aria-hidden="true" size={13} />
                        {t('embedding.actions.importZip')}
                      </button>
                    </>
                  )}
                </div>

                {!sourceAvailable && selectedModel && (
                  <p className="settings-warning">
                    {t('embedding.sourceUnavailableDescription', {
                      source: t(
                        `modelDownloadSources.${models?.selectedDownloadSource}`
                      )
                    })}
                  </p>
                )}

                {operation && (
                  <div
                    aria-live="polite"
                    className="document-ocr-model__operation"
                  >
                    <progress
                      aria-label={t(
                        operation.kind === 'import'
                          ? 'embedding.accessibility.importProgress'
                          : 'embedding.accessibility.downloadProgress',
                        { name: modelDisplayName }
                      )}
                      max={100}
                      {...(percent === undefined
                        ? {}
                        : { value: percent })}
                    />
                    <small>
                      {operation.currentFile
                        ? t('embedding.operations.processingFile', {
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
              <>
                <label className="field">
                  <span>{t('embedding.fields.name')}</span>
                  <input
                    onChange={(event) =>
                      onUpdateConnection(selected.id, {
                        name: event.target.value
                      })
                    }
                    value={selected.name}
                  />
                </label>
                <label className="field">
                  <span>{t('embedding.fields.endpoint')}</span>
                  <input
                    inputMode="url"
                    onChange={(event) =>
                      onUpdateConnection(selected.id, {
                        endpoint: event.target.value
                      })
                    }
                    value={selected.endpoint ?? ''}
                  />
                </label>
                {selectedEndpointDestination && (
                  <p
                    className={
                      selectedEndpointDestination.kind === 'network'
                        ? 'settings-warning'
                        : 'settings-notice'
                    }
                  >
                    {t(
                      `embedding.endpointDestination.${selectedEndpointDestination.kind}`,
                      { host: selectedEndpointDestination.host }
                    )}
                  </p>
                )}
                <label className="field">
                  <span>{t('embedding.fields.model')}</span>
                  <input
                    onChange={(event) =>
                      onUpdateConnection(selected.id, {
                        model: event.target.value
                      })
                    }
                    value={selected.model}
                  />
                </label>
                <label className="field">
                  <span>{t('embedding.fields.authentication')}</span>
                  <select
                    onChange={(event) =>
                      onUpdateConnection(selected.id, {
                        authentication: event.target
                          .value as EmbeddingConnectionPresentation['authentication'],
                        ...(event.target.value === 'none'
                          ? { apiKey: '', clearApiKey: true }
                          : {})
                      })
                    }
                    value={selected.authentication}
                  >
                    <option value="api-key">API Key</option>
                    <option value="none">
                      {t('embedding.fields.noAuthentication')}
                    </option>
                  </select>
                </label>
                {selected.authentication === 'api-key' && (
                  <>
                    <label className="field">
                      <span>{t('embedding.fields.apiKey')}</span>
                      <input
                        autoComplete="off"
                        disabled={!secureStorageAvailable}
                        onChange={(event) =>
                          onUpdateConnection(selected.id, {
                            apiKey: event.target.value,
                            clearApiKey: false
                          })
                        }
                        placeholder={
                          selected.apiKeyConfigured
                            ? t('embedding.fields.configuredPlaceholder')
                            : t('embedding.fields.apiKeyPlaceholder')
                        }
                        type="password"
                        value={selected.apiKey ?? ''}
                      />
                    </label>
                    {selected.apiKeyConfigured && (
                      <button
                        className="secondary-button"
                        onClick={() =>
                          onUpdateConnection(selected.id, {
                            apiKey: '',
                            clearApiKey: true
                          })
                        }
                        type="button"
                      >
                        {selected.clearApiKey
                          ? t('embedding.actions.clearAfterSave')
                          : t('embedding.actions.clearCredential')}
                      </button>
                    )}
                  </>
                )}
                <div className="runtime-config-actions">
                  <button
                    aria-label={t('embedding.accessibility.test', {
                      name: selected.name
                    })}
                    className="secondary-button"
                    disabled={!enabled || busy || diagnosticRunning}
                    onClick={() => onTestConnection(selected.id)}
                    type="button"
                  >
                    <FlaskConical aria-hidden="true" size={13} />
                    {diagnosticRunning
                      ? t('embedding.diagnostic.testing')
                      : t('embedding.actions.test')}
                  </button>
                </div>
              </>
            )}
            {diagnostic && <DiagnosticResult result={diagnostic} />}
          </div>
        )}
      </div>
    </section>
  )
}
