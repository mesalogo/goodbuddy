import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPackageInventory } from '../../shared/agent-package-contracts'
import { AgentPackageInventoryPanel } from './AgentPackageInventoryPanel'
import { changeUiLocale } from './i18n'

const agentPackageInventory: AgentPackageInventory = {
  checkedAt: '2026-08-24T00:00:00.000Z',
  catalog: {
    state: 'available',
    checkedAt: '2026-08-24T00:00:00.000Z',
    error: null
  },
  entries: [
    {
      platform: 'linux',
      architecture: 'x64',
      state: 'verified',
      version: '0.11.2',
      latestVersion: '0.11.4',
      updateAvailable: true,
      agentProtocol: { major: 2, minor: 0 },
      remoteRuntimeVersion: '1.18.29'
    },
    {
      platform: 'linux',
      architecture: 'arm64',
      state: 'not-downloaded',
      version: null,
      latestVersion: '0.11.4',
      updateAvailable: false,
      agentProtocol: null,
      remoteRuntimeVersion: null
    }
  ]
}
const getAgentPackageInventory = vi.fn<(refresh?: boolean, localOnly?: boolean) => Promise<AgentPackageInventory>>()
const downloadAgentPackage = vi.fn<(architecture: string, platform: string) => Promise<AgentPackageInventory>>()
const importAgentPackage = vi.fn<() => Promise<AgentPackageInventory | undefined>>()
const exportAgentPackage = vi.fn<(architecture: string, platform: string) => Promise<void>>()
const onAgentPackageProgress = vi.fn(() => () => {})

