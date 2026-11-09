import { QrCode } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChannelSettingsSnapshot } from '../../shared/channel-settings-contracts'
import type { DingTalkRegistrationBridge } from '../../shared/dingtalk-registration-contracts'
import { createDingTalkRegistrationStore } from './dingtalk-registration-store'
import './wecom.css'

function Registration({ api, onCreated }: { api: DingTalkRegistrationBridge; onCreated: (channels: ChannelSettingsSnapshot, revision: number) => void }): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const store = useMemo(() => createDingTalkRegistrationStore(api), [api])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const error = useSyncExternalStore(store.subscribe, store.getError)
  const [image, setImage] = useState<{ url: string; data: string }>()
  const [qrError, setQrError] = useState<{ url: string; message: string }>()
  const created = useRef(onCreated)
  const completedRevision = useRef(-1)
  useEffect(() => { created.current = onCreated }, [onCreated])
  useEffect(() => store.connect(), [store])
  useEffect(() => {
    if (snapshot.state === 'completed' && completedRevision.current !== snapshot.revision) {
      completedRevision.current = snapshot.revision
      created.current(snapshot.channels, snapshot.revision)
    }
  }, [snapshot])
  const url = snapshot.state === 'waiting' ? snapshot.url : undefined
  useEffect(() => {
    let active = true
    if (url) void QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 220 }).then(
      data => { if (active) { setImage({ url, data }); setQrError(undefined) } },
      reason => { if (active) setQrError({ url, message: String(reason) }) }
    )
    return () => { active = false }
  }, [url])
  const busy = snapshot.state === 'starting' || snapshot.state === 'saving'
  const failure = error ?? (qrError?.url === url ? qrError?.message : undefined) ?? (snapshot.state === 'failed' ? snapshot.message : undefined)
  return <div className="feishu-registration">
    <p className="field-help">{t('dingtalkRegistration.help')}</p>
    {snapshot.state === 'waiting' ? <div className="wecom-tools__qr-panel">
      {image && image.url === url ? <img alt={t('dingtalkRegistration.qrAlt')} className="wecom-tools__qr" src={image.data} />
        : <div className="wecom-tools__qr wecom-tools__qr--placeholder">{t('channels.qr.generating')}</div>}
      <p>{t('dingtalkRegistration.instructions')}</p>
      <small>{t('wecom.qrExpires', { time: new Date(snapshot.expiresAt).toLocaleTimeString() })}</small>
      <a href={snapshot.url} target="_blank" rel="noreferrer">{t('dingtalkRegistration.open')}</a>
      <button className="secondary-button" onClick={() => void store.cancel()} type="button">{t('wecom.cancelQr')}</button>
    </div> : <button className="secondary-button" disabled={busy} onClick={() => void store.start()} type="button">
      <QrCode aria-hidden="true" size={14} />{busy ? t('dingtalkRegistration.preparing') : t('dingtalkRegistration.start')}
    </button>}
    {failure && <p className="settings-warning" role="alert">{failure}</p>}
    {snapshot.state === 'completed' && <p className="settings-notice" role="status">{t('dingtalkRegistration.completed')}</p>}
  </div>
}

export function DingTalkAppRegistration({ onCreated }: { onCreated: (channels: ChannelSettingsSnapshot, revision: number) => void }): React.JSX.Element | null {
  const api = window.goodbuddy?.dingtalkRegistration
  return api ? <Registration api={api} onCreated={onCreated} /> : null
}
