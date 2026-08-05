import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AssistantExpert,
  AssistantTask
} from '../../shared/assistant-contracts'
import { RightAssistantSidebar } from './RightAssistantSidebar'

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1400
  })
})

function renderSidebar({
  tasks = [],
  experts = [],
  tab = 'context',
  onCreateSchedule = vi.fn(async () => undefined)
}: {
  tasks?: AssistantTask[]
  experts?: AssistantExpert[]
  tab?: 'tasks' | 'context'
  onCreateSchedule?: () => Promise<void>
} = {}): HTMLElement {
  render(
    <RightAssistantSidebar
      activities={[]}
      approvals={[]}
      artifacts={[]}
      attachments={[]}
      enabledLibraries={[]}
      experts={experts}
      heartbeatEntries={[]}
      heartbeats={[]}
      memories={[]}
      onClose={vi.fn()}
      onCreateHeartbeat={vi.fn(async () => undefined)}
      onCreateMemory={vi.fn(async () => undefined)}
      onCreateSchedule={onCreateSchedule}
      onImportArtifacts={vi.fn(async () => undefined)}
      onListWorkspaceDirectory={vi.fn(async (path: string) => ({
        path,
        entries: [],
        truncated: false
      }))}
      onLoadArtifact={vi.fn(async () => undefined)}
      onLoadWorkspaceFile={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenHeartbeat={vi.fn()}
      onRefreshChanges={vi.fn(async () => undefined)}
      onRemoveAttachment={vi.fn()}
      onRemoveHeartbeat={vi.fn(async () => undefined)}
      onRemoveMemory={vi.fn(async () => undefined)}
      onRemoveSchedule={vi.fn(async () => undefined)}
      onRespondApproval={vi.fn()}
      onRunHeartbeat={vi.fn(async () => undefined)}
      onRunSchedule={vi.fn(async () => undefined)}
      onSetHeartbeatPaused={vi.fn(async () => undefined)}
      onSetMemoryStatus={vi.fn(async () => undefined)}
      onStopBrowser={vi.fn(async () => undefined)}
      onTabChange={vi.fn()}
      open
      schedules={[]}
      tab={tab}
      tasks={tasks}
    />
  )

  return screen.getByRole('complementary', {
    name: '助手工作栏'
  })
}

describe('RightAssistantSidebar resizing', () => {
  it('resizes with pointer capture and clamps the resulting width', () => {
    const sidebar = renderSidebar()
    const separator = screen.getByRole('separator', {
      name: '调整助手工作栏宽度'
    })
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.defineProperties(separator, {
      setPointerCapture: { value: setPointerCapture },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: releasePointerCapture }
    })

    fireEvent.pointerDown(separator, {
      button: 0,
      clientX: 900,
      pointerId: 7
    })
    fireEvent.pointerMove(separator, {
      clientX: 600,
      pointerId: 7
    })

    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(sidebar).toHaveClass('assistant-sidebar--resizing')
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('640px')

    fireEvent.pointerUp(separator, { pointerId: 7 })
    expect(releasePointerCapture).toHaveBeenCalledWith(7)
    expect(sidebar).not.toHaveClass('assistant-sidebar--resizing')
  })

  it('supports arrow, Home, and End keyboard resizing', () => {
    const sidebar = renderSidebar()
    const separator = screen.getByRole('separator', {
      name: '调整助手工作栏宽度'
    })

    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('366px')
    expect(separator).toHaveAttribute('aria-valuenow', '366')

    fireEvent.keyDown(separator, { key: 'Home' })
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('300px')

    fireEvent.keyDown(separator, { key: 'End' })
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('640px')
  })

  it('remains resizable when the sidebar overlays a medium window', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024
    })
    const sidebar = renderSidebar()
    const separator = screen.getByRole('separator', {
      name: '调整助手工作栏宽度'
    })
    Object.defineProperties(separator, {
      setPointerCapture: { value: vi.fn() },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: vi.fn() }
    })

    expect(separator).toHaveAttribute('tabindex', '0')
    fireEvent.pointerDown(separator, {
      button: 0,
      clientX: 674,
      pointerId: 8
    })
    fireEvent.pointerMove(separator, {
      clientX: 600,
      pointerId: 8
    })

    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('424px')
  })

  it('indents child tasks and names their expert and routing mode', () => {
    const parentTask: AssistantTask = {
      id: 'parent-task',
      conversationId: 'conversation-1',
      title: '分析发布计划',
      instructions: '分析发布计划',
      origin: 'user',
      status: 'running',
      createdAt: '2026-08-01T00:00:00.000Z'
    }
    const childTask: AssistantTask = {
      id: 'child-task',
      conversationId: 'conversation-1',
      parentTaskId: parentTask.id,
      expertId: 'expert-1',
      routingMode: 'smart',
      title: '研究子任务',
      instructions: '收集资料',
      origin: 'subagent',
      status: 'completed',
      createdAt: '2026-08-01T00:01:00.000Z'
    }
    renderSidebar({
      tab: 'tasks',
      tasks: [childTask, parentTask],
      experts: [
        {
          id: 'expert-1',
          name: '研究专家',
          description: '分析证据',
          systemInstructions: 'Analyze evidence.',
          routingKeywords: ['研究'],
          enabled: true,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z'
        }
      ]
    })

    const taskButtons = screen.getAllByRole('button', {
      name: /分析发布计划|研究子任务/u
    })
    expect(taskButtons[0]).toHaveTextContent('分析发布计划')
    expect(taskButtons[1]).toHaveClass('assistant-sidebar__row--subtask')
    expect(taskButtons[1]).toHaveTextContent('子专家：研究专家 · 智能路由')
  })

  it('preserves schedule input and reports a failed action', async () => {
    const onCreateSchedule = vi.fn(async () => {
      throw new Error('定时服务不可用')
    })
    renderSidebar({ tab: 'tasks', onCreateSchedule })

    fireEvent.change(screen.getByLabelText('定时任务标题'), {
      target: { value: '每日摘要' }
    })
    fireEvent.change(screen.getByLabelText('定时任务内容'), {
      target: { value: '总结今天的工作' }
    })
    fireEvent.change(screen.getByLabelText('定时任务时间'), {
      target: { value: '2026-08-06T09:00' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '添加定时任务' })
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '定时服务不可用'
    )
    expect(screen.getByLabelText('定时任务标题')).toHaveValue(
      '每日摘要'
    )
    expect(screen.getByLabelText('定时任务内容')).toHaveValue(
      '总结今天的工作'
    )
  })
})
