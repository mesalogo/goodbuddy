import { ArrowLeft, ExternalLink, MessageSquarePlus, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeishuBrowseInput, FeishuBrowseItem } from '../../shared/feishu-contracts'
import { useFeishuSnapshot } from './feishu-snapshot'
import './wecom.css'

type Location = FeishuBrowseInput['location']

/** Right workbar panel: browse knowledge spaces and drive folders shared with the Feishu app. */
export function FeishuWorkbarPanel({
  onUseInConversation,
  onOpenSettings
}: {
  onUseInConversation?: (text: string) => void
  onOpenSettings?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const { snapshot, error: loadError } = useFeishuSnapshot()
  const [path, setPath] = useState<{ location: Location; name: string }[]>([{ location: { kind: 'root' }, name: '' }])
  const [result, setResult] = useState<{ key: string; items: FeishuBrowseItem[]; hint?: string; error?: string }>()
  const ready = Boolean(snapshot?.credentialsConfigured && snapshot.settings.enabled)
  const current = path.at(-1)!
  const key = JSON.stringify(current.location)

  useEffect(() => {
    const api = window.goodbuddy?.feishu
    if (!ready || !api) return
    let active = true
    void api.browse({ location: JSON.parse(key) as Location }).then(
      (next) => { if (active) setResult({ key, ...next }) },
      (reason: unknown) => { if (active) setResult({ key, items: [], error: reason instanceof Error ? reason.message : String(reason) }) }
    )
    return () => { active = false }
  }, [key, ready])

  const loading = ready && result?.key !== key

  return (
    <section aria-label={t('feishu.panel.title')} className="wecom-panel">
      <header className="wecom-panel__header">
        <div>
          <strong>{t('feishu.panel.title')}</strong>
          <small>{t('feishu.panel.identity')}</small>
        </div>
        {onOpenSettings && (
          <button aria-label={t('feishu.panel.openSettings')} className="icon-button" onClick={onOpenSettings}
            title={t('feishu.panel.openSettings')} type="button">
            <Settings aria-hidden="true" size={16} />
          </button>
        )}
      </header>
      {loadError && <p className="settings-warning" role="alert">{loadError}</p>}
      {!snapshot && !loadError && <p className="settings-empty" role="status">{t('feishu.loading')}</p>}
      {snapshot && !ready && (
        <div className="wecom-panel__empty">
          <p>{t('feishu.panel.notReady')}</p>
          {onOpenSettings && (
            <button className="secondary-button" onClick={onOpenSettings} type="button">{t('feishu.panel.openSettings')}</button>
          )}
        </div>
      )}
      {ready && (
        <>
          <nav aria-label={t('feishu.panel.root')} className="feishu-panel__path">
            {path.length > 1 && (
              <button aria-label={t('feishu.panel.back')} className="icon-button" onClick={() => setPath(path.slice(0, -1))}
                title={t('feishu.panel.back')} type="button">
                <ArrowLeft aria-hidden="true" size={16} />
              </button>
            )}
            <span>{path.map(entry => entry.name || t('feishu.panel.root')).join(' / ')}</span>
          </nav>
          {loading && <p className="settings-empty" role="status">{t('feishu.loading')}</p>}
          {!loading && result?.error && <p className="settings-warning" role="alert">{result.error}</p>}
          {!loading && result?.hint && <p className="settings-notice" style={{ whiteSpace: 'pre-line' }}>{result.hint}</p>}
          {!loading && result && !result.error && result.items.length === 0 && !result.hint && (
            <p className="settings-empty">{t('feishu.panel.empty')}</p>
          )}
          {!loading && result && result.items.length > 0 && (
            <ul aria-label={t('feishu.panel.title')} className="wecom-panel__results">
              {result.items.map(item => (
                <li className="wecom-panel__result" key={`${item.kind}:${item.token}`}>
                  {item.child ? (
                    <button className="feishu-panel__open" onClick={() => {
                      const child = item.child!
                      const location: Location = child.kind === 'node'
                        ? { kind: 'node', spaceId: child.spaceId ?? '', token: child.token }
                        : { kind: child.kind, token: child.token }
                      setPath([...path, { location, name: item.name }])
                    }} type="button">
                      <strong>{item.name}</strong>
                    </button>
                  ) : <strong>{item.name}</strong>}
                  <small>{t(`feishu.panel.kinds.${item.kind}`)}{item.type ? ` · ${item.type}` : ''}</small>
                  {(item.url || onUseInConversation) && item.kind !== 'space' && item.kind !== 'folder' && (
                    <div className="wecom-panel__actions">
                      {item.url && (
                        <a className="secondary-button" href={item.url} rel="noreferrer" target="_blank">
                          <ExternalLink aria-hidden="true" size={14} />
                          {t('feishu.panel.open')}
                        </a>
                      )}
                      {onUseInConversation && (
                        <button className="secondary-button" type="button"
                          onClick={() => onUseInConversation(t('feishu.panel.useText', { name: item.name, url: item.url ?? item.token }))}>
                          <MessageSquarePlus aria-hidden="true" size={14} />
                          {t('feishu.panel.use')}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
