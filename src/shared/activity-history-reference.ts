import type {
  ActivityHistoryChange,
  ActivityHistoryPage,
  ActivityHistoryPageRequest,
  ActivityHistorySummary,
  ActivityRecord,
  AssistantTask
} from './assistant-contracts'

const isActive = (record: ActivityRecord): boolean =>
  record.status === 'pending' || record.status === 'running'
const isFailed = (record: ActivityRecord): boolean =>
  record.status === 'failed' || record.status === 'denied' ||
  record.status === 'cancelled' || record.status === 'interrupted'

/** The records a list shows: the first occurrence of each ID. */
export function firstOccurrences(list: readonly ActivityRecord[]): ActivityRecord[] {
  const seen = new Set<string>()
  return list.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)))
}

/**
 * Reference page over a plain newest-first list; a record's sequence is its
 * distance from the end of the list (newer = larger), like `order_seq`.
 */
export function referenceActivityPage(
  list: readonly ActivityRecord[],
  request: ActivityHistoryPageRequest
): ActivityHistoryPage {
  const seen = new Set<string>()
  const matching: Array<{ record: ActivityRecord; seq: number }> = []
  list.forEach((record, index) => {
    if (seen.has(record.id)) return
    seen.add(record.id)
    const seq = list.length - index
    if (request.before !== undefined && seq >= request.before) return
    if (request.filter === 'active' && !isActive(record)) return
    if (request.filter === 'failed' && !isFailed(record)) return
    if (request.projectId && (record.scope.kind !== 'project' || record.scope.projectId !== request.projectId)) return
    if (request.conversationId && record.conversationId !== request.conversationId) return
    matching.push({ record, seq })
  })
  const shown = matching.slice(0, request.limit)
  return {
    records: shown.map((item) => item.record),
    ...(matching.length > request.limit ? { nextBefore: shown.at(-1)!.seq } : {})
  }
}

/**
 * The former ActivityPanel computation over the whole list: counts, the
 * first request title and the conversation status.
 */
export function referenceActivitySummary(
  list: readonly ActivityRecord[],
  conversationIds: readonly string[],
  legacyHistoryMayBeIncomplete = false
): ActivityHistorySummary {
  const records = firstOccurrences(list)
  const latest = (candidates: readonly ActivityRecord[]): ActivityRecord | undefined =>
    candidates.reduce<ActivityRecord | undefined>(
      (best, record) => (!best || record.createdAt > best.createdAt ? record : best), undefined)
  const conversations: ActivityHistorySummary['conversations'] = {}
  for (const conversationId of conversationIds) {
    const own = records.filter((record) => record.conversationId === conversationId)
    const title = own.find((record) => record.kind === 'request')?.title
    const latestRequest = latest(own.filter((record) => record.kind === 'request'))
    const status = latestRequest
      ? (latest(own.filter((record) => record.kind === 'result' && record.requestId === latestRequest.requestId))
          ?.status ?? latestRequest.status)
      : (latest(own.filter((record) => record.kind === 'result'))?.status ?? latest(own)?.status ?? 'completed')
    conversations[conversationId] = { ...(title === undefined ? {} : { title }), status }
  }
  return {
    counts: {
      all: records.length,
      active: records.filter(isActive).length,
      failed: records.filter(isFailed).length
    },
    conversations,
    legacyHistoryMayBeIncomplete
  }
}

/** Reference of `reconcile` (the former renderer reconcileActivityRecords) on shown records. */
export function referenceActivityReconcile(
  list: readonly ActivityRecord[],
  tasks: readonly Pick<AssistantTask, 'id' | 'status'>[],
  activeRequestIds: ReadonlySet<string>,
  interruptedDetail: string
): ActivityRecord[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const seen = new Set<string>()
  return list.map((record) => {
    const first = !seen.has(record.id)
    seen.add(record.id)
    if (!first || activeRequestIds.has(record.requestId) || !isActive(record)) return record
    const task = tasksById.get(record.requestId)
    const terminal = !task
      ? 'interrupted'
      : task.status === 'completed' || task.status === 'failed' ||
          task.status === 'cancelled' || task.status === 'interrupted'
        ? task.status : undefined
    if (!terminal) return record
    return {
      ...record,
      status: terminal === 'completed' && (record.kind === 'tool' || record.kind === 'approval' ||
        record.kind === 'subagent') ? 'interrupted' : terminal,
      detail: terminal === 'interrupted' ? `${record.detail}\n${interruptedDetail}` : record.detail
    }
  })
}

