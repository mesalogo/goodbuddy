import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'

describe('execution duration evidence', () => {
  let directory: string
  let database: AssistantDatabase
  let projectId: string
  let conversationId: string
  const epoch = Date.parse('2026-09-17T00:00:00Z')
  const at = (seconds: number): void => { vi.setSystemTime(epoch + seconds * 1000) }
  const request = (overrides: Partial<Parameters<AssistantDatabase['createTask']>[0]> = {}): string => {
    const id = randomUUID()
    database.createTask({ id, projectId, conversationId, title: 'Reply', instructions: 'Reply', workMode: 'ask', visible: false, ...overrides })
    return id
  }
  const text = (id: string): void => database.appendTaskEvent(id, 'text', { requestId: id, type: 'text', delta: 'Reply' })

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'goodbuddy-execution-stats-'))
    database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
    database.initialize(directory)
    projectId = database.listProjects()[0]!.id
    conversationId = randomUUID()
    vi.useFakeTimers({ toFake: ['Date'] })
    at(0)
  })
  afterEach(async () => {
    database.close()
    vi.useRealTimers()
    await rm(directory, { recursive: true, force: true })
  })

  it('sums hidden replies without round idle, counts approval/tool time, and scopes projects', () => {
    const first = request()
    text(first)
    at(2)
    database.updateTaskStatus(first, 'waiting_approval')
    at(8)
    database.updateTaskStatus(first, 'running')
    at(10)
    database.updateTaskStatus(first, 'completed')
    at(100)
    const second = request()
    text(second)
    at(105)
    database.updateTaskStatus(second, 'failed')
    const anotherConversation = request({ conversationId: randomUUID() })
    text(anotherConversation)
    at(108)
    database.updateTaskStatus(anotherConversation, 'cancelled')
    const unrelated = request({ projectId: undefined, conversationId: randomUUID() })
    text(unrelated)
    at(120)
    database.updateTaskStatus(unrelated, 'completed')
    expect(database.listTasks()).toEqual([])
    expect(database.getExecutionStats({ conversationId })).toEqual({
      durationMs: 15000, requestCount: 2, incompleteRequestCount: 0,
      activeRequestCount: 0, asOf: epoch + 120000, taskDurations: []
    })
    expect(database.getExecutionStats({ projectId })).toMatchObject({ durationMs: 18000, requestCount: 3 })
    expect(database.getExecutionStats({ conversationId: randomUUID() })).toMatchObject({ durationMs: 0, requestCount: 0 })
  })

  it('invalidates cached scopes for local messages, remote events and external deletion', () => {
    expect(database.getExecutionStats({ conversationId }).requestCount).toBe(0)
    database.saveLocalConversations([{
      header: { id: conversationId, projectId, title: 'History', updatedAt: epoch },
      messages: [{ id: randomUUID(), role: 'assistant', content: 'Retained', state: 'complete', createdAt: epoch }]
    }])
    expect(database.getExecutionStats({ conversationId }).requestCount).toBe(1)
    const id = request()
    database.getExecutionStats({ projectId })
    database.appendRemoteTaskEventOnce({ taskId: id, bindingId: randomUUID(), operationId: randomUUID(), semanticSequence: '1', eventIndex: 0, kind: 'done', payload: { requestId: id, type: 'done' } })
    expect(database.getExecutionStats({ projectId }).incompleteRequestCount).toBe(1)
    const raw = new DatabaseSync(join(directory, 'assistant.sqlite'))
    try {
      raw.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
      raw.prepare('DELETE FROM tasks WHERE id = ?').run(id)
      expect(database.getExecutionStats({ conversationId }).requestCount).toBe(0)
      expect(database.getExecutionStats({ projectId }).requestCount).toBe(0)
    } finally { raw.close() }
  })

  it('does not cache transaction snapshots across rollback, or serve a closed connection', () => {
    const connection = (database as unknown as { database: DatabaseSync }).database
    const id = request()
    expect(database.getExecutionStats({ conversationId }).requestCount).toBe(0)
    connection.exec('BEGIN')
    text(id)
    expect(database.getExecutionStats({ conversationId }).requestCount).toBe(1)
    connection.exec('ROLLBACK')
    expect(database.getExecutionStats({ conversationId }).requestCount).toBe(0)
    database.close()
    expect(() => database.getExecutionStats({ conversationId })).toThrow()
    database.initialize(directory)
    expect(database.getExecutionStats({ conversationId }).requestCount).toBe(0)
  })

  it('bounds cache scopes, expires idle entries and isolates returned objects', () => {
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const reads = (): number => prepare.mock.calls.filter(([sql]) => sql.includes('WITH scoped AS MATERIALIZED')).length
    try {
      const first = database.getExecutionStats({ projectId })
      first.requestCount = 999
      expect(database.getExecutionStats({ projectId }).requestCount).toBe(0)
      expect(reads()).toBe(1)
      for (let index = 0; index < 8; index++) database.getExecutionStats({ conversationId: randomUUID() })
      database.getExecutionStats({ projectId })
      expect(reads()).toBe(10)
      at(31)
      database.getExecutionStats({ projectId })
      expect(reads()).toBe(11)
    } finally { prepare.mockRestore() }
  })

  it('excludes stable schedules, nested experts, and status-only maintenance but includes scheduled reply requests', () => {
    const schedule = database.createSchedule({ projectId, title: 'Schedule', prompt: 'Reply', workMode: 'ask', recurrence: 'daily', nextRunAt: new Date(epoch).toISOString() })
    database.updateTaskStatus(schedule.taskId, 'running')
    text(schedule.taskId)
    const child = request({ origin: 'subagent', parentTaskId: schedule.taskId })
    text(child)
    const compact = request({ title: 'Compressed context' })
    const actual = request({ conversationId: schedule.conversationId, parentTaskId: schedule.taskId })
    text(actual)
    at(10)
    for (const id of [schedule.taskId, child, compact, actual]) database.updateTaskStatus(id, 'completed')
    expect(database.getExecutionStats({ projectId })).toMatchObject({ durationMs: 10000, requestCount: 1, incompleteRequestCount: 0 })
  })

  it('uses message request identity when a reply has no runtime events and does not use message timestamps', () => {
    const id = request()
    database.saveLocalConversations([{
      header: { id: conversationId, projectId, title: 'Chat', updatedAt: epoch },
      messages: [{ id: randomUUID(), role: 'assistant', content: '', state: 'error', createdAt: epoch - 86400000 }]
    }])
    // Only persisted request links are evidence; local snapshot saves do not supply them.
    const raw = new DatabaseSync(join(directory, 'assistant.sqlite'))
    raw.prepare('UPDATE messages SET request_id = ? WHERE conversation_id = ?').run(id, conversationId)
    raw.close()
    at(3)
    database.updateTaskStatus(id, 'failed')
    expect(database.getExecutionStats({ conversationId })).toMatchObject({ durationMs: 3000, requestCount: 1, incompleteRequestCount: 0 })
  })

  it('keeps only evidenced time for open and restart-interrupted replies', () => {
    const id = request()
    at(5)
    text(id)
    at(100)
    expect(database.getExecutionStats({ conversationId }, new Set([id]))).toMatchObject({ durationMs: 100000, requestCount: 1, incompleteRequestCount: 0, activeRequestCount: 1 })
    expect(database.getExecutionStats({ conversationId })).toMatchObject({ durationMs: 5000, incompleteRequestCount: 1, activeRequestCount: 0 })
    database.close()
    at(86400)
    database.initialize(directory)
    expect(database.getExecutionStats({ conversationId })).toMatchObject({ durationMs: 5000, requestCount: 1, incompleteRequestCount: 1, activeRequestCount: 0 })
    // A later resumed segment cannot include the shutdown/restart gap.
    at(86500)
    database.updateTaskStatus(id, 'running')
    at(86510)
    database.updateTaskStatus(id, 'completed')
    expect(database.getExecutionStats({ conversationId })).toMatchObject({ durationMs: 15000, incompleteRequestCount: 1 })
  })

  it('segments repeated runs and pauses without using the final completed_at span', () => {
    const id = request()
    text(id)
    at(5)
    database.updateTaskStatus(id, 'paused')
    at(100)
    database.updateTaskStatus(id, 'running')
    at(107)
    database.updateTaskStatus(id, 'completed')
    at(200)
    database.updateTaskStatus(id, 'running')
    at(203)
    database.updateTaskStatus(id, 'completed')
    expect(database.getExecutionStats({ conversationId })).toMatchObject({ durationMs: 15000, requestCount: 1, incompleteRequestCount: 0 })
  })

  it('does not substitute remote replay receipt time or unknown starts for actual execution time', () => {
    const remote = request()
    at(86400)
    database.appendRemoteTaskEventOnce({ taskId: remote, bindingId: randomUUID(), operationId: randomUUID(), semanticSequence: '1', eventIndex: 0, kind: 'done', payload: { requestId: remote, type: 'done' } })
    database.updateTaskStatus(remote, 'completed')
    const unknown = request()
    text(unknown)
    at(86410)
    database.updateTaskStatus(unknown, 'completed')
    const raw = new DatabaseSync(join(directory, 'assistant.sqlite'))
    raw.prepare('UPDATE tasks SET started_at = NULL WHERE id = ?').run(unknown)
    raw.close()
    expect(database.getExecutionStats({ conversationId })).toMatchObject({ durationMs: 0, requestCount: 2, incompleteRequestCount: 2 })
  })

  it('includes all retained requests beyond list pagination', () => {
    for (let index = 0; index < 105; index++) {
      at(index * 10)
      const id = request()
      text(id)
      at(index * 10 + 1)
      database.updateTaskStatus(id, 'completed')
    }
    expect(database.getExecutionStats({ projectId })).toMatchObject({ durationMs: 105000, requestCount: 105, incompleteRequestCount: 0 })
  })

  it('groups real schedule request IDs into stable cards across runs without parent lifecycle time', () => {
    const schedule = database.createSchedule({ projectId, title: 'Schedule', prompt: 'Reply', workMode: 'ask', recurrence: 'daily', nextRunAt: new Date(epoch).toISOString() })
    const idle = database.createSchedule({ projectId, conversationId: schedule.conversationId, title: 'Idle', prompt: 'Reply', workMode: 'ask', recurrence: 'daily', nextRunAt: new Date(epoch + 86400000).toISOString() })
    for (const start of [100, 1000]) {
      at(start)
      const queued = database.queueScheduleNow(schedule.id)
      database.claimConversationQueueItem(schedule.conversationId)
      database.completeConversationUserQueueItem(queued.id)
      // Production agentRun uses scheduleRunId as requestId, without parentTaskId.
      const id = queued.scheduleRunId!
      request({ id, conversationId: schedule.conversationId })
      database.updateTaskStatus(schedule.taskId, 'running')
      text(id)
      at(start + 10)
      database.updateTaskStatus(id, 'completed')
      database.completeTaskScheduleRun(id)
    }
    const live = database.queueScheduleNow(schedule.id)
    database.claimConversationQueueItem(schedule.conversationId)
    request({ id: live.scheduleRunId!, conversationId: schedule.conversationId })
    text(live.scheduleRunId!)
    at(1025)
    const stats = database.getExecutionStats({ projectId }, new Set([live.scheduleRunId!]))
    expect(stats).toMatchObject({ durationMs: 35000, requestCount: 3, incompleteRequestCount: 0, activeRequestCount: 1 })
    expect(stats.taskDurations).toEqual(expect.arrayContaining([
      { id: schedule.taskId, durationMs: 35000, incompleteRequestCount: 0 },
      { id: idle.taskId, durationMs: 0, incompleteRequestCount: 0 }
    ]))
    expect(stats.taskDurations.some(item => item.id === live.scheduleRunId)).toBe(false)
  })

  it.each([false, true])('retains schedule execution totals after plan deletion (repair old link: %s)', (oldLink) => {
    const schedule = database.createSchedule({ projectId, title: 'Removable plan', prompt: 'Reply', workMode: 'ask', recurrence: 'daily', nextRunAt: new Date(epoch).toISOString() })
    at(100)
    const run = database.queueScheduleNow(schedule.id)
    database.claimConversationQueueItem(schedule.conversationId)
    const task = database.createTask({ id: run.scheduleRunId!, projectId, conversationId: schedule.conversationId, title: 'Run', instructions: 'Reply', workMode: 'ask', visible: false })
    expect(task.parentTaskId).toBe(schedule.taskId)
    text(task.id)
    at(110)
    database.updateTaskStatus(task.id, 'completed')
    database.completeTaskScheduleRun(task.id)
    if (oldLink) {
      const raw = new DatabaseSync(join(directory, 'assistant.sqlite'))
      raw.prepare('UPDATE tasks SET parent_task_id = NULL WHERE id = ?').run(task.id)
      raw.close()
    }
    const before = database.getExecutionStats({ projectId })
    at(10000)
    database.removeSchedule(schedule.id)
    expect(database.getExecutionStats({ projectId })).toEqual({ ...before, asOf: epoch + 10000000 })
    expect(before.taskDurations).toEqual([{ id: schedule.taskId, durationMs: 10000, incompleteRequestCount: 0 }])
    database.close()
    database.initialize(directory)
    expect(database.getExecutionStats({ projectId }).taskDurations).toEqual(before.taskDurations)
  })

  it('does not claim a complete zero for an already removed plan with no retained execution relation', () => {
    const schedule = database.createSchedule({ projectId, title: 'Old removed plan', prompt: 'Reply', workMode: 'ask', recurrence: 'daily', nextRunAt: new Date(epoch).toISOString() })
    database.removeSchedule(schedule.id)
    expect(database.getExecutionStats({ projectId }).taskDurations).toEqual([{ id: schedule.taskId, durationMs: 0, incompleteRequestCount: 1 }])
  })

  it('recognizes runtime status-only replies but not maintenance statuses at restart', () => {
    const id = request()
    const maintenance = request({ title: 'Maintenance' })
    at(5)
    database.appendTaskEvent(id, 'status', { requestId: id, type: 'status', message: 'Processing request' })
    database.updateTaskStatus(maintenance, 'running')
    database.close()
    at(10000)
    database.initialize(directory)
    expect(database.getExecutionStats({ conversationId })).toMatchObject({ durationMs: 5000, requestCount: 1, incompleteRequestCount: 1 })
  })

  it('marks SSH channel timing unknown before the first remote provenance and keeps that result on replay', () => {
    const project = database.createSshProject({
      project: { name: 'SSH project', description: '', rootPath: '/srv/workspace', defaultWorkMode: 'execute', runtimeSelection: { provider: 'opencode' } },
      executionSpace: { kind: 'ssh', hostId: randomUUID(), remoteRootPath: '/srv/workspace' },
      assertCurrent: () => {}
    })
    const conversation = database.getOrCreateRemoteConversation({ projectId: project.id, channel: 'wecom', accountId: 'account', externalConversationId: 'external', conversationType: 'direct', title: 'SSH channel', accountDisplay: 'Account' })
    const id = request({ projectId: project.id, conversationId: conversation.id, origin: 'delegation' })
    at(5)
    database.appendTaskEvent(id, 'status', { requestId: id, type: 'status', message: 'Remote Agent is processing' })
    const expected = { durationMs: 0, requestCount: 1, incompleteRequestCount: 1, activeRequestCount: 1 }
    expect(database.getExecutionStats({ projectId: project.id }, new Set([id]))).toMatchObject(expected)
    at(100)
    database.appendRemoteTaskEventOnce({ taskId: id, bindingId: randomUUID(), operationId: randomUUID(), semanticSequence: '1', eventIndex: 0, kind: 'text', payload: { requestId: id, type: 'text', delta: 'Reply' } })
    expect(database.getExecutionStats({ projectId: project.id }, new Set([id]))).toMatchObject(expected)
    database.updateTaskStatus(id, 'completed')
    expect(database.getExecutionStats({ conversationId: conversation.id })).toMatchObject({ ...expected, activeRequestCount: 0 })
  })

  it('marks retained assistant replies without request history incomplete and ignores nested subagent content', () => {
    const known = request()
    text(known)
    at(2)
    database.updateTaskStatus(known, 'completed')
    const child = request({ origin: 'subagent', parentTaskId: known })
    text(child)
    database.updateTaskStatus(child, 'completed')
    const childMessage = randomUUID()
    database.saveLocalConversations([{
      header: { id: conversationId, projectId, title: 'Retained', updatedAt: epoch },
      messages: [
        { id: randomUUID(), role: 'assistant', content: 'Known reply', state: 'complete', createdAt: epoch, subagents: [] },
        { id: randomUUID(), role: 'assistant', content: 'Older reply without a task', state: 'complete', createdAt: epoch },
        { id: childMessage, role: 'assistant', content: 'Child reply', state: 'complete', createdAt: epoch }
      ]
    }])
    const raw = new DatabaseSync(join(directory, 'assistant.sqlite'))
    raw.prepare('UPDATE messages SET request_id = ? WHERE id = ?').run(child, childMessage)
    raw.close()
    expect(database.getExecutionStats({ conversationId })).toMatchObject({ durationMs: 2000, requestCount: 2, incompleteRequestCount: 1 })
    expect(database.getExecutionStats({ projectId })).toMatchObject({ durationMs: 2000, requestCount: 2, incompleteRequestCount: 1 })
  })

  it('flags missing schedule execution once even when its assistant message is retained', () => {
    const schedule = database.createSchedule({ projectId, title: 'Lost run', prompt: 'Reply', workMode: 'ask', recurrence: 'daily', nextRunAt: new Date(epoch).toISOString() })
    const queued = database.queueScheduleNow(schedule.id)
    database.claimConversationQueueItem(schedule.conversationId)
    database.completeScheduleRun(queued.scheduleRunId!, 'completed')
    database.saveLocalConversations([{
      header: { id: schedule.conversationId, projectId, title: 'Lost run', updatedAt: epoch },
      messages: [{ id: randomUUID(), role: 'assistant', content: 'Retained result', state: 'complete', createdAt: epoch, task: { id: schedule.taskId, title: 'Lost run' } }]
    }])
    expect(database.getExecutionStats({ projectId })).toMatchObject({
      durationMs: 0, requestCount: 1, incompleteRequestCount: 1,
      taskDurations: [{ id: schedule.taskId, durationMs: 0, incompleteRequestCount: 1 }]
    })
  })

  it('cannot make a remote or missing-start request complete just because it has a live lease', () => {
    const remote = request()
    database.appendRemoteTaskEventOnce({ taskId: remote, bindingId: randomUUID(), operationId: randomUUID(), semanticSequence: '1', eventIndex: 0, kind: 'text', payload: { requestId: remote, type: 'text', delta: 'Remote' } })
    const unknown = request()
    text(unknown)
    const raw = new DatabaseSync(join(directory, 'assistant.sqlite'))
    raw.prepare('UPDATE tasks SET started_at = NULL WHERE id = ?').run(unknown)
    raw.close()
    at(100)
    expect(database.getExecutionStats({ conversationId }, new Set([remote, unknown]))).toMatchObject({ durationMs: 0, incompleteRequestCount: 2, activeRequestCount: 2 })
  })

  it('counts confirmed live replies before their first event without counting maintenance leases', () => {
    const id = request()
    request({ title: 'Context compression' })
    at(10)
    expect(database.getExecutionStats({ conversationId }, new Set([id]))).toMatchObject({ durationMs: 10000, requestCount: 1, incompleteRequestCount: 0, activeRequestCount: 1 })
  })

  it('reports wholly missing reply history and task attribution without using message timestamps', () => {
    const schedule = database.createSchedule({ projectId, title: 'Old task', prompt: 'Reply', workMode: 'ask', recurrence: 'daily', nextRunAt: new Date(epoch).toISOString() })
    database.saveLocalConversations([{
      header: { id: schedule.conversationId, projectId, title: 'Old conversation', updatedAt: epoch },
      messages: [{ id: randomUUID(), role: 'assistant', content: 'Old reply', state: 'complete', createdAt: epoch - 100000, task: { id: schedule.taskId, title: 'Old task' } }]
    }])
    expect(database.getExecutionStats({ conversationId: schedule.conversationId })).toMatchObject({ durationMs: 0, requestCount: 1, incompleteRequestCount: 1 })
    expect(database.getExecutionStats({ projectId }).taskDurations).toEqual([{ id: schedule.taskId, durationMs: 0, incompleteRequestCount: 1 }])
  })

  it('does not let request coverage in another conversation conceal missing replies', () => {
    const id = request()
    text(id)
    at(1)
    database.updateTaskStatus(id, 'completed')
    database.saveLocalConversations([{
      header: { id: randomUUID(), projectId, title: 'Other conversation', updatedAt: epoch },
      messages: [{ id: randomUUID(), role: 'assistant', content: 'Missing history', state: 'complete', createdAt: epoch }]
    }])
    expect(database.getExecutionStats({ projectId })).toMatchObject({ durationMs: 1000, requestCount: 2, incompleteRequestCount: 1 })
  })

  it.each([
    ['zh-CN', '你好，我是 GoodBuddy。你可以直接向我提问、添加本地文件，或使用知识库整理和检索信息。需要我操作文件或调用工具时，请选择合适的 Agent Runtime 和工作模式。'],
    ['en-US', 'Hi, I’m GoodBuddy. Ask me a question, add local files, or use your knowledge base to organize and retrieve information. When you want me to operate on files or use tools, choose the appropriate Agent Runtime and work mode.']
  ])('excludes the persisted default greeting but retains unknown reply history (%s)', async (locale, greeting) => {
    expect(await readFile(join(process.cwd(), 'src/renderer/src/i18n/locales', locale, 'app.ts'), 'utf8')).toContain(greeting)
    const header = { id: conversationId, projectId, title: 'New conversation', updatedAt: epoch }
    const welcome = { id: randomUUID(), role: 'assistant' as const, content: greeting, state: 'complete' as const, createdAt: epoch }
    database.saveLocalConversations([{ header, messages: [welcome] }])
    expect(database.getExecutionStats({ conversationId })).toMatchObject({ durationMs: 0, requestCount: 0, incompleteRequestCount: 0 })
    database.saveLocalConversations([{ header, messages: [welcome,
      { id: randomUUID(), role: 'user', content: 'Question', state: 'complete', createdAt: epoch + 1 },
      { id: randomUUID(), role: 'assistant', content: greeting, state: 'complete', createdAt: epoch + 2 }
    ] }])
    expect(database.getExecutionStats({ projectId })).toMatchObject({ durationMs: 0, requestCount: 1, incompleteRequestCount: 1 })
  })

  it('seeks interruption boundaries without parsing large tool/delta payloads on repeated scope queries', () => {
    const id = request()
    const raw = new DatabaseSync(join(directory, 'assistant.sqlite'))
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    try {
      const insert = raw.prepare('INSERT INTO task_events (task_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)')
      const payload = JSON.stringify({ requestId: id, output: 'x'.repeat(32768) })
      raw.exec('BEGIN')
      for (let index = 0; index < 3000; index++) {
        insert.run(id, index % 2 ? 'text' : 'tool', payload, new Date(epoch + 5000).toISOString())
      }
      raw.exec('COMMIT')
      at(100)
      database.updateTaskStatus(id, 'interrupted')
      const baseline = raw.prepare("SELECT SUM(length(json_extract(payload_json, '$.requestId'))) FROM task_events WHERE task_id = ?")
      const baselineStart = performance.now()
      baseline.get(id)
      baseline.get(id)
      const baselineMs = performance.now() - baselineStart
      // One visible-panel tick reads both scopes; repeat to exercise warm polling.
      const start = performance.now()
      for (let iteration = 0; iteration < 5; iteration++) {
        expect(database.getExecutionStats({ conversationId })).toMatchObject({ durationMs: 5000, requestCount: 1, incompleteRequestCount: 1 })
        expect(database.getExecutionStats({ projectId })).toMatchObject({ durationMs: 5000, requestCount: 1, incompleteRequestCount: 1 })
      }
      const pairMs = (performance.now() - start) / 5
      const query = prepare.mock.calls.find(([sql]) => sql.includes('WITH scoped AS MATERIALIZED'))![0]
      const plan = raw.prepare(`EXPLAIN QUERY PLAN ${query}`).all(projectId).map(row => row.detail as string)
      for (const alias of ['proof', 'remote', 'tail', 'previous', 'e']) {
        expect(plan.some(detail => detail.includes(`SEARCH ${alias} USING INDEX task_events_task_idx`))).toBe(true)
      }
      // Malformed bodies make accidental JSON extraction fail deterministically.
      raw.prepare("UPDATE task_events SET payload_json = '{unparsed' WHERE task_id = ? AND kind IN ('text', 'tool')").run(id)
      expect(database.getExecutionStats({ conversationId })).toMatchObject({ durationMs: 5000, requestCount: 1, incompleteRequestCount: 1 })
      console.info(`execution stats: 3000 events, ${Math.round(payload.length * 3000 / 1024 / 1024)} MiB payload; old JSON extraction pair ${baselineMs.toFixed(1)} ms; scalar scope pair ${pairMs.toFixed(1)} ms`)
    } finally {
      prepare.mockRestore()
      raw.close()
    }
  })
})
