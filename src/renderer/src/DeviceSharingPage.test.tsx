import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DeviceSharingPage } from './DeviceSharingPage'
import type { DeviceSharingApi, SharingCatalog, SharingPublicationDraft } from '../../shared/device-sharing-contracts'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const settings = { deviceId: 'mine', name: 'My desktop', serverUrl: 'http://127.0.0.1:8787' }
function setup() {
  const catalog: SharingCatalog = { devices: [], publications: [] }
  const sharing = {
    getSettings: vi.fn(async () => settings), saveSettings: vi.fn(async input => ({ ...settings, ...input })),
    getCatalog: vi.fn(async () => structuredClone(catalog)),
    registerDevice: vi.fn(async () => {
      const device = { id: 'mine', name: 'My desktop', platform: 'win32', appVersion: '1', registeredAt: 'today', updatedAt: 'today' }
      catalog.devices.push(device); return device
    }),
    publish: vi.fn(async (input: SharingPublicationDraft) => {
      const item = { ...input, id: 'publication', deviceId: 'mine', status: 'published' as const, createdAt: 'today', updatedAt: 'today' }
      catalog.publications.push(item); return item
    }),
    revoke: vi.fn(async () => { catalog.publications[0]!.status = 'revoked'; return catalog.publications[0]! })
  } satisfies DeviceSharingApi
  vi.stubGlobal('goodbuddy', { sharing })
  const notify = vi.fn()
  render(<DeviceSharingPage notify={notify} />)
  return { sharing, catalog, notify }
}
it('registers, publishes independent knowledge flags, revokes and refreshes actual returned rows', async () => {
  const { sharing, notify } = setup()
  await waitFor(() => expect(screen.getByRole('button', { name: '注册本机' })).toBeEnabled())
  expect(screen.getByRole('button', { name: '发布元数据' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '注册本机' }))
  await waitFor(() => expect(screen.queryByText('暂无注册设备')).not.toBeInTheDocument())
  fireEvent.change(screen.getByLabelText('条目名称'), { target: { value: 'Shared knowledge' } })
  fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'knowledge' } })
  fireEvent.change(screen.getByLabelText('来源模式'), { target: { value: 'server' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '搜索' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '下载' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '发布元数据' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '发布元数据' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '撤销发布' })).toBeEnabled())
  expect(sharing.publish).toHaveBeenCalledWith(expect.objectContaining({ sourceMode: 'server', permissions: { search: true, read: false, download: true } }))
  const row = screen.getByText('Shared knowledge').closest('article')!
  expect(within(row).getByText(/搜索: 允许 · 读取: 不允许 · 下载: 允许/)).toBeInTheDocument()
  fireEvent.click(within(row).getByRole('button', { name: '撤销发布' }))
  fireEvent.click(screen.getByRole('button', { name: '确认撤销发布' }))
  await waitFor(() => { expect(screen.getByText('已撤销')).toBeInTheDocument(); expect(screen.getByRole('button', { name: '刷新列表' })).toBeEnabled() })
  expect(sharing.revoke).toHaveBeenCalledWith('publication')
  expect(notify).toHaveBeenCalledWith({ tone: 'success', message: '发布条目已撤销' })
})
it('preserves unsaved input on failure and does not offer revocation for other device IDs', async () => {
  const { sharing, catalog, notify } = setup()
  await waitFor(() => expect(screen.getByRole('button', { name: '注册本机' })).toBeEnabled())
  catalog.publications.push({ name: 'Other', id: 'other', deviceId: 'theirs', description: '', kind: 'capability', sourceMode: 'device', permissions: { search: false, read: false, download: false }, status: 'published', createdAt: 'today', updatedAt: 'today' })
  fireEvent.click(screen.getByRole('button', { name: '刷新列表' }))
  await screen.findByText('Other')
  expect(screen.queryByRole('button', { name: '撤销发布' })).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByLabelText('设备名称')).toBeEnabled())
  sharing.saveSettings.mockRejectedValueOnce(new Error('Disk full'))
  fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: 'My edit' } })
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', message: 'Error: Disk full' })))
  expect(screen.getByLabelText('设备名称')).toHaveValue('My edit')
  expect(screen.getByRole('button', { name: '注册本机' })).toBeDisabled()
})
