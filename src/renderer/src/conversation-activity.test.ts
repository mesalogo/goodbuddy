import { describe, expect, it } from 'vitest'
import { deriveConversationActivity } from './conversation-activity'

const projects = [{ id: 'local', name: 'Local' }, { id: 'remote', name: 'Remote' }]

describe('deriveConversationActivity', () => {
  it('counts each conversation once with question and approval ahead of task fallback', () => {
    const conversations = [
      { id: 'question', title: 'Question', projectId: 'remote', messages: [
        { state: 'streaming', approval: {} }, { pendingQuestions: [{}, {}] }
      ] },
      { id: 'approval', title: 'Approval', projectId: 'local', messages: [{ approval: {} }] },
      { id: 'fallback', title: 'Fallback', projectId: 'remote', messages: [{ state: 'streaming' }] }
    ]
    const tasks = conversations.flatMap((conversation) => [
      { conversationId: conversation.id, title: 'Task', status: 'running' },
      { conversationId: conversation.id, title: 'Task', status: 'waiting_approval' }
    ])
    const summary = deriveConversationActivity(
      conversations, tasks, new Set(conversations.map(({ id }) => id)), projects, 'Unknown'
    )
    expect(summary.activities.map(({ status }) => status)).toEqual(['question', 'approval', 'attention'])
    expect(summary).toMatchObject({
      running: 0, attention: 3,
      byProjectId: { remote: { running: 0, attention: 2 }, local: { running: 0, attention: 1 } }
    })
    expect(deriveConversationActivity(conversations, [...tasks].reverse(), new Set(), projects, 'Unknown'))
      .toEqual(summary)
  })

  it('includes background active IDs, streams, and tasks with unloaded conversation metadata', () => {
    const summary = deriveConversationActivity([
      { id: 'active', title: 'Active', projectId: 'local', messages: [] },
      { id: 'stream', title: 'Stream', projectId: 'remote', messages: [{ state: 'streaming' }] },
      { id: 'known', title: 'Conversation title', messages: [] }
    ], [
      { conversationId: 'unloaded', projectId: 'remote', title: 'Task title', status: 'running' },
      { conversationId: 'unloaded', projectId: 'remote', title: 'Task title', status: 'waiting_approval' },
      { conversationId: 'known', projectId: 'local', title: 'Wrong title', status: 'running' },
      { conversationId: 'missing-project', projectId: 'deleted', title: 'Missing project', status: 'running' }
    ], new Set(['active', 'no-metadata']), projects, 'Unknown')
    expect(summary).toMatchObject({
      running: 4, attention: 1,
      byProjectId: {
        local: { running: 1, attention: 0 },
        remote: { running: 1, attention: 1 },
        deleted: { running: 1, attention: 0 }
      }
    })
    expect(summary.activities).toContainEqual({
      conversationId: 'unloaded', projectId: 'remote', title: 'Task title', projectName: 'Remote', status: 'attention'
    })
    expect(summary.activities).toContainEqual({
      conversationId: 'known', projectId: undefined, title: 'Conversation title', projectName: 'Unknown', status: 'running'
    })
  })

  it('excludes idle, queued and terminal work and tasks without conversation IDs', () => {
    const summary = deriveConversationActivity([
      { id: 'idle', title: 'Idle', messages: [{ state: 'complete', approval: null, pendingQuestions: [] }] }
    ], [
      ...['queued', 'completed', 'failed', 'interrupted', 'cancelled', 'paused'].map((status) => ({
        conversationId: status, title: status, status
      })),
      { title: 'No conversation', status: 'running' }
    ], new Set(), projects, 'Unknown')
    expect(summary).toEqual({ activities: [], byProjectId: {}, running: 0, attention: 0 })
  })
})
