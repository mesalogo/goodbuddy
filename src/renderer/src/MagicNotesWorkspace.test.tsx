import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from './i18n'
import type { DesktopApi } from '../../shared/contracts'
import {
  defaultLocalToolEnvironmentSettings,
  type ApplicationSettings
} from '../../shared/application-settings-contracts'
import type {
  MagicNoteDetail,
  MagicNotesSnapshot,
  MagicNoteRichContent,
  MagicTodoItem,
  MagicTodoUpdateResult,
  MagicTodosSnapshot
} from '../../shared/magic-notes-contracts'
import { MagicNotesWorkspace } from './MagicNotesWorkspace'

vi.mock('./MagicNoteEditor', () => ({
  MagicNoteEditor: ({
    onChange,
    onParagraphCommit
  }: {
    onChange: (content: MagicNoteDetail['entries'][number]['content']) => void
    onParagraphCommit?: (
      content: MagicNoteDetail['entries'][number]['content']
    ) => void
  }) => (
    <button
      data-testid="magic-note-editor"
      onClick={() => {
        const content = {
          version: 1 as const,
          ops: [{ insert: '新的句子\n' }]
        }
        onChange(content)
        onParagraphCommit?.(content)
      }}
      type="button"
    >
      模拟输入并回车
    </button>
  )
}))

vi.mock('./MagicNoteContent', () => ({
  MagicNoteContent: ({ content }: { content: MagicNoteRichContent }) => {
    const checklistState =
      content.ops.find(
        (operation) =>
          operation.attributes?.list === 'checked' ||
          operation.attributes?.list === 'unchecked'
      )?.attributes?.list ?? 'none'
    return (
      <div>
        <span>记录正文</span>
        <output data-testid="magic-note-checklist-state">
          {checklistState}
        </output>
      </div>
    )
  }
}))

const noteId = '00000000-0000-4000-8000-000000000601'
const entryId = '00000000-0000-4000-8000-000000000602'
const noteTodoId = '00000000-0000-4000-8000-000000000603'
const manualTodoId = '00000000-0000-4000-8000-000000000604'
const secondNoteId = '00000000-0000-4000-8000-000000000608'
const thirdNoteId = '00000000-0000-4000-8000-000000000609'
const createdEntryId = '00000000-0000-4000-8000-000000000613'

const detail: MagicNoteDetail = {
  id: noteId,
  title: '发布笔记',
  preview: '整理发布清单',
  entryCount: 1,
  pinned: false,
  revision: 1,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:01:00.000Z',
  entries: [
    {
      id: entryId,
      noteId,
      content: {
        version: 1,
        ops: [{ insert: '整理发布清单\n' }]
      },
      plainText: '整理发布清单',
      comments: [
        {
          id: '00000000-0000-4000-8000-000000000605',
          kind: 'suggestion',
          content: '先核对发布材料。'
        }
      ],
      analyzedAt: '2026-08-01T00:02:00.000Z',
      revision: 1,
      createdAt: '2026-08-01T00:01:00.000Z',
      updatedAt: '2026-08-01T00:02:00.000Z'
    }
  ]
}

const noteTodo: MagicTodoItem = {
  id: noteTodoId,
  noteId,
  noteTitle: detail.title,
  entryId,
  sourceIndex: 0,
  source: 'note',
  title: '核对发布材料',
  instructions: '',
  completed: false,
  comments: [],
  revision: 1,
  createdAt: '2026-08-01T00:01:00.000Z',
  updatedAt: '2026-08-01T00:02:00.000Z'
}

const manualTodo: MagicTodoItem = {
  id: manualTodoId,
  noteId: secondNoteId,
  noteTitle: '演示笔记',
  entryId: '00000000-0000-4000-8000-000000000610',
  sourceIndex: 0,
  source: 'note',
  title: '准备演示',
  instructions: '确认演示环境和样例数据。',
  completed: false,
  comments: [],
  revision: 0,
  createdAt: '2026-08-01T00:03:00.000Z',
  updatedAt: '2026-08-01T00:03:00.000Z'
}

const alternateDetail = (
  id: string,
  title: string
): MagicNoteDetail => ({
  ...detail,
  id,
  title,
  preview: '',
  entryCount: 0,
  entries: []
})

const summaryFromDetail = (
  note: MagicNoteDetail
): MagicNotesSnapshot['notes'][number] => ({
  id: note.id,
  title: note.title,
  preview: note.preview,
  entryCount: note.entryCount,
  pinned: note.pinned,
  revision: note.revision,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt
})

const list = vi.fn<() => Promise<MagicNotesSnapshot>>()
const get = vi.fn<(noteId: string) => Promise<MagicNoteDetail>>()
const listTodos = vi.fn<() => Promise<MagicTodosSnapshot>>()
const create = vi.fn<DesktopApi['magicNotes']['create']>()
const remove = vi.fn<DesktopApi['magicNotes']['remove']>()
const createEntry = vi.fn<DesktopApi['magicNotes']['createEntry']>()
const updateEntry = vi.fn<DesktopApi['magicNotes']['updateEntry']>()
const analyze = vi.fn<DesktopApi['magicNotes']['analyze']>()
const updateTodo = vi.fn<DesktopApi['magicNotes']['updateTodo']>()
const analyzeTodo = vi.fn<DesktopApi['magicNotes']['analyzeTodo']>()
const analyzeDraft = vi.fn<DesktopApi['magicNotes']['analyzeDraft']>()
let analysisEventListener:
  | Parameters<DesktopApi['magicNotes']['onAnalysisEvent']>[0]
  | undefined
