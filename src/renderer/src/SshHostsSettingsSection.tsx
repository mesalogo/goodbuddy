import {
  Bot,
  Boxes,
  CheckCircle2,
  Download,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
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
  RemoteEnvironmentUpdatePhase,
  SshHost,
  SshHostConnectionTestResult,
  SshHostRemoteEnvironment,
  SshHostsSnapshot,
  SshHostValidationResult
} from '../../shared/ssh-host-contracts'
import type { AppNotificationInput } from './notifications'
import { SettingsCategoryHeader } from './SettingsPrimitives'
import { displayErrorMessage } from './error-message'
import { SshHostDialog } from './SshHostDialog'
import {
  DestructiveConfirmActions,
  EmptyState
} from './WorkspacePrimitives'

type SshHostsSettingsSectionProps = {
  onDirtyChange?: (dirty: boolean) => void
  onHostUpdated?: (hostId: string) => void
  onNotify?: (notification: AppNotificationInput) => void
}

type RemoteEnvironmentLoadState = {
  loading: boolean
  value?: SshHostRemoteEnvironment
  error?: string
}

type RemoteEnvironmentUpdateState = {
  hostId: string
  requestId: number
  phase?: RemoteEnvironmentUpdatePhase
  cancelling: boolean
}

type ActiveRemoteEnvironmentUpdate = {
  hostId: string
  requestId: number
  cancelRequested: boolean
  cancelError?: string
}

function credentialDescription(
  host: SshHost,
  t: ReturnType<typeof useTranslation<'settingsSections'>>['t']
): string {
  return t(`sshHosts.credentialSources.${host.credentialSource}`)
}

function upsertHost(hosts: SshHost[], host: SshHost): SshHost[] {
  const index = hosts.findIndex((candidate) => candidate.id === host.id)
  if (index === -1) {
    return [...hosts, host]
  }
  const next = [...hosts]
  next[index] = host
  return next
}

