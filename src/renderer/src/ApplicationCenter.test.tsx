import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applicationSettingsSchema,
  defaultApplicationNavigation,
  defaultLocalToolEnvironmentSettings,
} from '../../shared/application-settings-contracts'
import {
  ApplicationAvailability,
  ApplicationCenter,
  ApplicationSettingsNavigation,
  ApplicationSettingsView,
} from './ApplicationCenter'

const settings = applicationSettingsSchema.parse({
  checkUpdatesOnStartup: false,
  updateSource: 'github',
  modelDownloadSource: 'modelscope',
  localToolEnvironment: defaultLocalToolEnvironmentSettings,
  conversationHtmlRenderingEnabled: true,
  remoteProjectsEnabled: false,
})
const props = () => ({
  settings,
  pending: false,
  onClose: vi.fn(),
  onOpen: vi.fn(),
  onUpdate: vi.fn(async () => true),
  onRetry: vi.fn(),
})
afterEach(cleanup)

describe('Application Center', () => {
  it('returns from compact settings through header navigation without losing the search', () => {
    render(<ApplicationCenter {...props()} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '笔记' } })
    const body = screen.getByRole('searchbox').closest('.application-center__body')!
    body.scrollTop = 200
    fireEvent.click(screen.getByRole('button', { name: '魔法笔记 应用设置' }))
    expect(body.scrollTop).toBe(0)
    const dialog = screen.getByRole('dialog', { name: '魔法笔记' })
    expect(dialog).toHaveClass('application-center--detail')
    const back = within(dialog).getByRole('button', { name: '返回应用中心' })
    expect(back.closest('.settings-panel__header')).not.toBeNull()
    fireEvent.click(back)
    expect(screen.getByRole('searchbox')).toHaveValue('笔记')
    expect(screen.getByRole('searchbox')).toHaveFocus()
    expect(dialog).not.toHaveClass('application-center--detail')
  })

  it.each([['知识库', 'knowledge'], ['智能心跳', 'heartbeat']])('keeps %s fixed with Open and no settings, pin, or order controls', (title, id) => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} />)
    const card = screen.getByText(title, { exact: true }).closest('article')!
    expect(card).toHaveAttribute('draggable', 'false')
    expect(within(card).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(card).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(within(card).getByRole('button', { name: '打开' }))
    expect(handlers.onOpen).toHaveBeenCalledWith(id)
    const notes = screen.getByText('魔法笔记', { exact: true }).closest('article')!
    fireEvent.dragStart(notes)
    fireEvent.drop(card)
    expect(handlers.onUpdate).not.toHaveBeenCalled()
  })
  it('searches disabled and unpinned applications, opens without pinning, and restores focus', () => {
    const handlers = props()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { unmount } = render(
      <ApplicationCenter
        {...handlers}
        settings={{
          ...settings,
          localInferenceEnabled: false,
          applicationNavigation: {
            ...defaultApplicationNavigation,
            pinned: {
              ...defaultApplicationNavigation.pinned,
              'magic-notes': false,
            },
          },
        }}
      />,
    )
    const search = screen.getByRole('searchbox', { name: '搜索内置应用' })
    expect(search).toHaveFocus()
    fireEvent.change(search, { target: { value: '笔记' } })
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    expect(handlers.onOpen).toHaveBeenCalledWith('magic-notes')
    expect(handlers.onUpdate).not.toHaveBeenCalled()
    fireEvent.change(search, { target: { value: '推理' } })
    expect(screen.getByText('已关闭', { exact: false })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '打开' }),
    ).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '本机推理 应用设置' }))
    expect(screen.getByRole('switch', { name: '启用应用' })).not.toBeChecked()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(handlers.onClose).toHaveBeenCalledOnce()
    unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it('saves complete order and independent pin preferences without optimistic changes', () => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} />)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '本机推理 应用设置' }))
    fireEvent.click(screen.getByRole('switch', { name: '常驻左侧菜单' }))
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({
      applicationNavigation: {
        ...defaultApplicationNavigation,
        pinned: { ...defaultApplicationNavigation.pinned, 'local-inference': false },
      },
    })
    expect(
      screen.getByRole('switch', { name: '常驻左侧菜单' }),
    ).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '上移 本机推理' }))
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({
      applicationNavigation: {
        ...defaultApplicationNavigation,
        order: ['local-inference', 'magic-notes'],
      },
    })
    expect(screen.getByRole('button', { name: '下移 本机推理' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '返回应用中心' }))
    fireEvent.click(screen.getByRole('button', { name: '魔法笔记 应用设置' }))
    expect(screen.getByRole('button', { name: '上移 魔法笔记' })).toBeDisabled()
  })

  it('uses the same order patch for drag and keyboard controls', () => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} />)
    const notes = screen
      .getByText('魔法笔记', { exact: true })
      .closest('article')!
    const inference = screen
      .getByText('本机推理', { exact: true })
      .closest('article')!
    fireEvent.dragStart(inference)
    fireEvent.dragOver(notes)
    fireEvent.drop(notes)
    expect(handlers.onUpdate).toHaveBeenCalledWith({
      applicationNavigation: {
        ...defaultApplicationNavigation,
        order: ['local-inference', 'magic-notes'],
      },
    })
  })

  it('locks all preference controls while saving or awaiting a confirmed read', () => {
    const handlers = props()
    const { rerender } = render(<ApplicationCenter {...handlers} pending initialApplication="local-inference" />)
    for (const toggle of screen.getAllByRole('switch'))
      expect(toggle).toBeDisabled()
    expect(screen.getByRole('button', { name: '上移 本机推理' })).toBeDisabled()
    rerender(
      <ApplicationCenter {...handlers} locked error="无法确认保存结果" />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('无法确认保存结果')
    for (const toggle of screen.getAllByRole('switch'))
      expect(toggle).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    expect(handlers.onRetry).toHaveBeenCalledOnce()
  })

  it('provides a recoverable search empty state and no market or system tools', () => {
    render(<ApplicationCenter {...props()} />)
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByText('安装')).not.toBeInTheDocument()
    expect(screen.queryByText('终端')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'absent' },
    })
    expect(screen.getByText('未找到相关应用')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(screen.getAllByRole('article')).toHaveLength(4)
  })

  it('edits all notes preferences through the shared settings form', () => {
    const onUpdate = vi.fn(async () => true)
    render(
      <ApplicationSettingsView
        id="magic-notes"
        settings={settings}
        pending={false}
        onUpdate={onUpdate}
      />,
    )
    fireEvent.click(screen.getByRole('switch', { name: '启用应用' }))
    expect(onUpdate).toHaveBeenLastCalledWith({ magicNotesEnabled: false })
    fireEvent.click(screen.getByRole('switch', { name: '显示未完成待办数量' }))
    expect(onUpdate).toHaveBeenLastCalledWith({
      magicNotesShowIncompleteTodoCount: false,
    })
    fireEvent.click(screen.getByRole('button', { name: '保存后自动' }))
    expect(onUpdate).toHaveBeenLastCalledWith({
      magicNoteCommentMode: 'after-save-auto',
    })
    fireEvent.click(screen.getByRole('button', { name: '要点' }))
    expect(onUpdate).toHaveBeenLastCalledWith({
      magicNoteCommentFormat: 'structured',
    })
  })

  it('keeps disabled page drafts mounted with a recovery entry', () => {
    const open = vi.fn()
    const page = (enabled: boolean) => (
      <ApplicationSettingsNavigation value={open}>
        <ApplicationAvailability id="local-inference" enabled={enabled}>
          <input aria-label="draft" defaultValue="original" />
        </ApplicationAvailability>
      </ApplicationSettingsNavigation>
    )
    const { rerender, container } = render(page(true))
    const draft = screen.getByRole('textbox', { name: 'draft' })
    fireEvent.change(draft, { target: { value: 'keep this draft' } })
    rerender(page(false))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(draft).toBeInTheDocument()
    expect(screen.getByText('应用已关闭')).toBeInTheDocument()
    fireEvent.click(within(container).getByRole('button', { name: '应用设置' }))
    expect(open).toHaveBeenCalledWith('local-inference')
    rerender(page(true))
    expect(screen.getByRole('textbox')).toHaveValue('keep this draft')
  })
})
