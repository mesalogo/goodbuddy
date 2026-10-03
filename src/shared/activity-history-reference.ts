import type {
  ActivityHistoryChange,
  ActivityRecord
} from './assistant-contracts'

/**
 * Reference semantics of `activityHistory.update` on a plain newest-first
 * list (see `activityHistoryChangeSchema`), for tests and test doubles.
 */
export function applyActivityChanges(
  list: readonly ActivityRecord[],
  changes: readonly ActivityHistoryChange[]
): ActivityRecord[] {
  let next = [...list]
  for (const change of changes) {
    if (change.type === 'remove') {
      next = next.filter((item) => item.id !== change.id)
      continue
    }
    if (change.type === 'remove-duplicates') {
      const seen = new Set<string>()
      next = next.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)))
      continue
    }
    const index = next.findIndex((item) => item.id === change.record.id)
    if (index < 0) next = [change.record, ...next]
    else if (change.position === 'front') {
      next = [change.record, ...next.filter((_, at) => at !== index)]
    } else next = next.map((item, at) => (at === index ? change.record : item))
  }
  return next
}
