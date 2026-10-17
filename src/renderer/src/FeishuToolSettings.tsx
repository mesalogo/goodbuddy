import { QrCode, Wrench } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeishuDomain } from '../../shared/channel-settings-contracts'
import {
  feishuCategoryUsable,
  feishuToolCategories,
  type FeishuSnapshot,
  type FeishuToolSettingsUpdate
} from '../../shared/feishu-contracts'
import { useFeishuSnapshot } from './feishu-snapshot'
import './wecom.css'

function QrImage({ url }: { url: string }): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const [image, setImage] = useState<{ url: string; data: string }>()
  useEffect(() => {
    let active = true
    void QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 220 }).then((data) => {
      if (active) setImage({ url, data })
    })
    return () => { active = false }
  }, [url])
  return image?.url === url
    ? <img alt={t('channels.feishu.createApp')} className="wecom-tools__qr" src={image.data} />
    : <div className="wecom-tools__qr wecom-tools__qr--placeholder">{t('channels.qr.generating')}</div>
}

/** Scan-to-create for the Feishu app; fills the channel credentials when done. */
export function FeishuAppRegistration({
  domain,
  onCreated
}: {
  domain: FeishuDomain
  onCreated: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation('integrations')
  const { snapshot, setSnapshot } = useFeishuSnapshot()
  const [busy, setBusy] = useState(false)
  const api = window.goodbuddy?.feishu
  const state = snapshot?.registration.state
  const onCreatedRef = useRef(onCreated)
  const previousState = useRef(state)
  useEffect(() => { onCreatedRef.current = onCreated }, [onCreated])
  // Reload once when registration finishes. Running on every render while the
  // state stays "completed" reset the unsaved form after each change.
  useEffect(() => {
    const previous = previousState.current
    previousState.current = state
    if (state === 'completed' && previous !== undefined && previous !== 'completed') onCreatedRef.current()
  }, [state])
  if (!api || !snapshot) return null
  const registration = snapshot.registration
  const run = async (operation: () => Promise<FeishuSnapshot>): Promise<void> => {
    setBusy(true)
    try { setSnapshot(await operation()) } finally { setBusy(false) }
  }
  return (
    <div className="feishu-registration">
      {registration.state === 'waiting' ? (
        <div className="wecom-tools__qr-panel">
          <QrImage url={registration.url} />
          <p>{t('channels.feishu.qrInstructions')}</p>
          <small>{t('channels.feishu.qrExpires', { time: new Date(registration.expiresAt).toLocaleTimeString() })}</small>
          <button className="secondary-button" disabled={busy} onClick={() => void run(() => api.cancelRegistration())} type="button">
            {t('channels.feishu.cancel')}
          </button>
        </div>
      ) : (
        <div className="channel-binding-actions">
          <button
            className="secondary-button"
            disabled={busy || registration.state === 'starting'}
            onClick={() => void run(() => api.startRegistration(domain))}
            type="button"
          >
            <QrCode aria-hidden="true" size={14} />
            {registration.state === 'starting' ? t('channels.feishu.creating') : t('channels.feishu.createApp')}
          </button>
        </div>
      )}
      {registration.state === 'failed' && (
        <p className="settings-warning" role="alert">{t('channels.feishu.createFailed', { message: registration.message })}</p>
      )}
      {registration.state === 'completed' && <p className="settings-notice" role="status">{t('channels.feishu.created')}</p>}
    </div>
  )
}

/**
 * Feishu work tools: categories and message-session permission. Availability
 * follows the application switch on the Connection tab.
 */
export function FeishuToolSettings(): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const { snapshot, error: loadError, setSnapshot } = useFeishuSnapshot()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const api = window.goodbuddy?.feishu
  const update = async (input: FeishuToolSettingsUpdate): Promise<void> => {
    if (!api) return
    setBusy(true)
    setError(undefined)
    try {
      setSnapshot(await api.updateSettings(input))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('feishu.actionError'))
    } finally {
      setBusy(false)
    }
  }
  if (!snapshot || !api) {
    return (
      <article className="capability-card channel-settings-card" aria-label={t('feishu.title')}>
        {loadError
          ? <p className="settings-warning" role="alert">{loadError}</p>
          : <p className="settings-empty" role="status">{t('feishu.loading')}</p>}
      </article>
    )
  }
  return (
    <article className="capability-card channel-settings-card" aria-labelledby="feishu-tools-title">
      <div className="capability-card__header">
        <div>
          <strong id="feishu-tools-title"><Wrench aria-hidden="true" size={14} /> {t('feishu.title')}</strong>
          <small>{t('feishu.description')}</small>
        </div>
        <span>{snapshot.credentialsConfigured ? t('feishu.ready') : t('feishu.notConfigured')}</span>
      </div>
      {error && <p className="settings-warning" role="alert">{error}</p>}
      {!snapshot.credentialsConfigured && <p className="settings-notice">{t('feishu.needsCredentials')}</p>}
      {snapshot.credentialsConfigured && !snapshot.appEnabled && <p className="settings-notice">{t('feishu.appOff')}</p>}
      <fieldset className="wecom-tools__categories" disabled={busy || !snapshot.credentialsConfigured}>
        <legend>{t('feishu.categoriesTitle')}</legend>
        {feishuToolCategories.map(category => {
          const blocked = !feishuCategoryUsable(category, snapshot.settings.categories)
          return (
            <label className="check-field" key={category}>
              <input
                checked={snapshot.settings.categories[category] && !blocked}
                disabled={blocked}
                onChange={(event) => void update({ categories: { [category]: event.target.checked } })}
                type="checkbox"
              />
              <span>
                {t(`feishu.categories.${category}.label`)}
                <small>{blocked ? t('feishu.requiresDoc') : t(`feishu.categories.${category}.description`)}</small>
              </span>
            </label>
          )
        })}
      </fieldset>
      <p className="settings-notice">{t('feishu.identityHelp')}</p>
      <label className="toggle-row" htmlFor="feishu-tools-message-sessions">
        <input
          checked={snapshot.settings.allowInMessageSessions}
          disabled={busy || !snapshot.credentialsConfigured}
          id="feishu-tools-message-sessions"
          onChange={(event) => void update({ allowInMessageSessions: event.target.checked })}
          role="switch"
          type="checkbox"
        />
        <span>{t('feishu.allowInMessageSessions')}</span>
      </label>
      <small>{t('feishu.allowInMessageSessionsHelp')}</small>
    </article>
  )
}
