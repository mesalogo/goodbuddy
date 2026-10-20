import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InlineHelp } from './InlineHelp'
import { SettingsCategoryHeader } from './SettingsPrimitives'
import type {
  LocalToolEnvironmentSettings,
  LocalToolEnvironmentSnapshot,
  LocalToolKind,
  LocalToolRuntimeSelection
} from '../../shared/local-tool-environment-contracts'

type LocalToolSource = LocalToolRuntimeSelection['source']
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
  const [customOpen, setCustomOpen] = useState<
    Record<LocalToolKind, boolean>
  >({ node: false, python: false })
  const [runtimeErrors, setRuntimeErrors] = useState<
    Partial<Record<LocalToolKind, string>>
  >({})
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
        // Detection runs the tools once, so it happens only while this page
        // is open rather than on every application start.
        return api.diagnose('all').then(
          (detected) => {
            if (active) setSnapshot(detected)
          },
          () => undefined
        )
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
    successMessage: string,
    errorKind?: LocalToolKind
  ): Promise<boolean> => {
    const api = window.goodbuddy.localToolEnvironment
    if (!api || !snapshot) {
      return false
    }
    const confirmedSnapshot = snapshot
    setSnapshot({ ...snapshot, settings: nextSettings })
    setActionError(undefined)
    if (errorKind) {
      setRuntimeErrors((current) => ({
        ...current,
        [errorKind]: undefined
      }))
    }
    setBusy('settings')
    try {
      const next = await api.updateSettings(nextSettings)
      setSnapshot(next)
      onNotify({
        tone: 'success',
        message: successMessage,
        dedupeKey: 'local-tool-environment-settings'
      })
      return true
    } catch (reason) {
      setSnapshot(confirmedSnapshot)
      const message = errorMessage(
        reason,
        t('toolEnvironment.errors.saveFailed')
      )
      if (errorKind) {
        setRuntimeErrors((current) => ({
          ...current,
          [errorKind]: message
        }))
      } else {
        setActionError(message)
      }
      return false
    } finally {
      setBusy(undefined)
    }
  }

  const updateRuntime = async (
    kind: LocalToolKind,
    selection: LocalToolRuntimeSelection
  ): Promise<boolean> => {
    if (!snapshot) {
      return false
    }
    return updateSettings(
      { ...snapshot.settings, [kind]: selection },
      t('toolEnvironment.notifications.runtimeChanged', {
        runtime: t(`toolEnvironment.runtimes.${kind}.title`)
      }),
      kind
    )
  }

  const refreshCustomCandidates = async (
    kind: LocalToolKind
  ): Promise<void> => {
    setBusy(`refresh-${kind}`)
    setRuntimeErrors((current) => ({ ...current, [kind]: undefined }))
    try {
      const api = window.goodbuddy.localToolEnvironment
      if (!api) return
      setSnapshot(await api.refreshCandidates())
    } catch (reason) {
      setRuntimeErrors((current) => ({
        ...current,
        [kind]: errorMessage(
          reason,
          t('toolEnvironment.errors.refreshFailed')
        )
      }))
    } finally {
      setBusy(undefined)
    }
  }

  const selectCustomExecutable = async (
    kind: LocalToolKind
  ): Promise<void> => {
    const api = window.goodbuddy.localToolEnvironment
    if (!api || !snapshot) return
    const previous = snapshot.settings[kind]
    setBusy(`select-${kind}`)
    setRuntimeErrors((current) => ({ ...current, [kind]: undefined }))
    try {
      const next = await api.selectExecutable(kind)
      setSnapshot(next)
      const selected = next.settings[kind]
      if (
        selected.source === 'custom' &&
        (previous.source !== 'custom' ||
          previous.executablePath !== selected.executablePath)
      ) {
        setCustomOpen((current) => ({ ...current, [kind]: true }))
        onNotify({
          tone: 'success',
          message: t('toolEnvironment.notifications.runtimeChanged', {
            runtime: t(`toolEnvironment.runtimes.${kind}.title`)
          }),
          dedupeKey: `local-tool-environment-select-${kind}`
        })
      }
    } catch (reason) {
      setRuntimeErrors((current) => ({
        ...current,
        [kind]: errorMessage(
          reason,
          t('toolEnvironment.errors.selectFailed', {
            runtime: t(`toolEnvironment.runtimes.${kind}.title`)
          })
        )
      }))
    } finally {
      setBusy(undefined)
    }
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

  const header = (actions?: React.ReactNode): React.JSX.Element => (
    <SettingsCategoryHeader actions={actions} category="tool-environment" />
  )

  if ((!toolApi || loadError) && !snapshot) {
    return (
      <>
        {header()}
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
      </>
    )
  }

  if (!snapshot) {
    return (
      <>
        {header()}
        <p aria-busy="true" aria-live="polite" role="status">
          {t('toolEnvironment.loading')}
        </p>
      </>
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

  const renderManagedPython = (): React.JSX.Element => (
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
      {operation && (
        <div className="tool-environment-progress">
          <div
            aria-label={t('toolEnvironment.python.progressLabel')}
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
            {t(`toolEnvironment.python.phases.${operation.phase}`)}
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
            disabled={busy !== undefined && busy !== 'install-python'}
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
                      t('toolEnvironment.errors.cancelPythonFailed')
                    )
                  )
                }
              )
            }}
            type="button"
          >
            {t('toolEnvironment.actions.cancel')}
          </button>
        ) : !snapshot.managedPython.installed ? (
          <button
            className="primary-button"
            disabled={busy !== undefined}
            onClick={() =>
              void runSnapshotAction(
                'install-python',
                () => api.installPython(),
                t('toolEnvironment.errors.installPythonFailed'),
                t('toolEnvironment.notifications.pythonInstalled')
              )
            }
            type="button"
          >
            {t('toolEnvironment.actions.installPython')}
          </button>
        ) : confirmingRemove ? (
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
                  t('toolEnvironment.errors.removePythonFailed'),
                  t('toolEnvironment.notifications.pythonRemoved')
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
            disabled={busy !== undefined}
            onClick={() => setConfirmingRemove(true)}
            type="button"
          >
            {t('toolEnvironment.actions.removePython')}
          </button>
        )}
      </div>
    </div>
  )

  const renderRuntimeCard = (kind: LocalToolKind): React.JSX.Element => {
    const selection = snapshot.settings[kind]
    const runtimeName = t(`toolEnvironment.runtimes.${kind}.title`)
    const primaryDiagnostic =
      kind === 'node'
        ? snapshot.diagnostics.node
        : snapshot.diagnostics.python ?? snapshot.diagnostics.python3
    const dependencyDiagnostics =
      kind === 'node'
        ? ([
            ['npm', snapshot.diagnostics.npm],
            ['npx', snapshot.diagnostics.npx]
          ] as const)
        : ([['pip', snapshot.diagnostics.pip]] as const)
    const candidates = snapshot.candidates.filter(
      (candidate) => candidate.kind === kind
    )
    const selectedCustomPath =
      selection.source === 'custom' ? selection.executablePath : undefined
    const pendingCustom = customOpen[kind] && selection.source !== 'custom'
    const activeSource: LocalToolSource = pendingCustom
      ? 'custom'
      : selection.source
    const customError = runtimeErrors[kind]
    const customRegionId = `tool-environment-${kind}-custom-options`
    const sources: readonly LocalToolSource[] = ['auto', 'managed', 'custom']
    // The built-in Python matters whenever it may be used: always in
    // "built-in" mode, and in "auto" mode as the fallback.
    const showManagedPython =
      kind === 'python' && !pendingCustom && selection.source !== 'custom'

    const statusText = primaryDiagnostic
      ? primaryDiagnostic.available && primaryDiagnostic.origin
        ? t(`toolEnvironment.effective.${primaryDiagnostic.origin}`, {
            runtime: runtimeName,
            version: primaryDiagnostic.version ?? ''
          })
        : primaryDiagnostic.origin === 'system'
          ? t('toolEnvironment.brokenSystem', { runtime: runtimeName })
          : t(`toolEnvironment.missing.${kind}.${selection.source}`)
      : t('toolEnvironment.notDiagnosed')

    return (
      <article className="tool-environment-card">
        <div className="tool-environment-card__header">
          <div className="inline-help-label">
            <h3>{runtimeName}</h3>
            <InlineHelp label={runtimeName}>
              {t(`toolEnvironment.runtimes.${kind}.description`)}
            </InlineHelp>
          </div>
        </div>

        <div
          aria-live="polite"
          className={`tool-environment-status tool-environment-status--${
            primaryDiagnostic?.available ? 'ready' : 'missing'
          }`}
          role="status"
        >
          <p>
            <strong>{statusText}</strong>
          </p>
          {primaryDiagnostic?.executablePath && (
            <code>{primaryDiagnostic.executablePath}</code>
          )}
          {primaryDiagnostic?.available && (
            <ul className="tool-environment-companions">
              {dependencyDiagnostics.map(
                ([name, diagnostic]) =>
                  diagnostic && (
                    <li key={name}>
                      <strong>{name}</strong>{' '}
                      <span>
                        {diagnostic.available
                          ? diagnostic.version ?? t('toolEnvironment.available')
                          : t('toolEnvironment.unavailable')}
                      </span>
                    </li>
                  )
              )}
            </ul>
          )}
        </div>

        <fieldset
          aria-describedby={`tool-environment-${kind}-source-description`}
          className="tool-environment-options tool-environment-options--inline"
        >
          <legend>
            {t('toolEnvironment.runtimeSourceLegend', { runtime: runtimeName })}
          </legend>
          {sources.map((source) => (
            <label
              className="tool-environment-option"
              key={source}
              title={t(`toolEnvironment.runtimes.${kind}.sources.${source}`)}
            >
              <input
                aria-controls={source === 'custom' ? customRegionId : undefined}
                checked={activeSource === source}
                disabled={busy !== undefined}
                name={`${kind}-runtime-source`}
                onChange={() => {
                  setRuntimeErrors((current) => ({
                    ...current,
                    [kind]: undefined
                  }))
                  if (source === 'custom') {
                    setCustomOpen((current) => ({ ...current, [kind]: true }))
                    return
                  }
                  setCustomOpen((current) => ({ ...current, [kind]: false }))
                  if (selection.source !== source) {
                    void updateRuntime(kind, { source })
                  }
                }}
                type="radio"
              />
              <strong>{t(`toolEnvironment.sources.${source}`)}</strong>
            </label>
          ))}
        </fieldset>
        <p
          className="tool-environment-muted tool-environment-options__description"
          id={`tool-environment-${kind}-source-description`}
        >
          {t(`toolEnvironment.runtimes.${kind}.sources.${activeSource}`)}
        </p>

        {activeSource === 'custom' && (
          <div className="tool-environment-card__custom" id={customRegionId}>
            {pendingCustom && (
              <p className="tool-environment-muted">
                {t('toolEnvironment.chooseCustomPrompt', {
                  runtime: runtimeName
                })}
              </p>
            )}
            <div className="tool-environment-card__actions">
              <button
                className="secondary-button"
                disabled={busy !== undefined}
                onClick={() => void refreshCustomCandidates(kind)}
                type="button"
              >
                {t('toolEnvironment.actions.refreshCandidates')}
              </button>
              <button
                className="secondary-button"
                disabled={busy !== undefined}
                onClick={() => void selectCustomExecutable(kind)}
                type="button"
              >
                {t('toolEnvironment.actions.chooseFile')}
              </button>
            </div>
            {customError && (
              <p className="tool-environment__error" role="alert">
                {customError}
              </p>
            )}
            {selectedCustomPath && (
              <p className="tool-environment-path">
                <span>{t('toolEnvironment.selectedPath')}</span>
                <code>{selectedCustomPath}</code>
              </p>
            )}
            {candidates.length > 0 ? (
              <ul
                aria-label={t('toolEnvironment.candidateList', {
                  runtime: runtimeName
                })}
                className="tool-environment-candidates"
              >
                {candidates.map((candidate) => (
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
                ))}
              </ul>
            ) : (
              <p className="tool-environment-muted">
                {t('toolEnvironment.noCandidates')}
              </p>
            )}
          </div>
        )}

        {customError && activeSource !== 'custom' && (
          <p className="tool-environment__error" role="alert">
            {customError}
          </p>
        )}

        {showManagedPython && renderManagedPython()}
      </article>
    )
  }

  return (
    <>
    {header(
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
    )}
    <div className="tool-environment">
      {actionError && (
        <p className="tool-environment__error" role="alert">
          {actionError}
        </p>
      )}
      {renderRuntimeCard('node')}
      {renderRuntimeCard('python')}
      <section className="tool-environment-card">
        <div className="tool-environment-card__header">
          <div className="inline-help-label">
            <h3>{t('toolEnvironment.downloadSource.title')}</h3>
            <InlineHelp label={t('toolEnvironment.downloadSource.title')}>{t('toolEnvironment.downloadSource.description')}</InlineHelp>
          </div>
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
    </div>
    </>
  )
}
