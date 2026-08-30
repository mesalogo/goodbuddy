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
  RemoteEnvironmentPreparationMethod,
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
  getCachedSshHostRemoteEnvironments,
  removeCachedSshHostRemoteEnvironment,
  setCachedSshHostRemoteEnvironment
} from './ssh-host-remote-environment-cache'
import {
  DestructiveConfirmActions,
  EmptyState,
  SegmentedControl
} from './WorkspacePrimitives'

type SshHostsSettingsSectionProps = {
  onDirtyChange?: (dirty: boolean) => void
  onHostUpdated?: (hostId: string) => void
  onNotify?: (notification: AppNotificationInput) => void
  onProjectsDeleted?: (projectIds: string[]) => void
}

type RemoteEnvironmentLoadState = {
  loading: boolean
  value?: SshHostRemoteEnvironment
  error?: string
}

type RemoteEnvironmentUpdateState = {
  hostId: string
  requestedMethod: RemoteEnvironmentPreparationMethod
  resolvedMethod?: RemoteEnvironmentPreparationMethod
  requestId: number
  phase?: RemoteEnvironmentUpdatePhase
  cancelling: boolean
}

type ActiveRemoteEnvironmentUpdate = {
  hostId: string
  requestedMethod: RemoteEnvironmentPreparationMethod
  requestId: number
  cancelRequested: boolean
  cancelError?: string
}

