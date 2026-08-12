import {
  Activity,
  FlaskConical
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  EmbeddingConfigurationSummary,
  EmbeddingDiagnosticResult
} from '../../shared/embedding-contracts'
import { formatMediumDateTime } from './locale-formatters'

export interface EmbeddingSettingsSectionProps {
  configuration: EmbeddingConfigurationSummary
  diagnostic?: EmbeddingDiagnosticResult | null
  diagnosticRunning?: boolean
  disabled?: boolean
  onTest: () => void
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
            date: formatMediumDateTime(result.checkedAt, locale)
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

export function EmbeddingSettingsSection({
  configuration,
  diagnostic,
  diagnosticRunning = false,
  disabled = false,
  onTest
}: EmbeddingSettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')

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

    </section>
  )
}
