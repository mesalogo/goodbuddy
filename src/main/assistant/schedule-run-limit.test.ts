import { afterEach, expect, it, vi } from 'vitest'
import { startScheduleRunLimit } from './schedule-run-limit'

afterEach(() => vi.useRealTimers())

it('expires the maximum duration only after the entire 9999 minutes', () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  startScheduleRunLimit(9999, cancel)
  vi.advanceTimersByTime(9999 * 60_000 - 1)
  expect(cancel).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(cancel).toHaveBeenCalledOnce()
})

it('never expires an unlimited or finished run', () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  startScheduleRunLimit(0, cancel)
  startScheduleRunLimit(2, cancel)()
  vi.runAllTimers()
  expect(cancel).not.toHaveBeenCalled()
})
