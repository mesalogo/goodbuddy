import { ExternalLink, FilePlus, MessageSquarePlus, Search, Settings, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { wecomPanelViews, type WecomDocument, type WecomPanelView } from '../../shared/wecom-contracts'
import { InlineTitleForm } from './InlineTitleForm'
import { useWecomSnapshot } from './wecom-snapshot'
import './wecom.css'

const knownTypes = new Set(['doc', 'sheet', 'smartsheet', 'smartpage', 'file', 'folder', 'space', 'word', 'ppt'])
/** Type chips; "表格" covers online and smart sheets, "微盘" anything from the drive. */
const typeFilters = ['all', 'doc', 'sheet', 'disk'] as const
type TypeFilter = (typeof typeFilters)[number]

function matchesType(doc: WecomDocument, filter: TypeFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'disk') return doc.source === 'disk'
  if (filter === 'sheet') return doc.type === 'sheet' || doc.type === 'smartsheet'
  return doc.source !== 'disk' && doc.type !== 'sheet' && doc.type !== 'smartsheet'
}

/**
 * Right workbar panel: WeCom documents and drive files the authorized person
 * can access. The space dropdown picks a list (recent, created, drive) and a
 * search replaces it until cleared.
 */
export function WecomWorkbarPanel({
  onUseInConversation,
  onOpenSettings
}: {
  onUseInConversation?: (text: string) => void
  onOpenSettings?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const { snapshot, error: loadError } = useWecomSnapshot()
  const [view, setView] = useState<WecomPanelView>('recent')
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [filter, setFilter] = useState<TypeFilter>('all')
  const [result, setResult] = useState<{ key: string; items?: WecomDocument[]; error?: string }>()
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [creating, setCreating] = useState(false)
  const ready = snapshot?.authorization.state === 'authorized' && snapshot.appEnabled
  const categories = snapshot?.settings.categories
  const key = `${submitted ? `q:${submitted}` : `v:${view}`}:${reload}`

  useEffect(() => {
    const api = window.goodbuddy?.wecom
    if (!ready || !api) return
    let active = true
    const request = submitted ? api.searchDocuments({ query: submitted }) : api.listView({ view })
    void request.then(
      (items) => { if (active) setResult({ key, items }) },
      (reason: unknown) => { if (active) setResult({ key, error: reason instanceof Error ? reason.message : String(reason) }) }
    )
    return () => { active = false }
  }, [key, ready, submitted, view])

  const loading = ready && result?.key !== key
  const visible = useMemo(() => (result?.key === key ? result.items ?? [] : []).filter((doc) => matchesType(doc, filter)), [filter, key, result])

  const act = async (operation: () => Promise<WecomDocument | undefined>, done: (doc: WecomDocument) => string): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      const doc = await operation()
      if (doc) {
        setNotice(done(doc))
        setReload((value) => value + 1)
      }
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : t('wecom.actionError'))
    } finally {
      setBusy(false)
    }
  }
  const api = window.goodbuddy?.wecom

  return (
    <section aria-label={t('wecom.panel.title')} className="wecom-panel">
      <header className="wecom-panel__header">
        <div>
          <strong>{t('wecom.panel.title')}</strong>
          <small>
            {snapshot?.authorization.state === 'authorized' && snapshot.authorization.botId
              ? t('wecom.panel.identityBot', { botId: snapshot.authorization.botId })
              : t('wecom.panel.identity')}
          </small>
        </div>
        {onOpenSettings && (
          <button aria-label={t('wecom.panel.openSettings')} className="icon-button" onClick={onOpenSettings}
            title={t('wecom.panel.openSettings')} type="button">
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
            <button className="secondary-button" onClick={onOpenSettings} type="button">{t('wecom.panel.openSettings')}</button>
          )}
        </div>
      )}
      {ready && api && (
        <>
          <form className="wecom-panel__search" role="search"
            onSubmit={(event) => { event.preventDefault(); setSubmitted(query.trim()) }}>
            <input
              aria-label={t('wecom.panel.search')}
              maxLength={200}
              onChange={(event) => {
                setQuery(event.target.value)
                if (!event.target.value.trim()) setSubmitted('')
              }}
              placeholder={t('wecom.panel.searchPlaceholder')}
              type="search"
              value={query}
            />
            <button aria-label={t('wecom.panel.search')} className="icon-button" disabled={!query.trim()}
              title={t('wecom.panel.search')} type="submit">
              <Search aria-hidden="true" size={16} />
            </button>
          </form>
          <div className="wecom-panel__toolbar">
            <select
              aria-label={t('wecom.panel.space')}
              disabled={Boolean(submitted)}
              onChange={(event) => setView(event.target.value as WecomPanelView)}
              value={view}
            >
              {wecomPanelViews.map((option) => (
                <option key={option} value={option}>{t(`wecom.panel.views.${option}`)}</option>
              ))}
            </select>
            <button aria-label={t('wecom.panel.create')} className="icon-button" disabled={busy || !categories?.doc}
              onClick={() => setCreating(true)}
              title={categories?.doc ? t('wecom.panel.create') : t('wecom.panel.createOff')} type="button">
              <FilePlus aria-hidden="true" size={16} />
            </button>
            <button aria-label={t('wecom.panel.upload')} className="icon-button" disabled={busy || !categories?.disk}
              onClick={() => void act(() => api.uploadFile(), (doc) => t('wecom.panel.uploaded', { name: doc.name }))}
              title={categories?.disk ? t('wecom.panel.upload') : t('wecom.panel.uploadOff')} type="button">
              <Upload aria-hidden="true" size={16} />
            </button>
          </div>
          {creating && (
            <InlineTitleForm
              busy={busy}
              initial={t('wecom.panel.createDefault')}
              label={t('wecom.panel.createPrompt')}
              onCancel={() => setCreating(false)}
              onSubmit={(title) => {
                setCreating(false)
                void act(() => api.createDocument({ title }), (doc) => t('wecom.panel.created', { name: doc.name }))
              }}
            />
          )}
          <div aria-label={t('wecom.panel.typeFilter')} className="wecom-panel__chips" role="group">
            {typeFilters.map((option) => (
              <button aria-pressed={filter === option} className="wecom-panel__chip" key={option}
                onClick={() => setFilter(option)} type="button">
                {t(`wecom.panel.filters.${option}`)}
              </button>
            ))}
          </div>
          {notice && <p className="settings-notice" role="status">{notice}</p>}
          {loading && <p className="settings-empty" role="status">{t('wecom.panel.searching')}</p>}
          {!loading && result?.error && <p className="settings-warning" role="alert">{result.error}</p>}
          {!loading && !result?.error && (
            <>
              <small className="wecom-panel__count">{t('wecom.panel.count', { count: visible.length })}</small>
              {visible.length === 0
                ? <p className="settings-empty" role="status">{submitted ? t('wecom.panel.empty') : t('wecom.panel.emptyView')}</p>
                : (
                  <ul aria-label={t('wecom.panel.results')} className="wecom-panel__results">
                    {visible.map((doc) => (
                      <li className="wecom-panel__result" key={`${doc.source ?? 'doc'}:${doc.id}`}>
                        <strong>{doc.name}</strong>
                        <small>
                          {t(`wecom.panel.types.${knownTypes.has(doc.type) ? doc.type : 'other'}`)}
                          {doc.path ? ` · ${doc.path}` : ''}
                          {doc.modifiedAt ? ` · ${t('wecom.panel.updated', { time: doc.modifiedAt })}` : ''}
                        </small>
                        <div className="wecom-panel__actions">
                          {doc.url && (
                            <a className="secondary-button" href={doc.url} rel="noreferrer" target="_blank">
                              <ExternalLink aria-hidden="true" size={14} />
                              {t('wecom.panel.open')}
                            </a>
                          )}
                          {onUseInConversation && (
                            <button className="secondary-button" type="button"
                              onClick={() => onUseInConversation(t('wecom.panel.useText', { name: doc.name, url: doc.url ?? doc.id }))}>
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
        </>
      )}
    </section>
  )
}
