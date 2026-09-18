import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import i18n from './i18n'
import type { DesktopApi } from '../../shared/contracts'
import { defaultLocalToolEnvironmentSettings, defaultApplicationNavigation, type ApplicationSettings } from '../../shared/application-settings-contracts'
import type { MagicNoteDetail, MagicNoteRichContent, MagicNotesSnapshot, MagicTodoItem } from '../../shared/magic-notes-contracts'
import { MagicNotesWorkspace } from './MagicNotesWorkspace'

vi.mock('./MagicNoteEditor', () => ({
  MagicNoteEditor: ({ onChange, onParagraphCommit }: {
    onChange: (content: MagicNoteRichContent) => void
    onParagraphCommit?: (content: MagicNoteRichContent) => void
  }) => <button data-testid="magic-note-editor" type="button" onClick={() => {
    const content = { version: 1 as const, ops: [{ insert: '新的句子\n' }] }
    onChange(content)
    onParagraphCommit?.(content)
  }}>模拟输入并回车</button>
}))

vi.mock('./MagicNoteContent', () => ({
  MagicNoteContent: ({ content }: { content: MagicNoteRichContent }) => <div>
    <span>记录正文</span>
    <output data-testid="magic-note-checklist-state">{content.ops.find((op) => op.attributes?.list)?.attributes?.list ?? 'none'}</output>
  </div>
}))

const noteId = '00000000-0000-4000-8000-000000000601'
const entryId = '00000000-0000-4000-8000-000000000602'
const secondNoteId = '00000000-0000-4000-8000-000000000608'
const createdEntryId = '00000000-0000-4000-8000-000000000613'
const content: MagicNoteRichContent = { version: 1, ops: [{ insert: '新的句子\n' }] }
const detail: MagicNoteDetail = {
  id: noteId, title: '发布笔记', preview: '整理发布清单', entryCount: 1,
  pinned: false, revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z',
  entries: [{
    id: entryId, noteId, content: { version: 1, ops: [{ insert: '整理发布清单\n' }] }, plainText: '整理发布清单',
    comments: [{ id: 'comment', kind: 'suggestion', content: '先核对发布材料。' }],
    analyzedAt: '2026-08-01T00:02:00.000Z', revision: 1,
    createdAt: '2026-08-01T00:01:00.000Z', updatedAt: '2026-08-01T00:02:00.000Z'
  }]
}
const second: MagicNoteDetail = { ...detail, id: secondNoteId, title: '演示笔记', preview: '', entryCount: 0, entries: [] }
const todo: MagicTodoItem = {
  id: '00000000-0000-4000-8000-000000000603', noteId, noteTitle: detail.title, entryId,
  sourceIndex: 0, source: 'note', title: '核对发布材料', instructions: '', completed: false,
  comments: [], revision: 1, createdAt: detail.createdAt, updatedAt: detail.updatedAt
}
const otherTodo: MagicTodoItem = { ...todo, id: '00000000-0000-4000-8000-000000000604', noteId: secondNoteId, noteTitle: second.title, title: '准备演示' }
const settings: ApplicationSettings = {
  checkUpdatesOnStartup: false, updateSource: 'github', modelDownloadSource: 'modelscope',
  localToolEnvironment: defaultLocalToolEnvironmentSettings, applicationNavigation: defaultApplicationNavigation,
  localInferenceEnabled: true, conversationHtmlRenderingEnabled: true, remoteProjectsEnabled: false,
  magicNotesEnabled: true, magicNotesShowIncompleteTodoCount: true,
  magicNoteCommentMode: 'immediate', magicNoteCommentFormat: 'combined'
}
const list = vi.fn<DesktopApi['magicNotes']['list']>()
const get = vi.fn<DesktopApi['magicNotes']['get']>()
const listTodos = vi.fn<DesktopApi['magicNotes']['listTodos']>()
const create = vi.fn<DesktopApi['magicNotes']['create']>()
const remove = vi.fn<DesktopApi['magicNotes']['remove']>()
const update = vi.fn<DesktopApi['magicNotes']['update']>()
const createEntry = vi.fn<DesktopApi['magicNotes']['createEntry']>()
const updateEntry = vi.fn<DesktopApi['magicNotes']['updateEntry']>()
const removeEntry = vi.fn<DesktopApi['magicNotes']['removeEntry']>()
const analyze = vi.fn<DesktopApi['magicNotes']['analyze']>()
const updateTodo = vi.fn<DesktopApi['magicNotes']['updateTodo']>()
const analyzeTodo = vi.fn<DesktopApi['magicNotes']['analyzeTodo']>()
const analyzeDraft = vi.fn<DesktopApi['magicNotes']['analyzeDraft']>()
const getSettings = vi.fn<() => Promise<ApplicationSettings>>()
const onNotify = vi.fn()
const unsubscribeChanges = vi.fn()
let changeListener: (() => void) | undefined
let analysisListener: Parameters<DesktopApi['magicNotes']['onAnalysisEvent']>[0] | undefined
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')

