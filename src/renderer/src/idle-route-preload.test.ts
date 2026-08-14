import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  preloadRouteModules,
  scheduleIdleRoutePreload,
  type RouteModuleLoader
} from './idle-route-preload'

function idleDeadline(): IdleDeadline {
  return {
    didTimeout: false,
    timeRemaining: () => 10
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('idle route preload scheduling', () => {
  it('waits for an idle callback and supplies the timeout option', async () => {
    let idleCallback: IdleRequestCallback | undefined
    const requestIdleCallback = vi.fn(
      (callback: IdleRequestCallback): number => {
        idleCallback = callback
        return 17
      }
    )
    const cancelIdleCallback = vi.fn()
    const loader = vi.fn(() => Promise.resolve())
    vi.stubGlobal('requestIdleCallback', requestIdleCallback)
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback)

    const cleanup = scheduleIdleRoutePreload([loader])

    expect(loader).not.toHaveBeenCalled()
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 2000
    })

    idleCallback?.(idleDeadline())
    await Promise.resolve()

    expect(loader).toHaveBeenCalledOnce()
    cleanup()
    expect(cancelIdleCallback).not.toHaveBeenCalled()
  })

  it('cancels pending idle work and ignores a stale callback', async () => {
    let idleCallback: IdleRequestCallback | undefined
    const requestIdleCallback = vi.fn(
      (callback: IdleRequestCallback): number => {
        idleCallback = callback
        return 29
      }
    )
    const cancelIdleCallback = vi.fn()
    const loader = vi.fn()
    vi.stubGlobal('requestIdleCallback', requestIdleCallback)
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback)

    const cleanup = scheduleIdleRoutePreload([loader])
    cleanup()
    idleCallback?.(idleDeadline())
    await Promise.resolve()

    expect(cancelIdleCallback).toHaveBeenCalledWith(29)
    expect(loader).not.toHaveBeenCalled()
  })

  it('reschedules preloading while latency-sensitive work is active', async () => {
    vi.useFakeTimers()
    const idleCallbacks: IdleRequestCallback[] = []
    const requestIdleCallback = vi.fn(
      (callback: IdleRequestCallback): number => {
        idleCallbacks.push(callback)
        return idleCallbacks.length
      }
    )
    const loader = vi.fn()
    let latencySensitiveWorkActive = true
    vi.stubGlobal('requestIdleCallback', requestIdleCallback)
    vi.stubGlobal('cancelIdleCallback', vi.fn())

    scheduleIdleRoutePreload(
      [loader],
      () => !latencySensitiveWorkActive
    )
    idleCallbacks[0]?.(idleDeadline())
    await Promise.resolve()

    expect(loader).not.toHaveBeenCalled()
    expect(requestIdleCallback).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(100)

    expect(requestIdleCallback).toHaveBeenCalledTimes(2)

    latencySensitiveWorkActive = false
    idleCallbacks[1]?.(idleDeadline())
    await Promise.resolve()

    expect(loader).toHaveBeenCalledOnce()
  })

  it('uses a zero-delay timer fallback and cancels pending timer work', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    vi.stubGlobal('cancelIdleCallback', undefined)
    const startedLoader = vi.fn()
    const cancelledLoader = vi.fn()

    scheduleIdleRoutePreload([startedLoader])
    const cleanup = scheduleIdleRoutePreload([cancelledLoader])
    cleanup()

    expect(startedLoader).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()

    expect(startedLoader).toHaveBeenCalledOnce()
    expect(cancelledLoader).not.toHaveBeenCalled()
  })
})

describe('route module preloading', () => {
  it('settles every resolved, rejected, and synchronously thrown loader', async () => {
    const error = new Error('load failed')
    const loaders: RouteModuleLoader[] = [
      vi.fn(() => 'loaded'),
      vi.fn(() => Promise.reject(error)),
      vi.fn(() => {
        throw error
      }),
      vi.fn(() => Promise.resolve('also loaded'))
    ]

    const preload = preloadRouteModules(loaders)

    expect(loaders.every((loader) => vi.mocked(loader).mock.calls.length === 0))
      .toBe(true)
    await expect(preload).resolves.toEqual([
      { status: 'fulfilled', value: 'loaded' },
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
      { status: 'fulfilled', value: 'also loaded' }
    ])
    expect(loaders.every((loader) => vi.mocked(loader).mock.calls.length === 1))
      .toBe(true)
  })
})
