import {
  Activity,
  Database,
  FlaskConical,
  RefreshCw,
  XCircle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  EmbeddingConfigurationSummary,
  EmbeddingDiagnosticResult,
  EmbeddingIndexJob,
  EmbeddingIndexStatus
} from '../../shared/embedding-contracts'
import { isEmbeddingIndexJobActive } from '../../shared/embedding-contracts'

export interface EmbeddingSettingsSectionProps {
  configuration: EmbeddingConfigurationSummary
  diagnostic?: EmbeddingDiagnosticResult | null
  diagnosticRunning?: boolean
  indexStatus: EmbeddingIndexStatus
  disabled?: boolean
  onTest: () => void
  onRebuild: () => void
  onCancel?: (jobId: string) => void
}

function formatCheckedAt(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(timestamp)
}

function DiagnosticResult({
  result
}: {
  result: EmbeddingDiagnosticResult
}): React.JSX.Element {
  const { i18n, t } = useTranslation('settingsSections')
  const locale = i18n.resolvedLanguage ?? i18n.language
  if (result.status === 'available') {
    return (
      <div aria-live="polite" className="capability-diagnostic__result">
        <strong>{t('embedding.diagnostic.success')}</strong>
        <p>
          {t('embedding.diagnostic.result', {
            dimensions: result.dimensions,
            latency: result.latencyMs
          })}
        </p>
        <small>
          {t('embedding.diagnostic.checkedAt', {
            date: formatCheckedAt(result.checkedAt, locale)
          })}
        </small>
      </div>
    )
  }
  return (
    <div
      aria-live="assertive"
      className="capability-diagnostic__result"
      role="alert"
    >
      <strong>{t('embedding.diagnostic.failed')}</strong>
      <p>{result.error.message}</p>
      {result.error.remedy && (
        <p>
          {t('embedding.diagnostic.remedy', {
            remedy: result.error.remedy
          })}
        </p>
      )}
    </div>
  )
}

function IndexJobStatus({
  job,
  disabled,
  onCancel
}: {
  job: EmbeddingIndexJob
  disabled: boolean
  onCancel?: (jobId: string) => void
}): React.JSX.Element {
  const { i18n, t } = useTranslation('settingsSections')
  const locale = i18n.resolvedLanguage ?? i18n.language
  const active = isEmbeddingIndexJobActive(job)
  return (
    <div
      aria-live="polite"
      className="embedding-settings__job"
      data-status={job.status}
    >
      <div className="embedding-settings__job-header">
        <div>
          <strong>{t(`embedding.index.statuses.${job.status}`)}</strong>
          <small>
            {job.provider} · {job.model}
          </small>
        </div>
        {active && onCancel && (
          <button
            aria-label={t('embedding.index.cancelAria')}
            className="secondary-button"
            disabled={disabled}
            onClick={() => onCancel(job.id)}
            type="button"
          >
            <XCircle aria-hidden="true" size={13} />
            {t('embedding.index.cancel')}
          </button>
        )}
      </div>
      {active && (
        <>
          <progress
            aria-label={t('embedding.index.progressAria')}
            max={100}
            {...(job.progress.total > 0
              ? { value: job.progress.percent }
              : {})}
          />
          <p>
            {job.progress.total > 0
              ? t('embedding.index.completed', {
                  completed: job.progress.completed,
                  total: job.progress.total
                })
              : t('embedding.index.preparing')}
          </p>
          <p className="settings-notice">
            {t('embedding.index.atomicNotice')}
          </p>
        </>
      )}
      {job.status === 'completed' && (
        <p>
          {job.completedAt
            ? t('embedding.index.completedAt', {
                completed: job.progress.completed,
                total: job.progress.total,
                date: formatCheckedAt(job.completedAt, locale)
              })
            : t('embedding.index.completedWithPeriod', {
                completed: job.progress.completed,
                total: job.progress.total
              })}
        </p>
      )}
      {job.status === 'cancelled' && (
        <>
          <p>
            {t('embedding.index.completedWithPeriod', {
              completed: job.progress.completed,
              total: job.progress.total
            })}
          </p>
          <p>{t('embedding.index.cancelledNotice')}</p>
        </>
      )}
      {job.status === 'failed' && job.error && (
        <div role="alert">
          <p>{job.error.message}</p>
          <p>
            {t('embedding.index.failedNotice', {
              completed: job.progress.completed,
              total: job.progress.total
            })}
          </p>
          <p>
            {t('embedding.index.remedyPrefix')}
            {job.error.remedy ?? t('embedding.index.defaultRemedy')}
            {t('embedding.index.retrySuffix')}
          </p>
        </div>
      )}
    </div>
  )
}

