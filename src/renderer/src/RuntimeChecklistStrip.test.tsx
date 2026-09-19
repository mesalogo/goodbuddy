import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Message } from './ChatTimeline'
import { RuntimeChecklistStrip } from './RuntimeChecklistStrip'
import { ConversationTaskStrip } from './ConversationTaskStrip'

afterEach(cleanup)

const message: Message = {
  id: 'request-message', role: 'assistant', content: '', createdAt: 1, state: 'streaming',
  runtimeChecklist: { source: 'opencode', items: [
    { content: 'Inspect', status: 'completed' },
    { content: 'Implement', status: 'in_progress', priority: 'high' },
    { content: 'Verify', status: 'pending' },
    { content: 'Omitted', status: 'cancelled' }
  ] }
}

describe('RuntimeChecklistStrip', () => {
  it('is read-only, preserves collapse and focus during full replacements, and retains terminal item states', () => {
    const { rerender } = render(<RuntimeChecklistStrip messages={[message]} />)
    const toggle = screen.getByRole('button', { name: /执行清单/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    toggle.focus()
    fireEvent.click(toggle)
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeVisible()
    expect(screen.getByRole('group', { name: '执行清单' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByText('高优先级')).toBeVisible()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    const updated: Message = { ...message, state: 'error', status: '已取消', runtimeChecklist: {
      source: 'continue', items: [
        { content: 'Duplicate', status: 'pending' }, { content: 'Duplicate', status: 'completed' }
      ]
    } }
    rerender(<RuntimeChecklistStrip messages={[updated]} />)
    expect(toggle).toHaveFocus()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveTextContent('已完成 1/2')
    expect(toggle).toHaveTextContent('已取消')
    expect(screen.getAllByText('Duplicate')).toHaveLength(2)
    expect(screen.getByText('待处理')).toBeVisible()
    fireEvent.click(toggle)
    rerender(<RuntimeChecklistStrip messages={[{ ...updated, status: '失败' }]} />)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
  })

  it('selects the current request before looking at data and hides explicit empty snapshots', () => {
    const next: Message = { id: 'next', role: 'assistant', content: '', createdAt: 2, state: 'streaming' }
    const { rerender } = render(<RuntimeChecklistStrip messages={[message, next]} />)
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    rerender(<RuntimeChecklistStrip messages={[message, next]} activeMessageId="missing" />)
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    rerender(<RuntimeChecklistStrip messages={[message, next]} activeMessageId={message.id} />)
    expect(screen.getByRole('region', { name: '执行清单' })).toBeVisible()
    rerender(<RuntimeChecklistStrip messages={[message, { ...next, runtimeChecklist: { source: 'opencode', items: [] } }]} />)
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    rerender(<RuntimeChecklistStrip messages={[{ ...message, state: 'complete' }, next]} activeMessageId={message.id} />)
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })

  it('coexists with independent Task expansion and keeps the existing Task action', () => {
    const select = vi.fn()
    render(<div className="conversation-context-strips">
      <ConversationTaskStrip locale="zh-CN" schedules={[]} tasks={[{
        id: 'task', title: 'Existing Task', status: 'running', createdAt: new Date().toISOString(),
        instructions: 'Work', origin: 'schedule'
      }]} onSelectTask={select} onRemoveSchedule={vi.fn()} onRunSchedule={vi.fn()} onSetScheduleEnabled={vi.fn()} />
      <RuntimeChecklistStrip messages={[message]} />
    </div>)
    const checklistToggle = screen.getByRole('button', { name: /执行清单/ })
    const taskToggle = document.querySelector<HTMLButtonElement>('.conversation-task-strip__toggle')!
    fireEvent.click(taskToggle)
    expect(checklistToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(checklistToggle)
    expect(taskToggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Existing Task' }))
    expect(select).toHaveBeenCalledWith('task')
    fireEvent.click(taskToggle)
    expect(within(screen.getByRole('region', { name: '执行清单' })).getByRole('list')).toBeVisible()
  })

  it('bounds combined height and long content while retaining wrapping and keyboard focus', () => {
    const css = readFileSync('src/renderer/src/runtime-checklist.css', 'utf8')
    expect(css).toMatch(/\.conversation-context-strips\s*\{[^}]*max-height: 45vh;[^}]*overflow: auto;/s)
    expect(css).toMatch(/\.runtime-checklist__toggle\s*\{\s*flex: 0 0 auto;/s)
    expect(css).toMatch(/\.runtime-checklist__content\s*\{[^}]*min-height: 0;/s)
    expect(css).toMatch(/\.runtime-checklist__content\s*\{[^}]*max-height: 20vh;[^}]*overflow: auto;/s)
    expect(css).toContain('overflow-wrap: anywhere')
    expect(css).toContain('flex-wrap: wrap')
    expect(css).toContain(':focus-visible')
  })
})
