import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SharingModelCatalog } from '../../shared/device-sharing-contracts'
import type { AppNotificationInput } from './notifications'

export function SharingModelConfigs({ serverUrl, disabled, notify }: {
  serverUrl: string; disabled: boolean; notify: (input: AppNotificationInput) => void
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const [catalog, setCatalog] = useState<SharingModelCatalog>()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try { await action() }
    catch (error) { notify({ tone: 'error', message: String(error), dedupeKey: 'sharing-models' }) }
    finally { pending.current = false; setBusy(false) }
  }
  return <section className="device-sharing__section" aria-labelledby="sharing-models" aria-busy={busy}>
    <h2 id="sharing-models">{t('sharing.models.title')}</h2>
    <p>{t('sharing.models.help')}</p>
    <button className="secondary-button" disabled={disabled || busy} onClick={() => void run(async () => {
      setCatalog(undefined)
      setCatalog(await window.goodbuddy.sharing.getModelConfigs())
    })}>{t('sharing.models.fetch')}</button>
    {busy && <p role="status">{t('sharing.working')}</p>}
    {catalog?.items.length === 0 && <p>{t('sharing.models.empty')}</p>}
    {catalog?.items.map(item => <article key={item.id}>
      <h3>{item.name} · {item.model}</h3>
      <p>{t(`sharing.models.${item.routeType}`)} · {item.version}</p>
      <p>{item.baseURL}</p>
      <button className="secondary-button" disabled={disabled || busy} onClick={() => void run(async () => {
        const result = await window.goodbuddy.sharing.importModelConfig({ serverUrl, id: item.id, releaseId: item.releaseId })
        notify({ tone: result.imported ? 'success' : 'info', message: t(result.imported ? 'sharing.models.imported' : 'sharing.models.exists') })
      })}>{t('sharing.models.import')}</button>
    </article>)}
  </section>
}
