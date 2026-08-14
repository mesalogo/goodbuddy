export type RouteModuleLoader = () => unknown | PromiseLike<unknown>

export function preloadRouteModules(
  loaders: readonly RouteModuleLoader[]
): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(
    loaders.map((loader) => Promise.resolve().then(loader))
  )
}

export function scheduleIdleRoutePreload(
  loaders: readonly RouteModuleLoader[],
  canStart: () => boolean = () => true
): () => void {
  let active = true
  let started = false
  let cancelPending: (() => void) | undefined

  const start = (): void => {
    if (!active || started) {
      return
    }
    cancelPending = undefined
    if (!canStart()) {
      schedule(true)
      return
    }

    started = true
    void preloadRouteModules(loaders)
  }

  const schedule = (retry = false): void => {
    if (!active || started) {
      return
    }
    if (retry) {
      const timeoutId = window.setTimeout(() => {
        cancelPending = undefined
        schedule()
      }, 100)
      cancelPending = () => window.clearTimeout(timeoutId)
      return
    }

    if (typeof window.requestIdleCallback === 'function') {
      const idleCallbackId = window.requestIdleCallback(start, {
        timeout: 2000
      })
      cancelPending = () => window.cancelIdleCallback(idleCallbackId)
      return
    }

    const timeoutId = window.setTimeout(start, 0)
    cancelPending = () => window.clearTimeout(timeoutId)
  }

  schedule()

  return () => {
    if (started || !active) {
      return
    }

    active = false
    cancelPending?.()
    cancelPending = undefined
  }
}