const onAnalysisEvent = vi.fn<
  DesktopApi['magicNotes']['onAnalysisEvent']
>((listener) => {
  analysisEventListener = listener
  return vi.fn()
})
const getApplicationSettings = vi.fn<() => Promise<ApplicationSettings>>(async () => ({
  checkUpdatesOnStartup: false,
  updateSource: 'github',
  modelDownloadSource: 'modelscope',
  localToolEnvironment: defaultLocalToolEnvironmentSettings,
  remoteProjectsEnabled: false,
  magicNotesEnabled: true,
  magicNotesShowIncompleteTodoCount: true,
  magicNoteCommentMode: 'immediate',
  magicNoteCommentFormat: 'combined'
}))
const onNotify = vi.fn()

beforeEach(() => {
  localStorage.clear()
  analysisEventListener = undefined
  getApplicationSettings.mockResolvedValue({
    checkUpdatesOnStartup: false,
    updateSource: 'github',
    modelDownloadSource: 'modelscope',
    localToolEnvironment: defaultLocalToolEnvironmentSettings,
    remoteProjectsEnabled: false,
    magicNotesEnabled: true,
    magicNotesShowIncompleteTodoCount: true,
    magicNoteCommentMode: 'immediate',
    magicNoteCommentFormat: 'combined'
  })
  list.mockResolvedValue({ notes: [detail] })
  get.mockResolvedValue(detail)
  listTodos.mockResolvedValue({ todos: [noteTodo, manualTodo] })
  create.mockResolvedValue(alternateDetail(thirdNoteId, '新笔记'))
  remove.mockResolvedValue()
  const createdDetail: MagicNoteDetail = {
    ...detail,
    revision: detail.revision + 1,
    entryCount: 2,
    entries: [
      ...detail.entries,
      {
        ...detail.entries[0]!,
        id: createdEntryId,
        content: {
          version: 1,
          ops: [{ insert: '新的句子\n' }]
        },
        plainText: '新的句子',
        comments: [],
        analyzedAt: undefined,
        revision: 0,
        createdAt: '2026-08-01T00:05:00.000Z',
        updatedAt: '2026-08-01T00:05:00.000Z'
      }
    ]
  }
  createEntry.mockResolvedValue(createdDetail)
  updateEntry.mockResolvedValue({
    ...detail,
    revision: detail.revision + 1,
    entries: detail.entries.map((entry) => ({
      ...entry,
      content: {
        version: 1,
        ops: [{ insert: '新的句子\n' }]
      },
      plainText: '新的句子',
      revision: entry.revision + 1
    }))
  })
  updateTodo.mockImplementation(
    async (input): Promise<MagicTodoUpdateResult> => ({
      todo: {
        ...noteTodo,
        completed: input.completed,
        revision: input.expectedRevision + 1
      },
      note: {
        ...detail,
        revision: detail.revision + 1,
        entries: detail.entries.map((entry) =>
          entry.id === noteTodo.entryId
            ? {
                ...entry,
                content: {
                  version: 1,
                  ops: [
                    { insert: noteTodo.title },
                    {
                      insert: '\n',
                      attributes: {
                        list: input.completed ? 'checked' : 'unchecked'
                      }
                    }
                  ]
                },
                comments: [],
                analyzedAt: undefined,
                revision: entry.revision + 1
              }
            : entry
        )
      }
    })
  )
  analyze.mockResolvedValue({
    ...createdDetail,
    entries: createdDetail.entries.map((entry) =>
      entry.id === createdEntryId
        ? {
            ...entry,
            comments: [
              {
                id: '00000000-0000-4000-8000-000000000614',
                kind: 'suggestion',
                content: '保存后的自动评论。'
              }
            ],
            analyzedAt: '2026-08-01T00:06:00.000Z',
            revision: 1
          }
        : entry
    )
  })
  analyzeDraft.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000611',
    comments: [
      {
        id: '00000000-0000-4000-8000-000000000612',
        kind: 'summary',
        content: '这是最新的草稿评论。'
      }
    ],
    analyzedAt: '2026-08-01T00:05:00.000Z'
  })
  analyzeTodo.mockResolvedValue({
    ...noteTodo,
    comments: [
      {
        id: '00000000-0000-4000-8000-000000000607',
        kind: 'suggestion',
        content: '先补充明确的验收条件。'
      }
    ],
    analyzedAt: '2026-08-01T00:04:00.000Z',
    revision: 2
  })
  Object.defineProperty(window, 'goodbuddy', {
    configurable: true,
    value: {
      magicNotes: {
        list,
        get,
        listTodos,
        create,
        remove,
        createEntry,
        updateEntry,
        analyze,
        updateTodo,
        analyzeTodo,
        analyzeDraft,
        onAnalysisEvent
      },
      updates: {
        getSettings: getApplicationSettings
      }
    } as unknown as DesktopApi
  })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.clearAllMocks()
})

