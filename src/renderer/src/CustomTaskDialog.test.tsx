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

  it('defaults to Execute and keeps the current Conversation association', async () => {
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
        runtimeLabel="OpenCode"
        supportsToolExecution
        workspaceLabel="C:\\Workspace"
      />
    )

    expect(
      screen.getByRole('dialog', { name: '新建定制任务' })
    ).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('button', { name: 'Execute' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: '当前会话' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByLabelText('任务名称')).toHaveFocus()

    fireEvent.change(screen.getByLabelText('任务名称'), {
      target: { value: '每周项目总结' }
    })
    fireEvent.change(screen.getByLabelText('任务要求'), {
      target: { value: '总结完成和失败的工作' }
    })
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
        workMode: 'execute',
        recurrence: 'once'
      })
    )
  })

  it('uses Ask when the selected Runtime cannot execute tools', () => {
    render(
      <CustomTaskDialog
        currentConversationAvailable={false}
        defaultDestination="new"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        projectName="GoodBuddy Desktop"
        runtimeLabel="Direct model"
        supportsToolExecution={false}
        workspaceLabel="C:\\Workspace"
      />
    )

    expect(screen.getByRole('button', { name: 'Execute' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Ask' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: '当前会话' })).toBeDisabled()
  })
})
