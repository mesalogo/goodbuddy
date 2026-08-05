import { describe, expect, it } from 'vitest'
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
})
