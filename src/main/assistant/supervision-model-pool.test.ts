import { describe, expect, it, vi } from 'vitest'
import { SupervisionModelPool } from './supervision-model-pool'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('SupervisionModelPool', () => {
  it('removes a paused review from the queue without cancelling the active report', async () => {
    const pool = new SupervisionModelPool()
    const slot = await pool.acquire()
    const controller = new AbortController()
    const operation = vi.fn()
    const pending = pool.run(operation, controller.signal)
    controller.abort(new Error('Paused'))
    await expect(pending).rejects.toThrow('Paused')
    expect(operation).not.toHaveBeenCalled()
    expect(slot.signal.aborted).toBe(false)
    slot.release()
    await expect(pool.run(async () => 'next')).resolves.toBe('next')
  })
  it('keeps a slot until runtime cleanup settles, even when cleanup fails', async () => {
    const pool = new SupervisionModelPool()
    const cleaning = deferred()
    const finish = deferred()
    const first = pool.run(async () => {
      try {
        return 'model finished'
      } finally {
        cleaning.resolve()
        await finish.promise.then(() => { throw new Error('cleanup failed') })
      }
    })
    const rejected = expect(first).rejects.toThrow('cleanup failed')
    await cleaning.promise
    const next = vi.fn(async () => 'next')
    const second = pool.run(next)
    await Promise.resolve()
    expect(next).not.toHaveBeenCalled()
    finish.resolve()
    await rejected
    await expect(second).resolves.toBe('next')
  })

  it('shares FIFO slots, raises the cap and lowers it without aborting active work', async () => {
    const pool = new SupervisionModelPool()
    const holds = Array.from({ length: 4 }, deferred)
    const started: number[] = []
    const signals: AbortSignal[] = []
    const jobs = holds.map((hold, index) => pool.run(async signal => {
      started.push(index)
      signals.push(signal)
      await hold.promise
    }))
    await vi.waitFor(() => expect(started).toEqual([0]))
    pool.setLimit(3)
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]))
    pool.setLimit(1)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
    holds[0]!.resolve()
    holds[1]!.resolve()
    await Promise.all(jobs.slice(0, 2))
    expect(started).toEqual([0, 1, 2])
    holds[2]!.resolve()
    await jobs[2]
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]))
    holds[3]!.resolve()
    await Promise.all(jobs)
  })

  it('releases failures including cleanup failures and cancels queued work without leaking slots', async () => {
    const pool = new SupervisionModelPool()
    await expect(pool.run(async () => { throw new Error('cleanup failed') })).rejects.toThrow('cleanup failed')
    const started = deferred()
    const active = pool.run(async signal => {
      started.resolve()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      signal.throwIfAborted()
    })
    await started.promise
    const callback = vi.fn()
    const queued = pool.run(callback)
    const rejected = Promise.all([expect(active).rejects.toThrow('cancel'), expect(queued).rejects.toThrow('cancel')])
    pool.cancelAll(new Error('cancel'))
    await rejected
    expect(callback).not.toHaveBeenCalled()
    await expect(pool.run(async () => 'reused')).resolves.toBe('reused')
    const admitted = pool.run(callback)
    pool.dispose()
    await expect(admitted).rejects.toThrow('shutting down')
    await expect(pool.run(callback)).rejects.toThrow('shutting down')
    expect(callback).not.toHaveBeenCalled()
  })
})
