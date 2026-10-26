import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultWecomToolSettings, type WecomApi, type WecomSnapshot } from '../../shared/wecom-contracts'
import { WecomBotScan } from './WecomBotScan'
import { WecomToolSettings } from './WecomToolSettings'
import { WecomWorkbarPanel } from './WecomWorkbarPanel'
import i18n from './i18n'

let revision = 0
function snapshot(overrides: Partial<WecomSnapshot> = {}): WecomSnapshot {
  revision += 1
  return {
    revision,
    platformSupported: true,
    cli: { state: 'ready', version: '1.3.4' },
    authorization: { state: 'unauthorized' },
    qr: { state: 'idle' },
    settings: defaultWecomToolSettings(),
    appEnabled: true,
    ...overrides
  }
}

function installApi(initial: WecomSnapshot, overrides: Partial<WecomApi> = {}) {
  let listener: ((next: WecomSnapshot) => void) | undefined
  const api = {
    getSnapshot: vi.fn(async () => initial),
    updateSettings: vi.fn(async () => initial),
    startQrAuthorization: vi.fn(async () => ({ ...initial, qr: { state: 'starting' as const } })),
    cancelQrAuthorization: vi.fn(async () => initial),
    authorizeManually: vi.fn(async () => initial),
    authorizeWithChannelBot: vi.fn(async () => initial),
    disconnect: vi.fn(async () => initial),
    searchDocuments: vi.fn(async () => []),
    listView: vi.fn(async () => []),
    createDocument: vi.fn(async (input: { title: string }) => ({ id: 'new', name: input.title, type: 'doc' })),
    uploadFile: vi.fn(async () => undefined),
    onChanged: vi.fn((next: (snapshot: WecomSnapshot) => void) => { listener = next; return () => { listener = undefined } }),
    ...overrides
  } as WecomApi
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { wecom: api } })
  return { api, push: (next: WecomSnapshot) => act(() => listener?.(next)) }
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('zh-CN')
})

describe('WecomBotScan (Connection tab)', () => {
  it('scans, offers the browser fallback, and can be cancelled', async () => {
    const { api, push } = installApi(snapshot())
    render(<WecomBotScan onCreated={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '扫码创建企业微信机器人' }))
    expect(api.startQrAuthorization).toHaveBeenCalledOnce()
    push(snapshot({ qr: { state: 'waiting', url: 'https://work.weixin.qq.com/ai/qc/c?s=x&hide_more_btn=true&for_native=true',
      webUrl: 'https://work.weixin.qq.com/ai/qc/gen?scode=x', expiresAt: new Date(Date.now() + 300_000).toISOString() } }))
    expect(await screen.findByRole('link', { name: '扫不出来？在浏览器中打开二维码' })).toHaveAttribute('href', 'https://work.weixin.qq.com/ai/qc/gen?scode=x')
    await waitFor(() => expect(screen.getByRole('button', { name: '取消扫码' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '取消扫码' }))
    expect(api.cancelQrAuthorization).toHaveBeenCalledOnce()
  })

  it('reloads the channel form once when the scan also saved the channel bot', async () => {
    const { push } = installApi(snapshot({ qr: { state: 'waiting', url: 'https://work.weixin.qq.com/ai/qc/c?s=x',
      webUrl: 'https://work.weixin.qq.com/ai/qc/gen?scode=x', expiresAt: new Date(Date.now() + 300_000).toISOString() } }))
    const onCreated = vi.fn()
    render(<WecomBotScan onCreated={onCreated} />)
    await screen.findByRole('button', { name: '取消扫码' })
    const done = { state: 'completed' as const, channelSaved: true, userId: 'zhangsan' }
    push(snapshot({ authorization: { state: 'authorized', botId: 'bot-new' }, qr: done }))
    expect(await screen.findByText(/扫码人是唯一允许的发送者/u)).toBeInTheDocument()
    push(snapshot({ authorization: { state: 'authorized', botId: 'bot-new' }, qr: done, settings: { ...defaultWecomToolSettings(), enabled: true } }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
  })

  it('reports an unsupported platform and a failed scan', async () => {
    installApi(snapshot({ platformSupported: false, qr: { state: 'failed', message: '二维码已过期，请重新扫码' } }))
    render(<WecomBotScan onCreated={vi.fn()} />)
    expect(await screen.findByText('当前安装包没有内置企业微信 CLI（不支持此操作系统或处理器架构）。')).toBeInTheDocument()
    expect(screen.getByText('二维码已过期，请重新扫码')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '扫码创建企业微信机器人' })).toBeDisabled()
  })
})

