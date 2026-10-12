import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPackageInventory } from '../../shared/agent-package-contracts'
import {
  applicationSettingsSchema,
  defaultLocalToolEnvironmentSettings,
  type ApplicationSettings
} from '../../shared/application-settings-contracts'
import { changeUiLocale } from './i18n'
import { RemoteHostsPage } from './RemoteHostsPage'
import { WorkspaceUnsavedChangesContext } from './workspace-unsaved-changes'

const settings = applicationSettingsSchema.parse({
  checkUpdatesOnStartup: false,
  updateSource: 'github',
  modelDownloadSource: 'modelscope',
  localToolEnvironment: defaultLocalToolEnvironmentSettings,
  conversationHtmlRenderingEnabled: true,
  remoteProjectsEnabled: false
})
const inventory: AgentPackageInventory = {
  checkedAt: '2026-08-24T00:00:00.000Z',
  catalog: { state: 'available', checkedAt: '2026-08-24T00:00:00.000Z', error: null },
  entries: []
}
const getSnapshot = vi.fn(async () => ({ hosts: [], secureStorageAvailable: true }))
const getAgentPackageInventory = vi.fn(async () => inventory)

function renderPage(
  overrides: Partial<Parameters<typeof RemoteHostsPage>[0]> & { value?: ApplicationSettings } = {},
  report = vi.fn()
) {
  const onUpdateSettings = vi.fn(async () => true)
  const { value = settings, ...rest } = overrides
  const view = render(
    <WorkspaceUnsavedChangesContext.Provider value={report}>
      <RemoteHostsPage
        active
        settings={value}
        settingsPending={false}
        settingsLocked={false}
        onUpdateSettings={onUpdateSettings}
        onNotify={vi.fn()}
        {...rest}
      />
    </WorkspaceUnsavedChangesContext.Provider>
  )
  return { ...view, onUpdateSettings, report }
}

describe('RemoteHostsPage', () => {
  beforeEach(async () => {
    await changeUiLocale('zh-CN')
    vi.clearAllMocks()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        sshHosts: {
          getSnapshot,
          getAgentPackageInventory,
          onAgentPackageProgress: vi.fn(() => () => {}),
          onRemoteEnvironmentUpdateProgress: vi.fn(() => () => {})
        }
      }
    })
  })
  afterEach(() => cleanup())

  it('offers enablement on the Hosts tab without calling host services while remote capability is off', async () => {
    const { onUpdateSettings } = renderPage()
    expect(screen.getByRole('heading', { level: 1, name: '主机管理' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '主机' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('远程能力未启用')).toBeVisible()
    expect(getSnapshot).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '启用远程能力' }))
    expect(onUpdateSettings).toHaveBeenCalledWith({ remoteProjectsEnabled: true })
  })

  it('shows hosts when enabled and keeps every tab panel mounted while switching', async () => {
    renderPage({ value: { ...settings, remoteProjectsEnabled: true } })
    expect(await screen.findByText('尚未配置 SSH 主机')).toBeInTheDocument()
    expect(getSnapshot).toHaveBeenCalledOnce()
    expect(getAgentPackageInventory).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'Agent 离线包' }))
    expect(await screen.findByText('GoodBuddy Agent 包')).toBeVisible()
    await waitFor(() => expect(getAgentPackageInventory).toHaveBeenCalledOnce())
    expect(screen.getByText('尚未配置 SSH 主机')).not.toBeVisible()

    fireEvent.click(screen.getByRole('tab', { name: '主机' }))
    expect(screen.getByText('尚未配置 SSH 主机')).toBeVisible()
    // Panels stayed mounted: nothing was reloaded.
    expect(getSnapshot).toHaveBeenCalledOnce()
    expect(getAgentPackageInventory).toHaveBeenCalledOnce()
  })

  it('lets Agent packages be managed while remote capability is off', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Agent 离线包' }))
    expect(await screen.findByText('GoodBuddy Agent 包')).toBeVisible()
    expect(getAgentPackageInventory).toHaveBeenCalledOnce()
  })

  it('has only Hosts and Agent packages tabs; the switch stays in application settings', () => {
    renderPage()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['主机', 'Agent 离线包'])
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('pins the route while a host draft is open so the page cache keeps it', async () => {
    const report = vi.fn()
    renderPage({ value: { ...settings, remoteProjectsEnabled: true } }, report)
    await screen.findByText('尚未配置 SSH 主机')
    fireEvent.click(screen.getAllByRole('button', { name: '添加主机' })[0]!)
    fireEvent.change(screen.getByLabelText('主机名称'), { target: { value: '未保存的主机' } })
    await waitFor(() => expect(report).toHaveBeenLastCalledWith(expect.any(String), true))
  })
})
