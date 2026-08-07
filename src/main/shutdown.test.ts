import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForCleanup } from './shutdown'

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
})
