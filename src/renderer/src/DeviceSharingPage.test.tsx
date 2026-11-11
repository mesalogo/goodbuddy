import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DeviceSharingPage } from './DeviceSharingPage'
import type { DeviceSharingApi, SharingCatalog, SharingPublicationDraft } from '../../shared/device-sharing-contracts'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const settings = { deviceId: 'mine', name: 'My desktop', serverUrl: 'http://127.0.0.1:8787' }
function setup(initial: Partial<SharingCatalog> = {}) {
  const catalog: SharingCatalog = { devices: [], publications: [], ...initial }
  const sharing = {
    getPersonas: vi.fn(async () => ({ personas: [], canCreate: true, models: [], sources: [], subjects: { members: [], groups: [] } })),
    savePersona: vi.fn(async () => { throw new Error('Unconfigured fixture') }),
    transitionPersona: vi.fn(async () => { throw new Error('Unconfigured fixture') }),
    chatPersona: vi.fn(async () => { throw new Error('Unconfigured fixture') }),
    cancelPersonaChat: vi.fn(async () => undefined),
    getModelConfigs: vi.fn(async () => ({ items: [{ id: 'config', releaseId: 'release', name: 'Team', version: '1', model: 'chat', baseURL: 'http://192.168.0.2/v1', protocol: 'openai-chat-completions' as const, routeType: 'gateway' as const, authentication: 'client-supplied-api-key' as const }] })),
    importModelConfig: vi.fn(async () => ({ imported: true })),
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
it('fetches on demand and imports the selected release after registration', async () => {
  const { sharing, notify } = setup()
  await waitFor(() => expect(screen.getByRole('button', { name: '注册本机' })).toBeEnabled())
  expect(sharing.getModelConfigs).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '获取模型配置' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '注册本机' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '获取模型配置' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '获取模型配置' }))
  const button = await screen.findByRole('button', { name: '导入模型' })
  fireEvent.click(button)
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success', message: expect.stringContaining('模型已导入') })))
  expect(sharing.importModelConfig).toHaveBeenCalledWith({ serverUrl: settings.serverUrl, id: 'config', releaseId: 'release' })
})
it('preserves unsaved input on failure and does not offer revocation for other device IDs', async () => {
  const { sharing, catalog, notify } = setup()
  await waitFor(() => expect(screen.getByRole('button', { name: '注册本机' })).toBeEnabled())
  catalog.publications.push({ name: 'Other', id: 'other', deviceId: 'theirs', description: '', kind: 'capability', sourceMode: 'device', permissions: { search: false, read: false, download: false }, status: 'published', createdAt: 'today', updatedAt: 'today' })
  fireEvent.click(screen.getByRole('button', { name: '刷新列表' }))
  fireEvent.click(screen.getByRole('tab', { name: '共享给我的' }))
  await screen.findByText('Other')
  expect(screen.queryByRole('button', { name: '撤销发布' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: '我的设备' }))
  await waitFor(() => expect(screen.getByLabelText('设备名称')).toBeEnabled())
  sharing.saveSettings.mockRejectedValueOnce(new Error('Disk full'))
  fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: 'My edit' } })
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', message: 'Error: Disk full' })))
  expect(screen.getByLabelText('设备名称')).toHaveValue('My edit')
  expect(screen.getByRole('button', { name: '注册本机' })).toBeDisabled()
})
it('separates my device content from content shared by other devices', async () => {
  const { catalog } = setup()
  catalog.devices.push({ id: 'theirs', name: 'Team laptop', platform: 'linux', appVersion: '1', registeredAt: 'today', updatedAt: 'today' })
  catalog.publications.push({ name: 'Team knowledge', id: 'shared', deviceId: 'theirs', description: '', kind: 'knowledge', sourceMode: 'server', permissions: { search: true, read: true, download: false }, status: 'published', createdAt: 'today', updatedAt: 'today' })
  fireEvent.click(screen.getByRole('button', { name: '刷新列表' }))
  await waitFor(() => expect(screen.getByRole('tab', { name: '我的设备' })).toHaveAttribute('aria-selected', 'true'))
  expect(screen.queryByText('Team knowledge')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: '共享给我的' }))
  expect(await screen.findByText('Team knowledge')).toBeInTheDocument()
  expect(screen.getByText('Team laptop')).toBeInTheDocument()
})
it('shows pending, rejection and disabled status without enabling publication', async () => {
  const { catalog } = setup()
  for (const [status, message] of [['pending', '等待 ShareServer 管理员批准'], ['rejected', '设备注册申请已被拒绝'], ['disabled', '设备已被管理员停用']] as const) {
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新列表' })).toBeEnabled())
    catalog.registrationStatus = status
    fireEvent.click(screen.getByRole('button', { name: '刷新列表' }))
    await screen.findByText(new RegExp(message))
    expect(screen.getByRole('button', { name: '发布元数据' })).toBeDisabled()
  }
})

it('registers with a member account, clears the submitted password and preserves the username on failure', async () => {
  const { sharing, notify } = setup()
  await waitFor(() => expect(screen.getByRole('button', { name: '注册本机' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '用户名和密码' }))
  expect(screen.getByRole('button', { name: '注册本机' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('成员用户名'), { target: { value: 'member-one' } })
  fireEvent.change(screen.getByLabelText('成员密码'), { target: { value: 'test-only-password' } })
  sharing.registerDevice.mockRejectedValueOnce(new Error('Sharing HTTP 401: 账号或密码错误'))
  fireEvent.keyDown(screen.getByLabelText('成员密码'), { key: 'Enter' })
  await waitFor(() => {
    expect(sharing.registerDevice).toHaveBeenCalledWith({ mode: 'account', username: 'member-one', password: 'test-only-password' })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', message: expect.stringContaining('401') }))
    expect(screen.getByLabelText('成员密码')).toHaveValue('')
    expect(screen.getByLabelText('成员用户名')).toHaveValue('member-one')
  })
  expect(sharing.saveSettings).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('成员密码'), { target: { value: 'another-password' } })
  fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://other.example:8088' } })
  expect(screen.getByLabelText('成员密码')).toHaveValue('')
})

it('restores account mode from device status without retaining or auto-submitting a password', async () => {
  const { sharing } = setup({ authenticationMode: 'account', member: { id: 'member-1', username: 'member-one', displayName: 'Member one' } })
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '用户名和密码' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('成员用户名')).toHaveValue('member-one')
    expect(screen.getByLabelText('成员密码')).toHaveValue('')
  })
  expect(screen.getByText('设备已关联成员：Member one（member-one）')).toBeInTheDocument()
  expect(sharing.registerDevice).not.toHaveBeenCalled()
})
