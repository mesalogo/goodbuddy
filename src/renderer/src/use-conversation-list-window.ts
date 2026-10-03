import {
  defaultEstimatedRowHeight,
  defaultListWindowThreshold,
  defaultMaxRenderedRows,
  listWindowOverscan,
  listWindowRange,
  useListWindow,
  type ListWindowSegment,
} from './use-list-window'

/**
 * Windowing for the sidebar conversation list (PERF-14), on the shared
 * list-window hook. The list scrolls itself, is top-anchored, and returns to
 * the top when the project or search changes. Rows that hold user state
 * (focus, open menu, rename, the active conversation) stay mounted at their
 * real position even when scrolled away.
 */

/** Lists shorter than this render every row (no windowing). */
export const conversationListWindowThreshold = defaultListWindowThreshold
/** Height assumed for rows before any row has been measured. */
export const estimatedConversationRowHeight = defaultEstimatedRowHeight
/** Upper bound for rows mounted from the range (kept rows come on top). */
export const maxRenderedConversationRows = defaultMaxRenderedRows

export const conversationListOverscan = listWindowOverscan
export const conversationWindowRange = listWindowRange
export type ConversationListSegment = ListWindowSegment

export function useConversationListWindow({
  ids,
  scope,
  scrollRef,
  keepIds,
  enabled,
}: {
  /** Row ids in display order. */
  ids: readonly string[]
  /** Changing the scope (project, search) returns the list to the top. */
  scope: string
  scrollRef: React.RefObject<HTMLElement | null>
  /** Ids that must stay mounted (active, menu open, renaming...). */
  keepIds: readonly (string | undefined)[]
  enabled: boolean
}) {
  return useListWindow({
    ids,
    scope,
    scrollRef,
    keepIds,
    enabled,
    rowAttribute: 'data-conversation-window-row',
    resetScrollOnScopeChange: true,
  })
}