describe('WecomToolSettings', () => {
  it('points to the Connection tab before authorization, and offers the saved channel bot', async () => {
    const { api } = installApi(snapshot())
    const { rerender } = render(<WecomToolSettings channelBotConfigured={false} />)
    expect(await screen.findByText(/先在“连接”页扫码创建机器人/u)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /扫码/u })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '使用消息通道的机器人' })).not.toBeInTheDocument()
    rerender(<WecomToolSettings channelBotConfigured />)
    fireEvent.click(screen.getByRole('button', { name: '使用消息通道的机器人' }))
    await waitFor(() => expect(api.authorizeWithChannelBot).toHaveBeenCalledOnce())
  })

  it('shows authorization errors', async () => {
    installApi(snapshot(), { authorizeWithChannelBot: vi.fn(async () => { throw new Error('invalid bot_id or secret') }) })
    render(<WecomToolSettings channelBotConfigured />)
    fireEvent.click(await screen.findByRole('button', { name: '使用消息通道的机器人' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid bot_id or secret')
  })

  it('edits the enable switch, categories, and message-session permission once authorized', async () => {
    const authorized = snapshot({ authorization: { state: 'authorized', botId: 'bot-9' } })
    const { api } = installApi(authorized)
    render(<WecomToolSettings channelBotConfigured={false} />)
    expect(await screen.findByText(/机器人 bot-9/u)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /邮件/u })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /待办/u })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /待办/u })).toBeEnabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /邮件/u }))
    expect(api.updateSettings).toHaveBeenLastCalledWith({ categories: { email: true } })
    // Disconnect lives on the Connection tab now.
    expect(screen.queryByRole('button', { name: '断开并删除本机凭据' })).not.toBeInTheDocument()
  })
})

describe('WecomWorkbarPanel', () => {
  it('asks for setup until tools are enabled and authorized', async () => {
    installApi(snapshot())
    const onOpenSettings = vi.fn()
    render(<WecomWorkbarPanel onOpenSettings={onOpenSettings} />)
    expect(await screen.findByText('企业微信工具尚未授权或已关闭。')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '打开应用设置' })[1]!)
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('lists recent documents, switches lists and filters by type', async () => {
    const listView = vi.fn(async ({ view }: { view: 'recent' | 'created' | 'disk' }) => view === 'disk'
      ? [{ id: 'f1', name: '合同.pdf', type: 'file', source: 'disk' as const, path: '法务空间/合同', modifiedAt: '2026-10-11 10:00:00' }]
      : [
          { id: 'd1', name: '周报汇总', type: 'smartsheet', url: 'https://doc.weixin.qq.com/smartsheet/1', modifiedAt: '2026-10-10 09:00:00' },
          { id: 'd2', name: '发布说明', type: 'doc' }
        ])
    installApi(snapshot({ authorization: { state: 'authorized', botId: 'bot-1' } }), { listView })
    const onUse = vi.fn()
    render(<WecomWorkbarPanel onUseInConversation={onUse} />)
    expect(await screen.findByText(/企业微信当前要求提供关键词/u)).toBeInTheDocument()
    expect(listView).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '周报' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText('周报汇总')).toBeInTheDocument()
    expect(listView).toHaveBeenCalledWith({ view: 'recent', query: '周报' })
    expect(screen.getByText('2 项')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '表格' }))
    expect(screen.queryByText('发布说明')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '用于当前对话' })[0]!)
    expect(onUse).toHaveBeenCalledWith('请参考企业微信文档「周报汇总」（https://doc.weixin.qq.com/smartsheet/1）')
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    fireEvent.change(screen.getByRole('combobox', { name: '选择列表' }), { target: { value: 'disk' } })
    expect(await screen.findByText('合同.pdf')).toBeInTheDocument()
    expect(screen.getByText(/法务空间\/合同/u)).toBeInTheDocument()
  })

  it('searches within the selected view and stops requesting when cleared', async () => {
    const ready = snapshot({ authorization: { state: 'authorized' } })
    const { api } = installApi(ready, {
      listView: vi.fn(async () => [
        { id: 'd1', name: '周报汇总', type: 'smartsheet', url: 'https://doc.weixin.qq.com/smartsheet/1', modifiedAt: '2026-10-10 09:00:00' }
      ])
    })
    render(<WecomWorkbarPanel />)
    fireEvent.change(await screen.findByRole('searchbox', { name: '搜索企业微信文档' }), { target: { value: '周报' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText('周报汇总')).toBeInTheDocument()
    expect(api.listView).toHaveBeenCalledWith({ view: 'recent', query: '周报' })
    expect(screen.getByText(/智能表格 · 更新于 2026-10-10/u)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '打开原文' })).toHaveAttribute('href', 'https://doc.weixin.qq.com/smartsheet/1')
    fireEvent.change(screen.getByRole('combobox', { name: '选择列表' }), { target: { value: 'created' } })
    await waitFor(() => expect(api.listView).toHaveBeenCalledWith({ view: 'created', query: '周报' }))
    vi.mocked(api.listView).mockClear()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(await screen.findByText(/企业微信当前要求提供关键词/u)).toBeInTheDocument()
    expect(screen.queryByText('周报汇总')).not.toBeInTheDocument()
    expect(api.listView).not.toHaveBeenCalled()
  })

  it('creates a document and gates create and upload by category', async () => {
    const settings = { ...defaultWecomToolSettings(), categories: { ...defaultWecomToolSettings().categories, disk: false } }
    const { api } = installApi(snapshot({ authorization: { state: 'authorized' }, settings }))
    render(<WecomWorkbarPanel />)
    expect(await screen.findByRole('button', { name: '上传文件到微盘' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '新建在线文档' }))
    fireEvent.change(screen.getByRole('textbox', { name: '新文档标题' }), { target: { value: '周会纪要' } })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    await waitFor(() => expect(api.createDocument).toHaveBeenCalledWith({ title: '周会纪要' }))
    expect(await screen.findByText('已新建「周会纪要」')).toBeInTheDocument()
  })
})
