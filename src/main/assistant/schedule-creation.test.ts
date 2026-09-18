import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AssistantDatabase } from './assistant-database'

const input = {
  title: 'Immediate task',
  prompt: 'Run exactly once',
  recurrence: 'once' as const,
  nextRunAt: '2020-01-01T00:00:00.000Z',
  runImmediately: true
}

describe('immediate schedule creation', () => {
  it('commits one real queue occurrence and never rematerializes it on scheduler ticks', () => {
    const database = new AssistantDatabase(':memory:')
    database.initialize(process.cwd())
    try {
      const schedule = database.createSchedule(input)
      expect(schedule.enabled).toBe(false)
      expect(schedule).not.toHaveProperty('runImmediately')
      const [item] = database.listConversationQueueItems(schedule.conversationId)
      expect(item).toMatchObject({ scheduleId: schedule.id, taskId: schedule.taskId })
      expect(database.listTasks().find(task => task.id === schedule.taskId)?.status).toBe('queued')
      expect(database.queueDueSchedules(new Date('2099-01-01T00:00:00Z'))).toEqual([])
      const claimed = database.claimConversationQueueItem(schedule.conversationId)
      expect(claimed).toMatchObject({ source: 'schedule', runId: item!.id })
      expect(database.claimConversationQueueItem(schedule.conversationId)).toBeUndefined()
      database.completeScheduleRun(item!.id, 'completed')
      expect(database.listTasks().find(task => task.id === schedule.taskId)?.status).toBe('completed')
      expect(database.listSchedules()[0]).toMatchObject({ enabled: false, lastRunAt: expect.any(String) })
      expect(database.queueDueSchedules(new Date('2099-01-01T00:00:00Z'))).toEqual([])
      expect(database.listConversationQueueItems()).toEqual([])
    } finally {
      database.close()
    }
  })

  it('rolls back conversation, task and schedule when queue insertion fails, so retry creates only one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-schedule-create-'))
    const path = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(path)
    database.initialize(process.cwd())
    const sql = new DatabaseSync(path)
    try {
      sql.exec(`CREATE TRIGGER reject_queue BEFORE INSERT ON conversation_queue_items
        BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END;`)
      expect(() => database.createSchedule(input)).toThrow('queue unavailable')
      expect(database.listSchedules()).toEqual([])
      expect(database.listTasks()).toEqual([])
      expect(database.listConversations()).toEqual([])
      expect(sql.prepare('SELECT COUNT(*) AS count FROM schedule_runs').get()?.count).toBe(0)
      sql.exec('DROP TRIGGER reject_queue')
      database.createSchedule(input)
      expect(database.listSchedules()).toHaveLength(1)
      expect(database.listTasks()).toHaveLength(1)
      expect(database.listConversations()).toHaveLength(1)
      expect(database.listConversationQueueItems()).toHaveLength(1)
    } finally {
      sql.close()
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('consumes the immediate trigger even when cancelled and requires an explicit new run', () => {
    const database = new AssistantDatabase(':memory:')
    database.initialize(process.cwd())
    try {
      const schedule = database.createSchedule(input)
      expect(schedule.lastRunAt).toBe(schedule.nextRunAt)
      const [item] = database.listConversationQueueItems(schedule.conversationId)
      database.cancelConversationQueueItem(item!.id)
      expect(database.listSchedules()[0]).toMatchObject({
        enabled: false, lastRunAt: schedule.lastRunAt
      })
      expect(database.getTask(schedule.taskId).status).toBe('cancelled')
      expect(() => database.setScheduleEnabled(schedule.id, true)).toThrow(
        '已执行的一次性计划不能恢复自动运行'
      )
      expect(database.getTask(schedule.taskId).status).toBe('cancelled')
      const tomorrow = new Date(Date.parse(schedule.nextRunAt) + 86_400_000)
      expect(database.queueDueSchedules(tomorrow)).toEqual([])

      const retry = database.queueScheduleNow(schedule.id)
      expect(retry.id).not.toBe(item!.id)
      expect(database.listSchedules()).toHaveLength(1)
      expect(database.listConversationQueueItems()).toHaveLength(1)
      expect(database.getTask(schedule.taskId).status).toBe('queued')
      expect(database.claimConversationQueueItem(schedule.conversationId)).toMatchObject({
        runId: retry.id
      })
      database.completeScheduleRun(retry.id, 'completed')
      expect(database.getTask(schedule.taskId).status).toBe('completed')
      expect(database.queueDueSchedules(tomorrow)).toEqual([])
    } finally {
      database.close()
    }
  })

  it.each(['once', 'daily', 'weekly'] as const)('preserves pause and manual-run cancellation for a future %s schedule', (recurrence) => {
    const database = new AssistantDatabase(':memory:')
    database.initialize(process.cwd())
    try {
      const nextRunAt = new Date(Date.now() + 86_400_000).toISOString()
      const schedule = database.createSchedule({
        ...input, runImmediately: false, recurrence, nextRunAt
      })
      database.setScheduleEnabled(schedule.id, false)
      const manual = database.queueScheduleNow(schedule.id)
      database.cancelConversationQueueItem(manual.id)
      expect(database.listSchedules()[0]).toMatchObject({
        enabled: false, lastRunAt: undefined, nextRunAt
      })
      expect(database.queueDueSchedules(new Date(nextRunAt))).toEqual([])
      database.setScheduleEnabled(schedule.id, true)
      expect(database.queueDueSchedules(new Date(nextRunAt))).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('keeps scheduled creation enabled and rejects recurring immediate requests', () => {
    const database = new AssistantDatabase(':memory:')
    database.initialize(process.cwd())
    try {
      expect(() => database.createSchedule({ ...input, recurrence: 'daily' })).toThrow('立即执行只支持单次任务')
      const schedule = database.createSchedule({ ...input, runImmediately: false })
      expect(schedule.enabled).toBe(true)
      expect(database.listConversationQueueItems()).toEqual([])
      expect(database.queueDueSchedules()).toHaveLength(1)
    } finally {
      database.close()
    }
  })
})
