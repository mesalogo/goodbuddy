import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModelDownloadSource } from '../../shared/application-settings-contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import type { AppNotificationInput } from './notifications'

export function ModelDownloadSourceSettings({
  open, onOpen, onClose, onNotify, onSourceChanged
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  onNotify?: (notification: AppNotificationInput) => void
  onSourceChanged: (source: ModelDownloadSource) => void
}): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [source, setSource] = useState<ModelDownloadSource>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const returnFocus = useCallback(() => trigger.current, [])
  const receiveSource = useCallback((value: ModelDownloadSource) => {
    setSource(value)
    onSourceChanged(value)
  }, [onSourceChanged])
  useEffect(() => {
    let active = true
    const updates = window.goodbuddy.updates
    // A settings event is newer than the initial read still in flight.
    let receivedChange = false
    const unsubscribe = updates?.onSettingsChanged((settings) => {
      receivedChange = true
      receiveSource(settings.modelDownloadSource)
      setError(undefined)
      setLoading(false)
    })
    void (async () => {
      try {
        if (!updates) throw new Error('unavailable')
        const settings = await updates.getSettings()
        if (active && !receivedChange) {
          receiveSource(settings.modelDownloadSource)
        }
      } catch {
        if (active && !receivedChange) {
          setError(t('platformFeatures.modelDownloadSource.readFailed'))
        }
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [attempt, t, receiveSource])
  const retry = (): void => {
    setLoading(true)
    setError(undefined)
    setAttempt((value) => value + 1)
  }
  return (
    <div className="model-download-source-control">
      <small role={loading ? 'status' : undefined}>
        {source
          ? t('platformFeatures.modelDownloadSource.current', {
              source: t(`modelDownloadSources.${source}`)
            })
          : loading
            ? t('platformFeatures.loading')
            : t('platformFeatures.modelDownloadSource.readFailed')}
      </small>
      <button className="secondary-button" onClick={onOpen} ref={trigger} type="button">
        {t('platformFeatures.modelDownloadSource.title')}
      </button>
      {open && (
        <ModelDownloadSourceDialog
          source={source}
          loading={loading}
          loadError={error}
          onRetry={retry}
          onClose={onClose}
          onSaved={receiveSource}
          onNotify={onNotify}
          returnFocus={returnFocus}
        />
      )}
    </div>
  )
}

function ModelDownloadSourceDialog({
  source, loading, loadError, onRetry, onClose, onSaved, onNotify, returnFocus
}: {
  source?: ModelDownloadSource
  loading: boolean
  loadError?: string
  onRetry: () => void
  onClose: () => void
  onSaved: (source: ModelDownloadSource) => void
  onNotify?: (notification: AppNotificationInput) => void
  returnFocus: () => HTMLElement | null
}): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const { t: settingsT } = useTranslation('settings')
  const [draft, setDraft] = useState(source)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => activateModalFocus(() => closeButton.current, returnFocus), [returnFocus])
  const selection = draft ?? source
  const close = (): void => {
    if (!saving) onClose()
  }
  const confirm = async (): Promise<void> => {
    if (saving || loading || !selection || loadError) return
    if (selection === source) {
      onClose()
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const updates = window.goodbuddy.updates
      if (!updates) throw new Error('unavailable')
      const settings = await updates.updateSettings({ modelDownloadSource: selection })
      onSaved(settings.modelDownloadSource)
      onNotify?.({
        tone: 'success',
        dedupeKey: 'model-download-source',
        message: t('platformFeatures.modelDownloadSource.notification', {
          source: t(`modelDownloadSources.${settings.modelDownloadSource}`)
        })
      })
      onClose()
    } catch {
      setError(t('platformFeatures.errors.saveModelDownloadSourceFailed'))
    } finally {
      setSaving(false)
    }
  }
  return createPortal(
    <div className="custom-task-dialog" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        event.preventDefault()
        close()
      }
    }}>
      <section
        className="custom-task-dialog__surface"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby="model-download-source-title"
        aria-describedby="model-download-source-description"
        aria-busy={saving || loading}
        onKeyDown={(event) => {
          event.stopPropagation()
          trapTabFocus(event, event.currentTarget)
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
          }
        }}
      >
        <header className="custom-task-dialog__header">
          <h2 id="model-download-source-title">{t('platformFeatures.modelDownloadSource.title')}</h2>
          <button
            className="icon-button"
            type="button"
            ref={closeButton}
            disabled={saving}
            onClick={close}
            aria-label={t('platformFeatures.modelDownloadSource.close')}
            title={t('platformFeatures.modelDownloadSource.close')}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="custom-task-dialog__content">
          <p id="model-download-source-description">{t('platformFeatures.modelDownloadSource.description')}</p>
          {loading ? (
            <p role="status">{t('platformFeatures.loading')}</p>
          ) : loadError ? (
            <div>
              <p role="alert">{loadError}</p>
              <button className="secondary-button" type="button" onClick={onRetry}>
                {t('platformFeatures.modelDownloadSource.retry')}
              </button>
            </div>
          ) : (
            <fieldset
              className="model-download-source"
              disabled={saving}
              aria-describedby={error ? 'model-download-source-error' : undefined}
            >
              <legend className="sr-only">{t('platformFeatures.modelDownloadSource.title')}</legend>
              {(['modelscope', 'hugging-face'] as const).map((value) => (
                <label
                  key={value}
                  className={`model-download-source__option${selection === value ? ' model-download-source__option--selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="model-download-source"
                    value={value}
                    checked={selection === value}
                    onChange={() => {
                      setDraft(value)
                      setError(undefined)
                    }}
                  />
                  <span>
                    <strong>{t(`modelDownloadSources.${value}`)}</strong>
                    <small>{t(`platformFeatures.modelDownloadSource.options.${value}`)}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {error && <p className="settings-warning" id="model-download-source-error" role="alert">{error}</p>}
        </div>
        <footer className="custom-task-dialog__actions">
          <button className="secondary-button" type="button" disabled={saving} onClick={close}>
            {settingsT('actions.cancel')}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={saving || loading || !selection || Boolean(loadError)}
            onClick={() => void confirm()}
          >
            {saving ? settingsT('actions.saving') : t('platformFeatures.modelDownloadSource.confirm')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
