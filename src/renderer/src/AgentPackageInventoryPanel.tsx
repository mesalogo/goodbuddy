import { Cpu, Download, RefreshCw, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentPackageDownloadProgress,
  AgentPackageInventory
} from '../../shared/agent-package-contracts'
import type { AgentArchitecture } from '../../shared/agent-installation-contracts'
import type { AppNotificationInput } from './notifications'
import { displayErrorMessage } from './error-message'

// Local Agent package inventory used to install and update remote hosts.
// Package state lives in Main and is independent of host records.
export function AgentPackageInventoryPanel({
  active = true,
  onBusyChange,
  onNotify
}: {
  active?: boolean
  onBusyChange?: (busy: boolean) => void
  onNotify?: (notification: AppNotificationInput) => void
}): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [agentInventory, setAgentInventory] =
    useState<AgentPackageInventory>()
  const [agentInventoryLoading, setAgentInventoryLoading] =
    useState(false)
  const [agentInventoryError, setAgentInventoryError] =
    useState<string>()
  const [agentPackageBusy, setAgentPackageBusy] =
    useState<string>()
  const [agentPackageProgress, setAgentPackageProgress] =
    useState<AgentPackageDownloadProgress>()
  const agentInventoryRequested = useRef(false)

  useEffect(() => {
    onBusyChange?.(agentPackageBusy !== undefined)
  }, [agentPackageBusy, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])

  const loadAgentInventory = useCallback(async (
    refresh = false
  ): Promise<void> => {
    const getInventory =
      window.goodbuddy.sshHosts?.getAgentPackageInventory
    if (!getInventory) {
      setAgentInventoryError(
        t(
          'platformFeatures.remoteProjects.agentInventory.errors.unavailable'
        )
      )
      return
    }
    setAgentInventoryLoading(true)
    setAgentInventoryError(undefined)
    try {
      setAgentInventory(await getInventory(refresh))
    } catch (reason) {
      setAgentInventoryError(
        displayErrorMessage(
          reason,
          t(
            'platformFeatures.remoteProjects.agentInventory.errors.readFailed'
          )
        )
      )
    } finally {
      setAgentInventoryLoading(false)
    }
  }, [t])

  // Reading the inventory checks the online catalog, so it waits until shown.
  useEffect(() => {
    if (!active || agentInventoryRequested.current) {
      return
    }
    agentInventoryRequested.current = true
    void loadAgentInventory()
  }, [active, loadAgentInventory])

  useEffect(() => {
    const subscribe =
      window.goodbuddy.sshHosts?.onAgentPackageProgress
    return subscribe?.((progress) =>
      setAgentPackageProgress(progress)
    )
  }, [])

  const downloadAgentPackage = async (
    architecture: AgentArchitecture,
    platform: 'linux' | 'darwin'
  ): Promise<void> => {
    const download =
      window.goodbuddy.sshHosts?.downloadAgentPackage
    if (!download) {
      return
    }
    setAgentPackageBusy(`${platform}-${architecture}`)
    setAgentPackageProgress(undefined)
    setAgentInventoryError(undefined)
    try {
      setAgentInventory(await download(architecture, platform))
      onNotify?.({
        dedupeKey: `agent-package-downloaded:${platform}-${architecture}`,
        message: t(
          'platformFeatures.remoteProjects.agentInventory.notifications.downloaded',
          { architecture, platform: platform === 'darwin' ? 'macOS' : 'Linux' }
        ),
        tone: 'success'
      })
    } catch (reason) {
      setAgentInventoryError(
        displayErrorMessage(
          reason,
          t(
            'platformFeatures.remoteProjects.agentInventory.errors.downloadFailed'
          )
        )
      )
    } finally {
      setAgentPackageBusy(undefined)
      setAgentPackageProgress(undefined)
    }
  }

  const importAgentPackage = async (): Promise<void> => {
    const importPackage =
      window.goodbuddy.sshHosts?.importAgentPackage
    if (!importPackage) {
      return
    }
    setAgentPackageBusy('import')
    setAgentInventoryError(undefined)
    try {
      const inventory = await importPackage()
      if (inventory) {
        setAgentInventory(inventory)
        onNotify?.({
          dedupeKey: 'agent-package-imported',
          message: t(
            'platformFeatures.remoteProjects.agentInventory.notifications.imported'
          ),
          tone: 'success'
        })
      }
    } catch (reason) {
      setAgentInventoryError(
        displayErrorMessage(
          reason,
          t(
            'platformFeatures.remoteProjects.agentInventory.errors.importFailed'
          )
        )
      )
    } finally {
      setAgentPackageBusy(undefined)
    }
  }

  const exportAgentPackage = async (
    architecture: AgentArchitecture,
    platform: 'linux' | 'darwin'
  ): Promise<void> => {
    const exportPackage =
      window.goodbuddy.sshHosts?.exportAgentPackage
    if (!exportPackage) {
      return
    }
    setAgentPackageBusy(`${platform}-${architecture}`)
    setAgentInventoryError(undefined)
    try {
      await exportPackage(architecture, platform)
      onNotify?.({
        dedupeKey: `agent-package-exported:${platform}-${architecture}`,
        message: t(
          'platformFeatures.remoteProjects.agentInventory.notifications.exported',
          { architecture, platform: platform === 'darwin' ? 'macOS' : 'Linux' }
        ),
        tone: 'success'
      })
    } catch (reason) {
      setAgentInventoryError(
        displayErrorMessage(
          reason,
          t(
            'platformFeatures.remoteProjects.agentInventory.errors.exportFailed'
          )
        )
      )
    } finally {
      setAgentPackageBusy(undefined)
    }
  }

  return (
        <article className="capability-card">
          <div className="capability-card__header">
            <div>
              <strong>
                {t(
                  'platformFeatures.remoteProjects.agentInventory.title'
                )}
              </strong>
              <small>
                {t(
                  'platformFeatures.remoteProjects.agentInventory.description'
                )}
              </small>
            </div>
            <div className="capability-card__actions">
              <button
                className="secondary-button"
                disabled={agentPackageBusy !== undefined}
                onClick={() => void importAgentPackage()}
                type="button"
              >
                <Upload aria-hidden="true" size={13} />
                {t(
                  'platformFeatures.remoteProjects.agentInventory.import'
                )}
              </button>
              <button
                aria-label={t(
                  'platformFeatures.remoteProjects.agentInventory.refresh'
                )}
                className="secondary-button"
                disabled={
                  agentInventoryLoading ||
                  agentPackageBusy !== undefined
                }
                onClick={() => void loadAgentInventory(true)}
                type="button"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={
                    agentInventoryLoading
                      ? 'bundled-agent-inventory__spinner'
                      : undefined
                  }
                  size={13}
                />
                {t(
                  'platformFeatures.remoteProjects.agentInventory.refresh'
                )}
              </button>
            </div>
          </div>
          {agentInventory && (
            <p className="settings-notice">
              {t(
                'platformFeatures.remoteProjects.agentInventory.summary',
                {
                  available: agentInventory.entries.filter(
                    (entry) => entry.state === 'verified'
                  ).length,
                  total: agentInventory.entries.length
                }
              )}
            </p>
          )}
          {agentInventoryLoading && !agentInventory ? (
            <p className="settings-notice" role="status">
              {t(
                'platformFeatures.remoteProjects.agentInventory.loading'
              )}
            </p>
          ) : agentInventoryError ? (
            <p className="settings-warning" role="alert">
              {agentInventoryError}
            </p>
          ) : agentInventory ? (
            <div
              aria-label={t(
                'platformFeatures.remoteProjects.agentInventory.listLabel'
              )}
              className="bundled-agent-inventory"
              role="list"
            >
              {agentInventory.entries.map((entry) => (
                <article
                  className="bundled-agent-inventory__item"
                  key={`${entry.platform}-${entry.architecture}`}
                  role="listitem"
                >
                  <div className="bundled-agent-inventory__item-header">
                    <Cpu aria-hidden="true" size={16} />
                    <strong>
                      {entry.platform === 'darwin' ? 'macOS' : 'Linux'} {entry.architecture}
                    </strong>
                    <span
                      className={`bundled-agent-inventory__badge bundled-agent-inventory__badge--${
                        entry.updateAvailable
                          ? 'update-available'
                          : agentInventory.catalog.state ===
                              'available' &&
                              entry.state === 'verified' &&
                              entry.latestVersion !== null
                            ? 'up-to-date'
                            : entry.state
                      }`}
                    >
                      {t(
                        entry.updateAvailable
                          ? 'platformFeatures.remoteProjects.agentInventory.states.updateAvailable'
                          : agentInventory.catalog.state ===
                              'available' &&
                              entry.state === 'verified' &&
                              entry.latestVersion !== null
                            ? 'platformFeatures.remoteProjects.agentInventory.states.upToDate'
                            : `platformFeatures.remoteProjects.agentInventory.states.${entry.state}`
                      )}
                    </span>
                  </div>
                  <dl>
                    <div>
                      <dt>
                        {t(
                          'platformFeatures.remoteProjects.agentInventory.fields.agentVersion'
                        )}
                      </dt>
                      <dd>{entry.version ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>
                        {t(
                          'platformFeatures.remoteProjects.agentInventory.fields.latestVersion'
                        )}
                      </dt>
                      <dd>{entry.latestVersion ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>
                        {t(
                          'platformFeatures.remoteProjects.agentInventory.fields.architecture'
                        )}
                      </dt>
                      <dd>{entry.architecture}</dd>
                    </div>
                    <div>
                      <dt>
                        {t(
                          'platformFeatures.remoteProjects.agentInventory.fields.runtimeVersion'
                        )}
                      </dt>
                      <dd>{entry.remoteRuntimeVersion ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>
                        {t(
                          'platformFeatures.remoteProjects.agentInventory.fields.protocol'
                        )}
                      </dt>
                      <dd>
                        {entry.agentProtocol
                          ? `${entry.agentProtocol.major}.${entry.agentProtocol.minor}`
                          : '—'}
                      </dd>
                    </div>
                  </dl>
                  {agentPackageProgress?.architecture ===
                    entry.architecture &&
                    agentPackageProgress.platform === entry.platform &&
                    agentPackageBusy === `${entry.platform}-${entry.architecture}` && (
                      <p className="settings-notice" role="status">
                        {t(
                          `platformFeatures.remoteProjects.agentInventory.progress.${agentPackageProgress.phase}`
                        )}
                      </p>
                    )}
                  <div className="capability-card__actions">
                    {(
                      entry.updateAvailable ||
                      (
                        entry.state !== 'verified' &&
                        entry.latestVersion !== null
                      ) ||
                      agentInventory.catalog.state !== 'available'
                    ) && (
                      <button
                        className="secondary-button"
                        disabled={agentPackageBusy !== undefined}
                        onClick={() =>
                          void downloadAgentPackage(
                            entry.architecture,
                            entry.platform
                          )
                        }
                        type="button"
                      >
                        <Download aria-hidden="true" size={13} />
                        {t(
                          entry.updateAvailable
                            ? 'platformFeatures.remoteProjects.agentInventory.updateTo'
                            : entry.state !== 'verified' &&
                                entry.latestVersion !== null
                              ? 'platformFeatures.remoteProjects.agentInventory.downloadVersion'
                              : 'platformFeatures.remoteProjects.agentInventory.update',
                          { version: entry.latestVersion }
                        )}
                      </button>
                    )}
                    {entry.state === 'verified' && (
                      <button
                        className="secondary-button"
                        disabled={agentPackageBusy !== undefined}
                        onClick={() =>
                          void exportAgentPackage(
                            entry.architecture,
                            entry.platform
                          )
                        }
                        type="button"
                      >
                        <Upload aria-hidden="true" size={13} />
                        {t(
                          'platformFeatures.remoteProjects.agentInventory.export'
                        )}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : null}
          {agentInventory?.catalog.state === 'available' && (
            <p className="settings-notice" role="status">
              {t(
                'platformFeatures.remoteProjects.agentInventory.catalog.available'
              )}
            </p>
          )}
          {agentInventory?.catalog.state === 'unavailable' && (
            <p className="settings-warning" role="alert">
              {t(
                'platformFeatures.remoteProjects.agentInventory.catalog.unavailable',
                { error: agentInventory.catalog.error }
              )}
            </p>
          )}
        </article>
  )
}
