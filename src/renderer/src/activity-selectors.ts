import { useSyncExternalStore } from 'react'
import type { ActivityRecord, ActivityStore } from './activity-store'

/**
 * The records the Activity page shows: a snapshot refreshed on entry, by the
 * page timer and the refresh button, so streaming runs do not re-render it.
 */
export function useActivityPanelRecords(
  store: ActivityStore
): readonly ActivityRecord[] {
  return useSyncExternalStore(store.subscribePanel, store.getPanelRecords)
}
