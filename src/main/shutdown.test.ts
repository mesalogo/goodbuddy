import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runCleanupBeforeDeadline,
  settleCleanupPhases,
  waitForCleanup
} from './shutdown'

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForCleanup', () => {
  it('reports completed and failed cleanup as settled', async () => {
    await expect(
      waitForCleanup(Promise.resolve(), 100)
    ).resolves.toBe(true)
    await expect(
      waitForCleanup(Promise.reject(new Error('cleanup failed')), 100)
    ).resolves.toBe(true)
  })

  it('stops waiting after the shutdown deadline', async () => {
    vi.useFakeTimers()
    const result = waitForCleanup(new Promise(() => {}), 100)

    await vi.advanceTimersByTimeAsync(100)

    await expect(result).resolves.toBe(false)
  })

  it('runs dependent cleanup phases in order despite failures', async () => {
    const order: string[] = []

    await settleCleanupPhases([
      [
        async () => {
          order.push('ipc')
          throw new Error('cleanup failed')
        }
      ],
      [
        async () => {
          order.push('gateway')
        }
      ],
      [
        async () => {
          order.push('knowledge')
        }
      ]
    ])

    expect(order).toEqual(['ipc', 'gateway', 'knowledge'])
  })

  it('finalizes databases only after cleanup beats the deadline', async () => {
    const finalize = vi.fn()
    await expect(
      runCleanupBeforeDeadline(Promise.resolve(), 100, finalize)
    ).resolves.toBe(true)
    expect(finalize).toHaveBeenCalledOnce()

    vi.useFakeTimers()
    const timedOutFinalize = vi.fn()
    const result = runCleanupBeforeDeadline(
      new Promise(() => {}),
      100,
      timedOutFinalize
    )
    await vi.advanceTimersByTimeAsync(100)

    await expect(result).resolves.toBe(false)
    expect(timedOutFinalize).not.toHaveBeenCalled()
  })
})
