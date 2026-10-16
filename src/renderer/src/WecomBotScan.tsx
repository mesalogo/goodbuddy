import { QrCode } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WecomSnapshot } from '../../shared/wecom-contracts'
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

/**
 * Scan-to-create on the Connection tab, like Feishu: one scan creates the
 * smart bot, fills the channel credentials and authorizes the tools.
 */
export function WecomBotScan({ onCreated }: { onCreated: () => void }): React.JSX.Element | null {
  const { t } = useTranslation('integrations')
  const { snapshot, setSnapshot } = useWecomSnapshot()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const onCreatedRef = useRef(onCreated)
  useEffect(() => { onCreatedRef.current = onCreated }, [onCreated])
  const qrState = snapshot?.qr.state
  const channelSaved = snapshot?.qr.state === 'completed' && snapshot.qr.channelSaved
  const previous = useRef(qrState)
  // Only on the transition into "completed", so later edits are not reset.
  useEffect(() => {
    const before = previous.current
    previous.current = qrState
    if (channelSaved && before !== undefined && before !== 'completed') onCreatedRef.current()
  }, [qrState, channelSaved])
  const api = window.goodbuddy?.wecom
  if (!api || !snapshot) return null
  const run = async (operation: () => Promise<WecomSnapshot>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try { setSnapshot(await operation()) } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('wecom.actionError'))
    } finally { setBusy(false) }
  }
  const qr = snapshot.qr
  const failure = error ?? (qr.state === 'failed' ? qr.message : undefined)
  return (
    <div className="feishu-registration">
      {qr.state === 'waiting' ? (
        <div className="wecom-tools__qr-panel">
          <QrImage url={qr.url} />
          <p>{t('wecom.qrInstructions')}</p>
          <small>{t('wecom.qrExpires', { time: new Date(qr.expiresAt).toLocaleTimeString() })}</small>
          <a href={qr.webUrl} rel="noreferrer" target="_blank">{t('wecom.qrOpenWeb')}</a>
          <button className="secondary-button" disabled={busy} onClick={() => void run(() => api.cancelQrAuthorization())} type="button">
            {t('wecom.cancelQr')}
          </button>
        </div>
      ) : (
        <div className="channel-binding-actions">
          <button
            className="secondary-button"
            disabled={busy || qr.state === 'starting' || !snapshot.platformSupported}
            onClick={() => void run(() => api.startQrAuthorization())}
            type="button"
          >
            <QrCode aria-hidden="true" size={14} />
            {qr.state === 'starting' ? t('wecom.preparing') : t('wecom.scan')}
          </button>
        </div>
      )}
      {!snapshot.platformSupported && <p className="settings-warning" role="alert">{t('wecom.unsupportedPlatform')}</p>}
      {failure && <p className="settings-warning" role="alert">{failure}</p>}
      {qr.state === 'completed' && (
        <p className={qr.channelSaved ? 'settings-notice' : 'settings-warning'} role="status">
          {qr.channelSaved
            ? t(qr.userId ? 'wecom.scanChannelSaved' : 'wecom.scanChannelSavedNoSender')
            : qr.message ? t('wecom.scanChannelFailed', { message: qr.message }) : t('wecom.scanToolsOnly')}
        </p>
      )}
      <small>{t('wecom.adminHelp')}</small>
    </div>
  )
}
