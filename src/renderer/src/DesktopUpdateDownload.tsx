import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DesktopUpdateSnapshot } from '../../shared/desktop-update-contracts'
import { formatModelPackageBytes } from './model-download-presentation'

export const DesktopUpdateDownload = memo(function DesktopUpdateDownload({ snapshot, error, actions }: {
  snapshot: DesktopUpdateSnapshot
  error?: string
  actions: { download: (fileName: string) => void; cancel: () => void; open: () => Promise<void>; restart: () => Promise<void> }
}) {
  const { t } = useTranslation('settingsSections')
  const [selected, setSelected] = useState('')
  const [opening, setOpening] = useState(false)
  const files = snapshot.result?.target.files ?? []
  const busy = ['downloading', 'verifying', 'cancelling'].includes(snapshot.status)
  const fixed = busy || snapshot.status === 'ready' || snapshot.status === 'restarting'
  const fileName = fixed ? snapshot.fileName : snapshot.suggestedFileName ?? selected
  const file = files.find(item => item.name === fileName)
  const reveal = file?.name.endsWith('.zip') || file?.name.endsWith('.AppImage')
  return <div className="desktop-update-download">
    {!snapshot.suggestedFileName && !fixed && <label className="field">
      <span>{t('updates.download.format')}</span>
      <select value={file?.name ?? ''} onChange={event => setSelected(event.target.value)}>
        <option value="">{t('updates.download.chooseFormat')}</option>
        {files.map(item => <option key={item.name} value={item.name}>{item.name.split('.').pop()}</option>)}
      </select>
    </label>}
    <div className="update-settings__actions">
      {snapshot.status === 'ready'
        ? <button type="button" className="primary-button" disabled={opening || snapshot.cacheCleaning || snapshot.packageHandedOff} onClick={() => {
          setOpening(true)
          void (snapshot.restartAvailable ? actions.restart() : actions.open()).finally(() => setOpening(false))
        }}>{t(snapshot.restartAvailable ? 'updates.download.restart' : reveal ? 'updates.download.reveal' : 'updates.download.open')}</button>
        : snapshot.status === 'restarting'
          ? <button type="button" className="primary-button" disabled>{t('updates.download.restarting')}</button>
        : busy
          ? <button type="button" className="secondary-button" disabled={snapshot.status === 'cancelling'} onClick={actions.cancel}>
            {t(snapshot.status === 'cancelling' ? 'updates.download.cancelling' : 'updates.download.cancel')}
          </button>
          : <button type="button" className="primary-button" disabled={!file || snapshot.cacheCleaning || snapshot.packageHandedOff} onClick={() => file && actions.download(file.name)}>
            {t(snapshot.status === 'error' ? 'updates.download.retry' : 'updates.download.start')}
          </button>}
      {file && <span>{formatModelPackageBytes(file.size)}</span>}
    </div>
    {busy && file && <>
      <progress aria-label={t('updates.download.progress')} value={snapshot.transferred} max={file.size} />
      <small aria-live="polite">{snapshot.status === 'verifying'
        ? t('updates.download.verifying')
        : `${formatModelPackageBytes(snapshot.transferred)} / ${formatModelPackageBytes(file.size)}`}</small>
    </>}
    {snapshot.source && file && <small>{t('updates.download.source', { source: t(`updates.source.names.${snapshot.source}`) })}</small>}
    {snapshot.status === 'ready' && <p>{t(snapshot.restartAvailable ? 'updates.download.restartHelp' : reveal ? 'updates.download.revealHelp' : 'updates.download.installHelp')}</p>}
    {snapshot.packageHandedOff && <p>{t('updates.download.handedOff')}</p>}
    {(snapshot.error || error) && <p role="alert">{snapshot.error || error}</p>}
  </div>
})
