import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultFeishuToolSettings, type FeishuApiBridge, type FeishuSnapshot } from '../../shared/feishu-contracts'
import { FeishuAppRegistration, FeishuToolSettings } from './FeishuToolSettings'
import { FeishuWorkbarPanel } from './FeishuWorkbarPanel'
import i18n from './i18n'

let revision = 0
function snapshot(overrides: Partial<FeishuSnapshot> = {}): FeishuSnapshot {
  revision += 1
  return { revision, credentialsConfigured: true, appId: 'cli_app', domain: 'feishu', settings: defaultFeishuToolSettings(), registration: { state: 'idle' }, ...overrides }
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
    onChanged: vi.fn((next: (s: FeishuSnapshot) => void) => { listener = next; return () => { listener = undefined } }),
    ...overrides
  } satisfies FeishuApiBridge
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { feishu: api } })
  return { api, push: (next: FeishuSnapshot) => act(() => listener?.(next)) }
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('zh-CN')
})

describe('FeishuToolSettings', () => {
  it('requires credentials before enabling and defaults permission management off', async () => {
    installApi(snapshot({ credentialsConfigured: false }))
    render(<FeishuToolSettings />)
    expect(await screen.findByText('先在上方填写或扫码创建 App ID 和 App Secret 并保存。')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '在对话中提供飞书工具' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /权限管理/u })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /文档/u })).toBeChecked()
  })

  it('saves the enable switch and category changes', async () => {
    const { api } = installApi(snapshot())
    render(<FeishuToolSettings />)
    fireEvent.click(await screen.findByRole('switch', { name: '在对话中提供飞书工具' }))
    expect(api.updateSettings).toHaveBeenLastCalledWith({ enabled: true })
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
  it('browses spaces into nodes and uses a document in the conversation', async () => {
    const browse = vi.fn(async (input: Parameters<FeishuApiBridge['browse']>[0]) => input.location.kind === 'root'
      ? { items: [{ kind: 'space' as const, token: '7', name: '产品知识库', child: { kind: 'space' as const, token: '7' } }] }
      : { items: [{ kind: 'node' as const, token: 'n1', name: '发布流程', type: 'docx', url: 'https://www.feishu.cn/wiki/n1' }] })
    installApi(snapshot({ settings: { ...defaultFeishuToolSettings(), enabled: true } }), { browse })
    const onUse = vi.fn()
    render(<FeishuWorkbarPanel onUseInConversation={onUse} />)
    fireEvent.click(await screen.findByRole('button', { name: '产品知识库' }))
    expect(await screen.findByText('发布流程')).toBeInTheDocument()
    expect(browse).toHaveBeenLastCalledWith({ location: { kind: 'space', token: '7' } })
    fireEvent.click(screen.getByRole('button', { name: '用于当前对话' }))
    expect(onUse).toHaveBeenCalledWith('请参考飞书文档「发布流程」（https://www.feishu.cn/wiki/n1）')
    fireEvent.click(screen.getByRole('button', { name: '返回上一级' }))
    expect(await screen.findByRole('button', { name: '产品知识库' })).toBeInTheDocument()
  })

  it('shows the sharing hint when nothing is shared with the app', async () => {
    installApi(snapshot({ settings: { ...defaultFeishuToolSettings(), enabled: true } }), {
      browse: vi.fn(async () => ({ items: [], hint: '把文件夹分享给该应用' }))
    })
    render(<FeishuWorkbarPanel />)
    expect(await screen.findByText('把文件夹分享给该应用')).toBeInTheDocument()
  })
})
