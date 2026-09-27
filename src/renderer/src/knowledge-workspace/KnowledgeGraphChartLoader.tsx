import { createPreloadableComponent } from '../preloadable-component'
import { Component, type ReactNode, useState, Suspense } from 'react'
import { AlertCircle, LoaderCircle } from 'lucide-react'
import type { KnowledgeGraphChartProps } from '../KnowledgeGraphChart'
import { useTranslation } from 'react-i18next'

type KnowledgeGraphChartModule = typeof import('../KnowledgeGraphChart')

type KnowledgeGraphChartModuleLoader = (
) => Promise<KnowledgeGraphChartModule>

function createKnowledgeGraphChartRoute(
  loadModule: KnowledgeGraphChartModuleLoader
) {
  return createPreloadableComponent(
    loadModule,
    (module) => module.KnowledgeGraphChart
  )
}

const loadKnowledgeGraphChartModule: KnowledgeGraphChartModuleLoader =
  () => import('../KnowledgeGraphChart')

class KnowledgeGraphChunkErrorBoundary extends Component<
  {
    children: ReactNode
    onRetry: () => void
    retryLabel: string
    errorMessage: string
  },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children
    }
    return (
      <div className="route-load-error" role="alert">
        <AlertCircle aria-hidden="true" size={20} />
        <strong>{this.props.errorMessage}</strong>
        <button onClick={this.props.onRetry} type="button">
          {this.props.retryLabel}
        </button>
      </div>
    )
  }
}

export function KnowledgeGraphChartLoader({
  loadModule = loadKnowledgeGraphChartModule,
  ...props
}: KnowledgeGraphChartProps & {
  loadModule?: KnowledgeGraphChartModuleLoader
}
): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [loaderState, setLoaderState] = useState(() => ({
    generation: 0,
    route: createKnowledgeGraphChartRoute(loadModule)
  }))
  const route = loaderState.route
  const Chart = route.Component

  return (
    <KnowledgeGraphChunkErrorBoundary
      errorMessage={t('graph.chunk.loadFailed')}
      key={loaderState.generation}
      onRetry={() =>
        setLoaderState((current) => ({
          generation: current.generation + 1,
          route: createKnowledgeGraphChartRoute(loadModule)
        }))
      }
      retryLabel={t('actions.retry')}
    >
      <Suspense
        fallback={
          <div
            aria-busy="true"
            aria-live="polite"
            className="route-loading-status"
            role="status"
          >
            <LoaderCircle aria-hidden="true" size={20} />
            <span>{t('graph.chunk.loading')}</span>
          </div>
        }
      >
        <Chart {...props} />
      </Suspense>
    </KnowledgeGraphChunkErrorBoundary>
  )
}
