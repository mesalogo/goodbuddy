import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomTaskDialog } from './CustomTaskDialog'

const stylesheet = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'),
  'utf8'
)

afterEach(cleanup)

function futureLocalDateTime(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1_000)
  const local = new Date(
    date.getTime() - date.getTimezoneOffset() * 60_000
  )
  return local.toISOString().slice(0, 16)
}

describe('CustomTaskDialog', () => {
  it('keeps dialog spacing and form controls inside their layout bounds', () => {
    expect(stylesheet).toMatch(/--space-5:\s*20px;/u)
    expect(stylesheet).toMatch(
      /\.custom-task-dialog,\s*\.custom-task-dialog \*,\s*\.custom-task-dialog \*::before,\s*\.custom-task-dialog \*::after\s*\{[^}]*box-sizing:\s*border-box;/u
    )
    expect(stylesheet).toMatch(
      /\.custom-task-dialog__content\s*\{[^}]*padding:\s*var\(--space-5\);[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;/u
    )
    expect(stylesheet).toMatch(
      /@media \(max-height:\s*720px\)\s*\{[\s\S]*?\.custom-task-dialog__actions\s*\{[^}]*padding:\s*var\(--space-3\) var\(--space-5\);/u
    )
  })

  it('queues a timed message without capturing conversation execution settings', async () => {
    const conversationId =
      '00000000-0000-4000-8000-000000000801'
    const onCreate = vi.fn(async (input) => ({
      ...input,
      id: '00000000-0000-4000-8000-000000000802',
      taskId: '00000000-0000-4000-8000-000000000803',
      conversationId,
      enabled: true,
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z'
    }))

    render(
      <CustomTaskDialog
        currentConversationAvailable
        currentConversationId={conversationId}
        defaultDestination="current"
        onClose={vi.fn()}
        onCreate={onCreate}
        projectId="00000000-0000-4000-8000-000000000804"
        projectName="GoodBuddy Desktop"
        workspaceLabel="C:\\Workspace"
      />
    )

    expect(
      screen.getByRole('dialog', { name: '新建定制任务' })
    ).toHaveAttribute('aria-modal', 'true')
    expect(screen.queryByRole('button', { name: 'Execute' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('关联会话')).toHaveValue('current')
    expect(screen.getByLabelText('任务内容')).toHaveFocus()

    fireEvent.change(screen.getByLabelText('任务名称'), {
      target: { value: '每周项目总结' }
    })
    fireEvent.change(screen.getByLabelText('任务内容'), {
      target: { value: '总结完成和失败的工作' }
    })
    fireEvent.click(screen.getByRole('button', { name: '定时执行' }))
    fireEvent.change(screen.getByLabelText('首次运行'), {
      target: { value: futureLocalDateTime() }
    })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce())
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        title: '每周项目总结',
        prompt: '总结完成和失败的工作',
        recurrence: 'once'
      }),
      { runImmediately: false }
    )
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('workMode')
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('runtimeSelection')
  })

  it('creates an independent conversation using normal defaults', () => {
    render(
      <CustomTaskDialog
        currentConversationAvailable={false}
        defaultDestination="new"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        projectName="GoodBuddy Desktop"
        workspaceLabel="C:\\Workspace"
      />
    )

    expect(screen.queryByRole('button', { name: 'Ask' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: '当前会话' })).toBeDisabled()
    expect(screen.getByLabelText('关联会话')).toHaveValue('new')
  })

  const conversationId = '00000000-0000-4000-8000-000000000801'
  const projectId = '00000000-0000-4000-8000-000000000804'
  const otherId = '00000000-0000-4000-8000-000000000805'
  const props = {
    currentConversationAvailable: true,
    currentConversationId: conversationId,
    projectId,
    projectName: 'GoodBuddy Desktop',
    workspaceLabel: 'C:\\Workspace',
    onClose: vi.fn(),
    onCreate: vi.fn()
  }

  it('requires content and generates a bounded name for immediate execution by default', async () => {
    const onCreate = vi.fn()
    render(<CustomTaskDialog {...props} onCreate={onCreate} />)
    expect(screen.getByRole('button', { name: '立即执行' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByLabelText('首次运行')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('运行频率')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '  \n ' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByLabelText('任务内容')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('请输入任务内容。')

    const content = `  检查项目\n ${'内容'.repeat(80)}  `
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: content } })
    const before = Date.now()
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce())
    const [input, options] = onCreate.mock.calls[0]!
    expect(input).toMatchObject({
      projectId,
      conversationId,
      title: content.trim().replace(/\s+/gu, ' ').slice(0, 120),
      prompt: content.trim(),
      recurrence: 'once'
    })
    expect(Date.parse(input.nextRunAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(input.nextRunAt)).toBeLessThanOrEqual(Date.now())
    expect(options).toEqual({ runImmediately: true })
  })

  it.each(['daily', 'weekly'])('preserves %s scheduling and delegates future-time validation to App', async (recurrence) => {
    const onCreate = vi.fn()
    render(<CustomTaskDialog {...props} onCreate={onCreate} />)
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '检查项目' } })
    fireEvent.click(screen.getByRole('button', { name: '定时执行' }))
    fireEvent.change(screen.getByLabelText('运行频率'), { target: { value: recurrence } })
    fireEvent.change(screen.getByLabelText('首次运行'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByLabelText('首次运行')).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(screen.getByLabelText('首次运行'), { target: { value: '2020-01-01T12:00' } })
    fireEvent.click(screen.getByRole('button', { name: '立即执行' }))
    fireEvent.click(screen.getByRole('button', { name: '定时执行' }))
    expect(screen.getByLabelText('运行频率')).toHaveValue(recurrence)
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ recurrence, nextRunAt: new Date('2020-01-01T12:00').toISOString() }),
      { runImmediately: false }
    ))
  })

  it('only offers other conversations in this project and submits the chosen conversation', async () => {
    const onCreate = vi.fn()
    render(<CustomTaskDialog {...props} onCreate={onCreate} conversations={[
      { id: conversationId, projectId, title: '当前项目会话' },
      { id: otherId, projectId, title: '另一个会话' },
      { id: 'elsewhere', projectId: 'another-project', title: '其他项目会话' }
    ]} />)
    expect(screen.queryByRole('option', { name: '其他项目会话' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '当前项目会话' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('关联会话'), { target: { value: otherId } })
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '检查项目' } })
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: ' 自定义名称 ' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: otherId, title: '自定义名称' }),
      { runImmediately: true }
    ))
  })

  it('rejects a removed conversation without silently creating a new one', () => {
    const onCreate = vi.fn()
    const { rerender } = render(<CustomTaskDialog {...props} onCreate={onCreate}
      conversations={[{ id: otherId, projectId, title: '另一个会话' }]} />)
    fireEvent.change(screen.getByLabelText('关联会话'), { target: { value: otherId } })
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '检查项目' } })
    rerender(<CustomTaskDialog {...props} onCreate={onCreate} conversations={[]} />)
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByLabelText('关联会话')).toHaveAttribute('aria-invalid', 'true')
  })

  it('creates a new conversation without capturing execution settings or hidden recurrence', async () => {
    const onCreate = vi.fn()
    render(<CustomTaskDialog {...props} currentConversationId={undefined} onCreate={onCreate} />)
    expect(screen.getByLabelText('关联会话')).toHaveValue('new')
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '检查项目' } })
    fireEvent.click(screen.getByRole('button', { name: '定时执行' }))
    fireEvent.change(screen.getByLabelText('运行频率'), { target: { value: 'weekly' } })
    fireEvent.click(screen.getByRole('button', { name: '立即执行' }))
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce())
    expect(onCreate.mock.calls[0]![0]).toEqual({
      projectId, title: '检查项目', prompt: '检查项目', recurrence: 'once', nextRunAt: expect.any(String)
    })
  })

  it('locks submission and dismissal while pending, then preserves the draft on failure', async () => {
    let rejectCreate!: (reason: Error) => void
    const onCreate = vi.fn(() => new Promise<never>((_, reject) => { rejectCreate = reject }))
    const onClose = vi.fn()
    render(<CustomTaskDialog {...props} onCreate={onCreate} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '保留草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    expect(screen.getByLabelText('任务内容')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '创建中…' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(onClose).not.toHaveBeenCalled()
    expect(onCreate).toHaveBeenCalledOnce()
    rejectCreate(new Error('请选择未来时间'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('请选择未来时间'))
    expect(screen.getByLabelText('任务内容')).toHaveValue('保留草稿')
    expect(screen.getByLabelText('任务内容')).toBeEnabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('portals to the body, traps focus and restores the opener on close', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { unmount, container } = render(<CustomTaskDialog {...props} />)
    const dialog = screen.getByRole('dialog')
    expect(container).not.toContainElement(dialog)
    const create = screen.getByRole('button', { name: '创建任务' })
    create.focus()
    fireEvent.keyDown(create, { key: 'Tab' })
    expect(screen.getByRole('button', { name: '关闭新建定制任务' })).toHaveFocus()
    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})