/**
 * Reference semantics of `activityHistory.update` on a plain newest-first
 * list (see `activityHistoryChangeSchema`), for tests and test doubles.
 */
export function applyActivityChanges(
  list: readonly ActivityRecord[],
  changes: readonly ActivityHistoryChange[]
): ActivityRecord[] {
  let next = [...list]
  /** Indexes of shown records (first occurrences) that match. */
  const shown = (match: (record: ActivityRecord) => boolean): number[] => {
    const seen = new Set<string>()
    const indexes: number[] = []
    next.forEach((record, index) => {
      if (!seen.has(record.id) && match(record)) indexes.push(index)
      seen.add(record.id)
    })
    return indexes
  }
  const updateAt = (indexes: readonly number[], update: (record: ActivityRecord) => ActivityRecord): void => {
    const set = new Set(indexes)
    next = next.map((record, index) => (set.has(index) ? update(record) : record))
  }
  const removeIds = (ids: ReadonlySet<string>): void => {
    next = next.filter((record) => !ids.has(record.id))
  }
  for (const change of changes) {
    switch (change.type) {
      case 'remove':
        removeIds(new Set([change.id]))
        break
      case 'remove-duplicates':
        next = firstOccurrences(next)
        break
      case 'upsert': {
        const index = next.findIndex((item) => item.id === change.record.id)
        if (index < 0) next = [change.record, ...next]
        else if (change.position === 'front') next = [change.record, ...next.filter((_, at) => at !== index)]
        else next = next.map((item, at) => (at === index ? change.record : item))
        break
      }
      case 'upsert-call': {
        const incoming = change.record
        const [index] = shown((record) => record.kind === incoming.kind &&
          record.requestId === incoming.requestId && record.callId === incoming.callId)
        if (index === undefined) {
          next = [incoming, ...next]
          break
        }
        const existing = next[index]!
        const unchanged = existing.conversationId === incoming.conversationId && existing.title === incoming.title &&
          existing.detail === incoming.detail && existing.status === incoming.status
        if (unchanged && index === 0) break
        next = [
          unchanged ? existing : { ...incoming, id: existing.id, createdAt: existing.createdAt, scope: existing.scope },
          ...next.filter((_, at) => at !== index)
        ]
        break
      }
      case 'update-request':
        updateAt(shown((record) => record.requestId === change.requestId && record.kind === 'request'),
          (record) => ({ ...record, status: change.status, detail: change.detail ?? record.detail }))
        break
      case 'resolve-approval':
        updateAt(shown((record) => record.conversationId === change.conversationId &&
          record.kind === 'approval' && record.status === 'pending').slice(0, 1),
        (record) => ({ ...record, status: change.status, detail: `${record.detail}\n${change.detailLine}` }))
        break
      case 'settle-request':
        updateAt(shown((record) => record.requestId === change.requestId && record.kind !== 'request' &&
          isActive(record)),
        (record) => ({ ...record, status: change.status, detail: `${record.detail}\n${change.detailLine}` }))
        break
      case 'remove-request':
        removeIds(new Set(shown((record) => record.requestId === change.requestId).map((index) => next[index]!.id)))
        break
      case 'remove-call':
        removeIds(new Set(shown((record) => record.requestId === change.requestId && record.kind === 'tool' &&
          record.callId === change.callId).map((index) => next[index]!.id)))
        break
    }
  }
  return next
}