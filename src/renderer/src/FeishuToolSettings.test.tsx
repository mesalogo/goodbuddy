import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultFeishuToolSettings, type FeishuApiBridge, type FeishuSnapshot } from '../../shared/feishu-contracts'
import { FeishuAppRegistration, FeishuToolSettings } from './FeishuToolSettings'
import { FeishuWorkbarPanel } from './FeishuWorkbarPanel'
import i18n from './i18n'

let revision = 0
function snapshot(overrides: Partial<FeishuSnapshot> = {}): FeishuSnapshot {
  revision += 1
  return { revision, credentialsConfigured: true, appEnabled: true, appId: 'cli_app', domain: 'feishu', settings: defaultFeishuToolSettings(), registration: { state: 'idle' }, ...overrides }
}

function installApi(initial: FeishuSnapshot, overrides: Partial<FeishuApiBridge> = {}) {
  let listener: ((next: FeishuSnapshot) => void) | undefined
  const api = {
    getSnapshot: vi.fn(async () => initial),
    updateSettings: vi.fn(async () => initial),
    startRegistration: vi.fn(async () => initial),
    cancelRegistration: vi.fn(async () => initial),
    browse: vi.fn(async () => ({ items: [] })),
    searchDocuments: vi.fn(async () => []),
    createDocument: vi.fn(async (input: { title: string }) => ({ kind: 'file' as const, token: 'd-new', name: input.title })),
    uploadFile: vi.fn(async () => undefined),
    onChanged: vi.fn((next: (s: FeishuSnapshot) => void) => { listener = next; return () => { listener = undefined } }),
    ...overrides
  } as FeishuApiBridge
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { feishu: api } })
  return { api, push: (next: FeishuSnapshot) => act(() => listener?.(next)) }
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('zh-CN')
})

describe('FeishuToolSettings', () => {
  it('requires credentials before editing and defaults permission management off', async () => {
    installApi(snapshot({ credentialsConfigured: false }))
    render(<FeishuToolSettings />)
    expect(await screen.findByText('先在上方填写或扫码创建 App ID 和 App Secret 并保存。')).toBeInTheDocument()
    // No separate tool switch: availability follows the application switch.
    expect(screen.queryByRole('switch', { name: '在对话中提供飞书工具' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /权限管理/u })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /^文档/u })).toBeDisabled()
  })

  it('saves category changes, explains an off application, and ties 知识库 to 文档', async () => {
    const { api } = installApi(snapshot({ appEnabled: false, settings: { ...defaultFeishuToolSettings(), categories: { ...defaultFeishuToolSettings().categories, doc: false } } }))
    render(<FeishuToolSettings />)
    expect(await screen.findByText(/应用已关闭/u)).toBeInTheDocument()
    const wiki = screen.getByRole('checkbox', { name: /知识库/u })
    expect(wiki).toBeDisabled()
    expect(wiki).not.toBeChecked()
    expect(screen.getByText('依赖“文档”类别，开启“文档”后可用')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /^文档/u }))
    expect(api.updateSettings).toHaveBeenLastCalledWith({ categories: { doc: true } })
  })
})