beforeEach(async () => {
  vi.resetAllMocks()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  localStorage.clear()
  await i18n.changeLanguage('zh-CN')
  changeListener = undefined
  analysisListener = undefined
  list.mockResolvedValue({ notes: [detail, second] })
  get.mockImplementation(async (id) => id === secondNoteId ? second : detail)
  listTodos.mockResolvedValue({ todos: [todo, otherTodo] })
  create.mockResolvedValue({ ...second, title: '新笔记' })
  remove.mockResolvedValue()
  update.mockResolvedValue({ ...detail, pinned: true, revision: 2 })
  const saved = { ...detail, revision: 2, entryCount: 2, entries: [...detail.entries, { ...detail.entries[0]!, id: createdEntryId, content, comments: [] }] }
  createEntry.mockResolvedValue(saved)
  updateEntry.mockResolvedValue({ ...detail, revision: 2 })
  removeEntry.mockResolvedValue({ ...detail, revision: 2, entries: [] })
  analyze.mockResolvedValue({ ...saved, entries: saved.entries.map((entry) => entry.id === createdEntryId ? {
    ...entry, comments: [{ id: 'saved-comment', kind: 'suggestion', content: '保存后的自动评论。' }]
  } : entry) })
  analyzeDraft.mockResolvedValue({ id: 'draft-analysis', comments: [{ id: 'draft-comment', kind: 'summary', content: '这是最新的草稿评论。' }], analyzedAt: detail.updatedAt })
  analyzeTodo.mockResolvedValue({ ...todo, comments: [{ id: 'todo-comment', kind: 'suggestion', content: '先补充明确的验收条件。' }], revision: 2 })
  updateTodo.mockImplementation(async (input) => ({
    todo: { ...todo, completed: input.completed, revision: input.expectedRevision + 1 },
    note: { ...detail, revision: 2, entries: [{ ...detail.entries[0]!, content: {
      version: 1, ops: [{ insert: todo.title }, { insert: '\n', attributes: { list: input.completed ? 'checked' : 'unchecked' } }]
    } }] }
  }))
  getSettings.mockResolvedValue(settings)
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: {
    magicNotes: { list, get, listTodos, create, remove, update, createEntry, updateEntry, removeEntry, analyze, updateTodo, analyzeTodo, analyzeDraft,
      onChanged: (listener: () => void) => { changeListener = listener; return unsubscribeChanges },
      onAnalysisEvent: (listener: NonNullable<typeof analysisListener>) => { analysisListener = listener; return vi.fn() }
    }, updates: { getSettings }
  } as unknown as DesktopApi })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.restoreAllMocks()
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

async function openNote(title = detail.title): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`${title}.*条记录`) }))
  await screen.findByDisplayValue(title)
}

function back(): void {
  fireEvent.click(screen.getByRole('button', { name: '返回总览' }))
}

async function openTodo(): Promise<void> {
  await screen.findByText(detail.title)
  fireEvent.click(screen.getByRole('tab', { name: '待办' }))
  fireEvent.click(screen.getByRole('button', { name: /核对发布材料.*发布笔记/ }))
  await screen.findByRole('heading', { name: todo.title })
}