export function SshHostsSettingsSection({
  onDirtyChange,
  onHostUpdated,
  onNotify
}: SshHostsSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [hosts, setHosts] = useState<SshHost[]>([])
  const [secureStorageAvailable, setSecureStorageAvailable] =
    useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [editingId, setEditingId] = useState<string | 'new'>()
  const [busyHostId, setBusyHostId] = useState<string>()
  const [confirmingDeleteId, setConfirmingDeleteId] =
    useState<string>()
  const [testResults, setTestResults] = useState<
    Record<string, SshHostConnectionTestResult>
  >({})
  const [remoteEnvironments, setRemoteEnvironments] = useState<
    Record<string, RemoteEnvironmentLoadState>
  >({})
  const [remoteEnvironmentUpdate, setRemoteEnvironmentUpdate] =
    useState<RemoteEnvironmentUpdateState>()
  const [
    remoteEnvironmentUpdateErrors,
    setRemoteEnvironmentUpdateErrors
  ] = useState<Record<string, string>>({})
  const remoteEnvironmentRequests = useRef(new Map<string, number>())
  const activeRemoteEnvironmentUpdate =
    useRef<ActiveRemoteEnvironmentUpdate | undefined>(undefined)
  const remoteEnvironmentUpdateRequestId = useRef(0)
  const mounted = useRef(true)
  const api = window.goodbuddy.sshHosts

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (
      typeof api?.onRemoteEnvironmentUpdateProgress !== 'function'
    ) {
      return
    }
    return api.onRemoteEnvironmentUpdateProgress(
      ({ hostId, phase }) => {
        const activeUpdate = activeRemoteEnvironmentUpdate.current
        if (
          !mounted.current ||
          !activeUpdate ||
          activeUpdate.hostId !== hostId
        ) {
          return
        }
        setRemoteEnvironmentUpdate((current) => {
          if (
            !current ||
            current.requestId !== activeUpdate.requestId
          ) {
            return current
          }
          return {
            ...current,
            phase
          }
        })
      }
    )
  }, [api])

  const requestSnapshot = useCallback((): Promise<SshHostsSnapshot> => {
    if (!api) {
      return Promise.reject(
        new Error(t('sshHosts.errors.unavailable'))
      )
    }
    return api.getSnapshot()
  }, [api, t])

  const applySnapshot = useCallback(
    (snapshot: SshHostsSnapshot): void => {
      setHosts(snapshot.hosts)
      setSecureStorageAvailable(snapshot.secureStorageAvailable)
      setError(undefined)
    },
    []
  )

  useEffect(() => {
    let active = true
    void requestSnapshot()
      .then((snapshot) => {
        if (active) {
          applySnapshot(snapshot)
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            displayErrorMessage(
              reason,
              t('sshHosts.errors.readFailed')
            )
          )
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [applySnapshot, requestSnapshot, t])

  const requestRemoteEnvironment = useCallback(
    async (hostId: string): Promise<void> => {
      if (!mounted.current) {
        return
      }
      const requestId =
        (remoteEnvironmentRequests.current.get(hostId) ?? 0) + 1
      remoteEnvironmentRequests.current.set(hostId, requestId)
      setRemoteEnvironments((current) => ({
        ...current,
        [hostId]: {
          ...current[hostId],
          loading: true,
          error: undefined
        }
      }))
      try {
        if (!api?.getRemoteEnvironment) {
          throw new Error(t('sshHosts.errors.environmentUnavailable'))
        }
        const value = await api.getRemoteEnvironment(hostId)
        if (
          !mounted.current ||
          remoteEnvironmentRequests.current.get(hostId) !== requestId
        ) {
          return
        }
        setRemoteEnvironments((current) => ({
          ...current,
          [hostId]: { loading: false, value }
        }))
      } catch (reason) {
        if (
          !mounted.current ||
          remoteEnvironmentRequests.current.get(hostId) !== requestId
        ) {
          return
        }
        setRemoteEnvironments((current) => ({
          ...current,
          [hostId]: {
            loading: false,
            value: current[hostId]?.value,
            error: displayErrorMessage(
              reason,
              t('sshHosts.errors.environmentReadFailed')
            )
          }
        }))
      }
    },
    [api, t]
  )

  const updateRemoteEnvironment = async (
    host: SshHost
  ): Promise<void> => {
    if (
      typeof api?.updateRemoteEnvironment !== 'function' ||
      activeRemoteEnvironmentUpdate.current
    ) {
      return
    }
    const requestId = remoteEnvironmentUpdateRequestId.current + 1
    remoteEnvironmentUpdateRequestId.current = requestId
    const activeUpdate: ActiveRemoteEnvironmentUpdate = {
      hostId: host.id,
      requestId,
      cancelRequested: false
    }
    activeRemoteEnvironmentUpdate.current = activeUpdate
    setRemoteEnvironmentUpdateErrors((current) => {
      if (!(host.id in current)) {
        return current
      }
      const next = { ...current }
      delete next[host.id]
      return next
    })
    setRemoteEnvironmentUpdate({
      hostId: host.id,
      requestId,
      cancelling: false
    })

    let succeeded = false
    try {
      await api.updateRemoteEnvironment(host.id)
      succeeded = true
    } catch (reason) {
      const cancelled =
        activeUpdate.cancelRequested &&
        isCancellationError(reason)
      const message = cancelled
        ? activeUpdate.cancelError ??
          t('sshHosts.environment.errors.cancelled')
        : displayErrorMessage(
            reason,
            t('sshHosts.environment.errors.updateFailed')
          )
      if (mounted.current) {
        setRemoteEnvironmentUpdateErrors((current) => ({
          ...current,
          [host.id]: message
        }))
      } else if (!cancelled) {
        onNotify?.({
          dedupeKey:
            `ssh-host-environment-update-failed:${host.id}`,
          message,
          tone: 'error'
        })
      }
    } finally {
      const currentUpdate = activeRemoteEnvironmentUpdate.current
      if (currentUpdate === activeUpdate) {
        activeRemoteEnvironmentUpdate.current = undefined
        if (succeeded) {
          notify(
            `ssh-host-environment-updated:${host.id}`,
            t('sshHosts.notifications.environmentUpdated', {
              name: host.name
            })
          )
          onHostUpdated?.(host.id)
        }
        if (mounted.current) {
          if (succeeded) {
            setRemoteEnvironmentUpdateErrors((current) => {
              if (!(host.id in current)) {
                return current
              }
              const next = { ...current }
              delete next[host.id]
              return next
            })
          }
          await requestRemoteEnvironment(host.id)
          if (mounted.current) {
            setRemoteEnvironmentUpdate((current) =>
              current?.requestId === requestId
                ? undefined
                : current
            )
          }
        }
      }
    }
  }

  const cancelRemoteEnvironmentUpdate = async (
    hostId: string
  ): Promise<void> => {
    const activeUpdate = activeRemoteEnvironmentUpdate.current
    if (
      !activeUpdate ||
      activeUpdate.hostId !== hostId ||
      activeUpdate.cancelRequested ||
      typeof api?.cancelRemoteEnvironmentUpdate !== 'function'
    ) {
      return
    }
    activeUpdate.cancelRequested = true
    activeUpdate.cancelError = undefined
    setRemoteEnvironmentUpdateErrors((current) => {
      if (!(hostId in current)) {
        return current
      }
      const next = { ...current }
      delete next[hostId]
      return next
    })
    setRemoteEnvironmentUpdate((current) => {
      if (
        !current ||
        current.requestId !== activeUpdate.requestId
      ) {
        return current
      }
      return {
        ...current,
        cancelling: true
      }
    })
    try {
      await api.cancelRemoteEnvironmentUpdate(hostId)
    } catch (reason) {
      activeUpdate.cancelError = displayErrorMessage(
        reason,
        t('sshHosts.environment.errors.cancelFailed')
      )
      if (mounted.current) {
        activeUpdate.cancelRequested = false
        setRemoteEnvironmentUpdate((current) => {
          if (
            !current ||
            current.requestId !== activeUpdate.requestId
          ) {
            return current
          }
          return {
            ...current,
            cancelling: false
          }
        })
        setRemoteEnvironmentUpdateErrors((current) => ({
          ...current,
          [hostId]: activeUpdate.cancelError!
        }))
      }
    }
  }

  useEffect(
    () => () => {
      for (const [hostId, requestId] of
        remoteEnvironmentRequests.current) {
        remoteEnvironmentRequests.current.set(hostId, requestId + 1)
      }
    },
    []
  )

  useEffect(() => {
    if (loading) {
      return
    }
    const hostIds = hosts
      .filter(
        (host) =>
          host.lastValidatedAt &&
          !remoteEnvironmentRequests.current.has(host.id)
      )
      .map((host) => host.id)
    if (hostIds.length === 0) {
      return
    }
    let active = true
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (active) {
        const hostId = hostIds[nextIndex]
        nextIndex += 1
        if (!hostId) {
          return
        }
        await requestRemoteEnvironment(hostId)
      }
    }
    void Promise.all(
      Array.from(
        { length: Math.min(3, hostIds.length) },
        () => worker()
      )
    )
    return () => {
      active = false
    }
  }, [hosts, loading, requestRemoteEnvironment])

  const notify = (
    dedupeKey: string,
    message: string,
    tone: AppNotificationInput['tone'] = 'success'
  ): void => {
    onNotify?.({ dedupeKey, message, tone })
  }

  const handleSaved = (result: SshHostValidationResult): void => {
    const edited = hosts.some((host) => host.id === result.host.id)
    setHosts((current) => upsertHost(current, result.host))
    setTestResults((current) => ({
      ...current,
      [result.host.id]: result.connection
    }))
    setError(undefined)
    if (result.host.lastValidatedAt) {
      void requestRemoteEnvironment(result.host.id)
    }
    if (edited) {
      onHostUpdated?.(result.host.id)
    }
  }

  const remove = async (host: SshHost): Promise<void> => {
    if (!api) {
      return
    }
    setBusyHostId(host.id)
    setError(undefined)
    try {
      await api.remove(host.id)
      setConfirmingDeleteId(undefined)
      setHosts((current) =>
        current.filter((candidate) => candidate.id !== host.id)
      )
      setTestResults((current) => {
        if (!(host.id in current)) {
          return current
        }
        const next = { ...current }
        delete next[host.id]
        return next
      })
      setRemoteEnvironments((current) => {
        if (!(host.id in current)) {
          return current
        }
        const next = { ...current }
        delete next[host.id]
        return next
      })
      setRemoteEnvironmentUpdateErrors((current) => {
        if (!(host.id in current)) {
          return current
        }
        const next = { ...current }
        delete next[host.id]
        return next
      })
      remoteEnvironmentRequests.current.delete(host.id)
      notify(
        `ssh-host-removed:${host.id}`,
        t('sshHosts.notifications.removed', { name: host.name }),
        'info'
      )
    } catch (reason) {
      setError(
        displayErrorMessage(
          reason,
          t('sshHosts.errors.removeFailed')
        )
      )
    } finally {
      setBusyHostId(undefined)
    }
  }

  const editingHost =
    editingId && editingId !== 'new'
      ? hosts.find((host) => host.id === editingId)
      : undefined
  const hasActiveRemoteEnvironmentUpdate =
    remoteEnvironmentUpdate !== undefined

  return (
    <div className="ssh-hosts-settings">
      <SettingsCategoryHeader
        actions={
          <button
            className="primary-button"
            disabled={loading || Boolean(editingId) || !api}
            onClick={() => {
              setEditingId('new')
              setError(undefined)
            }}
            type="button"
          >
            <Plus aria-hidden="true" size={14} />
            {t('sshHosts.actions.add')}
          </button>
        }
        category="ssh-hosts"
        error={error}
        headingId="ssh-hosts-heading"
      />

      <div className="settings-notice">
        <ShieldCheck aria-hidden="true" size={16} />
        <span>{t('sshHosts.securityNotice')}</span>
      </div>

      {!secureStorageAvailable && !loading && (
        <div className="settings-warning" role="alert">
          {t('sshHosts.secureStorageUnavailable')}
        </div>
      )}

      {loading ? (
        <div className="settings-empty">{t('sshHosts.loading')}</div>
      ) : hosts.length === 0 ? (
        <EmptyState
          action={
            <button
              className="primary-button"
              disabled={!api}
              onClick={() => setEditingId('new')}
              type="button"
            >
              {t('sshHosts.actions.add')}
            </button>
          }
          description={t('sshHosts.empty.description')}
          icon={<Server size={22} />}
          title={t('sshHosts.empty.title')}
        />
      ) : (
        <div
          aria-label={t('sshHosts.listLabel')}
          className="ssh-hosts-list"
        >
          {hosts.map((host) => {
            const result = testResults[host.id]
            const remoteEnvironment = remoteEnvironments[host.id]
            const hostEnvironmentUpdate =
              remoteEnvironmentUpdate?.hostId === host.id
                ? remoteEnvironmentUpdate
                : undefined
            const remoteEnvironmentUpdateError =
              remoteEnvironmentUpdateErrors[host.id]
            const deleting = busyHostId === host.id
            const environmentNeedsUpdate = Boolean(
              remoteEnvironment?.value &&
                [
                  remoteEnvironment.value.agent,
                  ...remoteEnvironment.value.runtimes
                ].some(
                  ({ state }) =>
                    state === 'update-available' ||
                    state === 'not-installed'
                )
            )
            const updateApiAvailable =
              typeof api?.updateRemoteEnvironment === 'function' &&
              typeof api.cancelRemoteEnvironmentUpdate ===
                'function' &&
              typeof api.onRemoteEnvironmentUpdateProgress ===
                'function'
            return (
              <section
                aria-label={host.name}
                className="settings-section ssh-host-card"
                key={host.id}
              >
                <div className="settings-section__title settings-section__title--actions">
                  <Server aria-hidden="true" size={17} />
                  <div>
                    <strong>{host.name}</strong>
                    <small>
                      {host.username}@{host.hostname}:{host.port}
                    </small>
                  </div>
                  <button
                    aria-label={t(
                      host.lastValidatedAt
                        ? 'sshHosts.actions.editNamed'
                        : 'sshHosts.actions.validateNamed',
                      { name: host.name }
                    )}
                    className="secondary-button"
                    disabled={
                      Boolean(busyHostId) ||
                      Boolean(editingId) ||
                      Boolean(hostEnvironmentUpdate)
                    }
                    onClick={() => {
                      setEditingId(host.id)
                      setError(undefined)
                    }}
                    type="button"
                  >
                    <Pencil aria-hidden="true" size={13} />
                    {host.lastValidatedAt
                      ? t('sshHosts.actions.edit')
                      : t('sshHosts.actions.validate')}
                  </button>
                </div>

                <dl className="ssh-host-card__facts">
                  <div>
                    <dt>{t('sshHosts.fields.authentication')}</dt>
                    <dd>
                      {t(
                        `sshHosts.authentication.${host.authentication}`
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('sshHosts.status.credential')}</dt>
                    <dd>{credentialDescription(host, t)}</dd>
                  </div>
                  <div>
                    <dt>{t('sshHosts.status.validation')}</dt>
                    <dd>
                      {host.lastValidatedAt ? (
                        <span className="ssh-host-card__verified">
                          <CheckCircle2
                            aria-hidden="true"
                            size={14}
                          />
                          {t('sshHosts.status.validated')}
                        </span>
                      ) : (
                        t('sshHosts.status.needsValidation')
                      )}
                    </dd>
                  </div>
                </dl>

                {host.hostKey.fingerprintSha256 && (
                  <code className="ssh-host-fingerprint">
                    {host.hostKey.algorithm}{' '}
                    {host.hostKey.fingerprintSha256}
                  </code>
                )}

                {result && (
                  <div className="ssh-host-test-result" role="status">
                    <CheckCircle2 aria-hidden="true" size={15} />
                    <span>
                      {t('sshHosts.testResult', {
                        platform: result.platform,
                        architecture: result.architecture,
                        latency: result.latencyMs
                      })}
                    </span>
                  </div>
                )}

                {host.lastValidatedAt && (
                  <div className="ssh-host-environment">
                    <div className="ssh-host-environment__header">
                      <div className="ssh-host-environment__summary">
                        <span>
                          <Boxes aria-hidden="true" size={16} />
                          <strong>
                            {t('sshHosts.environment.title')}
                          </strong>
                        </span>
                        <small>
                          {t('sshHosts.environment.description')}
                        </small>
                      </div>
                      <div className="ssh-host-environment__actions">
                        <button
                          aria-label={t(
                            hostEnvironmentUpdate
                              ? 'sshHosts.environment.cancelUpdateNamed'
                              : 'sshHosts.environment.updateNamed',
                            { name: host.name }
                          )}
                          className="secondary-button"
                          disabled={
                            hostEnvironmentUpdate
                              ? hostEnvironmentUpdate.cancelling ||
                                hostEnvironmentUpdate.phase ===
                                  'finalizing'
                              : !host.lastValidatedAt ||
                                !remoteEnvironment?.value ||
                                !(
                                  environmentNeedsUpdate ||
                                  remoteEnvironmentUpdateError
                                ) ||
                                !updateApiAvailable ||
                                Boolean(remoteEnvironment?.loading) ||
                                Boolean(busyHostId) ||
                                Boolean(editingId) ||
                                hasActiveRemoteEnvironmentUpdate
                          }
                          onClick={() => {
                            if (hostEnvironmentUpdate) {
                              void cancelRemoteEnvironmentUpdate(
                                host.id
                              )
                            } else {
                              void updateRemoteEnvironment(host)
                            }
                          }}
                          type="button"
                        >
                          {hostEnvironmentUpdate?.cancelling ? (
                            <LoaderCircle
                              aria-hidden="true"
                              className="ssh-host-environment__spinner"
                              size={13}
                            />
                          ) : hostEnvironmentUpdate ? (
                            <X aria-hidden="true" size={13} />
                          ) : (
                            <Download aria-hidden="true" size={13} />
                          )}
                          {hostEnvironmentUpdate?.cancelling
                            ? t('sshHosts.environment.cancelling')
                            : hostEnvironmentUpdate
                              ? t('sshHosts.environment.cancelUpdate')
                              : t('sshHosts.environment.update')}
                        </button>
                        <button
                          aria-label={t(
                            'sshHosts.environment.refreshNamed',
                            { name: host.name }
                          )}
                          className="secondary-button"
                          disabled={
                            remoteEnvironment?.loading ||
                            Boolean(hostEnvironmentUpdate)
                          }
                          onClick={() =>
                            void requestRemoteEnvironment(host.id)
                          }
                          type="button"
                        >
                          {remoteEnvironment?.loading ? (
                            <LoaderCircle
                              aria-hidden="true"
                              className="ssh-host-environment__spinner"
                              size={13}
                            />
                          ) : (
                            <RefreshCw aria-hidden="true" size={13} />
                          )}
                          {t('sshHosts.environment.refresh')}
                        </button>
                      </div>
                    </div>

                    {hostEnvironmentUpdate && (
                      <div
                        className="ssh-host-environment__loading"
                        role="status"
                      >
                        <LoaderCircle
                          aria-hidden="true"
                          className="ssh-host-environment__spinner"
                          size={16}
                        />
                        {t(
                          hostEnvironmentUpdate.cancelling
                            ? 'sshHosts.environment.progress.cancelling'
                            : hostEnvironmentUpdate.phase
                              ? `sshHosts.environment.progress.${hostEnvironmentUpdate.phase}`
                              : 'sshHosts.environment.progress.preparing'
                        )}
                      </div>
                    )}

                    {remoteEnvironmentUpdateError && (
                      <div
                        className="ssh-host-environment__error"
                        role="alert"
                      >
                        {remoteEnvironmentUpdateError}
                      </div>
                    )}

                    {remoteEnvironment?.error && (
                      <div
                        className="ssh-host-environment__error"
                        role="alert"
                      >
                        {remoteEnvironment.error}
                      </div>
                    )}

                    {remoteEnvironment?.value ? (
                      <div className="ssh-host-environment__grid">
                        <EnvironmentVersionCard
                          icon={<Bot aria-hidden="true" size={17} />}
                          installed={
                            remoteEnvironment.value.agent.installed
                          }
                          label="GoodBuddy Agent"
                          state={remoteEnvironment.value.agent.state}
                          t={t}
                          expected={
                            remoteEnvironment.value.agent.expected
                          }
                        />
                        {remoteEnvironment.value.runtimes.map(
                          (runtime) => (
                            <EnvironmentVersionCard
                              icon={
                                <Server aria-hidden="true" size={17} />
                              }
                              installed={runtime.installed}
                              key={runtime.runtimeId}
                              label={
                                runtime.runtimeId === 'opencode'
                                  ? 'OpenCode Runtime'
                                  : runtime.runtimeId
                              }
                              state={runtime.state}
                              t={t}
                              expected={runtime.expected}
                            />
                          )
                        )}
                      </div>
                    ) : remoteEnvironment?.loading ? (
                      <div
                        className="ssh-host-environment__loading"
                        role="status"
                      >
                        <LoaderCircle
                          aria-hidden="true"
                          className="ssh-host-environment__spinner"
                          size={16}
                        />
                        {t('sshHosts.environment.loading')}
                      </div>
                    ) : null}
                  </div>
                )}

                <div className="ssh-host-card__actions">
                  <DestructiveConfirmActions
                    confirmLabel={t(
                      'sshHosts.actions.confirmRemove'
                    )}
                    confirming={confirmingDeleteId === host.id}
                    disabled={
                      deleting || Boolean(hostEnvironmentUpdate)
                    }
                    message={t('sshHosts.removeMessage', {
                      name: host.name
                    })}
                    onCancel={() =>
                      setConfirmingDeleteId(undefined)
                    }
                    onConfirm={() => void remove(host)}
                    onRequestConfirm={() =>
                      setConfirmingDeleteId(host.id)
                    }
                    triggerLabel={t('sshHosts.actions.remove')}
                  />
                </div>
              </section>
            )
          })}
        </div>
      )}

      {editingId && (editingId === 'new' || editingHost) && (
        <SshHostDialog
          host={editingHost}
          onClose={() => {
            setEditingId(undefined)
            onDirtyChange?.(false)
          }}
          onDirtyChange={onDirtyChange}
          onSaved={handleSaved}
          secureStorageAvailable={secureStorageAvailable}
        />
      )}
    </div>
  )
}

function isCancellationError(reason: unknown): boolean {
  if (
    typeof reason !== 'object' ||
    reason === null
  ) {
    return false
  }
  const name =
    'name' in reason && typeof reason.name === 'string'
      ? reason.name
      : ''
  const message =
    'message' in reason && typeof reason.message === 'string'
      ? reason.message
      : ''
  return (
    name === 'AbortError' ||
    /\b(?:cancelled|canceled)\b|取消/iu.test(message)
  )
}

function EnvironmentVersionCard({
  expected,
  icon,
  installed,
  label,
  state,
  t
}: {
  expected: SshHostRemoteEnvironment['agent']['expected']
  icon: React.ReactNode
  installed:
    | SshHostRemoteEnvironment['agent']['installed']
    | SshHostRemoteEnvironment['runtimes'][number]['installed']
  label: string
  state: SshHostRemoteEnvironment['agent']['state']
  t: ReturnType<typeof useTranslation<'settingsSections'>>['t']
}): React.JSX.Element {
  return (
    <article className="ssh-host-environment__runtime">
      <div className="ssh-host-environment__runtime-header">
        <span className="ssh-host-environment__runtime-icon">
          {icon}
        </span>
        <strong>{label}</strong>
        <span
          className={`ssh-host-environment__badge ssh-host-environment__badge--${state}`}
        >
          {t(`sshHosts.environment.states.${state}`)}
        </span>
      </div>
      <dl>
        <div>
          <dt>{t('sshHosts.environment.installed')}</dt>
          <dd>
            {installed ? (
              <>
                <strong>{installed.version}</strong>
                <small>
                  {t('sshHosts.environment.versionDetail', {
                    architecture: installed.architecture
                  })}
                </small>
              </>
            ) : (
              <span>{t('sshHosts.environment.notInstalled')}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('sshHosts.environment.expected')}</dt>
          <dd>
            <strong>{expected.version}</strong>
            <small>
              {t('sshHosts.environment.versionDetail', {
                architecture: expected.architecture
              })}
            </small>
          </dd>
        </div>
      </dl>
    </article>
  )
}
