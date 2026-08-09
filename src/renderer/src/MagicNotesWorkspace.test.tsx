import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../shared/contracts'
import type {
  MagicNoteDetail,
  MagicNotesSnapshot,
  MagicTodoItem,
  MagicTodosSnapshot
} from '../../shared/magic-notes-contracts'
import { MagicNotesWorkspace } from './MagicNotesWorkspace'

vi.mock('./MagicNoteEditor', () => ({
  MagicNoteEditor: () => <div data-testid="magic-note-editor" />
}))

vi.mock('./MagicNoteContent', () => ({
  MagicNoteContent: () => <div>记录正文</div>
}))

const noteId = '00000000-0000-4000-8000-000000000601'
const entryId = '00000000-0000-4000-8000-000000000602'
const noteTodoId = '00000000-0000-4000-8000-000000000603'
const manualTodoId = '00000000-0000-4000-8000-000000000604'
const secondNoteId = '00000000-0000-4000-8000-000000000608'
const thirdNoteId = '00000000-0000-4000-8000-000000000609'

const detail: MagicNoteDetail = {
  id: noteId,
  projectId: '00000000-0000-4000-8000-000000000101',
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
  projectId: detail.projectId,
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
  projectId: detail.projectId,
  source: 'manual',
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
  projectId: note.projectId,
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
const createTodo = vi.fn<DesktopApi['magicNotes']['createTodo']>()
const updateTodo = vi.fn<DesktopApi['magicNotes']['updateTodo']>()
const removeTodo = vi.fn<DesktopApi['magicNotes']['removeTodo']>()
const analyzeTodo = vi.fn<DesktopApi['magicNotes']['analyzeTodo']>()
const onNotify = vi.fn()

beforeEach(() => {
  list.mockResolvedValue({ notes: [detail] })
  get.mockResolvedValue(detail)
  listTodos.mockResolvedValue({ todos: [noteTodo, manualTodo] })
  createTodo.mockResolvedValue({
    ...manualTodo,
    id: '00000000-0000-4000-8000-000000000606',
    title: '新增手动待办',
    instructions: '新增说明'
  })
  updateTodo.mockImplementation(async (input) => ({
    ...(input.todoId === noteTodo.id ? noteTodo : manualTodo),
    ...input,
    revision:
      (input.todoId === noteTodo.id ? noteTodo.revision : manualTodo.revision) +
      1
  }))
  removeTodo.mockResolvedValue()
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
        createTodo,
        updateTodo,
        removeTodo,
        analyzeTodo
      }
    } as unknown as DesktopApi
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MagicNotesWorkspace', () => {
  it('aggregates note and manual todos without AI-created todo actions', async () => {
    render(
      <MagicNotesWorkspace
        onNotify={onNotify}
        projectId={detail.projectId}
        projectName="默认项目"
      />
    )

    expect(await screen.findByText('先核对发布材料。')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '创建待办' })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    expect(
      screen.getByRole('tablist', { name: '魔法笔记内容' })
    ).toHaveClass('page-tabs--segmented')
    expect(await screen.findAllByText('核对发布材料')).toHaveLength(2)
    expect(screen.getByText('准备演示')).toBeInTheDocument()
    expect(screen.getByText('笔记：发布笔记')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '标记为已完成' })
    )
    await waitFor(() =>
      expect(updateTodo).toHaveBeenCalledWith({
        todoId: noteTodo.id,
        completed: true,
        expectedRevision: noteTodo.revision
      })
    )
  })

  it('can hide and restore the AI comments pane', async () => {
    render(
      <MagicNotesWorkspace
        onNotify={onNotify}
        projectId={detail.projectId}
        projectName="默认项目"
      />
    )

    const pane = await screen.findByLabelText('AI 评论')
    fireEvent.click(
      screen.getByRole('button', { name: '关闭 AI 评论面板' })
    )
    expect(pane).not.toBeVisible()

    fireEvent.click(
      screen.getByRole('button', { name: '显示 AI 评论' })
    )
    expect(pane).toBeVisible()
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
      <MagicNotesWorkspace
        onNotify={onNotify}
        projectId={detail.projectId}
        projectName="默认项目"
      />
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

  it('creates a manual todo with a dedicated title and details form', async () => {
    render(
      <MagicNotesWorkspace
        onNotify={onNotify}
        projectId={detail.projectId}
        projectName="默认项目"
      />
    )

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    fireEvent.click(screen.getByRole('button', { name: '新建待办' }))
    expect(createTodo).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请输入待办标题')
    expect(onNotify).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('待办标题'), {
      target: { value: '新增手动待办' }
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('说明'), {
      target: { value: '新增说明' }
    })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() =>
      expect(createTodo).toHaveBeenCalledWith({
        projectId: detail.projectId,
        title: '新增手动待办',
        instructions: '新增说明'
      })
    )
    expect(onNotify).toHaveBeenCalledWith({
      tone: 'success',
      message: '待办已创建'
    })
    expect(screen.queryByText('待办已创建')).not.toBeInTheDocument()
  })

  it('reuses the AI comments pane for selected todos', async () => {
    render(
      <MagicNotesWorkspace
        onNotify={onNotify}
        projectId={detail.projectId}
        projectName="默认项目"
      />
    )

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }))

    await waitFor(() => expect(analyzeTodo).toHaveBeenCalledWith(noteTodo.id))
    expect(
      await screen.findByText('先补充明确的验收条件。')
    ).toBeInTheDocument()
  })

  it('clears delete confirmation before selecting the next todo', async () => {
    render(
      <MagicNotesWorkspace
        onNotify={onNotify}
        projectId={detail.projectId}
        projectName="默认项目"
      />
    )

    await screen.findByText('记录正文')
    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    fireEvent.click(screen.getByText('准备演示').closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: '删除待办' }))
    expect(
      screen.getByText('删除“准备演示”？此操作不可撤销。')
    ).toBeInTheDocument()
    listTodos.mockResolvedValue({ todos: [noteTodo] })
    fireEvent.click(
      screen.getAllByRole('button', { name: '删除待办' })[1]!
    )

    await waitFor(() =>
      expect(removeTodo).toHaveBeenCalledWith(manualTodo.id)
    )
    expect(
      screen.queryByText('删除“核对发布材料”？此操作不可撤销。')
    ).not.toBeInTheDocument()
  })
})