describe('MagicNotesWorkspace', () => {
  it('shows a retryable EmptyState when the initial load fails', async () => {
    get.mockRejectedValueOnce(new Error('详情暂时不可用'))

    render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    expect(
      await screen.findByText('魔法笔记加载失败')
    ).toBeInTheDocument()
    expect(screen.getByText(/详情暂时不可用/)).toBeInTheDocument()
    expect(screen.queryByText('还没有笔记')).not.toBeInTheDocument()
    expect(screen.queryByText('还没有待办')).not.toBeInTheDocument()
    expect(screen.queryByText('还没有选择笔记')).not.toBeInTheDocument()
    expect(onNotify).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('记录正文')).toBeInTheDocument()
    expect(screen.queryByText('魔法笔记加载失败')).not.toBeInTheDocument()
  })

  it('keeps successful data and selection when a refresh fails', async () => {
    render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    await screen.findByText('记录正文')
    list.mockRejectedValueOnce(new Error('刷新暂时不可用'))
    fireEvent.click(screen.getByRole('button', { name: '删除笔记' }))
    fireEvent.click(
      screen.getAllByRole('button', { name: '删除笔记' })[1]!
    )

    expect(
      await screen.findByText(/刷新失败，已保留当前内容：刷新暂时不可用/)
    ).toBeInTheDocument()
    expect(screen.getByLabelText('笔记标题')).toHaveValue(detail.title)
    expect(
      screen.getByRole('button', { name: /发布笔记/ })
    ).toHaveAttribute('aria-pressed', 'true')
    const updatedTime = screen
      .getByRole('button', { name: /发布笔记/ })
      .querySelector('time')
    expect(updatedTime).toHaveAttribute('datetime', detail.updatedAt)
    expect(updatedTime).toHaveTextContent('更新于')
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    expect(screen.getByText('准备演示')).toBeInTheDocument()
    const selectedTodoButton = screen
      .getAllByText('核对发布材料')
      .find((element) => element.tagName === 'STRONG')
      ?.closest('button')
    expect(
      selectedTodoButton
    ).toHaveAttribute('aria-pressed', 'true')
    expect(onNotify).not.toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'error',
        message: '刷新暂时不可用'
      })
    )
  })

  it('shows note-backed todos with the title above its source', async () => {
    render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    expect(await screen.findByText('先核对发布材料。')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '创建待办' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('全部笔记')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    expect(
      screen.getByRole('tablist', { name: '魔法笔记内容' })
    ).toHaveClass('page-tabs--segmented')
    expect(await screen.findAllByText('核对发布材料')).toHaveLength(2)
    expect(screen.getByText('准备演示')).toBeInTheDocument()
    const todoTitle = screen.getByRole('heading', {
      name: '核对发布材料'
    })
    const todoSource = todoTitle.parentElement!.querySelector('span')!
    expect(
      todoTitle.compareDocumentPosition(todoSource) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    expect(
      screen.getAllByRole('button', {
        name: `标记为已完成：${noteTodo.title}`
      })
    ).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: '打开原笔记修改' })
    ).toBeInTheDocument()
  })

  it('keeps history editing contained and de-emphasizes note deletion', async () => {
    const { container } = render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    await screen.findByText('记录正文')
    const deleteNote = screen.getByRole('button', {
      name: '删除笔记'
    })
    const deleteEntry = screen.getByRole('button', {
      name: '删除记录'
    })
    expect(deleteNote).toHaveClass(
      'icon-button',
      'magic-note-detail-header__delete'
    )
    expect(deleteNote).toHaveTextContent('')
    expect(deleteEntry).toHaveClass('danger-button', 'danger-button--quiet')
    expect(deleteEntry).toHaveTextContent('删除记录')

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    await waitFor(() =>
      expect(
        container.querySelector(
          '.magic-note-entry__editor > [data-testid="magic-note-editor"]'
        )
      ).toBeInTheDocument()
    )
    expect(
      container.querySelector(
        '.magic-note-entry__editor-actions'
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '删除记录' }))
    expect(
      screen.getByText('删除这条记录？此操作不可撤销。')
    ).toBeInTheDocument()
    expect(
      container.querySelector('.magic-note-entry__editor')
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(
      screen.queryByText('删除这条记录？此操作不可撤销。')
    ).not.toBeInTheDocument()
  })

  it('can hide and restore the AI comments pane', async () => {
    render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    const pane = await screen.findByLabelText('AI 评论')
    expect(
      screen.queryByRole('group', { name: 'AI 评论形式' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'AI 评论方向' })
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: '关闭 AI 评论面板' })
    )
    expect(pane).not.toBeVisible()

    fireEvent.click(
      screen.getByRole('button', { name: '显示 AI 评论' })
    )
    expect(pane).toBeVisible()
  })

  it('hides, restores, and remembers the left list pane', async () => {
    const firstRender = render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    const pane = await screen.findByLabelText('笔记列表')
    const hideButton = screen.getByRole('button', {
      name: '隐藏左侧列表'
    })
    expect(hideButton).toHaveAttribute('aria-expanded', 'true')
    expect(pane).toBeVisible()

    fireEvent.click(hideButton)
    expect(pane).not.toBeVisible()
    expect(
      screen.queryByRole('separator', {
        name: '调整笔记列表与编辑区宽度'
      })
    ).not.toBeInTheDocument()
    expect(
      JSON.parse(
        localStorage.getItem('goodbuddy.magic-notes-layout.v1') ?? '{}'
      )
    ).toMatchObject({ listPaneOpen: false })

    firstRender.unmount()
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    const restoredPane = await screen.findByLabelText('笔记列表')
    expect(restoredPane).not.toBeVisible()

    const showButton = screen.getByRole('button', {
      name: '显示左侧列表'
    })
    expect(showButton).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(showButton)
    expect(restoredPane).toBeVisible()
    expect(
      screen.getByRole('separator', {
        name: '调整笔记列表与编辑区宽度'
      })
    ).toBeInTheDocument()
  })

  it('resizes the left list pane with pointer and keyboard controls', async () => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1200
    })
    render(<MagicNotesWorkspace onNotify={onNotify} />)

    try {
      await screen.findByText('记录正文')
      const separator = screen.getByRole('separator', {
        name: '调整笔记列表与编辑区宽度'
      })
      const layout =
        separator.closest('.magic-notes-layout') as HTMLElement
      const setPointerCapture = vi.fn()
      const releasePointerCapture = vi.fn()
      Object.defineProperties(separator, {
        setPointerCapture: { value: setPointerCapture },
        hasPointerCapture: { value: () => true },
        releasePointerCapture: { value: releasePointerCapture }
      })

      expect(separator).toHaveAttribute('aria-valuenow', '220')
      expect(separator).toHaveAttribute('aria-valuemin', '180')
      expect(separator).toHaveAttribute('aria-valuemax', '360')

      fireEvent.pointerDown(separator, {
        button: 0,
        clientX: 220,
        pointerId: 13
      })
      fireEvent.pointerMove(separator, {
        clientX: 350,
        pointerId: 13
      })

      expect(setPointerCapture).toHaveBeenCalledWith(13)
      expect(layout).toHaveClass('magic-notes-layout--resizing')
      expect(layout).toHaveClass('magic-notes-layout--list-resizing')
      expect(
        layout.style.getPropertyValue('--magic-notes-list-width')
      ).toBe('350px')

      fireEvent.pointerUp(separator, { pointerId: 13 })
      expect(releasePointerCapture).toHaveBeenCalledWith(13)
      expect(layout).not.toHaveClass('magic-notes-layout--resizing')
      expect(
        JSON.parse(
          localStorage.getItem(
            'goodbuddy.magic-notes-layout.v1'
          ) ?? '{}'
        )
      ).toMatchObject({ listPaneWidth: 350 })

      fireEvent.keyDown(separator, { key: 'Home' })
      expect(
        layout.style.getPropertyValue('--magic-notes-list-width')
      ).toBe('180px')

      fireEvent.keyDown(separator, { key: 'ArrowRight' })
      expect(
        layout.style.getPropertyValue('--magic-notes-list-width')
      ).toBe('196px')

      fireEvent.keyDown(separator, { key: 'End' })
      expect(
        layout.style.getPropertyValue('--magic-notes-list-width')
      ).toBe('360px')
      expect(separator).toHaveAttribute('aria-valuenow', '360')
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth
      })
    }
  })

  it('disables horizontal pane resizing in the narrow stacked layout', async () => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 700
    })
    render(<MagicNotesWorkspace onNotify={onNotify} />)

    try {
      await screen.findByText('记录正文')
      const listSeparator = screen.getByRole('separator', {
        name: '调整笔记列表与编辑区宽度'
      })
      expect(listSeparator).toHaveAttribute('aria-disabled', 'true')
      expect(listSeparator).toHaveAttribute('tabindex', '-1')
      const aiSeparator = screen.getByRole('separator', {
        name: '调整编辑区与 AI 评论宽度'
      })
      expect(aiSeparator).toHaveAttribute('aria-disabled', 'true')
      expect(aiSeparator).toHaveAttribute('tabindex', '-1')
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth
      })
    }
  })

  it('shows a concise empty state before a note has AI comments', async () => {
    let resolveDetail:
      | ((value: MagicNoteDetail) => void)
      | undefined
    const delayedDetail = new Promise<MagicNoteDetail>((resolve) => {
      resolveDetail = resolve
    })
    get.mockReturnValueOnce(delayedDetail)

    render(<MagicNotesWorkspace onNotify={onNotify} />)

    const pane = await screen.findByLabelText('AI 评论')
    expect(within(pane).getByText('正在加载')).toBeInTheDocument()
    expect(within(pane).getByText('正在加载笔记…')).toBeInTheDocument()
    expect(
      within(pane).queryByText('暂无 AI 评论')
    ).not.toBeInTheDocument()

    await act(async () => {
      resolveDetail?.(alternateDetail(noteId, detail.title))
      await delayedDetail
    })

    expect(
      await within(pane).findByText(
        '写完一句并停止输入 5 秒后，评论会显示在这里。'
      )
    ).toBeInTheDocument()
    expect(within(pane).getByText('写下一句话')).toBeInTheDocument()
    expect(
      within(pane).queryByText('暂无 AI 评论')
    ).not.toBeInTheDocument()
    expect(within(pane).queryByText('正在加载')).not.toBeInTheDocument()
  })

  it('resizes the AI comments pane with pointer and keyboard controls', async () => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1200
    })
    render(<MagicNotesWorkspace onNotify={onNotify} />)

    await screen.findByText('记录正文')
    const separator = screen.getByRole('separator', {
      name: '调整编辑区与 AI 评论宽度'
    })
    const layout = separator.closest('.magic-notes-layout') as HTMLElement
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.defineProperties(separator, {
      setPointerCapture: { value: setPointerCapture },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: releasePointerCapture }
    })

    expect(separator).toHaveAttribute('aria-valuenow', '280')

    fireEvent.pointerDown(separator, {
      button: 0,
      clientX: 800,
      pointerId: 12
    })
    fireEvent.pointerMove(separator, {
      clientX: 600,
      pointerId: 12
    })

    expect(setPointerCapture).toHaveBeenCalledWith(12)
    expect(layout).toHaveClass('magic-notes-layout--resizing')
    expect(
      layout.style.getPropertyValue('--magic-notes-ai-width')
    ).toBe('520px')

    fireEvent.pointerUp(separator, { pointerId: 12 })
    expect(releasePointerCapture).toHaveBeenCalledWith(12)
    expect(layout).not.toHaveClass('magic-notes-layout--resizing')

    fireEvent.keyDown(separator, { key: 'Home' })
    expect(
      layout.style.getPropertyValue('--magic-notes-ai-width')
    ).toBe('240px')
    expect(separator).toHaveAttribute('aria-valuenow', '240')

    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(
      layout.style.getPropertyValue('--magic-notes-ai-width')
    ).toBe('256px')

    fireEvent.keyDown(separator, { key: 'End' })
    expect(
      layout.style.getPropertyValue('--magic-notes-ai-width')
    ).toBe('520px')

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth
    })
  })

  it('keeps the selected note aligned with the latest detail request', async () => {
    const second = alternateDetail(secondNoteId, '第二篇笔记')
    const third = alternateDetail(thirdNoteId, '第三篇笔记')
    list.mockResolvedValue({
      notes: [
        summaryFromDetail(detail),
        summaryFromDetail(second),
        summaryFromDetail(third)
      ]
    })
    let resolveSecond: (value: MagicNoteDetail) => void = () => undefined
    const delayedSecond = new Promise<MagicNoteDetail>((resolve) => {
      resolveSecond = resolve
    })
    get.mockImplementation((requestedId) => {
      if (requestedId === second.id) {
        return delayedSecond
      }
      return Promise.resolve(requestedId === third.id ? third : detail)
    })

    render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByText(second.title).closest('button')!)
    fireEvent.click(screen.getByText(third.title).closest('button')!)
    expect(await screen.findByDisplayValue(third.title)).toBeInTheDocument()

    resolveSecond(second)
    await waitFor(() =>
      expect(screen.getByLabelText('笔记标题')).toHaveValue(third.title)
    )
  })

  it('keeps a non-empty composer draft until note switching is confirmed', async () => {
    const second = alternateDetail(secondNoteId, '第二篇笔记')
    list.mockResolvedValue({
      notes: [summaryFromDetail(detail), summaryFromDetail(second)]
    })
    get.mockImplementation((requestedId) =>
      Promise.resolve(requestedId === second.id ? second : detail)
    )

    render(<MagicNotesWorkspace onNotify={onNotify} />)

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByText('模拟输入并回车'))
    const callsBeforeSwitch = get.mock.calls.length
    fireEvent.click(screen.getByText(second.title).closest('button')!)

    const confirmation = screen.getByRole('alertdialog', {
      name: '放弃当前未保存草稿？'
    })
    const continueEditing = screen.getByRole('button', {
      name: '继续编辑'
    })
    const discardAndSwitch = screen.getByRole('button', {
      name: '放弃草稿并切换'
    })
    expect(confirmation).toHaveAccessibleDescription(
      '切换后，当前记录草稿中的文字和附件将被丢弃。'
    )
    expect(continueEditing).toHaveFocus()
    expect(get).toHaveBeenCalledTimes(callsBeforeSwitch)
    expect(
      screen.getByRole('button', { name: /发布笔记/ })
    ).toHaveAttribute('aria-pressed', 'true')

    discardAndSwitch.focus()
    fireEvent.keyDown(discardAndSwitch, { key: 'Tab' })
    expect(continueEditing).toHaveFocus()
    fireEvent.keyDown(continueEditing, { key: 'Tab', shiftKey: true })
    expect(discardAndSwitch).toHaveFocus()
    fireEvent.keyDown(confirmation, { key: 'Escape' })

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('magic-note-editor')).toHaveFocus()
    )
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
    await waitFor(() =>
      expect(createEntry).toHaveBeenCalledWith({
        noteId,
        content: {
          version: 1,
          ops: [{ insert: '新的句子\n' }]
        }
      })
    )

    fireEvent.click(screen.getByText('模拟输入并回车'))
    fireEvent.click(screen.getByText(second.title).closest('button')!)
    fireEvent.click(
      screen.getByRole('button', { name: '放弃草稿并切换' })
    )

    expect(await screen.findByDisplayValue(second.title)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /第二篇笔记/ })
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('guards dirty existing-entry edits and keeps the first pending target', async () => {
    const second = alternateDetail(secondNoteId, '第二篇笔记')
    const third = alternateDetail(thirdNoteId, '第三篇笔记')
    list.mockResolvedValue({
      notes: [
        summaryFromDetail(detail),
        summaryFromDetail(second),
        summaryFromDetail(third)
      ]
    })
    get.mockImplementation((requestedId) =>
      Promise.resolve(
        requestedId === second.id
          ? second
          : requestedId === third.id
            ? third
            : detail
      )
    )
    const { container } = render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const editEditor = container.querySelector<HTMLButtonElement>(
      '.magic-note-entry__editor [data-testid="magic-note-editor"]'
    )!
    fireEvent.click(editEditor)
    const secondButton = screen.getByText(second.title).closest('button')!
    const thirdButton = screen.getByText(third.title).closest('button')!
    fireEvent.click(secondButton)

    const dialog = screen.getByRole('alertdialog', {
      name: '放弃当前未保存草稿？'
    })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(
      container.querySelector<HTMLElement>('.magic-notes-list-pane')?.inert
    ).toBe(true)
    fireEvent.click(thirdButton)
    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(
      container.querySelector<HTMLElement>('.magic-notes-list-pane')?.inert
    ).toBe(false)
    await waitFor(() => expect(editEditor).toHaveFocus())

    fireEvent.click(secondButton)
    fireEvent.click(
      screen.getByRole('button', { name: '放弃草稿并切换' })
    )

    expect(await screen.findByDisplayValue(second.title)).toBeInTheDocument()
    await waitFor(() => expect(secondButton).toHaveFocus())
    expect(get).not.toHaveBeenCalledWith(third.id)
  })

  it('guards keyboard tab selection and switches only after discard', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByText('模拟输入并回车'))
    const notesTab = screen.getByRole('tab', { name: '笔记' })
    const todosTab = screen.getByRole('tab', { name: '待办' })
    notesTab.focus()
    fireEvent.keyDown(notesTab, { key: 'ArrowRight' })

    expect(todosTab).toHaveAttribute('aria-selected', 'false')
    expect(notesTab).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('alertdialog', {
        name: '放弃当前未保存草稿？'
      })
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '放弃草稿并切换' })
    )

    expect(todosTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('准备演示')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('does not create and select another note before the draft is discarded', async () => {
    const { container } = render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByText('模拟输入并回车'))
    fireEvent.click(screen.getByRole('button', { name: '新建笔记' }))
    fireEvent.change(
      container.querySelector<HTMLInputElement>(
        '.magic-notes-create input'
      )!,
      {
        target: { value: '新笔记' }
      }
    )
    fireEvent.click(screen.getByRole('button', { name: '创建笔记' }))

    expect(create).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: /发布笔记/ })
    ).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(
      screen.getByRole('button', { name: '放弃草稿并切换' })
    )

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ title: '新笔记' })
    )
    expect(await screen.findByDisplayValue('新笔记')).toBeInTheDocument()
  })

  it('preserves the composer draft across save errors and unrelated rerenders', async () => {
    createEntry.mockRejectedValueOnce(new Error('暂时无法保存'))
    render(<MagicNotesWorkspace onNotify={onNotify} />)

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByText('模拟输入并回车'))
    await i18n.changeLanguage('en-US')
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }))

    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'error',
          message: '暂时无法保存'
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }))

    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(2))
    expect(createEntry).toHaveBeenNthCalledWith(1, {
      noteId,
      content: {
        version: 1,
        ops: [{ insert: '新的句子\n' }]
      }
    })
    expect(createEntry).toHaveBeenNthCalledWith(2, {
      noteId,
      content: {
        version: 1,
        ops: [{ insert: '新的句子\n' }]
      }
    })
    await i18n.changeLanguage('zh-CN')
  })

  it('finalizes a created entry before a to-do refresh failure', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)

    await screen.findByText('记录正文')
    listTodos.mockRejectedValueOnce(new Error('待办刷新失败'))
    fireEvent.click(screen.getByText('模拟输入并回车'))
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }))

    await waitFor(() => expect(createEntry).toHaveBeenCalledOnce())
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'success',
        message: '记录已保存'
      })
    )
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'error',
        message: '待办刷新失败'
      })
    )
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }))

    expect(createEntry).toHaveBeenCalledOnce()
    expect(screen.getByText('请先输入记录内容')).toBeInTheDocument()
  })

  it('finalizes an edited entry before a to-do refresh failure', async () => {
    const { container } = render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    await screen.findByText('记录正文')
    listTodos.mockRejectedValueOnce(new Error('待办刷新失败'))
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '.magic-note-entry__editor [data-testid="magic-note-editor"]'
      )!
    )
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(updateEntry).toHaveBeenCalledOnce())
    expect(updateEntry).toHaveBeenCalledWith({
      entryId,
      content: {
        version: 1,
        ops: [{ insert: '新的句子\n' }]
      },
      expectedRevision: detail.entries[0]!.revision
    })
    expect(
      screen.queryByRole('button', { name: '保存修改' })
    ).not.toBeInTheDocument()
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'success',
        message: '记录已更新，原 AI 评论已清除'
      })
    )
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'error',
        message: '待办刷新失败'
      })
    )
  })

  it('does not override a note selected while retrying a refresh', async () => {
    const second = alternateDetail(secondNoteId, '第二篇笔记')
    list.mockResolvedValue({
      notes: [summaryFromDetail(detail), summaryFromDetail(second)]
    })

    render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    await screen.findByText('记录正文')
    list.mockRejectedValueOnce(new Error('刷新暂时不可用'))
    fireEvent.click(screen.getByRole('button', { name: '删除笔记' }))
    fireEvent.click(
      screen.getAllByRole('button', { name: '删除笔记' })[1]!
    )
    const retry = await screen.findByRole('button', { name: '重试' })

    let resolveRefreshDetail:
      | ((value: MagicNoteDetail) => void)
      | undefined
    const delayedRefreshDetail = new Promise<MagicNoteDetail>(
      (resolve) => {
        resolveRefreshDetail = resolve
      }
    )
    get.mockImplementation((requestedId) =>
      requestedId === second.id
        ? Promise.resolve(second)
        : delayedRefreshDetail
    )

    fireEvent.click(retry)
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByText(second.title).closest('button')!)
    expect(await screen.findByDisplayValue(second.title)).toBeInTheDocument()

    resolveRefreshDetail?.(detail)
    await waitFor(() =>
      expect(screen.getByLabelText('笔记标题')).toHaveValue(second.title)
    )
  })

  it('only shows note-backed todos in a directory view', async () => {
    render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    expect(
      screen.queryByRole('button', { name: '新建待办' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: '待办列表方式' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('发布笔记')).toBeInTheDocument()
    expect(screen.getByText('演示笔记')).toBeInTheDocument()
    expect(screen.getByText('准备演示')).toBeInTheDocument()
  })

  it('synchronizes todo completion with its source note immediately', async () => {
    render(<MagicNotesWorkspace onNotify={onNotify} />)

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    fireEvent.click(
      screen.getAllByRole('button', {
        name: `标记为已完成：${noteTodo.title}`
      })[0]!
    )

    await waitFor(() =>
      expect(updateTodo).toHaveBeenCalledWith({
        todoId: noteTodo.id,
        completed: true,
        expectedRevision: noteTodo.revision
      })
    )
    expect(
      screen.getByRole('button', {
        name: `标记为未完成：${noteTodo.title}`
      })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'success',
        message: '待办已完成'
      })
    )

    fireEvent.click(screen.getByRole('tab', { name: '笔记' }))
    expect(
      screen.getByTestId('magic-note-checklist-state')
    ).toHaveTextContent('checked')

    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    fireEvent.click(
      screen.getByRole('button', {
        name: `标记为未完成：${noteTodo.title}`
      })
    )
    await waitFor(() =>
      expect(updateTodo).toHaveBeenNthCalledWith(2, {
        todoId: noteTodo.id,
        completed: false,
        expectedRevision: noteTodo.revision + 1
      })
    )

    fireEvent.click(screen.getByRole('tab', { name: '笔记' }))
    expect(
      screen.getByTestId('magic-note-checklist-state')
    ).toHaveTextContent('unchecked')
  })

  it('reuses the AI comments pane for selected todos', async () => {
    getApplicationSettings.mockResolvedValue({
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultLocalToolEnvironmentSettings,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'after-save-manual',
      magicNoteCommentFormat: 'combined'
    })
    render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }))

    await waitFor(() =>
      expect(analyzeTodo).toHaveBeenCalledWith(
        noteTodo.id,
        expect.objectContaining({
          requestId: expect.any(String),
          direction: 'general',
          format: 'combined'
        })
      )
    )
    expect(
      await screen.findByText('先补充明确的验收条件。')
    ).toBeInTheDocument()
  })

  it('streams with snapshotted sidebar options while later changes stay local', async () => {
    getApplicationSettings.mockResolvedValue({
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultLocalToolEnvironmentSettings,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'after-save-manual',
      magicNoteCommentFormat: 'narrative'
    })
    let finishAnalysis: (() => void) | undefined
    analyzeTodo.mockImplementationOnce(
      (_todoId, options) =>
        new Promise<MagicTodoItem>((resolve) => {
          analysisEventListener?.({
            requestId: options.requestId,
            type: 'text',
            delta: '正在扩展这一段内容。',
            direction: 'expand',
            format: 'narrative'
          })
          finishAnalysis = () =>
            resolve({
              ...noteTodo,
              comments: [
                {
                  id: '00000000-0000-4000-8000-000000000620',
                  kind: 'narrative',
                  content: '扩展后的完整评论。',
                  direction: 'expand',
                  format: 'narrative'
                }
              ],
              analyzedAt: '2026-08-01T00:07:00.000Z',
              revision: 2
            })
        })
    )

    render(<MagicNotesWorkspace onNotify={onNotify} />)

    await screen.findByText('记录正文')
    fireEvent.change(
      screen.getByRole('combobox', { name: 'AI 评论方向' }),
      { target: { value: 'expand' } }
    )
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }))

    expect(
      await screen.findByText('正在扩展这一段内容。')
    ).toBeInTheDocument()
    expect(screen.getByText(/正在生成 ·/)).toHaveTextContent(
      '正在生成 · 扩展写作'
    )
    fireEvent.change(
      screen.getByRole('combobox', { name: 'AI 评论方向' }),
      { target: { value: 'polish' } }
    )
    expect(screen.getByText(/正在生成 ·/)).toHaveTextContent(
      '正在生成 · 扩展写作'
    )

    await act(async () => finishAnalysis?.())

    expect(await screen.findByText('扩展后的完整评论。')).toBeInTheDocument()
    expect(
      screen
        .getAllByText('扩展写作')
        .some((element) =>
          element.classList.contains('magic-note-comment__direction')
        )
    ).toBe(true)
    expect(
      screen.getByRole('combobox', { name: 'AI 评论方向' })
    ).toHaveValue('polish')
    expect(analyzeTodo).toHaveBeenCalledWith(
      noteTodo.id,
      expect.objectContaining({
        direction: 'expand',
        format: 'narrative'
      })
    )
  })

  it('clears note searches and todo status filters with no results', async () => {
    listTodos.mockResolvedValue({
      todos: [
        { ...noteTodo, completed: true },
        { ...manualTodo, completed: true }
      ]
    })
    render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    await screen.findByText('记录正文')
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索当前范围的笔记' }), {
      target: { value: '不存在的笔记' }
    })
    expect(screen.getByText('没有符合条件的笔记')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(screen.getByRole('searchbox', {
      name: '搜索当前范围的笔记'
    })).toHaveValue('')
    expect(screen.getByText('发布笔记')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    expect(screen.getByText('没有符合条件的待办')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(
      screen.getByRole('button', { name: '全部' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByText('核对发布材料')).not.toHaveLength(0)
  })

  it('automatically comments on a newly saved record in auto mode', async () => {
    getApplicationSettings.mockResolvedValue({
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultLocalToolEnvironmentSettings,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'after-save-auto',
      magicNoteCommentFormat: 'combined'
    })
    render(<MagicNotesWorkspace onNotify={onNotify} />)

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByText('模拟输入并回车'))
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }))

    await waitFor(() =>
      expect(createEntry).toHaveBeenCalledWith({
        noteId,
        content: {
          version: 1,
          ops: [{ insert: '新的句子\n' }]
        }
      })
    )
    await waitFor(() =>
      expect(analyze).toHaveBeenCalledWith(
        createdEntryId,
        expect.objectContaining({
          requestId: expect.any(String),
          direction: 'general',
          format: 'combined'
        })
      )
    )
    expect(
      await screen.findByText('保存后的自动评论。')
    ).toBeInTheDocument()
  })

  it('comments on an unsaved draft five seconds after Enter', async () => {
    render(
      <MagicNotesWorkspace onNotify={onNotify} />
    )

    await screen.findByText('记录正文')
    vi.useFakeTimers()
    fireEvent.click(screen.getByText('模拟输入并回车'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999)
    })
    expect(analyzeDraft).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(analyzeDraft).toHaveBeenCalledWith(
      {
        version: 1,
        ops: [{ insert: '新的句子\n' }]
      },
      expect.objectContaining({
        requestId: expect.any(String),
        direction: 'general',
        format: 'combined'
      })
    )
    expect(screen.getByText('这是最新的草稿评论。')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('switches to English without reloading notes', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<MagicNotesWorkspace onNotify={onNotify} />)
    await screen.findByRole('heading', { name: '魔法笔记' })
    expect(list).toHaveBeenCalledOnce()

    try {
      await i18n.changeLanguage('en-US')

      expect(
        await screen.findByRole('heading', { name: 'Magic Notes' })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('tab', { name: 'Notes' })
      ).toHaveAttribute('aria-selected', 'true')
      expect(
        screen.getByRole('button', { name: 'New note' })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('combobox', { name: 'AI comment direction' })
      ).toHaveValue('general')
      expect(screen.getByText(detail.title)).toBeInTheDocument()
      expect(screen.getByText('先核对发布材料。')).toBeInTheDocument()
      expect(list).toHaveBeenCalledOnce()
    } finally {
      await i18n.changeLanguage('zh-CN')
    }
  })
})
