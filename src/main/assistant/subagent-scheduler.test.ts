import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { SubagentScheduler } from './subagent-scheduler'

describe('SubagentScheduler', () => {
  it('enforces concurrency and starts queued work in FIFO order', async () => {
    const scheduler = new SubagentScheduler({
      concurrency: 2,
      queueLimit: 3,
      timeoutMs: 1_000
    })
    const started: number[] = []
    let releaseInitial!: () => void
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    const jobs = [0, 1, 2, 3].map((value) =>
      scheduler.schedule(async () => {
        started.push(value)
        if (value < 2) {
          await initialGate
        }
        return value
      })
    )
    await Promise.resolve()
    expect(started).toEqual([0, 1])
    releaseInitial()
    await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2, 3])
    expect(started).toEqual([0, 1, 2, 3])
    scheduler.dispose()
  })

  it('rejects overflow, queued cancellation, and timed out work', async () => {
    const scheduler = new SubagentScheduler({
      concurrency: 1,
      queueLimit: 1,
      timeoutMs: 20
    })
    const blocker = scheduler.schedule(
      (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason))
      })
    )
    const controller = new AbortController()
    const queued = scheduler.schedule(async () => 'queued', controller.signal)
    await expect(
      scheduler.schedule(async () => 'overflow')
    ).rejects.toThrow('队列已满')
    controller.abort(new Error('cancelled'))
    await expect(queued).rejects.toThrow('cancelled')
    await expect(blocker).rejects.toThrow('120 秒')
    scheduler.dispose()
  })

  it('holds its concurrency slot until aborted work finishes cleanup', async () => {
    const scheduler = new SubagentScheduler({
      concurrency: 1,
      queueLimit: 1,
      timeoutMs: 1_000
    })
    const controller = new AbortController()
    let finishCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const started: string[] = []
    const first = scheduler.schedule(async (signal) => {
      started.push('first')
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      await cleanupGate
      return 'first'
    }, controller.signal)
    const second = scheduler.schedule(async () => {
      started.push('second')
      return 'second'
    })

    await vi.waitFor(() => expect(started).toEqual(['first']))
    controller.abort(new Error('cancelled'))
    await expect(first).rejects.toThrow('cancelled')
    await Promise.resolve()
    expect(started).toEqual(['first'])

    let idle = false
    const idlePromise = scheduler.waitForIdle().then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)

    finishCleanup()
    await expect(second).resolves.toBe('second')
    await idlePromise
    expect(started).toEqual(['first', 'second'])
    scheduler.dispose()
  })
})
