import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'

describe('persisted running-state duration', () => {
  let directory: string
  let path: string
  let database: AssistantDatabase
  let projectId: string
  let conversationId: string
  let now: number
  const raw = (): DatabaseSync => (database as unknown as { database: DatabaseSync }).database
  const stats = () => database.getExecutionStats({ conversationId })
  const task = (options: Partial<Parameters<AssistantDatabase['createTask']>[0]> = {}): string => {
    const id = options.id ?? randomUUID()
    database.createTask({ id, projectId, conversationId, title: 'Reply', instructions: 'Reply',
      workMode: 'ask', visible: false, ...options })
    return id
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'goodbuddy-timing-'))
    path = join(directory, 'assistant.sqlite')
    database = new AssistantDatabase(path)
    database.initialize(directory)
    projectId = database.listProjects()[0]!.id
    conversationId = randomUUID()
    now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    database.saveLocalConversations([{ header: { id: conversationId, projectId, title: 'Timing', updatedAt: now }, messages: [] }])
  })
  afterEach(async () => { database.close(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }) })

  it('accumulates only running segments across pause, approval, queue, resume and completion', () => {
    const id = task({ visible: true })
    database.startExecutionTiming(id)
    now += 2000
    database.updateTaskStatus(id, 'running')
    now += 1000
    database.updateTaskStatus(id, 'paused')
    now += 90_000
    expect(stats()).toMatchObject({ durationMs: 3000, runningCount: 0, incomplete: false })
    database.updateTaskStatus(id, 'running')
    now += 4000
    database.updateTaskStatus(id, 'waiting_approval')
    now += 60_000
    database.updateTaskStatus(id, 'queued')
    database.updateTaskStatus(id, 'running')
    now += 2000
    expect(stats()).toMatchObject({ durationMs: 9000, runningCount: 1 })
    database.updateTaskStatus(id, 'completed')
    database.endExecutionTiming(id)
    now += 60_000
    expect(stats()).toMatchObject({ durationMs: 9000, runningCount: 0 })
    expect(database.getExecutionStats({ projectId }).taskDurations).toEqual([
      { id, durationMs: 9000, runningCount: 0, incomplete: false }
    ])
  })

  it.each(['failed', 'cancelled', 'interrupted'] as const)('closes on %s and cannot resume after lease release', (status) => {
    const id = task()
    database.startExecutionTiming(id)
    now += 3000
    database.updateTaskStatus(id, status)
    database.endExecutionTiming(id)
    now += 30_000
    database.updateTaskStatus(id, 'running')
    expect(stats()).toMatchObject({ durationMs: 3000, runningCount: 0 })
  })

  it.each(['waiting_approval', 'paused', 'queued'] as const)('registers a new %s lease without opening a segment until running', (status) => {
    const id = task({ status })
    database.startExecutionTiming(id)
    now += 60_000
    expect(stats()).toMatchObject({ durationMs: 0, runningCount: 0 })
    database.updateTaskStatus(id, 'running')
    now += 3000
    database.endExecutionTiming(id)
    expect(stats()).toMatchObject({ durationMs: 3000, runningCount: 0 })
  })

  it('stops immediately on lease abort even if task cleanup is delayed', () => {
    const id = task()
    database.startExecutionTiming(id)
    now += 5000
    database.endExecutionTiming(id)
    now += 60_000
    database.updateTaskStatus(id, 'running')
    database.updateTaskStatus(id, 'cancelled')
    expect(stats()).toMatchObject({ durationMs: 5000, runningCount: 0 })
  })

  it('does not write or read history on snapshots, tokens, or repeated running notifications', async () => {
    const id = task()
    database.startExecutionTiming(id)
    await Promise.resolve()
    const changed = vi.fn()
    const unsubscribe = database.onExecutionStatsChanged(changed)
    const before = raw().prepare('SELECT total_changes() AS n').get()!.n
    const prepare = vi.spyOn(raw(), 'prepare')
    for (let tick = 0; tick < 10; tick++) { now += 1000; stats(); database.getExecutionStats({ projectId }) }
    expect(raw().prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
    expect(prepare.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/\b(messages|task_events|tools)\b/)
    database.appendTaskEvent(id, 'text', { requestId: id, type: 'text', delta: 'Token' })
    database.updateTaskStatus(id, 'running')
    await Promise.resolve()
    expect(changed).not.toHaveBeenCalled()
    database.updateTaskStatus(id, 'paused')
    await Promise.resolve()
    expect(changed).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('retains closed intervals and marks the open interval unknown after restart', () => {
    const id = task()
    database.startExecutionTiming(id)
    now += 2000
    database.updateTaskStatus(id, 'paused')
    database.updateTaskStatus(id, 'running')
    now += 5000
    database.close()
    now += 86_400_000
    database.initialize(directory)
    expect(stats()).toMatchObject({ durationMs: 2000, runningCount: 0, incomplete: true })
    database.startExecutionTiming(id)
    database.updateTaskStatus(id, 'running')
    now += 3000
    database.endExecutionTiming(id)
    expect(stats()).toMatchObject({ durationMs: 5000, runningCount: 0, incomplete: true })
  })

  it('excludes maintenance and nested tasks and sums concurrent replies across conversations', () => {
    const maintenance = task()
    const child = task({ origin: 'subagent' })
    database.startExecutionTiming(child)
    const first = task()
    database.startExecutionTiming(first)
    const otherConversation = randomUUID()
    const second = task({ conversationId: otherConversation })
    database.startExecutionTiming(second)
    now += 3000
    database.updateTaskStatus(maintenance, 'completed')
    database.updateTaskStatus(child, 'completed')
    expect(stats()).toMatchObject({ durationMs: 3000, runningCount: 1 })
    expect(database.getExecutionStats({ projectId })).toMatchObject({ durationMs: 6000, runningCount: 2 })
  })

  it.each(['running', 'waiting_approval'] as const)('recovers remote %s timing without counting known waiting or changing terminal checkpoints', (status) => {
    const project = database.createSshProject({
      project: { name: 'Remote', description: '', rootPath: '/srv/project', defaultWorkMode: 'execute' },
      executionSpace: { kind: 'ssh', hostId: randomUUID(), remoteRootPath: '/srv/project' }, assertCurrent: () => {}
    })
    const remoteConversationId = randomUUID()
    database.saveLocalConversations([{ header: { id: remoteConversationId, projectId: project.id, title: 'Remote', updatedAt: now }, messages: [] }])
    const assistantMessageId = randomUUID()
    const id = task({ projectId: project.id, conversationId: remoteConversationId, remoteRecovery: {
      recoverable: true, currentUserMessageId: randomUUID(), currentAssistantMessageId: assistantMessageId
    } })
    database.startExecutionTiming(id)
    now += 2000
    database.updateTaskStatus(id, 'paused')
    database.updateTaskStatus(id, status)
    database.close()
    now += 86_400_000
    database.initialize(directory)
    database.startExecutionTiming(id)
    if (status === 'waiting_approval') {
      now += 60_000
      expect(database.getTask(id).status).toBe('waiting_approval')
      expect(database.getExecutionStats({ conversationId: remoteConversationId })).toMatchObject({
        durationMs: 2000, runningCount: 0, incomplete: false
      })
      database.startExecutionTiming(id)
      now += 60_000
      expect(database.getExecutionStats({ conversationId: remoteConversationId }).durationMs).toBe(2000)
      database.updateTaskStatus(id, 'running')
    }
    now += 3000
    const bindingId = randomUUID()
    const operationId = randomUUID()
    const append = (eventIndex: number, type: 'done' | 'remote-semantic-checkpoint') => database.appendRemoteConversationTaskEventOnce({
      taskId: id, conversationId: remoteConversationId, assistantMessageId,
      bindingId, operationId, semanticSequence: '1', eventIndex, event: { type, requestId: id }
    })
    expect(append(0, 'done')).toBe(true)
    expect(database.getExecutionStats({ conversationId: remoteConversationId })).toMatchObject({
      durationMs: 5000, runningCount: 1, incomplete: status === 'running'
    })
    expect(append(1, 'remote-semantic-checkpoint')).toBe(true)
    now += 60_000
    expect(append(0, 'done')).toBe(false)
    expect(append(1, 'remote-semantic-checkpoint')).toBe(false)
    expect(database.getTask(id).status).toBe('completed')
    expect(database.getExecutionStats({ conversationId: remoteConversationId })).toMatchObject({
      durationMs: 5000, runningCount: 0, incomplete: status === 'running'
    })
  })

  it('aggregates repeated schedule runs under the stable card without timing the parent', () => {
    const schedule = database.createSchedule({ projectId, conversationId, title: 'Scheduled', prompt: 'Run',
      workMode: 'ask', recurrence: 'once', nextRunAt: new Date(now + 60_000).toISOString() })
    database.startExecutionTiming(schedule.taskId)
    for (let i = 0; i < 2; i++) {
      const item = database.queueScheduleNow(schedule.id)
      database.claimConversationQueueItem(conversationId, item.id)
      task({ id: item.scheduleRunId!, parentTaskId: schedule.taskId })
      database.startExecutionTiming(item.scheduleRunId!)
      now += 3000
      database.updateTaskStatus(item.scheduleRunId!, 'completed')
      database.endExecutionTiming(item.scheduleRunId!)
      database.completeTaskScheduleRun(item.scheduleRunId!)
    }
    expect(database.getExecutionStats({ projectId }).taskDurations).toEqual([
      { id: schedule.taskId, durationMs: 6000, runningCount: 0, incomplete: false }
    ])
  })

  it('marks migrated history incomplete without reconstructing messages and adds the covering index', () => {
    const id = task({ visible: true })
    database.updateTaskStatus(id, 'completed')
    database.close()
    const old = new DatabaseSync(path)
    old.exec(`DROP TABLE execution_timing;
      DROP INDEX conversations_timing_incomplete;
      ALTER TABLE conversations DROP COLUMN timing_incomplete;
      DROP INDEX messages_summary_idx;
      PRAGMA user_version = 58;`)
    old.close()
    database.initialize(directory)
    expect(stats()).toMatchObject({ durationMs: 0, runningCount: 0, incomplete: true })
    expect(database.getExecutionStats({ projectId }).taskDurations).toEqual([
      { id, durationMs: 0, runningCount: 0, incomplete: true }
    ])
    expect(raw().prepare('PRAGMA index_info(messages_summary_idx)').all().map(row => row.name))
      .toEqual(['conversation_id', 'sequence', 'role', 'created_at'])
    expect(raw().prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  })

  it('deletes timing with its conversation and notifies snapshot subscribers', async () => {
    const id = task()
    database.startExecutionTiming(id)
    now += 3000
    database.updateTaskStatus(id, 'completed')
    database.endExecutionTiming(id)
    await Promise.resolve()
    const changed = vi.fn()
    database.onExecutionStatsChanged(changed)
    database.deleteLocalConversation(conversationId)
    await Promise.resolve()
    expect(changed).toHaveBeenCalledOnce()
    expect(database.getExecutionStats({ projectId })).toMatchObject({ durationMs: 0, runningCount: 0 })
    expect(raw().prepare('SELECT count(*) AS n FROM execution_timing').get()!.n).toBe(0)
  })
})
