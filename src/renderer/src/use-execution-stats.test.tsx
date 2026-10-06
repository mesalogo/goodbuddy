import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionStats } from '../../shared/assistant-contracts'
import { useExecutionStats } from './use-execution-stats'

const snapshot = (runningCount = 0, durationMs = 1000): ExecutionStats => ({
  durationMs, runningCount, incomplete: false, asOf: Date.now(),
  taskDurations: [{ id: 'task', durationMs, runningCount, incomplete: false }]
})
const getExecutionStats = vi.fn()
const listeners = new Set<() => void>()
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  getExecutionStats.mockReset().mockImplementation(async () => snapshot())
  vi.stubGlobal('goodbuddy', { tasks: { getExecutionStats,
    onExecutionStatsChanged: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } })
})
afterEach(() => { cleanup(); listeners.clear(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('state-driven duration snapshots', () => {
  it('ticks locally for concurrent running segments without polling or writes', async () => {
    getExecutionStats.mockImplementation(async () => snapshot(2))
    const { result } = renderHook(() => useExecutionStats('conversation', 'project', true))
    await flush()
    expect(getExecutionStats).toHaveBeenCalledTimes(2)
    act(() => { vi.advanceTimersByTime(6000) })
    expect(result.current.conversation?.durationMs).toBe(13_000)
    expect(result.current.project?.taskDurations[0]?.durationMs).toBe(13_000)
    expect(getExecutionStats).toHaveBeenCalledTimes(2)
    getExecutionStats.mockImplementation(async () => snapshot(0, 13_000))
    act(() => { listeners.forEach((listener) => listener()) })
    await flush()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(result.current.conversation?.durationMs).toBe(13_000)
    expect(getExecutionStats).toHaveBeenCalledTimes(4)
  })

  it('unsubscribes while hidden and gets authoritative snapshots on reopening', async () => {
    const { result, rerender, unmount } = renderHook(({ enabled }) => useExecutionStats('c', 'p', enabled),
      { initialProps: { enabled: true } })
    await flush()
    rerender({ enabled: false })
    expect(listeners.size).toBe(0)
    expect(result.current.conversation).toBeUndefined()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(getExecutionStats).toHaveBeenCalledTimes(2)
    getExecutionStats.mockImplementation(async () => snapshot(1, 60_000))
    rerender({ enabled: true })
    await flush()
    expect(result.current.conversation?.durationMs).toBe(60_000)
    unmount()
    expect(listeners.size).toBe(0)
  })

  it('discards old scopes and in-flight snapshots superseded by a state change', async () => {
    const pending: Array<(value: ExecutionStats) => void> = []
    getExecutionStats.mockImplementation(() => new Promise<ExecutionStats>((resolve) => pending.push(resolve)))
    const { result, rerender } = renderHook(({ id }) => useExecutionStats(id, 'p', true), { initialProps: { id: 'old' } })
    rerender({ id: 'new' })
    act(() => { for (let i = 0; i < 100; i++) listeners.forEach((listener) => listener()) })
    expect(getExecutionStats).toHaveBeenCalledTimes(4)
    await act(async () => { for (const resolve of pending.slice(0, 4)) resolve(snapshot(1, 1000)) })
    expect(result.current.conversation).toBeUndefined()
    expect(getExecutionStats).toHaveBeenCalledTimes(6)
    await act(async () => { pending[4]!(snapshot(0, 9000)); pending[5]!(snapshot(0, 9000)) })
    expect(result.current.conversation?.durationMs).toBe(9000)
    expect(result.current.project?.runningCount).toBe(0)
  })

  it('does not tick idle snapshots and clears a failed scope', async () => {
    const { result } = renderHook(() => useExecutionStats('c', 'p', true))
    await flush()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(result.current.conversation?.durationMs).toBe(1000)
    expect(getExecutionStats).toHaveBeenCalledTimes(2)
    getExecutionStats.mockRejectedValue(new Error('unavailable'))
    act(() => { listeners.forEach((listener) => listener()) })
    await flush()
    expect(result.current).toEqual({ conversation: undefined, project: undefined })
  })
})