describe('MagicNotesWorkspace overview navigation', () => {
  it('starts with adaptive cards, overview tabs and search without fetching a detail', async () => {
    const { container } = render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByText(detail.title)
    expect(get).not.toHaveBeenCalled()
    expect(screen.getByRole('tablist', { name: '魔法笔记内容' })).toHaveClass('page-tabs--segmented')
    expect(screen.getByRole('searchbox', { name: '搜索当前范围的笔记' })).toBeVisible()
    expect(screen.getByRole('button', { name: '新建笔记' })).toBeVisible()
    expect(screen.queryByLabelText('笔记标题')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('AI 评论')).not.toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(container.querySelector('.magic-notes-card-grid')).toBeVisible()
    const card = screen.getByRole('button', { name: /发布笔记.*条记录/ })
    expect(card.querySelector('time')).toHaveAttribute('datetime', detail.updatedAt)
    expect(card).not.toHaveAttribute('aria-pressed')
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    expect(css).toMatch(/\.magic-notes-card-grid\s*\{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 240px\), 1fr\)\)/)
    expect(css).toMatch(/\.magic-notes-page > \.page-header \.page-tabs\s*\{[^}]*flex: 0 0 auto/)
    expect(css).toMatch(/\.magic-notes-page > \.page-header \.page-tabs\s*\{[^}]*width: fit-content/)
    expect(screen.getByRole('tablist').parentElement).toBe(screen.getByRole('button', { name: '新建笔记' }).parentElement)
    expect(screen.getByRole('tablist').nextElementSibling).toBe(screen.getByRole('button', { name: '新建笔记' }))
    expect(css).not.toContain('magic-notes-list-resize-handle')
    expect(css).not.toContain('--magic-notes-list-width')
    expect(css).toMatch(/grid-template-rows: minmax\(0, 1fr\) minmax\(0, min\(40%, 280px\)\)/)
    expect(css).toMatch(/\.magic-notes-layout--overview,\s*\.magic-notes-layout--ai-hidden\s*\{\s*grid-template-rows: minmax\(0, 1fr\)/)
  })

  it('opens a card and restores overview search, scroll and keyboard focus on return', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByText(detail.title)
    const overview = screen.getByRole('region', { name: '笔记列表' })
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: '发布' } })
    overview.scrollTop = 180
    const card = screen.getByRole('button', { name: /发布笔记.*条记录/ })
    await openNote()
    expect(overview).not.toBeVisible()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建笔记' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '笔记记录' })).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: '返回总览' })).toHaveFocus())
    back()
    expect(overview).toBeVisible()
    expect(search).toHaveValue('发布')
    expect(overview.scrollTop).toBe(180)
    expect(screen.queryByRole('region', { name: '笔记记录' })).not.toBeInTheDocument()
    await waitFor(() => expect(card).toHaveFocus())
    await openNote()
    expect(get).toHaveBeenCalledTimes(2)
  })

  it.each(['composer', 'entry', 'title'] as const)('guards returning with a dirty %s and cancels or discards through the existing dialog', async (draft) => {
    const { container } = render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    let editor = screen.getByTestId('magic-note-editor')
    if (draft === 'entry') {
      fireEvent.click(screen.getByRole('button', { name: '编辑' }))
      editor = container.querySelector<HTMLElement>('.magic-note-entry__editor [data-testid="magic-note-editor"]')!
    }
    if (draft === 'title') fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: '未保存标题' } })
    else fireEvent.click(editor)
    back()
    const dialog = screen.getByRole('alertdialog', { name: '放弃当前未保存草稿？' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('切换后，当前记录草稿中的文字和附件将被丢弃。')
    expect(container.querySelector<HTMLElement>('.page-header')?.inert).toBe(true)
    const cancel = screen.getByRole('button', { name: '继续编辑' })
    const discard = screen.getByRole('button', { name: '放弃草稿并切换' })
    expect(cancel).toHaveFocus()
    discard.focus()
    fireEvent.keyDown(discard, { key: 'Tab' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(discard).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(container.querySelector<HTMLElement>('.page-header')?.inert).toBe(false)
    if (draft !== 'title') await waitFor(() => expect(editor).toHaveFocus())
    back()
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿并切换' }))
    expect(screen.getByRole('tab', { name: '笔记' })).toBeVisible()
    expect(createEntry).not.toHaveBeenCalled()
    expect(updateEntry).not.toHaveBeenCalled()
    await openNote()
    back()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('creates from either overview tab and enters the new note, retaining input after failure', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByText(detail.title)
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    fireEvent.click(screen.getByRole('button', { name: '新建笔记' }))
    fireEvent.click(screen.getByRole('button', { name: '创建笔记' }))
    expect(screen.getByText('请输入笔记标题')).toBeVisible()
    fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: '新笔记' } })
    create.mockRejectedValueOnce(new Error('create failed'))
    fireEvent.click(screen.getByRole('button', { name: '创建笔记' }))
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ message: 'create failed' })))
    expect(screen.getByLabelText('笔记标题')).toHaveValue('新笔记')
    fireEvent.click(screen.getByRole('button', { name: '创建笔记' }))
    await waitFor(() => expect(screen.getByRole('region', { name: '笔记记录' })).toBeVisible())
    expect(screen.getByLabelText('笔记标题')).toHaveValue('新笔记')
    expect(create).toHaveBeenLastCalledWith({ title: '新笔记' })
    back()
    await waitFor(() => expect(screen.getByRole('button', { name: '新建笔记' })).toHaveFocus())
  })

  it('keeps the first pending entry switch and saves the original draft after cancellation', async () => {
    const anotherEntry = { ...detail.entries[0]!, id: createdEntryId }
    get.mockResolvedValue({ ...detail, entries: [...detail.entries, anotherEntry] })
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    const original = within(document.getElementById(`magic-note-entry-${entryId}`)!)
    let other = within(document.getElementById(`magic-note-entry-${createdEntryId}`)!)
    fireEvent.click(original.getByRole('button', { name: '编辑' }))
    fireEvent.click(original.getByTestId('magic-note-editor'))
    fireEvent.click(other.getByRole('button', { name: '编辑' }))
    back()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(original.getByTestId('magic-note-editor')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(updateEntry).toHaveBeenCalledWith({ entryId, content, expectedRevision: 1 }))

    get.mockResolvedValue({ ...detail, entries: [...detail.entries, anotherEntry] })
    act(() => changeListener?.())
    await waitFor(() => expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(2))
    other = within(document.getElementById(`magic-note-entry-${createdEntryId}`)!)
    fireEvent.click(original.getByRole('button', { name: '编辑' }))
    fireEvent.click(original.getByTestId('magic-note-editor'))
    fireEvent.click(other.getByRole('button', { name: '编辑' }))
    back()
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿并切换' }))
    expect(other.getByTestId('magic-note-editor')).toBeInTheDocument()
    expect(screen.getByLabelText('笔记标题')).toBeVisible()
  })

  it('saves the composer after cancelling return without fetching another note or losing content', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    fireEvent.click(screen.getByTestId('magic-note-editor'))
    back()
    expect(get).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
    await waitFor(() => expect(createEntry).toHaveBeenCalledWith({ noteId, content }))
  })

  it('keeps todo filters and search when opening its source note and returning', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByText(detail.title)
    fireEvent.keyDown(screen.getByRole('tab', { name: '笔记' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: '待办' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '核对' } })
    const item = screen.getByRole('button', { name: /核对发布材料.*发布笔记/ })
    fireEvent.click(item)
    const source = await screen.findByRole('region', { name: '对应的笔记记录' })
    await within(source).findByText('记录正文')
    expect(screen.getByRole('region', { name: '待办详情' })).toContainElement(source)
    expect(screen.getByRole('heading', { name: todo.title })).toBeVisible()
    expect(screen.getByRole('searchbox')).toBeVisible()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(item).toHaveAttribute('aria-expanded', 'true')
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView)
    fireEvent.click(screen.getByRole('button', { name: '打开原笔记修改' }))
    await screen.findByDisplayValue(detail.title)
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'center' }))
    expect(document.getElementById(`magic-note-entry-${entryId}`)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '返回待办' }))
    expect(screen.getByRole('tab', { name: '待办' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('searchbox')).toHaveValue('核对')
    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(item).toHaveFocus())
    expect(screen.getByRole('heading', { name: todo.title })).toBeVisible()
    fireEvent.click(item)
    expect(screen.queryByRole('heading', { name: todo.title })).not.toBeInTheDocument()
    expect(item).toHaveAttribute('aria-expanded', 'false')
  })

  it('clears searches and status filters when the overview has no results', async () => {
    listTodos.mockResolvedValue({ todos: [{ ...todo, completed: true }] })
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByText(detail.title)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '不存在' } })
    expect(screen.getByText('没有符合条件的笔记')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(screen.getByRole('searchbox')).toHaveValue('')
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    expect(screen.getByText('没有符合条件的待办')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(todo.title)).toBeVisible()
  })

  it('supports retrying initial overview and detail failures independently', async () => {
    list.mockRejectedValueOnce(new Error('list failed'))
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByText('魔法笔记加载失败')
    expect(screen.queryByText('还没有笔记')).not.toBeInTheDocument()
    expect(screen.queryByText('还没有待办')).not.toBeInTheDocument()
    expect(onNotify).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText(detail.title)
    expect(get).not.toHaveBeenCalled()
    get.mockRejectedValueOnce(new Error('detail failed'))
    fireEvent.click(screen.getByRole('button', { name: /发布笔记.*条记录/ }))
    await screen.findByText('魔法笔记加载失败')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByDisplayValue(detail.title)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('ignores a late detail response after returning and opening another card', async () => {
    let resolveDetail!: (value: MagicNoteDetail) => void
    get.mockImplementationOnce(() => new Promise((resolve) => { resolveDetail = resolve }))
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    fireEvent.click(await screen.findByRole('button', { name: /发布笔记.*条记录/ }))
    back()
    await openNote(second.title)
    await act(async () => resolveDetail(detail))
    expect(screen.getByLabelText('笔记标题')).toHaveValue(second.title)
  })

  it('portals note actions with keyboard navigation, confirmation and outside dismissal', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    const trigger = await screen.findByRole('button', { name: `更多笔记操作 ${detail.title}` })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ right: 5000, bottom: 5000 } as DOMRect)
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
    expect(parseFloat(menu.style.left)).toBeLessThanOrEqual(window.innerWidth - 8)
    expect(parseFloat(menu.style.top)).toBeLessThanOrEqual(window.innerHeight - 8)
    expect(screen.getByRole('menuitem', { name: '置顶笔记' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(screen.getByRole('menuitem', { name: '删除笔记' })).toHaveFocus()
    fireEvent.click(document.activeElement!)
    expect(screen.getByRole('alertdialog')).toHaveTextContent(detail.title)
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.getByRole('menuitem', { name: '删除笔记' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(trigger)
    act(() => screen.getByRole('searchbox').focus())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: '笔记' }))
    fireEvent.click(screen.getByRole('button', { name: `更多笔记操作 ${detail.title}` }))
    await openNote()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('pins and deletes overview cards without opening a detail, retaining failed confirmation', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    const trigger = await screen.findByRole('button', { name: `更多笔记操作 ${detail.title}` })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: '置顶笔记' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ noteId, pinned: true, expectedRevision: 1 }))
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: '取消置顶' })).toBeVisible()
    update.mockRejectedValueOnce(new Error('revision conflict'))
    fireEvent.click(screen.getByRole('menuitem', { name: '取消置顶' }))
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ message: 'revision conflict' })))
    expect(update).toHaveBeenLastCalledWith({ noteId, pinned: false, expectedRevision: 2 })
    expect(document.querySelector('.magic-note-list-item__title')).toHaveTextContent(detail.title)
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除笔记' }))
    remove.mockRejectedValueOnce(new Error('delete failed'))
    fireEvent.click(screen.getByRole('button', { name: '删除笔记' }))
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ message: 'delete failed' })))
    expect(screen.getByRole('alertdialog')).toBeVisible()
    list.mockResolvedValue({ notes: [second] })
    fireEvent.click(screen.getByRole('button', { name: '删除笔记' }))
    await waitFor(() => expect(screen.queryByText(detail.title)).not.toBeInTheDocument())
    expect(screen.getByText(second.title)).toBeVisible()
    expect(get).not.toHaveBeenCalled()
  })
})