export function EmbeddingSettingsSection({
  configuration,
  diagnostic,
  diagnosticRunning = false,
  indexStatus,
  disabled = false,
  onTest,
  onRebuild,
  onCancel
}: EmbeddingSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const active = isEmbeddingIndexJobActive(indexStatus.job)

  return (
    <section
      aria-label={t('embedding.label')}
      className="embedding-settings settings-section"
    >
      <div className="settings-section__title">
        <Activity aria-hidden="true" size={17} />
        <div>
          <h2 id="embedding-settings-heading">{t('embedding.title')}</h2>
          <small>{t('embedding.description')}</small>
        </div>
      </div>

      <div
        aria-labelledby="embedding-model-heading"
        className="embedding-settings__group"
      >
        <div className="embedding-settings__subheading">
          <div>
            <FlaskConical aria-hidden="true" size={15} />
            <h3 id="embedding-model-heading">
              {t('embedding.model.heading')}
            </h3>
          </div>
        </div>
        <div className="embedding-settings__model">
          <div className="embedding-settings__model-name">
            <span>{t('embedding.model.configured')}</span>
            <strong>{configuration.model}</strong>
            <small>
              {t('embedding.model.provider', {
                provider: configuration.provider
              })}
            </small>
          </div>
          <span className="embedding-settings__credential">
            {configuration.credentialConfigured
              ? t('embedding.model.credentialConfigured')
              : t('embedding.model.credentialMissing')}
          </span>
        </div>
        {configuration.endpoint && (
          <p className="embedding-settings__endpoint">
            {t('embedding.model.endpoint')}
            <code>{configuration.endpoint}</code>
          </p>
        )}
        <div className="capability-diagnostic">
          <button
            className="secondary-button"
            disabled={disabled || diagnosticRunning}
            onClick={onTest}
            type="button"
          >
            <FlaskConical aria-hidden="true" size={13} />
            {diagnosticRunning
              ? t('embedding.diagnostic.testing')
              : t('embedding.diagnostic.test')}
          </button>
          {diagnostic && <DiagnosticResult result={diagnostic} />}
          {!diagnostic && !diagnosticRunning && (
            <p className="settings-notice">
              {t('embedding.diagnostic.notice')}
            </p>
          )}
        </div>
      </div>

      <div
        aria-labelledby="embedding-index-heading"
        className="embedding-settings__group"
      >
        <div className="embedding-settings__subheading">
          <div>
            <Database aria-hidden="true" size={15} />
            <h3 id="embedding-index-heading">
              {t('embedding.index.heading')}
            </h3>
          </div>
          <button
            className="secondary-button"
            disabled={disabled || active}
            onClick={onRebuild}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={13} />
            {active
              ? t('embedding.index.rebuildRunning')
              : t('embedding.index.rebuild')}
          </button>
        </div>

        {indexStatus.job ? (
          <IndexJobStatus
            disabled={disabled}
            job={indexStatus.job}
            onCancel={onCancel}
          />
        ) : (
          <div className="embedding-settings__empty">
            <strong>{t('embedding.index.emptyTitle')}</strong>
            <p>{t('embedding.index.emptyDescription')}</p>
          </div>
        )}
      </div>
    </section>
  )
}