describe('AgentPackageInventoryPanel', () => {
  beforeEach(async () => {
    await changeUiLocale('zh-CN')
    vi.clearAllMocks()
    getAgentPackageInventory.mockResolvedValue(agentPackageInventory)
    downloadAgentPackage.mockResolvedValue(agentPackageInventory)
    importAgentPackage.mockResolvedValue(agentPackageInventory)
    exportAgentPackage.mockResolvedValue(undefined)
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        sshHosts: {
          getAgentPackageInventory,
          downloadAgentPackage,
          importAgentPackage,
          exportAgentPackage,
          onAgentPackageProgress
        }
      }
    })
  })
  afterEach(() => cleanup())

  it('waits until shown, then lists, refreshes, downloads, exports, and imports packages', async () => {
    const onNotify = vi.fn()
    const onBusyChange = vi.fn()
    const { rerender } = render(
      <AgentPackageInventoryPanel active={false} onBusyChange={onBusyChange} onNotify={onNotify} />
    )
    expect(getAgentPackageInventory).not.toHaveBeenCalled()
    rerender(<AgentPackageInventoryPanel active onBusyChange={onBusyChange} onNotify={onNotify} />)

    expect(await screen.findByText('GoodBuddy Agent 包')).toBeInTheDocument()
    expect(await screen.findByText('当前 1 / 2 个平台与架构目标可用。')).toBeInTheDocument()
    expect(screen.getByText('有更新')).toBeInTheDocument()
    expect(screen.getByText('未下载')).toBeInTheDocument()
    expect(getAgentPackageInventory).toHaveBeenNthCalledWith(1, false, true)
    expect(getAgentPackageInventory).toHaveBeenNthCalledWith(2, false)

    fireEvent.click(screen.getByRole('button', { name: '刷新包清单' }))
    await waitFor(() => expect(getAgentPackageInventory).toHaveBeenCalledTimes(3))
    expect(getAgentPackageInventory).toHaveBeenNthCalledWith(3, true)

    const x64Card = screen.getByText('Linux x64').closest('[role="listitem"]') as HTMLElement
    const arm64Card = screen.getByText('Linux arm64').closest('[role="listitem"]') as HTMLElement
    downloadAgentPackage.mockResolvedValueOnce({
      ...agentPackageInventory,
      entries: agentPackageInventory.entries.map((entry) =>
        entry.architecture === 'x64' ? { ...entry, version: '0.11.4', updateAvailable: false } : entry
      )
    })
    fireEvent.click(within(x64Card).getByRole('button', { name: '更新到 0.11.4' }))
    await waitFor(() => expect(downloadAgentPackage).toHaveBeenCalledWith('x64', 'linux'))
    expect(await within(x64Card).findByText('已是最新')).toBeInTheDocument()
    expect(onBusyChange).toHaveBeenCalledWith(true)
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false))

    fireEvent.click(within(x64Card).getByRole('button', { name: '导出离线包' }))
    await waitFor(() => expect(exportAgentPackage).toHaveBeenCalledWith('x64', 'linux'))
    await waitFor(() => expect(within(arm64Card).getByRole('button', { name: '下载 0.11.4' })).toBeEnabled())
    fireEvent.click(within(arm64Card).getByRole('button', { name: '下载 0.11.4' }))
    await waitFor(() => expect(downloadAgentPackage).toHaveBeenCalledWith('arm64', 'linux'))
    await waitFor(() => expect(screen.getByRole('button', { name: '导入离线包' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '导入离线包' }))
    await waitFor(() => expect(importAgentPackage).toHaveBeenCalledOnce())
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'agent-package-imported' })))
  })

  it('shows the local inventory before the online catalog returns', async () => {
    const localInventory: AgentPackageInventory = {
      ...agentPackageInventory,
      catalog: { state: 'not-checked', checkedAt: null, error: null },
      entries: agentPackageInventory.entries.map((entry) => ({
        ...entry,
        latestVersion: null,
        updateAvailable: false
      }))
    }
    let resolveOnline: ((inventory: AgentPackageInventory) => void) | undefined
    getAgentPackageInventory
      .mockResolvedValueOnce(localInventory)
      .mockReturnValueOnce(
        new Promise<AgentPackageInventory>((resolve) => {
          resolveOnline = resolve
        })
      )

    render(<AgentPackageInventoryPanel />)
    expect(await screen.findByText('当前 1 / 2 个平台与架构目标可用。')).toBeInTheDocument()
    expect(getAgentPackageInventory).toHaveBeenNthCalledWith(1, false, true)
    expect(getAgentPackageInventory).toHaveBeenNthCalledWith(2, false)

    await act(async () => {
      resolveOnline?.(agentPackageInventory)
      await Promise.resolve()
    })
    expect(await screen.findByText('有更新')).toBeInTheDocument()
  })

  it('shows loading and recovers from a refresh error', async () => {
    let resolveInventory: ((inventory: AgentPackageInventory) => void) | undefined
    getAgentPackageInventory.mockReturnValueOnce(
      new Promise<AgentPackageInventory>((resolve) => { resolveInventory = resolve })
    )
    render(<AgentPackageInventoryPanel />)
    expect(await screen.findByText('正在校验本地 Agent 包并检查在线版本…')).toBeInTheDocument()
    await act(async () => {
      resolveInventory?.(agentPackageInventory)
      await Promise.resolve()
    })
    expect(await screen.findByText('当前 1 / 2 个平台与架构目标可用。')).toBeInTheDocument()

    getAgentPackageInventory.mockRejectedValueOnce(new Error('inventory unavailable'))
    fireEvent.click(screen.getByRole('button', { name: '刷新包清单' }))
    await screen.findByText('inventory unavailable')
    fireEvent.click(screen.getByRole('button', { name: '刷新包清单' }))
    await waitFor(() => expect(screen.queryByText('inventory unavailable')).not.toBeInTheDocument())
    expect(getAgentPackageInventory).toHaveBeenCalledTimes(4)
  })

  it('keeps local Agent packages usable when the online catalog is unavailable', async () => {
    const unavailableInventory: AgentPackageInventory = {
      ...agentPackageInventory,
      catalog: { state: 'unavailable', checkedAt: '2026-08-24T00:00:00.000Z', error: 'network unavailable' },
      entries: agentPackageInventory.entries.map((entry) => ({ ...entry, latestVersion: null, updateAvailable: false }))
    }
    getAgentPackageInventory
      .mockResolvedValueOnce(unavailableInventory)
      .mockResolvedValueOnce(unavailableInventory)
    render(<AgentPackageInventoryPanel />)
    expect(await screen.findByText(/network unavailable/u)).toBeInTheDocument()
    const x64Card = screen.getByText('Linux x64').closest('[role="listitem"]') as HTMLElement
    expect(within(x64Card).getByRole('button', { name: '检查并更新' })).toBeInTheDocument()
    expect(within(x64Card).getByRole('button', { name: '导出离线包' })).toBeInTheDocument()
  })
})
