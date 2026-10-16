import { ExternalLink, MessageSquarePlus, Search, Settings } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WecomDocument } from '../../shared/wecom-contracts'
import { useWecomSnapshot } from './wecom-snapshot'
import './wecom.css'

const knownTypes = new Set(['doc', 'sheet', 'smartsheet', 'smartpage'])

/** Right workbar panel: search WeCom documents the authorized person can access. */
export function WecomWorkbarPanel({
  onUseInConversation,
  onOpenSettings
}: {
  onUseInConversation?: (text: string) => void
  onOpenSettings?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const { snapshot, error: loadError } = useWecomSnapshot()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WecomDocument[]>()
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string>()
  const ready = snapshot?.authorization.state === 'authorized' && snapshot.settings.enabled

  const search = async (): Promise<void> => {
    const api = window.goodbuddy?.wecom
    const text = query.trim()
    if (!api || !text || searching) return
    setSearching(true)
    setError(undefined)
    try {
      setResults(await api.searchDocuments({ query: text }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('wecom.actionError'))
    } finally {
      setSearching(false)
    }
  }

  return (
    <section aria-label={t('wecom.panel.title')} className="wecom-panel">
      <header className="wecom-panel__header">
        <div>
          <strong>{t('wecom.panel.title')}</strong>
          <small>{t('wecom.panel.identity')}</small>
        </div>
        {onOpenSettings && (
          <button
            aria-label={t('wecom.panel.openSettings')}
            className="icon-button"
            onClick={onOpenSettings}
            title={t('wecom.panel.openSettings')}
            type="button"
          >
            <Settings aria-hidden="true" size={16} />
          </button>
        )}
      </header>
      {loadError && <p className="settings-warning" role="alert">{loadError}</p>}
      {!snapshot && !loadError && <p className="settings-empty" role="status">{t('wecom.loading')}</p>}
      {snapshot && !ready && (
        <div className="wecom-panel__empty">
          <p>{t('wecom.panel.notReady')}</p>
          {onOpenSettings && (
            <button className="secondary-button" onClick={onOpenSettings} type="button">
              {t('wecom.panel.openSettings')}
            </button>
          )}
        </div>
      )}
      {ready && (
        <>
          <form
            className="wecom-panel__search"
            onSubmit={(event) => { event.preventDefault(); void search() }}
            role="search"
          >
            <input
              aria-label={t('wecom.panel.search')}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('wecom.panel.searchPlaceholder')}
              type="search"
              value={query}
            />
            <button
              aria-label={t('wecom.panel.search')}
              className="icon-button"
              disabled={searching || !query.trim()}
              title={t('wecom.panel.search')}
              type="submit"
            >
              <Search aria-hidden="true" size={16} />
            </button>
          </form>
          {error && <p className="settings-warning" role="alert">{error}</p>}
          {searching && <p className="settings-empty" role="status">{t('wecom.panel.searching')}</p>}
          {!searching && results === undefined && <p className="settings-empty">{t('wecom.panel.initial')}</p>}
          {!searching && results?.length === 0 && <p className="settings-empty" role="status">{t('wecom.panel.empty')}</p>}
          {!searching && results && results.length > 0 && (
            <ul aria-label={t('wecom.panel.search')} className="wecom-panel__results">
              {results.map((doc) => (
                <li className="wecom-panel__result" key={doc.id}>
                  <strong>{doc.name}</strong>
                  <small>
                    {t(`wecom.panel.types.${knownTypes.has(doc.type) ? doc.type : 'other'}`)}
                    {doc.modifiedAt ? ` · ${doc.modifiedAt}` : ''}
                  </small>
                  <div className="wecom-panel__actions">
                    {doc.url && (
                      <a className="secondary-button" href={doc.url} rel="noreferrer" target="_blank">
                        <ExternalLink aria-hidden="true" size={14} />
                        {t('wecom.panel.open')}
                      </a>
                    )}
                    {onUseInConversation && (
                      <button
                        className="secondary-button"
                        onClick={() => onUseInConversation(t('wecom.panel.useText', { name: doc.name, url: doc.url ?? '' }))}
                        type="button"
                      >
                        <MessageSquarePlus aria-hidden="true" size={14} />
                        {t('wecom.panel.use')}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
