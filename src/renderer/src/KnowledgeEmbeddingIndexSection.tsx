import { Database, ListChecks, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  KnowledgeEmbeddingIndexSnapshot
} from '../../shared/embedding-contracts'
import { isEmbeddingIndexJobActive } from '../../shared/embedding-contracts'

export type KnowledgeEmbeddingIndexSectionProps = {
  snapshot?: KnowledgeEmbeddingIndexSnapshot
  loading?: boolean
  onRebuild: () => void
  onViewTasks?: () => void
}

export function KnowledgeEmbeddingIndexSection({
  snapshot,
  loading = false,
  onRebuild,
  onViewTasks
}: KnowledgeEmbeddingIndexSectionProps): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const active = isEmbeddingIndexJobActive(snapshot?.indexStatus.job)
  return (
    <section
      aria-labelledby="knowledge-vector-index-title"
      className="knowledge-embedding-index"
    >
      <div className="knowledge-embedding-index__heading">
        <div>
          <Database aria-hidden="true" size={16} />
          <div>
            <h3 id="knowledge-vector-index-title">
              {t('settings.vectorIndex.title')}
            </h3>
            <p>{t('settings.vectorIndex.description')}</p>
          </div>
        </div>
        <button
          className="secondary-button"
          disabled={loading || !snapshot?.enabled || active}
          onClick={onRebuild}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={13} />
          {t('settings.vectorIndex.rebuild')}
        </button>
      </div>

      {loading || !snapshot ? (
        <p aria-live="polite">{t('settings.vectorIndex.loading')}</p>
      ) : !snapshot.enabled || !snapshot.configuration ? (
        <div className="knowledge-embedding-index__empty">
          <strong>{t('settings.vectorIndex.disabledTitle')}</strong>
          <p>{t('settings.vectorIndex.disabledDescription')}</p>
        </div>
      ) : (
        <>
          <div className="knowledge-embedding-index__model">
            <span>{t('settings.vectorIndex.currentModel')}</span>
            <strong>{snapshot.configuration.model}</strong>
            <small>
              {snapshot.configuration.provider}
              {snapshot.configuration.endpoint
                ? ` · ${snapshot.configuration.endpoint}`
                : ''}
            </small>
          </div>
          <dl className="knowledge-embedding-index__coverage">
            {(['indexed', 'missing', 'error', 'total'] as const).map(
              (key) => (
                <div key={key}>
                  <dt>{t(`settings.vectorIndex.coverage.${key}`)}</dt>
                  <dd>{snapshot.coverage[key]}</dd>
                </div>
              )
            )}
          </dl>
          {active && (
            <div className="knowledge-embedding-index__task-guidance">
              <div>
                <strong>{t('settings.vectorIndex.activeTitle')}</strong>
                <p>{t('settings.vectorIndex.activeDescription')}</p>
              </div>
              {onViewTasks && (
                <button
                  className="secondary-button"
                  onClick={onViewTasks}
                  type="button"
                >
                  <ListChecks aria-hidden="true" size={13} />
                  {t('settings.vectorIndex.viewTasks')}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
