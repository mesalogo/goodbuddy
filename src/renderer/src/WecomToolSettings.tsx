import { KeyRound, QrCode, Unplug, Wrench } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  wecomToolCategories,
  type WecomSnapshot,
  type WecomToolCategory,
  type WecomToolSettingsUpdate
} from '../../shared/wecom-contracts'
import { useWecomSnapshot } from './wecom-snapshot'
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
    ? <img alt={t('wecom.qrAlt')} className="wecom-tools__qr" src={image.data} />
    : <div className="wecom-tools__qr wecom-tools__qr--placeholder">{t('channels.qr.generating')}</div>
}

/** WeCom work tools: authorization of the personal smart bot and category switches. */
export function WecomToolSettings({
  channelBotConfigured,
  onChannelBotSaved
}: {
  channelBotConfigured: boolean
  /** Called once when a scan also saved the bot as the message channel bot. */
  onChannelBotSaved?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const { snapshot, error: loadError, setSnapshot } = useWecomSnapshot()
  const savedRef = useRef(onChannelBotSaved)
  useEffect(() => { savedRef.current = onChannelBotSaved }, [onChannelBotSaved])
  const qrState = snapshot?.qr.state
  const channelSaved = snapshot?.qr.state === 'completed' && snapshot.qr.channelSaved
  const previousQrState = useRef(qrState)
  // Only on the transition into "completed", so later edits are not reset.
  useEffect(() => {
    const previous = previousQrState.current
    previousQrState.current = qrState
    if (channelSaved && previous !== undefined && previous !== 'completed') savedRef.current?.()
  }, [qrState, channelSaved])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [manualOpen, setManualOpen] = useState(false)
  const [botId, setBotId] = useState('')
  const [secret, setSecret] = useState('')

  const act = async (operation: () => Promise<WecomSnapshot>): Promise<boolean> => {
    setBusy(true)
    setError(undefined)
    try {
      setSnapshot(await operation())
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('wecom.actionError'))
      return false
    } finally {
      setBusy(false)
    }
  }
  const api = window.goodbuddy?.wecom
  const update = (input: WecomToolSettingsUpdate): void => {
    if (api) void act(() => api.updateSettings(input))
  }

  if (!snapshot || !api) {
    return (
      <article className="capability-card channel-settings-card wecom-tools" aria-label={t('wecom.title')}>
        {loadError
          ? <p className="settings-warning" role="alert">{loadError}</p>
          : <p className="settings-empty" role="status">{t('wecom.loading')}</p>}
      </article>
    )
  }

  const authorized = snapshot.authorization.state === 'authorized'
  const qr = snapshot.qr
  return (
    <article className="capability-card channel-settings-card wecom-tools" aria-labelledby="wecom-tools-title">
      <div className="capability-card__header">
        <div>
          <strong id="wecom-tools-title"><Wrench aria-hidden="true" size={14} /> {t('wecom.title')}</strong>
          <small>{t('wecom.description')}</small>
        </div>
        <span>{authorized ? t('wecom.authorized') : t('wecom.unauthorized')}</span>
      </div>

      {!snapshot.platformSupported && <p className="settings-warning" role="alert">{t('wecom.unsupportedPlatform')}</p>}
      {(error ?? (qr.state === 'failed' ? qr.message : undefined)) && (
        <p className="settings-warning" role="alert">{error ?? (qr.state === 'failed' ? qr.message : '')}</p>
      )}

      {qr.state === 'completed' && (
        <p className={qr.channelSaved ? 'settings-notice' : 'settings-warning'} role="status">
          {qr.channelSaved
            ? t(qr.userId ? 'wecom.scanChannelSaved' : 'wecom.scanChannelSavedNoSender')
            : qr.message
              ? t('wecom.scanChannelFailed', { message: qr.message })
              : t('wecom.scanToolsOnly')}
        </p>
      )}
      {authorized ? (
        <>
          <p>{snapshot.authorization.state === 'authorized' && snapshot.authorization.botId
            ? t('wecom.authorizedAs', { botId: snapshot.authorization.botId })
            : t('wecom.authorizedHelp')}</p>
          <label className="toggle-row" htmlFor="wecom-tools-enabled">
            <input
              checked={snapshot.settings.enabled}
              disabled={busy}
              id="wecom-tools-enabled"
              onChange={(event) => update({ enabled: event.target.checked })}
              role="switch"
              type="checkbox"
            />
            <span>{t('wecom.enable')}</span>
          </label>
          <fieldset className="wecom-tools__categories" disabled={busy || !snapshot.settings.enabled}>
            <legend>{t('wecom.categoriesTitle')}</legend>
            {wecomToolCategories.map((category: WecomToolCategory) => (
              <label className="check-field" key={category}>
                <input
                  checked={snapshot.settings.categories[category]}
                  onChange={(event) => update({ categories: { [category]: event.target.checked } })}
                  type="checkbox"
                />
                <span>
                  {t(`wecom.categories.${category}.label`)}
                  <small>{t(`wecom.categories.${category}.description`)}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="settings-notice">{t('wecom.categoriesHelp')}</p>
          <label className="toggle-row" htmlFor="wecom-tools-message-sessions">
            <input
              checked={snapshot.settings.allowInMessageSessions}
              disabled={busy || !snapshot.settings.enabled}
              id="wecom-tools-message-sessions"
              onChange={(event) => update({ allowInMessageSessions: event.target.checked })}
              role="switch"
              type="checkbox"
            />
            <span>{t('wecom.allowInMessageSessions')}</span>
          </label>
          <small>{t('wecom.allowInMessageSessionsHelp')}</small>
          <div className="channel-binding-actions">
            <button
              className="danger-button danger-button--quiet"
              disabled={busy}
              onClick={() => void act(() => api.disconnect())}
              type="button"
            >
              <Unplug aria-hidden="true" size={14} />
              {t('wecom.disconnect')}
            </button>
          </div>
          <small>{t('wecom.disconnectHelp')}</small>
        </>
      ) : qr.state === 'waiting' ? (
        <div className="wecom-tools__qr-panel">
          <QrImage url={qr.url} />
          <p>{t('wecom.qrInstructions')}</p>
          <small>{t('wecom.qrExpires', { time: new Date(qr.expiresAt).toLocaleTimeString() })}</small>
          <a href={qr.webUrl} rel="noreferrer" target="_blank">{t('wecom.qrOpenWeb')}</a>
          <button className="secondary-button" disabled={busy} onClick={() => void act(() => api.cancelQrAuthorization())} type="button">
            {t('wecom.cancelQr')}
          </button>
        </div>
      ) : (
        <>
          <p>{t('wecom.connectHelp')}</p>
          <div className="channel-binding-actions">
            <button
              className="primary-button"
              disabled={busy || qr.state === 'starting' || !snapshot.platformSupported}
              onClick={() => void act(() => api.startQrAuthorization())}
              type="button"
            >
              <QrCode aria-hidden="true" size={14} />
              {qr.state === 'starting' ? t('wecom.preparing') : t('wecom.scan')}
            </button>
            {channelBotConfigured && (
              <button
                className="secondary-button"
                disabled={busy || !snapshot.platformSupported}
                onClick={() => void act(() => api.authorizeWithChannelBot())}
                type="button"
              >
                {t('wecom.useChannelBot')}
              </button>
            )}
            <button
              aria-expanded={manualOpen}
              className="secondary-button"
              disabled={busy || !snapshot.platformSupported}
              onClick={() => setManualOpen(!manualOpen)}
              type="button"
            >
              <KeyRound aria-hidden="true" size={14} />
              {t('wecom.manual')}
            </button>
          </div>
          <small>{t('wecom.adminHelp')}</small>
          {manualOpen && (
            <form
              className="wecom-tools__manual"
              onSubmit={(event) => {
                event.preventDefault()
                void act(() => api.authorizeManually({ botId, secret })).then((ok) => {
                  if (ok) { setSecret(''); setManualOpen(false) }
                })
              }}
            >
              <label className="field">
                <span>{t('wecom.botId')}</span>
                <input maxLength={256} onChange={(event) => setBotId(event.target.value)} required value={botId} />
              </label>
              <label className="field">
                <span>{t('wecom.secret')}</span>
                <input autoComplete="off" maxLength={4096} onChange={(event) => setSecret(event.target.value)} required type="password" value={secret} />
              </label>
              <button className="primary-button" disabled={busy || !botId.trim() || !secret.trim()} type="submit">
                {t('wecom.verify')}
              </button>
            </form>
          )}
        </>
      )}
    </article>
  )
}
