import { useCallback } from 'react'
import { conversationActivityTime, getConversationDisplayTitle, type Conversation } from './chat-conversation'
import { useConversationStoreSelector, type ConversationStore } from './conversation-store'
import type { ConversationActivity } from './conversation-activity'
import { sameArrayItems } from './stable-derived-value'
import { formatConversationListTime, type TimeFormatLocale } from './time-format'
import { formatMediumDateTime } from './locale-formatters'

export function useWorkspaceConversationTime(store: ConversationStore, id: string, locale: TimeFormatLocale) {
  const selector = useCallback(() => {
    const conversation = store.getConversation(id)
    if (!conversation) return undefined
    return {
      dateTime: new Date(conversation.updatedAt).toISOString(),
      label: formatConversationListTime(conversation.updatedAt, locale),
      title: formatMediumDateTime(conversation.updatedAt, locale)
    }
  }, [store, id, locale])
  const subscribe = useCallback((listener: () => void) => store.subscribeConversation(id, listener), [store, id])
  // Streaming changes below the displayed precision do not need a React commit.
  return useConversationStoreSelector(store, selector,
    (a, b) => a?.label === b?.label && a?.title === b?.title, subscribe)
}

export type WorkspaceConversation = {
  id: string
  projectId?: string
  title: string
  time: number
  channel: boolean
}
export type WorkspaceFilter = 'all' | 'attention' | 'running' | 'completed'
export type WorkspaceConversationRow = WorkspaceConversation & {
  status?: ConversationActivity['status']
  group: 'attention' | 'running' | 'recent' | 'completed'
}

export function useWorkspaceConversations(store: ConversationStore, defaultTitle: string, activityTimes: ReadonlyMap<string, number>): WorkspaceConversation[] {
  const selector = useCallback((conversations: Conversation[]) => conversations.map((conversation) => ({
    id: conversation.id,
    projectId: conversation.projectId,
    title: getConversationDisplayTitle(conversation, defaultTitle),
    time: Math.max(conversationActivityTime(conversation), activityTimes.get(conversation.id) ?? 0),
    channel: Boolean(conversation.remote)
  })), [defaultTitle, activityTimes])
  return useConversationStoreSelector(store, selector, sameWorkspaceConversations)
}

export function sameWorkspaceConversations(a: WorkspaceConversation[], b: WorkspaceConversation[]): boolean {
  return sameArrayItems(a, b, (left, right) => left.id === right.id && left.projectId === right.projectId &&
    left.title === right.title && left.time === right.time && left.channel === right.channel)
}

export function workspaceConversationRows(
  conversations: readonly WorkspaceConversation[],
  activities: readonly ConversationActivity[],
  scope: string | null,
  filter: WorkspaceFilter,
  activityTimes?: ReadonlyMap<string, number>
): WorkspaceConversationRow[] {
  const activityById = new Map(activities.map((activity) => [activity.conversationId, activity]))
  const rows = new Map<string, WorkspaceConversationRow>()
  for (const conversation of conversations) {
    if (scope !== null && conversation.projectId !== scope) continue
    const status = activityById.get(conversation.id)?.status
    const group = status === 'running' ? 'running' : status && status !== 'completed' ? 'attention' : 'recent'
    rows.set(conversation.id, { ...conversation, status, group })
  }
  // Task activity can arrive before its conversation summary. Navigation already
  // hydrates that exact ID; preview never needs to fetch the conversation.
  for (const activity of activities) {
    if (rows.has(activity.conversationId) || (scope !== null && activity.projectId !== scope)) continue
    rows.set(activity.conversationId, {
      id: activity.conversationId, projectId: activity.projectId, title: activity.title,
      time: activityTimes?.get(activity.conversationId) ?? 0, channel: false, status: activity.status,
      group: activity.status === 'running' ? 'running' : activity.status === 'completed' ? 'recent' : 'attention'
    })
  }
  const ordered = [...rows.values()].sort((a, b) => b.time - a.time || a.id.localeCompare(b.id))
  if (filter === 'completed') return ordered.filter((row) => row.status === 'completed').map((row) => ({ ...row, group: 'completed' }))
  if (filter !== 'all') return ordered.filter((row) => row.group === filter)
  return [
    ...ordered.filter((row) => row.group === 'attention'),
    ...ordered.filter((row) => row.group === 'running'),
    ...ordered.filter((row) => row.group === 'recent').slice(0, 10)
  ]
}