type RemoteEnvironmentUpdateError = {
  detail: string
  reinstallAttempt: boolean
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
  onNotify,
  onProjectsDeleted
}: SshHostsSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [hosts, setHosts] = useState<SshHost[]>([])
  const [secureStorageAvailable, setSecureStorageAvailable] =
    useState(false)
  const [projectReferences, setProjectReferences] =
    useState<SshHostsSnapshot['projectReferences']>()
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
  >(() =>
    Object.fromEntries(
      Object.entries(getCachedSshHostRemoteEnvironments()).map(
        ([hostId, value]) => [
          hostId,
          { loading: false, value }
        ]
      )
    )
  )
  const [
    remoteEnvironmentPreparationMethods,
    setRemoteEnvironmentPreparationMethods
  ] = useState<Record<string, RemoteEnvironmentPreparationMethod>>({})
  const [remoteEnvironmentUpdate, setRemoteEnvironmentUpdate] =
    useState<RemoteEnvironmentUpdateState>()
  const [
    remoteEnvironmentUpdateErrors,
    setRemoteEnvironmentUpdateErrors
  ] = useState<Record<string, RemoteEnvironmentUpdateError>>({})
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
      ({ hostId, method, phase }) => {
        const activeUpdate = activeRemoteEnvironmentUpdate.current
        if (
          !mounted.current ||
          !activeUpdate ||
          activeUpdate.hostId !== hostId ||
          (activeUpdate.requestedMethod !== 'auto' &&
            activeUpdate.requestedMethod !== method)
        ) {
          return
        }
        setRemoteEnvironmentUpdate((current) => {
          if (
            !current ||
            current.requestId !== activeUpdate.requestId ||
            (current.phase === phase &&
              current.resolvedMethod === method)
          ) {
            return current
          }
          return {
            ...current,
            resolvedMethod: method,
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
      setProjectReferences(snapshot.projectReferences)
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
        setCachedSshHostRemoteEnvironment(value)
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
    host: SshHost,
    method: RemoteEnvironmentPreparationMethod
  ): Promise<void> => {
    if (
      typeof api?.updateRemoteEnvironment !== 'function' ||
      activeRemoteEnvironmentUpdate.current
    ) {
      return
    }
    removeCachedSshHostRemoteEnvironment(host.id)
    const requestId = remoteEnvironmentUpdateRequestId.current + 1
    remoteEnvironmentUpdateRequestId.current = requestId
    const activeUpdate: ActiveRemoteEnvironmentUpdate = {
      hostId: host.id,
      requestedMethod: method,
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
      requestedMethod: method,
      requestId,
      cancelling: false
    })

    let succeeded = false
    const currentEnvironment = remoteEnvironments[host.id]?.value
    const reinstallingMatchedEnvironment =
      currentEnvironment !== undefined &&
      [
        currentEnvironment.agent,
        ...currentEnvironment.runtimes
      ].every(({ state }) => state === 'current')
    try {
      await api.updateRemoteEnvironment({
        hostId: host.id,
        method
      })
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
          [host.id]: {
            detail: message,
            reinstallAttempt:
              reinstallingMatchedEnvironment && !cancelled
          }
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
          [hostId]: {
            detail: activeUpdate.cancelError!,
            reinstallAttempt: false
          }
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

  const notify = (
    dedupeKey: string,
    message: string,
    tone: AppNotificationInput['tone'] = 'success'
  ): void => {
    onNotify?.({ dedupeKey, message, tone })
  }

  const handleSaved = (result: SshHostValidationResult): void => {
    const edited = hosts.some((host) => host.id === result.host.id)
    removeCachedSshHostRemoteEnvironment(result.host.id)
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
      const result = await api.remove(host.id)
      onProjectsDeleted?.(
        result.deletedProjects.map((project) => project.id)
      )
      setConfirmingDeleteId(undefined)
      removeCachedSshHostRemoteEnvironment(host.id)
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
      setRemoteEnvironmentPreparationMethods((current) => {
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
      setProjectReferences((current) => {
        if (!current || !(host.id in current)) {
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
            const relatedProjects =
              projectReferences?.[host.id] ?? []
            const result = testResults[host.id]
            const remoteEnvironment = remoteEnvironments[host.id]
            const hostEnvironmentUpdate =
              remoteEnvironmentUpdate?.hostId === host.id
                ? remoteEnvironmentUpdate
                : undefined
            const remoteEnvironmentUpdateError =
              remoteEnvironmentUpdateErrors[host.id]
            const deleting = busyHostId === host.id
            const environmentComponents = remoteEnvironment?.value
              ? [
                  remoteEnvironment.value.agent,
                  ...remoteEnvironment.value.runtimes
                ]
              : []
            const environmentAction =
              environmentComponents.some(
                ({ state }) => state === 'not-installed'
              )
                ? 'install'
                : environmentComponents.some(
                      ({ state }) => state === 'update-available'
                    )
                  ? 'update'
                  : 'reinstall'
            const remoteDownload =
              remoteEnvironment?.value?.remoteDownload
            const directDownloadActionAvailable =
              remoteDownload?.available === true ||
              remoteDownload?.reason === 'probe-failed'
            const preparationMethod =
              remoteEnvironmentPreparationMethods[host.id] ?? 'auto'
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

                    {!hostEnvironmentUpdate && (
                      <div className="ssh-host-environment__toolbar">
                        <div className="ssh-host-environment__method">
                          <span>
                            {t('sshHosts.environment.methodLabel')}
                          </span>
                          <SegmentedControl
                            ariaLabel={t(
                              'sshHosts.environment.methodSelectorNamed',
                              { name: host.name }
                            )}
                            disabled={
                              !host.lastValidatedAt ||
                              !remoteEnvironment?.value ||
                              !updateApiAvailable ||
                              Boolean(remoteEnvironment?.loading) ||
                              Boolean(busyHostId) ||
                              Boolean(editingId) ||
                              hasActiveRemoteEnvironmentUpdate
                            }
                            onChange={(method) =>
                              setRemoteEnvironmentPreparationMethods(
                                (current) => ({
                                  ...current,
                                  [host.id]: method
                                })
                              )
                            }
                            options={[
                              {
                                value: 'auto',
                                label: t(
                                  'sshHosts.environment.methods.auto'
                                )
                              },
                              {
                                value: 'remote-download',
                                label: t(
                                  'sshHosts.environment.methods.remote-download'
                                )
                              },
                              {
                                value: 'goodbuddy-transfer',
                                label: t(
                                  'sshHosts.environment.methods.goodbuddy-transfer'
                                )
                              }
                            ]}
                            value={preparationMethod}
                          />
                        </div>
                        <button
                          aria-label={t(
                            `sshHosts.environment.actions.${environmentAction}Named`,
                            { name: host.name }
                          )}
                          className="primary-button"
                          disabled={
                            !host.lastValidatedAt ||
                            !remoteEnvironment?.value ||
                            !updateApiAvailable ||
                            (preparationMethod === 'remote-download' &&
                              !directDownloadActionAvailable) ||
                            Boolean(remoteEnvironment?.loading) ||
                            Boolean(busyHostId) ||
                            Boolean(editingId) ||
                            hasActiveRemoteEnvironmentUpdate
                          }
                          onClick={() => {
                            void updateRemoteEnvironment(
                              host,
                              preparationMethod
                            )
                          }}
                          type="button"
                        >
                          <Download aria-hidden="true" size={13} />
                          {t(
                            `sshHosts.environment.actions.${environmentAction}`
                          )}
                        </button>
                      </div>
                    )}

                    {remoteDownload &&
                      !remoteDownload.available && (
                        <div className="ssh-host-environment__availability">
                          {t(
                            `sshHosts.environment.remoteDownloadUnavailable.${remoteDownload.reason}`,
                            {
                              source: remoteDownload.source
                                ? t(
                                    `sshHosts.environment.sources.${remoteDownload.source}`
                                  )
                                : undefined
                            }
                          )}
                          {remoteDownload.packageSize && (
                            <small>
                              {t(
                                'sshHosts.environment.remoteDownloadPackageSize',
                                {
                                  size: formatPackageSize(
                                    remoteDownload.packageSize
                                  )
                                }
                              )}
                            </small>
                          )}
                        </div>
                      )}

                    {hostEnvironmentUpdate && (
                      <div
                        className="ssh-host-environment__loading ssh-host-environment__loading--update"
                        role="status"
                      >
                        <LoaderCircle
                          aria-hidden="true"
                          className="ssh-host-environment__spinner"
                          size={16}
                        />
                        <span>
                          {!hostEnvironmentUpdate.cancelling && (
                            <strong>
                              {t(
                                `sshHosts.environment.methods.${hostEnvironmentUpdate.resolvedMethod ?? hostEnvironmentUpdate.requestedMethod}`
                              )}
                            </strong>
                          )}
                          <span>
                            {t(
                              hostEnvironmentUpdate.cancelling
                                ? 'sshHosts.environment.progress.cancelling'
                                : hostEnvironmentUpdate.phase
                                  ? `sshHosts.environment.progress.${hostEnvironmentUpdate.phase}`
                                  : 'sshHosts.environment.progress.preparing'
                            )}
                          </span>
                        </span>
                        <button
                          aria-label={t(
                            'sshHosts.environment.cancelUpdateNamed',
                            { name: host.name }
                          )}
                          className="secondary-button"
                          disabled={
                            hostEnvironmentUpdate.cancelling ||
                            hostEnvironmentUpdate.phase === 'finalizing' ||
                            hostEnvironmentUpdate.phase === 'complete'
                          }
                          onClick={() =>
                            void cancelRemoteEnvironmentUpdate(host.id)
                          }
                          type="button"
                        >
                          {hostEnvironmentUpdate.cancelling ? (
                            <LoaderCircle
                              aria-hidden="true"
                              className="ssh-host-environment__spinner"
                              size={13}
                            />
                          ) : (
                            <X aria-hidden="true" size={13} />
                          )}
                          {hostEnvironmentUpdate.cancelling
                            ? t('sshHosts.environment.cancelling')
                            : t('sshHosts.environment.cancelUpdate')}
                        </button>
                      </div>
                    )}

                    {remoteEnvironmentUpdateError && (
                      <div
                        className="ssh-host-environment__error"
                        role="alert"
                      >
                        {remoteEnvironmentUpdateError.reinstallAttempt && (
                          <strong>
                            {t(
                              'sshHosts.environment.errors.reinstallFailedSummary'
                            )}
                          </strong>
                        )}
                        <span>{remoteEnvironmentUpdateError.detail}</span>
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
                    ) : (
                      <div className="ssh-host-environment__availability">
                        {t('sshHosts.environment.notChecked')}
                      </div>
                    )}
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
                    message={
                      confirmingDeleteId === host.id ? (
                        <div className="ssh-host-remove-confirmation">
                          <p>
                            {t('sshHosts.removeMessage', {
                              name: host.name
                            })}
                          </p>
                          {relatedProjects.length > 0 && (
                            <>
                              <strong>
                                {t('sshHosts.removeProjectsHeading')}
                              </strong>
                              <ul>
                                {relatedProjects.map((project) => (
                                  <li key={project.id}>
                                    {project.name}
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      ) : null
                    }
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

function formatPackageSize(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024)
  return `${mebibytes >= 10 ? Math.round(mebibytes) : mebibytes.toFixed(1)} MiB`
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
