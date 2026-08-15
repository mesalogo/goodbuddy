import {
  act,
  cleanup,
  render,
  screen
} from '@testing-library/react'
import { Suspense } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreloadableComponent } from './preloadable-component'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('createPreloadableComponent', () => {
  it('renders synchronously without a fallback after preloading', async () => {
    const fallbackRender = vi.fn()
    const Loaded = ({ label }: { label: string }) => <h1>{label}</h1>
    const loadModule = vi.fn(async () => ({ Loaded }))
    const route = createPreloadableComponent(
      loadModule,
      (module) => module.Loaded
    )
    const Component = route.Component
    const Fallback = (): React.JSX.Element => {
      fallbackRender()
      return <p>loading</p>
    }

    await route.preload()
    render(
      <Suspense fallback={<Fallback />}>
        <Component label="ready" />
      </Suspense>
    )

    expect(screen.getByRole('heading', { name: 'ready' }))
      .toBeInTheDocument()
    expect(fallbackRender).not.toHaveBeenCalled()
    expect(loadModule).toHaveBeenCalledOnce()
  })

  it('shares an unfinished preload with the lazy fallback path', async () => {
    const module = deferred<{
      Loaded: React.ComponentType<{ label: string }>
    }>()
    const loadModule = vi.fn(() => module.promise)
    const route = createPreloadableComponent(
      loadModule,
      (loaded) => loaded.Loaded
    )
    const Component = route.Component
    const preload = route.preload()

    render(
      <Suspense fallback={<p>loading</p>}>
        <Component label="ready" />
      </Suspense>
    )

    expect(await screen.findByText('loading')).toBeInTheDocument()
    await act(async () => {
      module.resolve({
        Loaded: ({ label }) => <h1>{label}</h1>
      })
      await preload
    })

    expect(
      await screen.findByRole('heading', { name: 'ready' })
    ).toBeInTheDocument()
    expect(loadModule).toHaveBeenCalledOnce()
  })

  it('allows a first render to retry a failed idle preload', async () => {
    let attempts = 0
    const Loaded = ({ label }: { label: string }) => <h1>{label}</h1>
    const route = createPreloadableComponent(
      async () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('temporary failure')
        }
        return { Loaded }
      },
      (module) => module.Loaded
    )
    const Component = route.Component

    await expect(route.preload()).rejects.toThrow('temporary failure')
    render(
      <Suspense fallback={<p>loading</p>}>
        <Component label="recovered" />
      </Suspense>
    )

    expect(
      await screen.findByRole('heading', { name: 'recovered' })
    ).toBeInTheDocument()
    expect(attempts).toBe(2)
  })

  it('retries when an in-flight preload shared with the first render fails', async () => {
    type RouteModule = {
      Loaded: React.ComponentType<{ label: string }>
    }
    const firstModule = deferred<RouteModule>()
    const Loaded = ({ label }: { label: string }) => <h1>{label}</h1>
    let attempts = 0
    const loadModule = vi.fn((): Promise<RouteModule> => {
      attempts += 1
      return attempts === 1
        ? firstModule.promise
        : Promise.resolve({ Loaded })
    })
    const route = createPreloadableComponent(
      loadModule,
      (module) => module.Loaded
    )
    const Component = route.Component
    const preload = route.preload()

    render(
      <Suspense fallback={<p>loading</p>}>
        <Component label="recovered shared route" />
      </Suspense>
    )

    expect(await screen.findByText('loading')).toBeInTheDocument()
    await act(async () => {
      firstModule.reject(new Error('temporary shared failure'))
      await expect(preload).rejects.toThrow('temporary shared failure')
    })

    expect(
      await screen.findByRole('heading', { name: 'recovered shared route' })
    ).toBeInTheDocument()
    expect(loadModule).toHaveBeenCalledTimes(2)
  })
})