describe('MagicNotesWorkspace detail behavior', () => {
  it('keeps a stable sibling list and detail, searches instructions and translates without reloading', async () => {
    listTodos.mockResolvedValue({ todos: [{ ...todo, instructions: '确认验收条件' }, otherTodo] })
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openTodo()
    const first = screen.getByRole('button', { name: /核对发布材料.*发布笔记/ })
    expect(screen.getByRole('tab', { name: '待办' })).toBeVisible()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '返回总览' })).not.toBeInTheDocument()
    expect(first).toHaveAttribute('aria-controls', `magic-todo-detail-${todo.id}`)
    const list = first.closest('.magic-notes-list')!
    const pane = screen.getByRole('region', { name: '待办详情' })
    expect(list.parentElement).toContainElement(pane)
    expect(list).not.toContainElement(pane)
    const toolbar = screen.getByRole('searchbox').closest('.magic-todo-toolbar')!
    expect(toolbar).toContainElement(screen.getByRole('group', { name: '筛选待办' }))
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    expect(css).toMatch(/\.magic-todo-workspace\s*\{[^}]*grid-template-columns: minmax\(280px, 34%\) minmax\(0, 1fr\)/)
    expect(css).toContain('@container magic-notes-page (max-width: 700px)')
    expect(css).toMatch(/\.magic-todo-workspace--selected > \.magic-notes-list,\s*\.magic-todo-detail--empty\s*\{\s*display: none/)
    fireEvent.click(screen.getByRole('button', { name: /准备演示.*演示笔记/ }))
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getAllByRole('region', { name: '待办详情' })).toHaveLength(1)
    expect(first.closest('.magic-notes-list')).toBe(list)
    fireEvent.click(screen.getByRole('button', { name: '返回待办列表' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /准备演示.*演示笔记/ })).toHaveFocus())
    expect(screen.queryByRole('region', { name: '待办详情' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '验收' } })
    expect(screen.queryByRole('region', { name: '待办详情' })).not.toBeInTheDocument()
    expect(screen.getByText('1 / 2 项')).toBeVisible()
    fireEvent.click(first)
    expect(screen.getByText('确认验收条件')).toBeVisible()
    await act(async () => { await i18n.changeLanguage('en-US') })
    expect(screen.getByRole('region', { name: 'To-do details' })).toBeVisible()
    expect(screen.getByPlaceholderText('Search tasks, instructions, or source notes')).toHaveValue('验收')
    expect(screen.getByText('1 / 2 items')).toBeVisible()
    expect(listTodos).toHaveBeenCalledOnce()
  })

  it('retries source failures and ignores a late source from a previously expanded task', async () => {
    get.mockRejectedValueOnce(new Error('source failed'))
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openTodo()
    fireEvent.click(await screen.findByRole('button', { name: '重试加载来源' }))
    await within(screen.getByRole('region', { name: '对应的笔记记录' })).findByText('记录正文')
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ message: 'source failed' }))
    let finish!: (value: MagicNoteDetail) => void
    get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: /准备演示.*演示笔记/ }))
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(secondNoteId))
    fireEvent.click(screen.getByRole('button', { name: /核对发布材料.*发布笔记/ }))
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(noteId))
    await act(async () => finish(second))
    expect(within(screen.getByRole('region', { name: '对应的笔记记录' })).getByText('记录正文')).toBeVisible()
  })

  it('retains the expanded task and saved comments after completion or analysis failures', async () => {
    listTodos.mockResolvedValue({ todos: [{ ...todo, comments: [{ id: 'saved', kind: 'suggestion', content: '已保存的建议' }] }, otherTodo] })
    updateTodo.mockRejectedValueOnce(new Error('revision conflict'))
    analyzeTodo.mockRejectedValueOnce(new Error('model failed'))
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openTodo()
    const check = screen.getByRole('button', { name: `标记为已完成：${todo.title}` })
    fireEvent.click(check)
    await waitFor(() => expect(check).toBeEnabled())
    expect(check).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }))
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ message: 'model failed' })))
    expect(screen.getByText('已保存的建议')).toBeVisible()
    expect(screen.getByRole('button', { name: /核对发布材料.*发布笔记/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('retains AI visibility and width across navigation and remounts', async () => {
    const view = render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    expect(screen.queryByRole('group', { name: 'AI 评论形式' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'AI 评论方向' })).toBeVisible()
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' })
    const width = screen.getByRole('separator').getAttribute('aria-valuenow')
    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 评论面板' }))
    expect(screen.queryByRole('complementary', { name: 'AI 评论' })).not.toBeInTheDocument()
    back()
    await openNote()
    expect(screen.getByRole('button', { name: '显示 AI 评论' })).toBeVisible()
    view.unmount()
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    fireEvent.click(screen.getByRole('button', { name: '显示 AI 评论' }))
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', width)
    expect(JSON.parse(localStorage.getItem('goodbuddy.magic-notes-layout.v1')!)).toEqual({ aiPaneOpen: true, aiPaneWidth: Number(width) })
  })

  it('resizes AI with pointer and keyboard and disables resizing in narrow layouts', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200)
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    const separator = screen.getByRole('separator', { name: '调整编辑区与 AI 评论宽度' })
    const layout = separator.closest('.magic-notes-layout') as HTMLElement
    const release = vi.fn()
    Object.defineProperties(separator, { setPointerCapture: { value: vi.fn() }, hasPointerCapture: { value: () => true }, releasePointerCapture: { value: release } })
    fireEvent.pointerDown(separator, { button: 0, clientX: 920, pointerId: 12 })
    fireEvent.pointerMove(separator, { clientX: 600, pointerId: 12 })
    expect(layout).toHaveClass('magic-notes-layout--resizing')
    expect(layout.style.getPropertyValue('--magic-notes-ai-width')).toBe('520px')
    fireEvent.pointerUp(separator, { pointerId: 12 })
    expect(release).toHaveBeenCalledWith(12)
    expect(layout).not.toHaveClass('magic-notes-layout--resizing')
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator).toHaveAttribute('aria-valuenow', '240')
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(separator).toHaveAttribute('aria-valuenow', '256')
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', '520')
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(700)
    back()
    await openNote()
    expect(screen.getByRole('separator')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('separator')).toHaveAttribute('tabindex', '-1')
  })

  it('shows loading then the AI empty state for a note without entries', async () => {
    let resolveDetail!: (value: MagicNoteDetail) => void
    get.mockImplementationOnce(() => new Promise((resolve) => { resolveDetail = resolve }))
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    fireEvent.click(await screen.findByRole('button', { name: /发布笔记.*条记录/ }))
    const pane = screen.getByRole('complementary', { name: 'AI 评论' })
    expect(within(pane).getByText('正在加载笔记…')).toBeVisible()
    await act(async () => resolveDetail({ ...detail, entries: [], entryCount: 0 }))
    expect(within(pane).getByText('写完一句并停止输入 5 秒后，评论会显示在这里。')).toBeVisible()
  })

  it('keeps entry editing contained and supports deletion confirmation', async () => {
    const { container } = render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    expect(container.querySelector('.magic-note-detail-header button')).toBeNull()
    expect(screen.getByRole('button', { name: '删除记录' })).toHaveClass('danger-button--quiet')
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(container.querySelector('.magic-note-entry__editor')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '删除记录' }))
    expect(screen.getByText('删除这条记录？此操作不可撤销。')).toBeVisible()
    expect(container.querySelector('.magic-note-entry__editor')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.queryByText('删除这条记录？此操作不可撤销。')).not.toBeInTheDocument()
  })

  it('preserves composer content across save failures and language changes', async () => {
    createEntry.mockRejectedValueOnce(new Error('save failed'))
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    fireEvent.click(screen.getByTestId('magic-note-editor'))
    await act(async () => { await i18n.changeLanguage('en-US') })
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }))
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ message: 'save failed' })))
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }))
    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(2))
    expect(createEntry).toHaveBeenNthCalledWith(1, { noteId, content })
    expect(createEntry).toHaveBeenNthCalledWith(2, { noteId, content })
    expect(list).toHaveBeenCalledOnce()
  })

  it.each(['create', 'edit'] as const)('finalizes %s before a todo refresh failure', async (operation) => {
    const { container } = render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    listTodos.mockRejectedValueOnce(new Error('todo refresh failed'))
    if (operation === 'edit') fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(operation === 'create' ? screen.getByTestId('magic-note-editor') : container.querySelector<HTMLElement>('.magic-note-entry__editor [data-testid="magic-note-editor"]')!)
    fireEvent.click(screen.getByRole('button', { name: operation === 'create' ? '保存记录' : '保存修改' }))
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ message: 'todo refresh failed' })))
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({
      tone: 'success', message: operation === 'create' ? '记录已保存' : '记录已更新，原 AI 评论已清除'
    }))
    if (operation === 'create') {
      fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
      expect(createEntry).toHaveBeenCalledOnce()
      expect(screen.getByText('请先输入记录内容')).toBeVisible()
    } else {
      expect(updateEntry).toHaveBeenCalledWith({ entryId, content, expectedRevision: 1 })
      expect(screen.queryByRole('button', { name: '保存修改' })).not.toBeInTheDocument()
    }
  })

  it('synchronizes completion in the list without opening another task, and applies status filters', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openTodo()
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    fireEvent.click(screen.getByRole('button', { name: `标记为已完成：${todo.title}` }))
    await waitFor(() => expect(updateTodo).toHaveBeenCalledWith({ todoId: todo.id, completed: true, expectedRevision: 1 }))
    expect(screen.getByTestId('magic-note-checklist-state')).toHaveTextContent('checked')
    fireEvent.click(screen.getByRole('button', { name: `标记为未完成：${todo.title}` }))
    await waitFor(() => expect(updateTodo).toHaveBeenLastCalledWith({ todoId: todo.id, completed: false, expectedRevision: 2 }))
    expect(screen.getByTestId('magic-note-checklist-state')).toHaveTextContent('unchecked')
    fireEvent.click(screen.getByRole('button', { name: /核对发布材料.*发布笔记/ }))
    fireEvent.click(screen.getByRole('button', { name: '未完成' }))
    fireEvent.click(screen.getByRole('button', { name: `标记为已完成：${todo.title}` }))
    await waitFor(() => expect(updateTodo).toHaveBeenCalledTimes(3))
    expect(screen.getByRole('tab', { name: '待办' })).toBeVisible()
    expect(screen.queryByRole('region', { name: '待办详情' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /核对发布材料.*发布笔记/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /准备演示.*演示笔记/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('reuses AI for todo details with snapshotted streaming options', async () => {
    getSettings.mockResolvedValue({ ...settings, magicNoteCommentFormat: 'narrative' })
    let finish!: (value: MagicTodoItem) => void
    analyzeTodo.mockImplementationOnce((_id, options) => new Promise((resolve) => {
      finish = resolve
      analysisListener?.({ requestId: options.requestId, type: 'text', delta: '正在扩展内容。', direction: 'expand', format: 'narrative' })
    }))
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openTodo()
    fireEvent.change(screen.getByRole('combobox', { name: 'AI 评论方向' }), { target: { value: 'expand' } })
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }))
    await screen.findByText('正在扩展内容。')
    fireEvent.change(screen.getByRole('combobox', { name: 'AI 评论方向' }), { target: { value: 'polish' } })
    expect(screen.getByText(/正在生成 ·/)).toHaveTextContent('扩展写作')
    expect(screen.getByRole('button', { name: '打开原笔记修改' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /准备演示.*演示笔记/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '返回总览' })).not.toBeInTheDocument()
    await act(async () => finish({ ...todo, comments: [{ id: 'result', kind: 'narrative', content: '扩展完成。', direction: 'expand', format: 'narrative' }] }))
    expect(screen.getByText('扩展完成。')).toBeVisible()
    expect(document.querySelector('.magic-note-comment__direction')).toHaveTextContent('扩展写作')
    expect(analyzeTodo).toHaveBeenCalledWith(todo.id, expect.objectContaining({ direction: 'expand', format: 'narrative' }))
    expect(screen.getByRole('combobox', { name: 'AI 评论方向' })).toHaveValue('polish')
  })

  it.each([true, false])('shows the updated checklist when opening the source after setting completion to %s', async (completed) => {
    listTodos.mockResolvedValue({ todos: [{ ...todo, completed: !completed }] })
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByText(detail.title)
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    fireEvent.click(screen.getByRole('button', { name: /核对发布材料.*发布笔记/ }))
    fireEvent.click(screen.getByRole('button', { name: `${completed ? '标记为已完成' : '标记为未完成'}：${todo.title}` }))
    await waitFor(() => expect(updateTodo).toHaveBeenCalledWith({ todoId: todo.id, completed, expectedRevision: 1 }))
    const result = await updateTodo.mock.results[0]!.value
    get.mockResolvedValue(result.note)
    expect(screen.getByRole('button', { name: `${completed ? '标记为未完成' : '标记为已完成'}：${todo.title}` })).toHaveAttribute('aria-pressed', String(completed))
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success', message: completed ? '待办已完成' : '待办已恢复为未完成' }))
    fireEvent.click(screen.getByRole('button', { name: '打开原笔记修改' }))
    await screen.findByDisplayValue(detail.title)
    expect(within(screen.getByRole('region', { name: '笔记记录' })).getByTestId('magic-note-checklist-state')).toHaveTextContent(completed ? 'checked' : 'unchecked')
  })

  it('renders a completed todo analysis inline with default options', async () => {
    getSettings.mockResolvedValue({ ...settings, magicNoteCommentMode: 'after-save-manual' })
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openTodo()
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }))
    await within(screen.getByRole('region', { name: 'AI 评论' })).findByText('先补充明确的验收条件。')
    expect(analyzeTodo).toHaveBeenCalledWith(todo.id, expect.objectContaining({ requestId: expect.any(String), direction: 'general', format: 'combined' }))
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success', message: 'AI 评论已添加' }))
  })

  it('automatically analyzes a saved entry in auto mode', async () => {
    getSettings.mockResolvedValue({ ...settings, magicNoteCommentMode: 'after-save-auto' })
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    fireEvent.click(screen.getByTestId('magic-note-editor'))
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
    await screen.findByText('保存后的自动评论。')
    expect(analyze).toHaveBeenCalledWith(createdEntryId, expect.objectContaining({ direction: 'general', format: 'combined' }))
  })

  it('retains manual entry analysis and the overview translations without reloading data', async () => {
    getSettings.mockResolvedValue({ ...settings, magicNoteCommentMode: 'after-save-manual' })
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    fireEvent.click(screen.getByRole('button', { name: '重新分析' }))
    await waitFor(() => expect(analyze).toHaveBeenCalledWith(entryId, expect.objectContaining({ direction: 'general', format: 'combined' })))
    await waitFor(() => expect(screen.getByRole('button', { name: '返回总览' })).toBeEnabled())
    back()
    await act(async () => { await i18n.changeLanguage('en-US') })
    expect(screen.getByRole('heading', { name: 'Magic Notes' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'New note' })).toBeVisible()
    expect(list).toHaveBeenCalledOnce()
  })

  it('does not show a discarded draft analysis in the next note', async () => {
    let finish!: (value: Awaited<ReturnType<DesktopApi['magicNotes']['analyzeDraft']>>) => void
    analyzeDraft.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    vi.useFakeTimers()
    fireEvent.click(screen.getByTestId('magic-note-editor'))
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(analyzeDraft).toHaveBeenCalledOnce()
    back()
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿并切换' }))
    vi.useRealTimers()
    await openNote(second.title)
    expect(screen.queryByText(/正在生成 ·/)).not.toBeInTheDocument()
    await act(async () => finish({ id: 'old-analysis', comments: [{ id: 'old-comment', kind: 'summary', content: 'Discarded comment' }], analyzedAt: detail.updatedAt }))
    expect(screen.queryByText('Discarded comment')).not.toBeInTheDocument()
  })

  it('analyzes an unsaved draft five seconds after Enter and cancels queued work when leaving', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    vi.useFakeTimers()
    fireEvent.click(screen.getByTestId('magic-note-editor'))
    await act(() => vi.advanceTimersByTimeAsync(4999))
    expect(analyzeDraft).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(analyzeDraft).toHaveBeenCalledWith(content, expect.objectContaining({ direction: 'general', format: 'combined' }))
    expect(screen.getByText('这是最新的草稿评论。')).toBeVisible()
    fireEvent.click(screen.getByTestId('magic-note-editor'))
    back()
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿并切换' }))
    await act(() => vi.advanceTimersByTimeAsync(6000))
    expect(analyzeDraft).toHaveBeenCalledOnce()
  })
})

