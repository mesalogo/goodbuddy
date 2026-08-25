import { describe, expect, it, vi } from 'vitest'
import { RemoteEnvironmentUpdateService } from './remote-environment-update-service'

const HOST_ID = '00000000-0000-4000-8000-000000000101'
const OTHER_HOST_ID = '00000000-0000-4000-8000-000000000102'

function createOwner() {
  let destroyed = false
  const listeners = new Set<() => void>()
  return {
    id: 1,
    isDestroyed: vi.fn(() => destroyed),
    on: vi.fn((_event: 'destroyed', listener: () => void) => {
      listeners.add(listener)
    }),
    removeListener: vi.fn(
      (_event: 'destroyed', listener: () => void) => {
        listeners.delete(listener)
      }
    ),
    destroy() {
      destroyed = true
      for (const listener of [...listeners]) {
        listener()
      }
    }
  }
}

function abortablePending(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true
    })
  })
}

describe('RemoteEnvironmentUpdateService', () => {
  it('force-updates Agent then locked Runtime with one signal before finalizing', async () => {
    const sequence: string[] = []
    const signals: AbortSignal[] = []
    const agent = {
      ensureInstalled: vi.fn(
        async (
          _hostId: string,
          options: { force?: boolean; signal?: AbortSignal }
        ) => {
          sequence.push('agent')
          expect(options.force).toBe(true)
          signals.push(options.signal!)
          return {}
        }
      )
    }
    const runtime = {
      ensureInstalled: vi.fn(
        async (
          _hostId: string,
          options: { force?: boolean; signal?: AbortSignal }
        ) => {
          sequence.push('runtime')
          expect(options.force).toBe(true)
          signals.push(options.signal!)
          return {}
        }
      )
    }
    const afterUpdate = vi.fn(async () => {
      sequence.push('finalizing')
    })
    const service = new RemoteEnvironmentUpdateService(
      agent as never,
      runtime as never,
      afterUpdate
    )
    const progress: string[] = []

    await expect(
      service.update(createOwner(), HOST_ID, (event) => {
        progress.push(event.phase)
      })
    ).resolves.toBeUndefined()

    expect(agent.ensureInstalled).toHaveBeenCalledWith(HOST_ID, {
      force: true,
      signal: expect.any(AbortSignal)
    })
    expect(runtime.ensureInstalled).toHaveBeenCalledWith(HOST_ID, {
      force: true,
      signal: expect.any(AbortSignal)
    })
    expect(signals[0]).toBe(signals[1])
    expect(sequence).toEqual(['agent', 'runtime', 'finalizing'])
    expect(progress).toEqual(['agent', 'runtime', 'finalizing'])
    expect(afterUpdate).toHaveBeenCalledWith(HOST_ID)
  })

  it('does not run the Runtime or finalizer after an Agent error', async () => {
    const failure = new Error('agent failed')
    const agent = {
      ensureInstalled: vi.fn(async () => {
        throw failure
      })
    }
    const runtime = { ensureInstalled: vi.fn() }
    const afterUpdate = vi.fn()
    const service = new RemoteEnvironmentUpdateService(
      agent as never,
      runtime as never,
      afterUpdate
    )

    await expect(
      service.update(createOwner(), HOST_ID)
    ).rejects.toBe(failure)
    expect(runtime.ensureInstalled).not.toHaveBeenCalled()
    expect(afterUpdate).not.toHaveBeenCalled()
  })

  it('joins duplicate updates and rejects a different Host for the same owner', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const agent = {
      ensureInstalled: vi.fn(async () => {
        await gate
        return {}
      })
    }
    const runtime = {
      ensureInstalled: vi.fn(async () => ({}))
    }
    const owner = createOwner()
    const service = new RemoteEnvironmentUpdateService(
      agent as never,
      runtime as never
    )

    const first = service.update(owner, HOST_ID)
    expect(service.update(owner, HOST_ID)).toBe(first)
    await expect(
      service.update(owner, OTHER_HOST_ID)
    ).rejects.toThrow('another Host')
    release()
    await first
  })

  it('aborts on explicit cancellation and owner destruction', async () => {
    for (const cancel of ['explicit', 'destroyed'] as const) {
      let signal: AbortSignal | undefined
      const agent = {
        ensureInstalled: vi.fn(
          async (
            _hostId: string,
            options: { signal?: AbortSignal }
          ) => {
            signal = options.signal
            return abortablePending(options.signal!)
          }
        )
      }
      const runtime = { ensureInstalled: vi.fn() }
      const owner = createOwner()
      const service = new RemoteEnvironmentUpdateService(
        agent as never,
        runtime as never
      )
      const update = service.update(owner, HOST_ID)
      await vi.waitFor(() =>
        expect(signal).toBeInstanceOf(AbortSignal)
      )

      if (cancel === 'explicit') {
        service.cancel(owner, HOST_ID)
      } else {
        owner.destroy()
      }

      await expect(update).rejects.toMatchObject({
        name: 'AbortError'
      })
      expect(signal?.aborted).toBe(true)
      expect(runtime.ensureInstalled).not.toHaveBeenCalled()
    }
  })

  it('aborts active work and settles cleanly on disposal', async () => {
    let signal: AbortSignal | undefined
    const agent = {
      ensureInstalled: vi.fn(
        async (
          _hostId: string,
          options: { signal?: AbortSignal }
        ) => {
          signal = options.signal
          return abortablePending(options.signal!)
        }
      )
    }
    const service = new RemoteEnvironmentUpdateService(
      agent as never,
      { ensureInstalled: vi.fn() } as never
    )
    const update = service.update(createOwner(), HOST_ID)
    await vi.waitFor(() =>
      expect(signal).toBeInstanceOf(AbortSignal)
    )

    await expect(service.dispose()).resolves.toBeUndefined()
    await expect(update).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal?.aborted).toBe(true)
    expect(() =>
      service.update(createOwner(), HOST_ID)
    ).toThrow('disposed')
  })

  it('bounds disposal when an installation ignores cancellation', async () => {
    vi.useFakeTimers()
    try {
      let started = false
      const service = new RemoteEnvironmentUpdateService(
        {
          ensureInstalled: vi.fn(async () => {
            started = true
            await new Promise(() => undefined)
          })
        } as never,
        { ensureInstalled: vi.fn() } as never
      )
      void service.update(createOwner(), HOST_ID)
      await vi.waitFor(() => expect(started).toBe(true))

      const disposal = service.dispose()
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(disposal).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('isolates progress observer errors from the update outcome', async () => {
    const afterUpdate = vi.fn()
    const service = new RemoteEnvironmentUpdateService(
      { ensureInstalled: vi.fn(async () => ({})) } as never,
      { ensureInstalled: vi.fn(async () => ({})) } as never,
      afterUpdate
    )

    await expect(
      service.update(createOwner(), HOST_ID, () => {
        throw new Error('observer failed')
      })
    ).resolves.toBeUndefined()
    expect(afterUpdate).toHaveBeenCalledOnce()
  })
})