describe('FeishuAppRegistration', () => {
  it('shows the QR code and reloads channel settings when the app is created', async () => {
    const { api, push } = installApi(snapshot())
    const onCreated = vi.fn()
    render(<FeishuAppRegistration domain="lark" onCreated={onCreated} />)
    fireEvent.click(await screen.findByRole('button', { name: '扫码创建飞书应用' }))
    expect(api.startRegistration).toHaveBeenCalledWith('lark')
    push(snapshot({ registration: { state: 'waiting', url: 'https://accounts.feishu.cn/x', expiresAt: new Date(Date.now() + 60_000).toISOString() } }))
    expect(await screen.findByText(/请用飞书手机端扫描二维码/u)).toBeInTheDocument()
    push(snapshot({ registration: { state: 'completed' } }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    // Later snapshots that still say "completed" must not reload (and wipe) the form again.
    push(snapshot({ registration: { state: 'completed' } }))
    push(snapshot({ registration: { state: 'completed' }, settings: { ...defaultFeishuToolSettings(), enabled: true } }))
    expect(onCreated).toHaveBeenCalledOnce()
    push(snapshot({ registration: { state: 'failed', message: 'access denied' } }))
    expect(await screen.findByRole('alert')).toHaveTextContent('access denied')
  })
})

describe('FeishuWorkbarPanel', () => {
  const space = { kind: 'space' as const, token: '7', name: '产品知识库', child: { kind: 'space' as const, token: '7' } }
  const page = { kind: 'node' as const, token: 'n1', name: '发布流程', type: 'docx', url: 'https://www.feishu.cn/wiki/n1' }

  it('picks a space from the dropdown, filters by type and uses a document in the conversation', async () => {
    const browse = vi.fn(async (input: Parameters<FeishuApiBridge['browse']>[0]) => input.location.kind === 'root'
      ? { items: [space, { kind: 'file' as const, token: 'b1', name: '需求池', type: 'bitable', modifiedAt: '2026-10-10T01:00:00.000Z' }] }
      : { items: [page] })
    installApi(snapshot(), { browse })
    const onUse = vi.fn()
    render(<FeishuWorkbarPanel onUseInConversation={onUse} />)
    // The drive root files show at the top level; spaces go to the dropdown.
    expect(await screen.findByText('需求池')).toBeInTheDocument()
    expect(screen.getByText(/更新于/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    expect(screen.queryByText('需求池')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    fireEvent.change(screen.getByRole('combobox', { name: '选择空间' }), { target: { value: '7' } })
    expect(await screen.findByText('发布流程')).toBeInTheDocument()
    expect(browse).toHaveBeenLastCalledWith({ location: { kind: 'space', token: '7' } })
    fireEvent.click(screen.getByRole('button', { name: '用于当前对话' }))
    expect(onUse).toHaveBeenCalledWith('请参考飞书文档「发布流程」（https://www.feishu.cn/wiki/n1）')
  })

  it('searches titles across shared spaces and shows where each match lives', async () => {
    const searchDocuments = vi.fn(async () => [{ ...page, path: '产品知识库 / 发布' }])
    installApi(snapshot(), { browse: vi.fn(async () => ({ items: [space] })), searchDocuments })
    render(<FeishuWorkbarPanel />)
    fireEvent.change(await screen.findByRole('searchbox', { name: '搜索飞书文档' }), { target: { value: '发布' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText(/产品知识库 \/ 发布/u)).toBeInTheDocument()
    expect(searchDocuments).toHaveBeenCalledWith({ query: '发布' })
    expect(screen.getByRole('combobox', { name: '选择空间' })).toBeDisabled()
  })

  it('creates a page in the selected space and lists it after a refresh', async () => {
    const browse = vi.fn(async (input: Parameters<FeishuApiBridge['browse']>[0]) => input.location.kind === 'root' ? { items: [space] } : { items: [page] })
    const { api } = installApi(snapshot(), { browse })
    render(<FeishuWorkbarPanel />)
    await screen.findByRole('option', { name: '产品知识库' })
    fireEvent.change(screen.getByRole('combobox', { name: '选择空间' }), { target: { value: '7' } })
    await screen.findByText('发布流程')
    fireEvent.click(screen.getByRole('button', { name: '新建文档' }))
    fireEvent.change(screen.getByRole('textbox', { name: '新文档标题' }), { target: { value: '周会纪要' } })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    await waitFor(() => expect(api.createDocument).toHaveBeenCalledWith({ title: '周会纪要', location: { kind: 'space', token: '7' } }))
    expect(await screen.findByText('已新建「周会纪要」')).toBeInTheDocument()
    // Uploads only go into drive folders.
    expect(screen.getByRole('button', { name: '上传文件到当前文件夹' })).toBeDisabled()
  })

  it('shows the sharing hint when nothing is shared with the app', async () => {
    installApi(snapshot(), {
      browse: vi.fn(async () => ({ items: [], hint: '把文件夹分享给该应用' }))
    })
    render(<FeishuWorkbarPanel />)
    expect(await screen.findByText('把文件夹分享给该应用')).toBeInTheDocument()
  })
})