describe('MagicNotesWorkspace external refresh', () => {
  it('coalesces writes in detail, keeps the selected note, and returns to overview after clean external deletion', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    const renamed = { ...detail, title: 'Agent-renamed note', pinned: true, revision: 2 }
    list.mockResolvedValue({ notes: [second, renamed] })
    get.mockResolvedValue(renamed)
    act(() => { changeListener?.(); changeListener?.(); changeListener?.() })
    await screen.findByDisplayValue(renamed.title)
    expect(get).toHaveBeenLastCalledWith(noteId)
    expect(list).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    list.mockResolvedValue({ notes: [second] })
    act(() => changeListener?.())
    await screen.findByRole('tab', { name: '笔记' })
    expect(screen.queryByLabelText('笔记标题')).not.toBeInTheDocument()
    expect(screen.getByText(second.title)).toBeVisible()
    expect(get).not.toHaveBeenCalledWith(secondNoteId)
  })

  it('keeps overview data and filters after a post-deletion refresh fails, then retries', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByText(detail.title)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '发布' } })
    fireEvent.click(screen.getByRole('button', { name: `更多笔记操作 ${detail.title}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除笔记' }))
    list.mockRejectedValueOnce(new Error('refresh failed'))
    fireEvent.click(screen.getByRole('button', { name: '删除笔记' }))
    await screen.findByText(/刷新失败，已保留当前内容：refresh failed/)
    expect(screen.getByRole('searchbox')).toHaveValue('发布')
    expect(screen.getByRole('button', { name: /发布笔记.*条记录/ })).toBeVisible()
    expect(onNotify).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', message: 'refresh failed' }))
    list.mockResolvedValue({ notes: [second] })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('没有符合条件的笔记')
    expect(screen.queryByText(/refresh failed/)).not.toBeInTheDocument()
    expect(screen.getByRole('searchbox')).toHaveValue('发布')
  })

  it('does not override a newer selection when a retried detail refresh resolves late', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    list.mockRejectedValueOnce(new Error('refresh failed'))
    act(() => changeListener?.())
    await screen.findByText(/refresh failed/)
    let finish!: (value: MagicNoteDetail) => void
    get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    back()
    await openNote(second.title)
    await act(async () => finish(detail))
    expect(screen.getByLabelText('笔记标题')).toHaveValue(second.title)
    expect(screen.queryByText(/refresh failed/)).not.toBeInTheDocument()
  })

  it('retains a dirty title alone when its note is externally deleted', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: 'Unsaved title' } })
    list.mockResolvedValue({ notes: [] })
    listTodos.mockResolvedValue({ todos: [] })
    act(() => changeListener?.())
    await screen.findByText(/这篇笔记已在其他入口删除/)
    expect(screen.getByLabelText('笔记标题')).toHaveValue('Unsaved title')
    back()
    expect(screen.getByRole('alertdialog')).toBeVisible()
  })

  it('coalesces overview refreshes without opening a note', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByText(detail.title)
    list.mockResolvedValue({ notes: [{ ...detail, title: 'Agent note' }] })
    act(() => { changeListener?.(); changeListener?.(); changeListener?.() })
    await screen.findByText('Agent note')
    expect(list).toHaveBeenCalledTimes(2)
    expect(get).not.toHaveBeenCalled()
  })

  it('preserves title and composer drafts when external entries arrive', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    const title = screen.getByLabelText('笔记标题')
    fireEvent.change(title, { target: { value: 'Unsaved title' } })
    const editor = screen.getByTestId('magic-note-editor')
    fireEvent.click(editor)
    get.mockResolvedValue({ ...detail, title: 'External title', revision: 2, entries: [...detail.entries, { ...detail.entries[0]!, id: createdEntryId, comments: [] }] })
    act(() => changeListener?.())
    await waitFor(() => expect(screen.getAllByText('记录正文')).toHaveLength(2))
    expect(title).toHaveValue('Unsaved title')
    expect(screen.getByTestId('magic-note-editor')).toBe(editor)
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
    await waitFor(() => expect(createEntry).toHaveBeenCalledWith({ noteId, content }))
  })

  it.each(['updated', 'deleted'] as const)('retains an entry draft externally %s and its original revision', async (change) => {
    const { container } = render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const editor = container.querySelector<HTMLElement>('.magic-note-entry__editor [data-testid="magic-note-editor"]')!
    fireEvent.click(editor)
    get.mockResolvedValue({ ...detail, title: 'External change', revision: 2, entries: change === 'deleted' ? [] : detail.entries.map((entry) => ({ ...entry, revision: 2 })) })
    act(() => changeListener?.())
    await screen.findByDisplayValue('External change')
    expect(container.querySelector('.magic-note-entry__editor [data-testid="magic-note-editor"]')).toBe(editor)
    if (change === 'deleted') expect(screen.getByText(/正在编辑的记录已在其他入口删除/)).toBeVisible()
    updateEntry.mockRejectedValueOnce(new Error('revision conflict'))
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(updateEntry).toHaveBeenCalledWith({ entryId, content, expectedRevision: 1 }))
    expect(container.querySelector('.magic-note-entry__editor [data-testid="magic-note-editor"]')).toBe(editor)
  })

  it('retains a deleted note with drafts until the user returns to the overview', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    const editor = screen.getByTestId('magic-note-editor')
    fireEvent.click(editor)
    list.mockResolvedValue({ notes: [second] })
    act(() => changeListener?.())
    await screen.findByText(/这篇笔记已在其他入口删除/)
    expect(screen.getByTestId('magic-note-editor')).toBe(editor)
    back()
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿并切换' }))
    expect(screen.getByText(second.title)).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: '新建笔记' })).toHaveFocus())
  })

  it('preserves the selected todo and reloads its source after external writes', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByText(detail.title)
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    expect(screen.queryByRole('button', { name: '新建待办' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '待办列表方式' })).not.toBeInTheDocument()
    expect(screen.getByText(second.title)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /准备演示.*演示笔记/ }))
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(secondNoteId))
    const callsBeforeRefresh = get.mock.calls.length
    listTodos.mockResolvedValue({ todos: [todo, { ...otherTodo, title: 'External todo' }] })
    act(() => changeListener?.())
    await screen.findByRole('heading', { name: 'External todo' })
    await waitFor(() => expect(get).toHaveBeenCalledTimes(callsBeforeRefresh + 1))
    expect(get).toHaveBeenLastCalledWith(secondNoteId)
  })

  it.each(['return', 'select'] as const)('does not let a delayed refresh undo a newer %s action', async (action) => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    let finish!: (snapshot: MagicNotesSnapshot) => void
    list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    act(() => changeListener?.())
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    back()
    if (action === 'select') await openNote(second.title)
    await act(async () => finish({ notes: [detail, second] }))
    if (action === 'select') expect(screen.getByLabelText('笔记标题')).toHaveValue(second.title)
    else {
      expect(screen.getByRole('tab', { name: '笔记' })).toBeVisible()
      expect(screen.queryByLabelText('笔记标题')).not.toBeInTheDocument()
    }
  })

  it('keeps drafts after refresh failure and while typing during retry', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    const editor = screen.getByTestId('magic-note-editor')
    fireEvent.click(editor)
    list.mockRejectedValueOnce(new Error('refresh failed'))
    act(() => changeListener?.())
    await screen.findByText(/refresh failed/)
    let finish!: (value: MagicNoteDetail) => void
    get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: 'Typed during refresh' } })
    await act(async () => finish({ ...detail, title: 'External title' }))
    expect(screen.getByLabelText('笔记标题')).toHaveValue('Typed during refresh')
    expect(screen.getByTestId('magic-note-editor')).toBe(editor)
  })

  it('defers refresh until an active save completes and prevents leaving mid-save', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await openNote()
    let finish!: (value: MagicNoteDetail) => void
    createEntry.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByTestId('magic-note-editor'))
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
    expect(screen.getByRole('button', { name: '返回总览' })).toBeDisabled()
    vi.useFakeTimers()
    act(() => changeListener?.())
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(list).toHaveBeenCalledOnce()
    await act(async () => finish(detail))
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes and cancels queued refreshes on unmount', async () => {
    const { unmount } = render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByText(detail.title)
    vi.useFakeTimers()
    act(() => changeListener?.())
    unmount()
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(unsubscribeChanges).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledOnce()
  })
})
