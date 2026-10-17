import { ArrowLeft, ExternalLink, FilePlus, MessageSquarePlus, Search, Settings, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { feishuCategoryUsable, type FeishuBrowseInput, type FeishuBrowseItem } from '../../shared/feishu-contracts'
import { InlineTitleForm } from './InlineTitleForm'
import { useFeishuSnapshot } from './feishu-snapshot'
import './wecom.css'

type Location = FeishuBrowseInput['location']
type Crumb = { location: Location; name: string }

/** Type chips. Spaces and folders always stay visible so the tree remains walkable. */
const typeFilters = ['all', 'doc', 'wiki', 'bitable', 'file'] as const
type TypeFilter = (typeof typeFilters)[number]

function matchesType(item: FeishuBrowseItem, filter: TypeFilter): boolean {
  if (filter === 'all' || item.kind === 'space' || item.kind === 'folder') return true
  if (filter === 'wiki') return item.kind === 'node'
  if (filter === 'bitable') return item.type === 'bitable'
  if (filter === 'doc') return item.type === 'docx' || item.type === 'doc'
  return item.kind === 'file' && !['docx', 'doc', 'bitable', 'sheet'].includes(item.type ?? '')
}

const DRIVE_ROOT = '__drive__'

/**
 * Right workbar panel: knowledge spaces and drive folders shared with the
 * Feishu app. The space dropdown jumps to one space (or the app's drive), a
 * breadcrumb walks into it, and a title search covers everything visible.
 */
export function FeishuWorkbarPanel({
  onUseInConversation,
  onOpenSettings
}: {
  onUseInConversation?: (text: string) => void
  onOpenSettings?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const { snapshot, error: loadError } = useFeishuSnapshot()
  const ready = Boolean(snapshot?.credentialsConfigured && snapshot.appEnabled)
  const [path, setPath] = useState<Crumb[]>([{ location: { kind: 'root' }, name: '' }])
  const [spaces, setSpaces] = useState<FeishuBrowseItem[]>([])
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [filter, setFilter] = useState<TypeFilter>('all')
  const [result, setResult] = useState<{ key: string; items: FeishuBrowseItem[]; hint?: string; error?: string }>()
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [creating, setCreating] = useState(false)
  const current = path.at(-1)!
  const key = `${submitted ? `q:${submitted}` : JSON.stringify(current.location)}:${reload}`
  const categories = snapshot?.settings.categories

  useEffect(() => {
    const api = window.goodbuddy?.feishu
    if (!ready || !api) return
    let active = true
    const request = submitted
      ? api.searchDocuments({ query: submitted }).then((items) => ({ items }))
      : api.browse({ location: current.location })
    void request.then(
      (next) => {
        if (!active) return
        setResult({ key, ...next })
        if (!submitted && current.location.kind === 'root') setSpaces(next.items.filter((item) => item.kind === 'space'))
      },
      (reason: unknown) => { if (active) setResult({ key, items: [], error: reason instanceof Error ? reason.message : String(reason) }) }
    )
    return () => { active = false }
  }, [current.location, key, ready, submitted])

  const loading = ready && result?.key !== key
  const atRoot = current.location.kind === 'root'
  const items = useMemo(() => {
    const listed = result?.key === key ? result.items : []
    // At the top level the dropdown already lists the spaces; show the drive root files here.
    const own = atRoot && !submitted ? listed.filter((item) => item.kind !== 'space') : listed
    return own.filter((item) => matchesType(item, filter))
  }, [atRoot, filter, key, result, submitted])
  const selectedSpace = path[1]?.location.kind === 'space' ? path[1].location.token : atRoot ? '' : DRIVE_ROOT

  const enter = (item: FeishuBrowseItem): void => {
    const child = item.child!
    const location: Location = child.kind === 'node'
      ? { kind: 'node', spaceId: child.spaceId ?? '', token: child.token }
      : { kind: child.kind, token: child.token }
    setPath([...path, { location, name: item.name }])
  }
  const act = async (operation: () => Promise<FeishuBrowseItem | undefined>, done: (item: FeishuBrowseItem) => string): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      const item = await operation()
      if (item) {
        setNotice(done(item))
        setReload((value) => value + 1)
      }
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : t('feishu.actionError'))
    } finally {
      setBusy(false)
    }
  }
  // New pages go into the current wiki space or node; new documents into the current folder or drive root.
  const inWiki = current.location.kind === 'space' || current.location.kind === 'node'
  const canCreate = Boolean(categories && (inWiki
    ? categories.wiki && feishuCategoryUsable('wiki', categories)
    : categories.doc))
  const canUpload = Boolean(categories?.drive) && !inWiki
  const api = window.goodbuddy?.feishu

  return (
    <section aria-label={t('feishu.panel.title')} className="wecom-panel">
      <header className="wecom-panel__header">
        <div>
          <strong>{t('feishu.panel.title')}</strong>
          <small>{snapshot?.appId ? t('feishu.panel.identityApp', { appId: snapshot.appId }) : t('feishu.panel.identity')}</small>
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
      {ready && api && (
        <>
          <form className="wecom-panel__search" role="search"
            onSubmit={(event) => { event.preventDefault(); setSubmitted(query.trim()) }}>
            <input
              aria-label={t('feishu.panel.search')}
              maxLength={200}
              onChange={(event) => {
                setQuery(event.target.value)
                if (!event.target.value.trim()) setSubmitted('')
              }}
              placeholder={t('feishu.panel.searchPlaceholder')}
              type="search"
              value={query}
            />
            <button aria-label={t('feishu.panel.search')} className="icon-button" disabled={!query.trim()}
              title={t('feishu.panel.search')} type="submit">
              <Search aria-hidden="true" size={16} />
            </button>
          </form>
          <div className="wecom-panel__toolbar">
            <select
              aria-label={t('feishu.panel.space')}
              disabled={Boolean(submitted)}
              onChange={(event) => {
                const value = event.target.value
                const space = spaces.find((item) => item.token === value)
                setPath(space
                  ? [path[0]!, { location: { kind: 'space', token: space.token }, name: space.name }]
                  : [path[0]!])
              }}
              value={selectedSpace === DRIVE_ROOT ? '' : selectedSpace}
            >
              <option value="">{t('feishu.panel.root')}</option>
              {spaces.map((space) => <option key={space.token} value={space.token}>{space.name}</option>)}
            </select>
            <button aria-label={t('feishu.panel.create')} className="icon-button" disabled={busy || !canCreate || Boolean(submitted)}
              onClick={() => setCreating(true)}
              title={canCreate ? t(inWiki ? 'feishu.panel.createPage' : 'feishu.panel.create') : t('feishu.panel.createOff')} type="button">
              <FilePlus aria-hidden="true" size={16} />
            </button>
            <button aria-label={t('feishu.panel.upload')} className="icon-button" disabled={busy || !canUpload || Boolean(submitted)}
              onClick={() => void act(
                () => api.uploadFile(current.location.kind === 'folder' ? { folderToken: current.location.token } : {}),
                (item) => t('feishu.panel.uploaded', { name: item.name }))}
              title={canUpload ? t('feishu.panel.upload') : t('feishu.panel.uploadOff')} type="button">
              <Upload aria-hidden="true" size={16} />
            </button>
          </div>
          {creating && (
            <InlineTitleForm
              busy={busy}
              initial={t('feishu.panel.createDefault')}
              label={t('feishu.panel.createPrompt')}
              onCancel={() => setCreating(false)}
              onSubmit={(title) => {
                setCreating(false)
                const location = current.location
                void act(() => api.createDocument({ title, location }), (item) => t('feishu.panel.created', { name: item.name }))
              }}
            />
          )}
          <div aria-label={t('feishu.panel.typeFilter')} className="wecom-panel__chips" role="group">
            {typeFilters.map((option) => (
              <button aria-pressed={filter === option} className="wecom-panel__chip" key={option}
                onClick={() => setFilter(option)} type="button">
                {t(`feishu.panel.filters.${option}`)}
              </button>
            ))}
          </div>
          {!submitted && (
            <nav aria-label={t('feishu.panel.location')} className="feishu-panel__path">
              {path.length > 1 && (
                <button aria-label={t('feishu.panel.back')} className="icon-button" onClick={() => setPath(path.slice(0, -1))}
                  title={t('feishu.panel.back')} type="button">
                  <ArrowLeft aria-hidden="true" size={16} />
                </button>
              )}
              <span>{path.map((entry) => entry.name || t('feishu.panel.drive')).join(' / ')}</span>
            </nav>
          )}
          {notice && <p className="settings-notice" role="status">{notice}</p>}
          {loading && <p className="settings-empty" role="status">{t('feishu.loading')}</p>}
          {!loading && result?.error && <p className="settings-warning" role="alert">{result.error}</p>}
          {!loading && result?.hint && <p className="settings-notice" style={{ whiteSpace: 'pre-line' }}>{result.hint}</p>}
          {!loading && result && !result.error && (
            <>
              <small className="wecom-panel__count">{t('feishu.panel.count', { count: items.length })}</small>
              {items.length === 0 && !result.hint && (
                <p className="settings-empty">{submitted ? t('feishu.panel.noMatch') : t('feishu.panel.empty')}</p>
              )}
              {items.length > 0 && (
                <ul aria-label={t('feishu.panel.title')} className="wecom-panel__results">
                  {items.map((item) => (
                    <li className="wecom-panel__result" key={`${item.kind}:${item.token}`}>
                      {item.child && !submitted ? (
                        <button className="feishu-panel__open" onClick={() => enter(item)} type="button">
                          <strong>{item.name}</strong>
                        </button>
                      ) : <strong>{item.name}</strong>}
                      <small>
                        {t(`feishu.panel.kinds.${item.kind}`)}{item.type ? ` · ${item.type}` : ''}
                        {item.path ? ` · ${item.path}` : ''}
                        {item.modifiedAt ? ` · ${t('feishu.panel.updated', { time: new Date(item.modifiedAt).toLocaleString() })}` : ''}
                      </small>
                      {item.kind !== 'space' && item.kind !== 'folder' && (item.url || onUseInConversation) && (
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
        </>
      )}
    </section>
  )
}
