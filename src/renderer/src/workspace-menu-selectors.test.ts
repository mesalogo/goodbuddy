import { describe, expect, it } from 'vitest'
import { deriveConversationActivity } from './conversation-activity'
import { sameWorkspaceConversations, workspaceConversationRows, type WorkspaceConversation } from './workspace-menu-selectors'

const conversations: WorkspaceConversation[] = Array.from({ length: 15 }, (_, index) => ({
  id: `c${index}`, title: `Conversation ${index}`, projectId: index === 14 ? 'other' : 'project', time: 100 - index, channel: false
}))

describe('workspace conversation summaries', () => {
  it('uses real attention priority, adds ten non-active recent rows, and does not cap completed', () => {
    const activities = deriveConversationActivity(conversations.map((row, index) => ({
      ...row, messages: index === 0 ? [{ pendingQuestions: [{}], state: 'streaming' }] : []
    })), [{ conversationId: 'c0', title: 'task', status: 'running' }], new Set(['c0', 'c1']), [], '', new Set(conversations.slice(2).map((row) => row.id)))
    const rows = workspaceConversationRows(conversations, activities.activities, 'project', 'all')
    expect(rows.map((row) => row.id)).toEqual(conversations.slice(0, 12).map((row) => row.id))
    expect(rows[0]).toMatchObject({ status: 'question', group: 'attention' })
    expect(workspaceConversationRows(conversations, activities.activities, null, 'attention').map((row) => row.id)).toEqual(['c0'])
    expect(workspaceConversationRows(conversations, activities.activities, null, 'running').map((row) => row.id)).toEqual(['c1'])
    expect(workspaceConversationRows(conversations, activities.activities, null, 'completed')).toHaveLength(13)
  })

  it('keeps viewed completions in recent history after the reminder is acknowledged', () => {
    const activity = { conversationId: 'c0', projectId: 'project', projectName: 'Project', title: 'Conversation 0', status: 'completed' as const }
    const before = workspaceConversationRows(conversations, [activity], 'project', 'all')
    const after = workspaceConversationRows(conversations, [], 'project', 'all')
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id))
    expect(after[0]?.status).toBeUndefined()
    expect(workspaceConversationRows(conversations, [], 'project', 'completed')).toEqual([])
  })

  it('includes task-only activity for exact-ID navigation without requiring hydration', () => {
    const rows = workspaceConversationRows([], [{ conversationId: 'missing', projectId: 'project', projectName: 'Project', title: 'Background job', status: 'approval' }], 'project', 'all')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'missing', group: 'attention', status: 'approval' })
  })

  it('retains equal metadata and notices scope, title and ordering changes', () => {
    expect(sameWorkspaceConversations(conversations, conversations.map((row) => ({ ...row })))).toBe(true)
    for (const change of [{ title: 'Changed' }, { time: 101 }, { projectId: 'other' }, { channel: true }]) {
      expect(sameWorkspaceConversations(conversations, conversations.map((row, index) => index ? row : { ...row, ...change }))).toBe(false)
    }
  })
})
