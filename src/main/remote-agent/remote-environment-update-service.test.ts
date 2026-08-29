import { describe, expect, it, vi } from 'vitest'
import type { RemoteEnvironmentUpdateProgress } from '../../shared/ssh-host-contracts'
import {
  RemoteEnvironmentUpdateService,
  type RemoteEnvironmentPreparer
} from './remote-environment-update-service'

const HOST_ID = '00000000-0000-4000-8000-000000000101'

function createOwner(id = 1) {
  let destroyed = false
  const listeners = new Set<() => void>()
  return {
    id,
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
      for (const listener of [...listeners]) listener()
    }
  }
}

function abortablePending(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true
    })
  })
}

describe('RemoteEnvironmentUpdateService', () => {
  it('deduplicates the same Host and method across owners and fans out progress', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let emit:
      | ((progress: RemoteEnvironmentUpdateProgress) => void)
      | undefined
    const preparer: RemoteEnvironmentPreparer = {
      prepare: vi.fn(async (_hostId, method, observer) => {
        expect(method).toBe('remote-download')
        emit = observer
        await gate
      })
    }
    const service = new RemoteEnvironmentUpdateService(preparer)
    const firstProgress: string[] = []
    const secondProgress: string[] = []

    const first = service.update(
      createOwner(1),
      { hostId: HOST_ID, method: 'remote-download' },
      (progress) => firstProgress.push(progress.phase)
    )
    const second = service.update(
      createOwner(2),
      { hostId: HOST_ID, method: 'remote-download' },
      (progress) => secondProgress.push(progress.phase)
    )
    await vi.waitFor(() => expect(emit).toBeTypeOf('function'))
    emit?.({
      hostId: HOST_ID,
      method: 'remote-download',
      phase: 'downloading'
    })
    release()

    await Promise.all([first, second])
    expect(preparer.prepare).toHaveBeenCalledOnce()
    expect(firstProgress).toEqual([
      'downloading',
      'finalizing',
      'complete'
    ])
    expect(secondProgress).toEqual(firstProgress)
  })

  it('rejects a different method while the same Host has active work', async () => {
    let signal: AbortSignal | undefined
    const preparer: RemoteEnvironmentPreparer = {
      prepare: vi.fn(async (
        _hostId,
        _method,
        _observer,
        operationSignal
      ) => {
        signal = operationSignal
        return abortablePending(operationSignal)
      })
    }
    const service = new RemoteEnvironmentUpdateService(preparer)
    const owner = createOwner()
    const active = service.update(
      owner,
      { hostId: HOST_ID, method: 'auto' }
    )

    await expect(service.update(
      createOwner(2),
      { hostId: HOST_ID, method: 'goodbuddy-transfer' }
    )).rejects.toThrow('conflicting')
    owner.destroy()
    await expect(active).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal?.aborted).toBe(true)
  })

  it('cancels only one waiter and aborts underlying work when the last owner is destroyed', async () => {
    let signal: AbortSignal | undefined
    const preparer: RemoteEnvironmentPreparer = {
      prepare: vi.fn(async (
        _hostId,
        _method,
        _observer,
        operationSignal
      ) => {
        signal = operationSignal
        return abortablePending(operationSignal)
      })
    }
    const service = new RemoteEnvironmentUpdateService(preparer)
    const firstOwner = createOwner(1)
    const secondOwner = createOwner(2)
    const first = service.update(
      firstOwner,
      { hostId: HOST_ID, method: 'remote-download' }
    )
    const second = service.update(
      secondOwner,
      { hostId: HOST_ID, method: 'remote-download' }
    )
    await vi.waitFor(() =>
      expect(signal).toBeInstanceOf(AbortSignal)
    )

    service.cancel(firstOwner, HOST_ID)
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal?.aborted).toBe(false)

    secondOwner.destroy()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal?.aborted).toBe(true)
    expect(firstOwner.removeListener).toHaveBeenCalledOnce()
    expect(secondOwner.removeListener).toHaveBeenCalledOnce()
  })

  it('aborts active work and bounds disposal when the preparer ignores cancellation', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const preparer: RemoteEnvironmentPreparer = {
        prepare: vi.fn(async (
          _hostId,
          _method,
          _observer,
          operationSignal
        ) => {
          signal = operationSignal
          await new Promise(() => undefined)
        })
      }
      const service = new RemoteEnvironmentUpdateService(preparer)
      void service.update(
        createOwner(),
        { hostId: HOST_ID, method: 'remote-download' }
      ).catch(() => undefined)
      await Promise.resolve()
      await Promise.resolve()
      expect(signal).toBeInstanceOf(AbortSignal)

      const disposal = service.dispose()
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(disposal).resolves.toBeUndefined()
      expect(signal?.aborted).toBe(true)
      expect(() => service.update(
        createOwner(2),
        { hostId: HOST_ID, method: 'remote-download' }
      )).toThrow('disposed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('isolates observers and preserves an auto-resolved method through finalizing and complete', async () => {
    const afterUpdate = vi.fn(async () => undefined)
    const preparer: RemoteEnvironmentPreparer = {
      prepare: vi.fn(async (hostId, method, observer, signal) => {
        expect(hostId).toBe(HOST_ID)
        expect(method).toBe('auto')
        expect(signal.aborted).toBe(false)
        observer?.({
          hostId,
          method: 'remote-download',
          phase: 'downloading'
        })
      })
    }
    const service = new RemoteEnvironmentUpdateService(
      preparer,
      afterUpdate
    )
    const observed: RemoteEnvironmentUpdateProgress[] = []
    const throwingObserver = vi.fn(() => {
      throw new Error('observer failed')
    })
    const first = service.update(
      createOwner(1),
      { hostId: HOST_ID, method: 'auto' },
      throwingObserver
    )
    const second = service.update(
      createOwner(2),
      { hostId: HOST_ID, method: 'auto' },
      (event) => observed.push(event)
    )

    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined
    ])
    expect(afterUpdate).toHaveBeenCalledWith(HOST_ID)
    expect(throwingObserver).toHaveBeenCalledTimes(3)
    expect(observed).toEqual([
      {
        hostId: HOST_ID,
        method: 'remote-download',
        phase: 'downloading'
      },
      {
        hostId: HOST_ID,
        method: 'remote-download',
        phase: 'finalizing'
      },
      {
        hostId: HOST_ID,
        method: 'remote-download',
        phase: 'complete'
      }
    ])
  })

  it('does not let preparer-emitted terminal phases bypass finalization', async () => {
    const order: string[] = []
    const preparer: RemoteEnvironmentPreparer = {
      prepare: vi.fn(async (hostId, method, observer) => {
        observer?.({ hostId, method, phase: 'finalizing' })
        observer?.({ hostId, method, phase: 'complete' })
        order.push('prepared')
      })
    }
    const service = new RemoteEnvironmentUpdateService(
      preparer,
      async () => {
        order.push('after')
      }
    )

    await service.update(
      createOwner(),
      { hostId: HOST_ID, method: 'goodbuddy-transfer' },
      (event) => order.push(event.phase)
    )

    expect(order).toEqual([
      'prepared',
      'finalizing',
      'after',
      'complete'
    ])
  })
})
