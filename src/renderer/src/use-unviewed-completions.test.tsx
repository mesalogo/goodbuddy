import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUnviewedCompletions } from './use-unviewed-completions'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useUnviewedCompletions', () => {
  const task = { id: 'task', conversationId: 'chat', status: 'running' }

  it('baselines history, ignores child work, and does not restore acknowledged completions on refresh', () => {
    const history = { ...task, status: 'completed' }
    const initialProps: {
      tasks: (typeof task & { parentTaskId?: string })[]; viewed?: string
    } = { tasks: [history] }
    const { result, rerender } = renderHook(({ tasks, viewed }) =>
      useUnviewedCompletions(tasks, viewed), { initialProps })
    expect(result.current.completedConversationIds.size).toBe(0)
    rerender({ tasks: [task, { ...task, id: 'child', parentTaskId: 'task' }] })
    rerender({ tasks: [task, { ...history, id: 'child', parentTaskId: 'task' }] })
    expect(result.current.completedConversationIds.size).toBe(0)
    rerender({ tasks: [history] })
    expect(result.current.completedConversationIds.has('chat')).toBe(true)
    rerender({ tasks: [history], viewed: 'chat' })
    expect(result.current.completedConversationIds.size).toBe(0)
    rerender({ tasks: [{ ...history }] })
    expect(result.current.completedConversationIds.size).toBe(0)
    rerender({ tasks: [task] })
    rerender({ tasks: [history] })
    expect(result.current.completedConversationIds.has('chat')).toBe(true)
  })

  it('retains completion in a hidden window until the selected chat becomes visible', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const tasks: typeof task[] = []
    const { result } = renderHook(() => useUnviewedCompletions(tasks, 'chat'))
    act(() => result.current.markConversationCompleted('chat'))
    expect(result.current.completedConversationIds.has('chat')).toBe(true)
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(result.current.completedConversationIds.size).toBe(0)
  })

  it('clears an old completion before a new local run and ignores failed task transitions', () => {
    const { result, rerender } = renderHook(({ tasks }) => useUnviewedCompletions(tasks), {
      initialProps: { tasks: [task] }
    })
    act(() => result.current.markConversationCompleted('chat'))
    act(() => result.current.clearConversationCompleted('chat'))
    rerender({ tasks: [{ ...task, status: 'failed' }] })
    expect(result.current.completedConversationIds.size).toBe(0)
  })
})
