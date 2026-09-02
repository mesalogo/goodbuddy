import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  LocalToolEnvironmentSettings,
  LocalToolEnvironmentSnapshot,
  LocalToolKind,
  LocalToolRuntimeSelection
} from '../../shared/local-tool-environment-contracts'
import type { AppNotificationInput } from './notifications'
import { displayErrorMessage } from './error-message'

type ToolEnvironmentSettingsSectionProps = {
  onNotify?: (notification: AppNotificationInput) => void
}

function formatBytes(value: number): string {
  if (value < 1_024) {
    return `${value} B`
  }
  if (value < 1_024 * 1_024) {
    return `${(value / 1_024).toFixed(1)} KiB`
  }
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`
}

function isManagedPythonCancellation(reason: unknown): boolean {
  if (
    reason instanceof DOMException &&
    reason.name === 'AbortError'
  ) {
    return true
  }
  if (typeof reason !== 'object' || reason === null) {
    return false
  }
  const error = reason as { name?: unknown; message?: unknown }
  return (
    error.name === 'AbortError' ||
    (typeof error.message === 'string' &&
      error.message.includes('Managed Python operation cancelled'))
  )
}

export function ToolEnvironmentSettingsSection({
  onNotify = () => {}
}: ToolEnvironmentSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [snapshot, setSnapshot] =
    useState<LocalToolEnvironmentSnapshot>()
  const [loadError, setLoadError] = useState<string>()
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [actionError, setActionError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const pythonCancellationRequested = useRef(false)
  const toolApi = window.goodbuddy.localToolEnvironment

  const errorMessage = useCallback(
    (reason: unknown, fallback: string): string =>
      displayErrorMessage(reason, fallback),
    []
  )

  useEffect(() => {
    const api = toolApi
    if (!api) {
      return
    }
    let active = true
    const unsubscribe = api.onProgress(({ snapshot: next }) => {
      if (active) {
        setSnapshot(next)
      }
    })
    void api.getSnapshot().then(
      (next) => {
        if (active) {
          setSnapshot(next)
          setLoadError(undefined)
        }
      },
      (reason: unknown) => {
        if (active) {
          setLoadError(
            errorMessage(
              reason,
              t('toolEnvironment.errors.readFailed')
            )
          )
        }
      }
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [errorMessage, loadAttempt, t, toolApi])

  const updateSettings = async (
    nextSettings: LocalToolEnvironmentSettings,
    successMessage: string
  ): Promise<void> => {
    const api = window.goodbuddy.localToolEnvironment
    if (!api || !snapshot) {
      return
    }
    const confirmedSnapshot = snapshot
    setSnapshot({ ...snapshot, settings: nextSettings })
    setActionError(undefined)
    setBusy('settings')
    try {
      const next = await api.updateSettings(nextSettings)
      setSnapshot(next)
      onNotify({
        tone: 'success',
        message: successMessage,
        dedupeKey: 'local-tool-environment-settings'
      })
    } catch (reason) {
      setSnapshot(confirmedSnapshot)
      setActionError(
        errorMessage(
          reason,
          t('toolEnvironment.errors.saveFailed')
        )
      )
    } finally {
      setBusy(undefined)
    }
  }

  const updateRuntime = async (
    kind: LocalToolKind,
    selection: LocalToolRuntimeSelection
  ): Promise<void> => {
    if (!snapshot) {
      return
    }
    await updateSettings(
      { ...snapshot.settings, [kind]: selection },
      t('toolEnvironment.notifications.runtimeChanged', {
        runtime: t(`toolEnvironment.runtimes.${kind}.title`)
      })
    )
  }

  const runSnapshotAction = async (
    key: string,
    action: () => Promise<LocalToolEnvironmentSnapshot>,
    fallback: string,
    successMessage?: string
  ): Promise<boolean> => {
    setBusy(key)
    setActionError(undefined)
    if (key === 'install-python') {
      pythonCancellationRequested.current = false
    }
    try {
      const next = await action()
      setSnapshot(next)
      if (
        successMessage &&
        !(key === 'install-python' && pythonCancellationRequested.current)
      ) {
        onNotify({
          tone: 'success',
          message: successMessage,
          dedupeKey: `local-tool-environment-${key}`
        })
      }
      return true
    } catch (reason) {
      if (
        key === 'install-python' &&
        isManagedPythonCancellation(reason)
      ) {
        return false
      }
      setActionError(errorMessage(reason, fallback))
      return false
    } finally {
      setBusy(undefined)
    }
  }

  if ((!toolApi || loadError) && !snapshot) {
    return (
      <div className="tool-environment__load-error" role="alert">
        <p>
          {loadError ?? t('toolEnvironment.errors.unavailable')}
        </p>
        {toolApi && (
          <button
            className="secondary-button"
            onClick={() => {
              setLoadError(undefined)
              setLoadAttempt((current) => current + 1)
            }}
            type="button"
          >
            {t('toolEnvironment.actions.retry')}
          </button>
        )}
      </div>
    )
  }

  if (!snapshot) {
    return (
      <p aria-busy="true" aria-live="polite" role="status">
        {t('toolEnvironment.loading')}
      </p>
    )
  }

  const api = toolApi!
  const operation = snapshot.managedPython.operation
  const progress =
    operation?.receivedBytes !== undefined &&
    operation.totalBytes !== undefined
      ? Math.min(
          100,
          Math.round(
            (operation.receivedBytes / operation.totalBytes) * 100
          )
        )
      : undefined

  const renderRuntimeCard = (kind: LocalToolKind): React.JSX.Element => {
    const selection = snapshot.settings[kind]
    const primaryDiagnostic =
      kind === 'node'
        ? snapshot.diagnostics.node
        : snapshot.diagnostics.python ??
          snapshot.diagnostics.python3
    const dependencyDiagnostics =
      kind === 'node'
        ? [
            ['npm', snapshot.diagnostics.npm],
            ['npx', snapshot.diagnostics.npx]
          ] as const
        : [['pip', snapshot.diagnostics.pip]] as const
    const candidates = snapshot.candidates.filter(
      (candidate) => candidate.kind === kind
    )
    const selectedCustomPath =
      selection.source === 'custom'
        ? selection.executablePath
        : undefined
    const customPath = selectedCustomPath ?? candidates[0]?.executablePath

    return (
      <article className="tool-environment-card">
        <div className="tool-environment-card__header">
          <div>
            <h3>{t(`toolEnvironment.runtimes.${kind}.title`)}</h3>
            <p>{t(`toolEnvironment.runtimes.${kind}.description`)}</p>
          </div>
          <button
            className="secondary-button"
            disabled={busy !== undefined}
            onClick={() =>
              void runSnapshotAction(
                `diagnose-${kind}`,
                () => api.diagnose(kind),
                t('toolEnvironment.errors.diagnoseFailed', {
                  runtime: t(
                    `toolEnvironment.runtimes.${kind}.title`
                  )
                })
              )
            }
            type="button"
          >
            {busy === `diagnose-${kind}`
              ? t('toolEnvironment.actions.diagnosing')
              : t('toolEnvironment.actions.diagnose')}
          </button>
        </div>

        <fieldset className="tool-environment-options">
          <legend>
            {t('toolEnvironment.runtimeSourceLegend', {
              runtime: t(`toolEnvironment.runtimes.${kind}.title`)
            })}
          </legend>
          <label className="tool-environment-option">
            <input
              checked={selection.source === 'managed'}
              disabled={busy !== undefined}
              name={`${kind}-runtime-source`}
              onChange={() =>
                void updateRuntime(kind, { source: 'managed' })
              }
              type="radio"
            />
            <span>
              <strong>{t('toolEnvironment.sources.managed')}</strong>
              <small>
                {t(
                  `toolEnvironment.runtimes.${kind}.managedDescription`
                )}
              </small>
            </span>
          </label>
          <label className="tool-environment-option">
            <input
              checked={selection.source === 'custom'}
              disabled={busy !== undefined || !customPath}
              name={`${kind}-runtime-source`}
              onChange={() => {
                if (customPath) {
                  void updateRuntime(kind, {
                    source: 'custom',
                    executablePath: customPath
                  })
                }
              }}
              type="radio"
            />
            <span>
              <strong>{t('toolEnvironment.sources.custom')}</strong>
              <small>{t('toolEnvironment.sources.customDescription')}</small>
            </span>
          </label>
        </fieldset>

        <div className="tool-environment-card__custom">
          <div className="tool-environment-card__actions">
            <button
              className="secondary-button"
              disabled={busy !== undefined}
              onClick={() =>
                void runSnapshotAction(
                  `refresh-${kind}`,
                  () => api.refreshCandidates(),
                  t('toolEnvironment.errors.refreshFailed')
                )
              }
              type="button"
            >
              {t('toolEnvironment.actions.refreshCandidates')}
            </button>
            <button
              className="secondary-button"
              disabled={busy !== undefined}
              onClick={() =>
                void runSnapshotAction(
                  `select-${kind}`,
                  () => api.selectExecutable(kind),
                  t('toolEnvironment.errors.selectFailed', {
                    runtime: t(
                      `toolEnvironment.runtimes.${kind}.title`
                    )
                  }),
                  t('toolEnvironment.notifications.runtimeChanged', {
                    runtime: t(
                      `toolEnvironment.runtimes.${kind}.title`
                    )
                  })
                )
              }
              type="button"
            >
              {t('toolEnvironment.actions.chooseFile')}
            </button>
          </div>
          {selectedCustomPath && (
            <p className="tool-environment-path">
              <span>{t('toolEnvironment.selectedPath')}</span>
              <code>{selectedCustomPath}</code>
            </p>
          )}
          {candidates.length > 0 ? (
            <ul
              aria-label={t('toolEnvironment.candidateList', {
                runtime: t(`toolEnvironment.runtimes.${kind}.title`)
              })}
              className="tool-environment-candidates"
            >
              {candidates.map((candidate) => {
                return (
                  <li key={candidate.executablePath}>
                    <button
                      aria-pressed={
                        selectedCustomPath === candidate.executablePath
                      }
                      disabled={busy !== undefined}
                      onClick={() =>
                        void updateRuntime(kind, {
                          source: 'custom',
                          executablePath: candidate.executablePath
                        })
                      }
                      type="button"
                    >
                      <code>{candidate.executablePath}</code>
                      <small>
                        {candidate.version} · {candidate.architecture}
                      </small>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="tool-environment-muted">
              {t('toolEnvironment.noCandidates')}
            </p>
          )}
        </div>

        <div className="tool-environment-status">
          <h4>{t('toolEnvironment.toolStatus')}</h4>
          {primaryDiagnostic ? (
            <dl>
              <dt>{t('toolEnvironment.status')}</dt>
              <dd>
                {primaryDiagnostic.available
                  ? t('toolEnvironment.available')
                  : t('toolEnvironment.unavailable')}
              </dd>
              {primaryDiagnostic.version && (
                <>
                  <dt>{t('toolEnvironment.version')}</dt>
                  <dd>{primaryDiagnostic.version}</dd>
                </>
              )}
              {primaryDiagnostic.executablePath && (
                <>
                  <dt>{t('toolEnvironment.path')}</dt>
                  <dd>
                    <code>{primaryDiagnostic.executablePath}</code>
                  </dd>
                </>
              )}
              <dt>{t('toolEnvironment.detail')}</dt>
              <dd>{primaryDiagnostic.detail}</dd>
            </dl>
          ) : (
            <p>{t('toolEnvironment.notDiagnosed')}</p>
          )}
        </div>

        <div className="tool-environment-status">
          <h4>{t('toolEnvironment.companionStatus')}</h4>
          {dependencyDiagnostics.some(([, value]) => value) ? (
            <ul>
              {dependencyDiagnostics.map(
                ([name, diagnostic]) =>
                  diagnostic && (
                    <li key={name}>
                      <strong>{name}</strong>
                      <span>
                        {diagnostic.available
                          ? t('toolEnvironment.available')
                          : t('toolEnvironment.unavailable')}
                        {diagnostic.version
                          ? ` · ${diagnostic.version}`
                          : ''}
                      </span>
                      <small>{diagnostic.detail}</small>
                    </li>
                  )
              )}
            </ul>
          ) : (
            <p>{t('toolEnvironment.notDiagnosed')}</p>
          )}
        </div>

        <div className="tool-environment-status">
          <h4>{t('toolEnvironment.capabilityDependencyStatus')}</h4>
          <p>{t('toolEnvironment.capabilityDependenciesUnverified')}</p>
        </div>

        {kind === 'python' && selection.source === 'managed' && (
          <div className="tool-environment-python">
            <p>
              {snapshot.managedPython.installed
                ? t('toolEnvironment.python.installed', {
                    version: snapshot.managedPython.version
                  })
                : t('toolEnvironment.python.notInstalled', {
                    version: snapshot.managedPython.version
                  })}
            </p>
            {snapshot.managedPython.executablePath && (
              <code>{snapshot.managedPython.executablePath}</code>
            )}
            {operation && (
              <div className="tool-environment-progress">
                <div
                  aria-label={t(
                    'toolEnvironment.python.progressLabel'
                  )}
                  aria-valuemax={progress === undefined ? undefined : 100}
                  aria-valuemin={progress === undefined ? undefined : 0}
                  aria-valuenow={progress}
                  className="tool-environment-progress__track"
                  role="progressbar"
                >
                  {progress !== undefined && (
                    <span style={{ width: `${progress}%` }} />
                  )}
                </div>
                <span>
                  {t(
                    `toolEnvironment.python.phases.${operation.phase}`
                  )}
                  {operation.receivedBytes !== undefined &&
                    ` · ${formatBytes(operation.receivedBytes)}`}
                  {operation.totalBytes !== undefined &&
                    ` / ${formatBytes(operation.totalBytes)}`}
                </span>
                <span>
                  {t('toolEnvironment.python.progressSource', {
                    source: t(
                      `toolEnvironment.downloadSource.options.${operation.source}.label`
                    )
                  })}
                </span>
              </div>
            )}
            <div className="tool-environment-card__actions">
              {operation ? (
                <button
                  className="secondary-button"
                  disabled={
                    busy !== undefined && busy !== 'install-python'
                  }
                  onClick={() => {
                    pythonCancellationRequested.current = true
                    setBusy('cancel-python')
                    setActionError(undefined)
                    void api.cancelPython().then(
                      () => setBusy(undefined),
                      (reason: unknown) => {
                        setBusy(undefined)
                        setActionError(
                          errorMessage(
                            reason,
                            t(
                              'toolEnvironment.errors.cancelPythonFailed'
                            )
                          )
                        )
                      }
                    )
                  }}
                  type="button"
                >
                  {t('toolEnvironment.actions.cancel')}
                </button>
              ) : (
                <button
                  className="primary-button"
                  disabled={busy !== undefined}
                  onClick={() =>
                    void runSnapshotAction(
                      'install-python',
                      () => api.installPython(),
                      t(
                        'toolEnvironment.errors.installPythonFailed'
                      ),
                      t(
                        'toolEnvironment.notifications.pythonInstalled'
                      )
                    )
                  }
                  type="button"
                >
                  {snapshot.managedPython.installed
                    ? t('toolEnvironment.actions.updatePython')
                    : t('toolEnvironment.actions.installPython')}
                </button>
              )}
              {snapshot.managedPython.installed &&
                !operation &&
                (confirmingRemove ? (
                  <>
                    <span role="alert">
                      {t('toolEnvironment.python.removeConfirmation')}
                    </span>
                    <button
                      className="danger-solid"
                      disabled={busy !== undefined}
                      onClick={() =>
                        void runSnapshotAction(
                          'remove-python',
                          () => api.removePython(),
                          t(
                            'toolEnvironment.errors.removePythonFailed'
                          ),
                          t(
                            'toolEnvironment.notifications.pythonRemoved'
                          )
                        ).then((removed) => {
                          if (removed) {
                            setConfirmingRemove(false)
                          }
                        })
                      }
                      type="button"
                    >
                      {t('toolEnvironment.actions.confirmRemovePython')}
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => setConfirmingRemove(false)}
                      type="button"
                    >
                      {t('toolEnvironment.actions.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    className="danger-ghost"
                    onClick={() => setConfirmingRemove(true)}
                    type="button"
                  >
                    {t('toolEnvironment.actions.removePython')}
                  </button>
                ))}
            </div>
          </div>
        )}
      </article>
    )
  }

  return (
    <div className="tool-environment">
      <p className="tool-environment__scope">
        {t('toolEnvironment.scope')}
      </p>
      {actionError && (
        <p className="tool-environment__error" role="alert">
          {actionError}
        </p>
      )}
      <section className="tool-environment-card">
        <div className="tool-environment-card__header">
          <div>
            <h3>{t('toolEnvironment.downloadSource.title')}</h3>
            <p>{t('toolEnvironment.downloadSource.description')}</p>
          </div>
          <button
            className="secondary-button"
            disabled={busy !== undefined}
            onClick={() =>
              void runSnapshotAction(
                'diagnose-all',
                () => api.diagnose('all'),
                t('toolEnvironment.errors.diagnoseAllFailed')
              )
            }
            type="button"
          >
            {busy === 'diagnose-all'
              ? t('toolEnvironment.actions.diagnosing')
              : t('toolEnvironment.actions.diagnoseAll')}
          </button>
        </div>
        <fieldset className="tool-environment-options">
          <legend>{t('toolEnvironment.downloadSource.legend')}</legend>
          {(['native', 'oss'] as const).map((source) => (
            <label className="tool-environment-option" key={source}>
              <input
                checked={
                  snapshot.settings.artifactDownloadSource === source
                }
                disabled={busy !== undefined}
                name="artifact-download-source"
                onChange={() =>
                  void updateSettings(
                    {
                      ...snapshot.settings,
                      artifactDownloadSource: source
                    },
                    t(
                      'toolEnvironment.notifications.downloadSourceChanged'
                    )
                  )
                }
                type="radio"
              />
              <span>
                <strong>
                  {t(
                    `toolEnvironment.downloadSource.options.${source}.label`
                  )}
                </strong>
                <small>
                  {t(
                    `toolEnvironment.downloadSource.options.${source}.description`
                  )}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="tool-environment-muted">
          {t('toolEnvironment.downloadSource.noFallback')}
        </p>
      </section>
      {renderRuntimeCard('node')}
      {renderRuntimeCard('python')}
    </div>
  )
}
