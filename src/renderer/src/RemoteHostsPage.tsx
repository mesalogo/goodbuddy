import { Server } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentPackageInventoryPanel } from './AgentPackageInventoryPanel'
import type {
  ApplicationSettings,
  ApplicationSettingsUpdate
} from '../../shared/application-settings-contracts'
import type { AppNotificationInput } from './notifications'
import { SshHostsSettingsSection } from './SshHostsSettingsSection'
import { useWorkspaceUnsavedChanges } from './workspace-unsaved-changes'
import { EmptyState, PageHeader, PageShell, PageTabs } from './WorkspacePrimitives'
import './remote-hosts.css'

export type RemoteHostsTab = 'hosts' | 'packages'

/**
 * Hosts application: SSH hosts and local Agent packages. The shared remote
 * capability switch lives in the application settings (Application Center).
 * Host operations stay gated by remoteProjectsEnabled in Main, so the Hosts
 * tab offers enabling it instead of failing.
 */
export function RemoteHostsPage({
  active,
  settings,
  settingsPending,
  settingsLocked,
  onUpdateSettings,
  onNotify,
  onHostUpdated,
  onProjectsDeleted
}: {
  active: boolean
  settings?: ApplicationSettings
  settingsPending: boolean
  settingsLocked: boolean
  onUpdateSettings: (patch: ApplicationSettingsUpdate) => Promise<boolean>
  onNotify: (notification: AppNotificationInput) => void
  onHostUpdated?: (hostId: string) => void
  onProjectsDeleted?: (projectIds: string[]) => void
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const [tab, setTab] = useState<RemoteHostsTab>('hosts')
  const [hostDraftDirty, setHostDraftDirty] = useState(false)
  const [hostsBusy, setHostsBusy] = useState(false)
  const [packagesBusy, setPackagesBusy] = useState(false)
  const remoteEnabled = settings?.remoteProjectsEnabled === true
  const [packagesVisited, setPackagesVisited] = useState(false)

  // Pins the route while a host draft, installation, or package transfer is
  // in progress so the cache never discards it.
  useWorkspaceUnsavedChanges(hostDraftDirty || hostsBusy || packagesBusy)

  // Derived during render: the package inventory loads once its tab is first shown.
  if (active && tab === 'packages' && !packagesVisited) setPackagesVisited(true)

  const handleHostsDirty = useCallback((dirty: boolean) => setHostDraftDirty(dirty), [])
  const handleHostsBusy = useCallback((busy: boolean) => setHostsBusy(busy), [])
  const handlePackagesBusy = useCallback((busy: boolean) => setPackagesBusy(busy), [])

  return (
    <PageShell variant="standard">
      <PageHeader
        headingId="remote-hosts-title"
        icon={<Server size={18} />}
        title={t('remoteHosts.title')}
        description={t('remoteHosts.description')}
        scope={{ kind: 'global' }}
      />
      <div className="remote-hosts-tabs">
        <PageTabs
          ariaLabel={t('remoteHosts.tabsLabel')}
          idPrefix="remote-hosts"
          onChange={setTab}
          tabs={[
            { id: 'hosts', label: t('remoteHosts.tabs.hosts') },
            { id: 'packages', label: t('remoteHosts.tabs.packages') }
          ]}
          value={tab}
        />
      </div>
      {/* Panels stay mounted so in-flight installs and transfers keep reporting progress. */}
      <section
        aria-labelledby="remote-hosts-tab-hosts"
        className="remote-hosts-panel"
        hidden={tab !== 'hosts'}
        id="remote-hosts-panel-hosts"
        role="tabpanel"
      >
        {remoteEnabled ? (
          <SshHostsSettingsSection
            onBusyChange={handleHostsBusy}
            onDirtyChange={handleHostsDirty}
            onHostUpdated={onHostUpdated}
            onNotify={onNotify}
            onProjectsDeleted={onProjectsDeleted}
          />
        ) : (
          <EmptyState
            action={
              <button
                className="primary-button"
                disabled={!settings || settingsPending || settingsLocked}
                onClick={() => void onUpdateSettings({ remoteProjectsEnabled: true })}
                type="button"
              >
                {t('remoteHosts.disabled.enable')}
              </button>
            }
            description={t('remoteHosts.disabled.description')}
            icon={<Server size={22} />}
            title={t('remoteHosts.disabled.title')}
          />
        )}
      </section>
      <section
        aria-labelledby="remote-hosts-tab-packages"
        className="remote-hosts-panel"
        hidden={tab !== 'packages'}
        id="remote-hosts-panel-packages"
        role="tabpanel"
      >
        <AgentPackageInventoryPanel
          active={packagesVisited}
          onBusyChange={handlePackagesBusy}
          onNotify={onNotify}
        />
      </section>
    </PageShell>
  )
}
