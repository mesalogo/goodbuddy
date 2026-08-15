import {
  createElement,
  lazy,
  useRef,
  type ComponentType
} from 'react'

export type PreloadableComponent<Props extends object> = {
  Component: ComponentType<Props>
  preload: () => Promise<unknown>
}

export function createPreloadableComponent<
  Module,
  Props extends object
>(
  loadModule: () => Promise<Module>,
  selectComponent: (module: Module) => ComponentType<Props>
): PreloadableComponent<Props> {
  let loadPromise: Promise<Module> | undefined
  let resolvedComponent: ComponentType<Props> | undefined

  const preload = (): Promise<Module> => {
    if (!loadPromise) {
      loadPromise = Promise.resolve()
        .then(loadModule)
        .then((module) => {
          resolvedComponent = selectComponent(module)
          return module
        })
        .catch((error: unknown) => {
          loadPromise = undefined
          throw error
        })
    }
    return loadPromise
  }

  const loadLazyModule = async () => {
    const module = await preload()
    return {
      default: resolvedComponent ?? selectComponent(module)
    }
  }

  const LazyComponent = lazy(async () => {
    try {
      return await loadLazyModule()
    } catch {
      return loadLazyModule()
    }
  })

  function PreloadedComponent(props: Props): React.JSX.Element {
    const renderSynchronously = useRef(
      resolvedComponent !== undefined
    ).current
    const Component = resolvedComponent
    if (renderSynchronously && Component) {
      return createElement(Component, props)
    }
    return createElement(LazyComponent, props)
  }

  return {
    Component: PreloadedComponent,
    preload
  }
}
