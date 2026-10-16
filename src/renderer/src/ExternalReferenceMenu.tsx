import { FileText } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChannelIcon } from './ChannelIcon'
import {
  referenceKey,
  type ExternalDocumentReference,
  type ExternalReferenceProvider,
  type ExternalReferenceSources
} from './external-references'
import './external-references.css'

const SEARCH_DELAY_MS = 250
const providers: readonly ExternalReferenceProvider[] = ['feishu', 'wecom']
// Stable empties: a fresh object or array each render would loop through onItemsChange.
const noResults: Partial<Record<ExternalReferenceProvider, ProviderResult>> = {}
const noItems: readonly ExternalDocumentReference[] = []

type ProviderResult =
  | { state: 'loading' }
  | { state: 'done'; items: ExternalDocumentReference[] }
  | { state: 'failed'; message: string }

async function search(provider: ExternalReferenceProvider, query: string): Promise<ExternalDocumentReference[]> {
  if (provider === 'wecom') {
    const docs = await window.goodbuddy.wecom!.searchDocuments({ query })
    return docs.map((doc) => ({ provider, id: doc.id, title: doc.name, type: doc.type, ...(doc.url ? { url: doc.url } : {}) }))
  }
  const items = await window.goodbuddy.feishu!.searchDocuments({ query })
  return items.flatMap((item): ExternalDocumentReference[] => item.kind === 'node' || item.kind === 'file'
    ? [{ provider, id: item.token, title: item.name, kind: item.kind, ...(item.type ? { type: item.type } : {}), ...(item.url ? { url: item.url } : {}) }]
    : [])
}

/**
 * The `@` popup above the composer: searches each ready platform with the
 * typed text and lists unready ones with a way to fix them. Keyboard input
 * stays in the textarea; the parent forwards arrow keys through `activeIndex`.
 */
export function ExternalReferenceMenu({
  query,
  sources,
  selected,
  activeIndex,
  onActiveIndexChange,
  onItemsChange,
  onPick,
  onResolve
}: {
  query: string
  sources: ExternalReferenceSources
  selected: readonly ExternalDocumentReference[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onItemsChange: (items: readonly ExternalDocumentReference[]) => void
  onPick: (reference: ExternalDocumentReference) => void
  onResolve: (provider: ExternalReferenceProvider) => void
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const ready = useMemo(() => providers.filter((provider) => sources[provider]?.state === 'ready'), [sources])
  const term = query.trim()
  const [results, setResults] = useState<{ term: string; byProvider: Partial<Record<ExternalReferenceProvider, ProviderResult>> }>({ term: '', byProvider: {} })

  useEffect(() => {
    if (!term) return
    let active = true
    const timer = setTimeout(() => {
      setResults({ term, byProvider: Object.fromEntries(ready.map((provider) => [provider, { state: 'loading' }])) })
      for (const provider of ready) {
        void search(provider, term).then(
          (items) => { if (active) setResults((current) => current.term === term ? { term, byProvider: { ...current.byProvider, [provider]: { state: 'done', items } } } : current) },
          (reason: unknown) => {
            if (active) setResults((current) => current.term === term ? { term, byProvider: { ...current.byProvider, [provider]: { state: 'failed', message: reason instanceof Error ? reason.message : String(reason) } } } : current)
          }
        )
      }
    }, SEARCH_DELAY_MS)
    return () => { active = false; clearTimeout(timer) }
  }, [ready, term])

  const byProvider = results.term === term ? results.byProvider : noResults
  const selectedKeys = useMemo(() => new Set(selected.map(referenceKey)), [selected])
  // Visible items per platform, numbered in display order for keyboard focus.
  const { groups, items } = useMemo(() => {
    const visible: Partial<Record<ExternalReferenceProvider, { item: ExternalDocumentReference; index: number }[]>> = {}
    const flat: ExternalDocumentReference[] = []
    if (term) {
      for (const provider of ready) {
        const result = byProvider[provider]
        if (result?.state !== 'done') continue
        visible[provider] = result.items
          .filter((item) => !selectedKeys.has(referenceKey(item)))
          .map((item) => ({ item, index: flat.push(item) - 1 }))
      }
    }
    return { groups: visible, items: flat.length > 0 ? flat : noItems }
  }, [byProvider, ready, selectedKeys, term])
  useEffect(() => { onItemsChange(items) }, [items, onItemsChange])

  return (
    <div className="external-reference-menu" role="presentation" onMouseDown={(event) => event.preventDefault()}>
      <p className="external-reference-menu__hint">
        {term ? t('composer.references.searching', { query: term }) : t('composer.references.typeToSearch')}
      </p>
      <ul aria-label={t('composer.references.listLabel')} className="external-reference-menu__list" id="external-reference-menu" role="listbox">
        {providers.map((provider) => {
          const source = sources[provider]
          if (!source) return null
          const label = t(`composer.references.providers.${provider}`)
          const result = byProvider[provider]
          return (
            <li className="external-reference-menu__group" key={provider} role="presentation">
              <span className="external-reference-menu__group-label">
                <ChannelIcon channel={provider} size={14} />
                {label}
              </span>
              {source.state === 'unavailable' ? (
                <div className="external-reference-menu__unavailable">
                  <small>{source.reason}</small>
                  <button className="secondary-button" onClick={() => onResolve(provider)} type="button">
                    {t('composer.references.resolve')}
                  </button>
                </div>
              ) : !term ? null : !result || result.state === 'loading' ? (
                <small className="external-reference-menu__status" role="status">{t('composer.references.loading')}</small>
              ) : result.state === 'failed' ? (
                <small className="external-reference-menu__status" role="alert">{result.message}</small>
              ) : !groups[provider]?.length ? (
                <small className="external-reference-menu__status">
                  {t(provider === 'feishu' ? 'composer.references.emptyFeishu' : 'composer.references.empty')}
                </small>
              ) : (
                <ul className="external-reference-menu__items" role="group" aria-label={label}>
                  {groups[provider].map(({ item, index: itemIndex }) => {
                    return (
                      <li
                        aria-selected={itemIndex === activeIndex}
                        className="external-reference-menu__item"
                        id={`external-reference-option-${itemIndex}`}
                        key={referenceKey(item)}
                        onClick={() => onPick(item)}
                        onMouseEnter={() => onActiveIndexChange(itemIndex)}
                        role="option"
                      >
                        <FileText aria-hidden="true" size={14} />
                        <span>{item.title}</span>
                        {item.type && <small>{item.type}</small>}
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
