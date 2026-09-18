import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionStats, ExecutionStatsInput } from '../../shared/assistant-contracts'
import { useExecutionStats } from './use-execution-stats'

function stats(durationMs: number): ExecutionStats {
  return {
    durationMs, requestCount: 1, incompleteRequestCount: 0,
    activeRequestCount: 0, asOf: 1_000, taskDurations: []
  }
}

function deferred() {
  let resolve!: (value: ExecutionStats) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<ExecutionStats>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const empty = { conversation: undefined, project: undefined }
const initialProps = {
  conversationId: 'chat-a' as string | undefined,
  projectId: 'project-a' as string | undefined,
  revision: '1', enabled: true
}

function renderStats() {
  return renderHook(({ conversationId, projectId, revision, enabled }) =>
    useExecutionStats(conversationId, projectId, revision, enabled), { initialProps })
}

const getExecutionStats = vi.fn<(input: ExecutionStatsInput) => Promise<ExecutionStats>>()

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  getExecutionStats.mockReset().mockResolvedValue(stats(10))
  vi.stubGlobal('goodbuddy', { tasks: { getExecutionStats } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useExecutionStats', () => {
  it.each(['project', 'conversation'] as const)(
    'clears the previous %s selection and ignores its late polling result', async (scope) => {
      const { result, rerender } = renderStats()
      await act(async () => {})
      expect(result.current).toEqual({ conversation: stats(10), project: stats(10) })

      const oldConversation = deferred()
      const oldProject = deferred()
      getExecutionStats.mockReturnValueOnce(oldConversation.promise).mockReturnValueOnce(oldProject.promise)
      await act(async () => { vi.advanceTimersByTime(5_000) })

      const newConversation = deferred()
      const newProject = deferred()
      getExecutionStats.mockReturnValueOnce(newConversation.promise).mockReturnValueOnce(newProject.promise)
      rerender({
        ...initialProps, conversationId: 'chat-b',
        projectId: scope === 'project' ? 'project-b' : 'project-a'
      })
      expect(result.current).toEqual({
        conversation: undefined, project: scope === 'project' ? undefined : stats(10)
      })
      expect(getExecutionStats.mock.calls.slice(-2)).toEqual([
        [{ conversationId: 'chat-b' }],
        [{ projectId: scope === 'project' ? 'project-b' : 'project-a' }]
      ])

      await act(async () => {
        newConversation.resolve(stats(20))
        newProject.resolve(stats(30))
      })
      await act(async () => {
        oldConversation.resolve(stats(90))
        oldProject.resolve(stats(99))
      })
      expect(result.current).toEqual({ conversation: stats(20), project: stats(30) })
    }
  )

  it('does not resurrect cancelled results when switching back to the same IDs', async () => {
    const oldConversation = deferred()
    const oldProject = deferred()
    getExecutionStats.mockReturnValueOnce(oldConversation.promise).mockReturnValueOnce(oldProject.promise)
    const { result, rerender } = renderStats()
    rerender({ ...initialProps, conversationId: 'chat-b', projectId: 'project-b' })
    await act(async () => {})
    const currentConversation = deferred()
    const currentProject = deferred()
    getExecutionStats.mockReturnValueOnce(currentConversation.promise).mockReturnValueOnce(currentProject.promise)
    rerender(initialProps)
    await act(async () => {
      oldConversation.resolve(stats(90))
      oldProject.resolve(stats(99))
    })
    expect(result.current).toEqual(empty)
    await act(async () => {
      currentConversation.resolve(stats(20))
      currentProject.resolve(stats(30))
    })
    expect(result.current).toEqual({ conversation: stats(20), project: stats(30) })
  })

  it('does not overlap polling, focus or visibility refreshes while either query is pending', async () => {
    const conversation = deferred()
    const project = deferred()
    getExecutionStats.mockReturnValueOnce(conversation.promise).mockReturnValueOnce(project.promise)
    const { result } = renderStats()
    await act(async () => {
      vi.advanceTimersByTime(15_000)
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      conversation.resolve(stats(20))
    })
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      window.dispatchEvent(new Event('focus'))
    })
    expect(getExecutionStats).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual(empty)
    await act(async () => { project.resolve(stats(30)) })
    expect(result.current).toEqual({ conversation: stats(20), project: stats(30) })
    await act(async () => { vi.advanceTimersByTime(4_999) })
    expect(getExecutionStats).toHaveBeenCalledTimes(2)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(getExecutionStats).toHaveBeenCalledTimes(4)
  })

  it('replaces the poller on revision changes and removes timers and listeners on unmount', async () => {
    const conversation = deferred()
    const project = deferred()
    getExecutionStats.mockReturnValueOnce(conversation.promise).mockReturnValueOnce(project.promise)
    const { result, rerender, unmount } = renderStats()
    await act(async () => { vi.advanceTimersByTime(2_000) })
    rerender({ ...initialProps, revision: '2' })
    await act(async () => {})
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => {
      conversation.resolve(stats(90))
      project.resolve(stats(99))
      vi.advanceTimersByTime(3_000)
    })
    expect(result.current).toEqual({ conversation: stats(10), project: stats(10) })
    expect(getExecutionStats).toHaveBeenCalledTimes(4)
    await act(async () => { vi.advanceTimersByTime(2_000) })
    expect(getExecutionStats).toHaveBeenCalledTimes(6)

    const lastConversation = deferred()
    const lastProject = deferred()
    getExecutionStats.mockReturnValueOnce(lastConversation.promise).mockReturnValueOnce(lastProject.promise)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      lastConversation.resolve(stats(50))
      lastProject.resolve(stats(60))
    })
    await act(async () => {
      vi.advanceTimersByTime(15_000)
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(getExecutionStats).toHaveBeenCalledTimes(8)
  })

  it.each(['conversation', 'project', 'both'] as const)(
    'clears stale statistics when %s queries fail and recovers on the next poll', async (failure) => {
      const { result } = renderStats()
      await act(async () => {})
      expect(result.current).toEqual({ conversation: stats(10), project: stats(10) })
      getExecutionStats.mockImplementation(async (input) => {
        if (failure === 'both' ||
          (failure === 'conversation' && 'conversationId' in input) ||
          (failure === 'project' && 'projectId' in input)) {
          throw new Error('stats unavailable')
        }
        return stats(20)
      })
      await act(async () => { vi.advanceTimersByTime(5_000) })
      expect(result.current).toEqual({
        conversation: failure === 'project' ? stats(20) : undefined,
        project: failure === 'conversation' ? stats(20) : undefined
      })
      getExecutionStats.mockResolvedValue(stats(30))
      await act(async () => { vi.advanceTimersByTime(5_000) })
      expect(result.current).toEqual({ conversation: stats(30), project: stats(30) })
    }
  )

  it('does not query while hidden and resumes when visible', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const { result } = renderStats()
    await act(async () => {
      vi.advanceTimersByTime(15_000)
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(getExecutionStats).not.toHaveBeenCalled()
    expect(result.current).toEqual(empty)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(getExecutionStats).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual({ conversation: stats(10), project: stats(10) })
    visibility.mockReturnValue('hidden')
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      window.dispatchEvent(new Event('focus'))
    })
    expect(getExecutionStats).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('visible')
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(getExecutionStats).toHaveBeenCalledTimes(4)
  })

  it.each(['disabled', 'no-project'] as const)('stops querying and hides results when %s', async (mode) => {
    const { result, rerender } = renderStats()
    await act(async () => {})
    const conversation = deferred()
    const project = deferred()
    getExecutionStats.mockReturnValueOnce(conversation.promise).mockReturnValueOnce(project.promise)
    await act(async () => { vi.advanceTimersByTime(5_000) })
    rerender({
      ...initialProps, enabled: mode !== 'disabled',
      projectId: mode === 'no-project' ? undefined : initialProps.projectId
    })
    expect(result.current).toEqual(empty)
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      conversation.resolve(stats(90))
      project.reject(new Error('late failure'))
    })
    await act(async () => {
      vi.advanceTimersByTime(15_000)
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(getExecutionStats).toHaveBeenCalledTimes(4)
    expect(result.current).toEqual(empty)
    rerender(initialProps)
    await act(async () => {})
    expect(getExecutionStats).toHaveBeenCalledTimes(6)
    expect(result.current).toEqual({ conversation: stats(10), project: stats(10) })
  })

  it('queries only the project when no conversation is selected', async () => {
    const { result, rerender } = renderStats()
    await act(async () => {})
    getExecutionStats.mockClear()
    rerender({ ...initialProps, conversationId: undefined })
    expect(result.current.conversation).toBeUndefined()
    await act(async () => {})
    expect(getExecutionStats.mock.calls).toEqual([[{ projectId: 'project-a' }]])
    expect(result.current).toEqual({ conversation: undefined, project: stats(10) })
  })
})
