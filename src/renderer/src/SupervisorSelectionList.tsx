import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { SupervisionGraphView } from '../../shared/supervision-contracts'
import { useListWindow } from './use-list-window'

type Kind = 'event' | 'entity' | 'relation'

export function SupervisorSelectionList({ kind, events, entities, relations, entityMap, selectedId, onSelect, date, shortDate, entityTone, id, labelledBy }: {
  kind: Kind
  events: SupervisionGraphView['events']
  entities: SupervisionGraphView['entities']
  relations: SupervisionGraphView['relations']
  entityMap: Map<string, SupervisionGraphView['entities'][number]>
  selectedId?: string
  onSelect: (selection: { kind: Kind; id: string }) => void
  date: (value: string) => string
  shortDate: (value: string) => string
  entityTone: (id: string) => number
  id: string
  labelledBy: string
}) {
  const { t } = useTranslation('heartbeat')
  const ref = useRef<HTMLDivElement>(null)
  const [keyboardId, setKeyboardId] = useState<string>()
  const records = kind === 'event' ? events : kind === 'entity' ? entities : relations
  const ids = useMemo(() => records.map(record => record.id), [records])
  // Native Tab entry from either side must reach the logical endpoints, even when scrolled away.
  const list = useListWindow({ ids, scope: kind, scrollRef: ref, keepIds: [ids[0], ids.at(-1), selectedId, keyboardId], enabled: true, estimatedRowHeight: kind === 'event' ? 64 : 44 })
  const { onScroll } = list

  useLayoutEffect(() => {
    const panel = ref.current
    if (!panel || !selectedId) return
    const row = Array.from(panel.querySelectorAll<HTMLElement>('[data-list-window-row]')).find(item => item.dataset.listWindowRow === selectedId)
    if (!row) return
    const bounds = panel.getBoundingClientRect(), rect = row.getBoundingClientRect()
    if (rect.top < bounds.top) panel.scrollTop += rect.top - bounds.top
    else if (rect.bottom > bounds.bottom) panel.scrollTop += rect.bottom - bounds.bottom
    onScroll()
  }, [selectedId, onScroll])

  return <div ref={ref} className="supervisor-workspace__list-panel supervisor-workspace__selection-list"
    role="tabpanel" id={id} aria-labelledby={labelledBy} tabIndex={0}
    onScroll={list.onScroll} onFocus={list.onFocus} onBlur={list.onBlur}
    onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key) || !ids.length) return
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-list-window-row]')
      const index = row ? ids.indexOf(row.dataset.listWindowRow!) : -1
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
        : index + (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1)
      if (event.key === 'Tab' && (index < 0 || next < 0 || next >= ids.length)) return
      event.preventDefault()
      event.stopPropagation()
      const nextId = ids[Math.max(0, Math.min(ids.length - 1, next))]!
      // Materialize the logical next row before native focus, including across spacers.
      flushSync(() => setKeyboardId(nextId))
      const target = Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-list-window-row]') ?? []).find(item => item.dataset.listWindowRow === nextId)
      target?.querySelector('button')?.focus()
      target?.scrollIntoView?.({ block: 'nearest' })
      list.onScroll()
    }}>
    {!ids.length && <p className="supervisor-workspace__muted">{t('supervisor.listEmpty')}</p>}
    {list.segments.map(segment => {
      if (segment.kind === 'spacer') return <div key={segment.key} data-list-window-spacer aria-hidden="true" style={{ height: segment.height, flex: '0 0 auto' }} />
      const index = segment.index, rowId = ids[index]!
      const event = kind === 'event' ? events[index] : undefined
      const entity = kind === 'entity' ? entities[index] : undefined
      const relation = kind === 'relation' ? relations[index] : undefined
      return <div key={rowId} data-list-window-row={rowId} ref={list.rowRef(rowId)} className="supervisor-workspace__list-row">
        <button type="button" aria-pressed={selectedId === rowId}
          aria-label={event ? `${index + 1}. ${event.title} · ${date(event.occurred_at)}` : undefined}
          data-tone={entity ? entityTone(rowId) : undefined} onClick={() => onSelect({ kind, id: rowId })}>
          {event ? <><span className="supervisor-workspace__event-index">{index + 1}.</span>
            <span className="supervisor-workspace__list-copy">{event.title}<small title={date(event.occurred_at)}>{shortDate(event.occurred_at)}</small></span></>
            : entity ? <><i className="supervisor-workspace__entity-dot" aria-hidden="true" /><span className="supervisor-workspace__list-copy">{entity.canonical_label}</span></>
              : relation ? <>{entityMap.get(relation.from_entity_id)?.canonical_label} → {entityMap.get(relation.to_entity_id)?.canonical_label} · {t(`supervisor.relationTypes.${relation.relation_type}`, { defaultValue: relation.relation_type })}</> : null}
        </button>
      </div>
    })}
  </div>
}
