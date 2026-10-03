import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { ActivityHistorySummary } from '../../shared/assistant-contracts'
import type { ActivityPageState, ActivityStore } from './activity-store'

export type ActivityPanelView = {
  page: ActivityPageState
  summary?: ActivityHistorySummary
}

/**
 * What the Activity page shows: the snapshot of the loaded pages (refreshed
 * on entry, by the page timer and the refresh button, so streaming runs do
 * not re-render it) and Main's summary. The same object while both are
 * unchanged.
 */
export function useActivityPanel(store: ActivityStore): ActivityPanelView {
  const cache = useRef<ActivityPanelView | undefined>(undefined)
  const getSnapshot = useCallback((): ActivityPanelView => {
    const page = store.getPanel()
    const summary = store.getSummary()
    const cached = cache.current
    if (cached && cached.page === page && cached.summary === summary) return cached
    return (cache.current = { page, ...(summary ? { summary } : {}) })
  }, [store])
  return useSyncExternalStore(store.subscribePanel, getSnapshot)
}
