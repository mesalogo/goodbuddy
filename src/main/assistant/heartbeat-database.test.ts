import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantDatabase } from './assistant-database'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createDatabase(): Promise<{
  database: AssistantDatabase
  path: string
}> {
  const directory = await mkdtemp(
    join(tmpdir(), 'goodbuddy-heartbeat-db-')
  )
  temporaryDirectories.push(directory)
  const path = join(directory, 'assistant.sqlite')
  const database = new AssistantDatabase(path)
  database.initialize('C:\\Workspace')
  return { database, path }
}

const input = {
  name: 'Daily heartbeat',
  timezone: 'UTC',
  recurrence: { type: 'daily' as const, localTime: '18:00' },
  enabled: true,
  lookbackHours: 24,
  retentionDays: 7
}

const summary = {
  summary: 'A durable summary',
  highlights: ['A highlight'],
  proposedMemories: [
    {
      scope: 'global' as const,
      type: 'fact' as const,
      content: 'A proposed fact',
      confidence: 0.7,
      salience: 0.8
    }
  ],
  followUpTasks: [
    {
      title: 'A proposed follow-up',
      instructions: 'Review this task before starting it.'
    }
  ]
}

describe('AssistantDatabase heartbeat persistence', () => {
  it('migrates a v2 database without changing existing schedules', async () => {
    const { database, path } = await createDatabase()
    const schedule = database.createSchedule({
      title: 'Existing schedule',
      prompt: 'Keep this schedule',
      workMode: 'ask',
      recurrence: 'weekly',
      nextRunAt: '2026-08-03T09:00:00.000Z'
    })
    database.close()

    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 2')
    raw.close()

    const migrated = new AssistantDatabase(path)
    migrated.initialize('C:\\Workspace')
    expect(migrated.listSchedules()).toEqual([
      expect.objectContaining({
        id: schedule.id,
        title: 'Existing schedule',
        recurrence: 'weekly',
        nextRunAt: '2026-08-03T09:00:00.000Z'
      })
    ])
    const check = new DatabaseSync(path)
    const version = (
      check.prepare('PRAGMA user_version').get() as {
        user_version: number
      }
    ).user_version
    const heartbeatTableCount = (
      check
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'heartbeat_%'`
        )
        .get() as { count: number }
    ).count
    check.close()
    migrated.close()
    expect(version).toBe(18)
    expect(heartbeatTableCount).toBe(3)
  })

  it('claims one scheduled run durably and advances local recurrence', async () => {
    const { database } = await createDatabase()
    const config = database.createHeartbeatConfig(
      input,
      new Date('2026-08-01T12:00:00.000Z')
    )

    const claims = database.claimDueHeartbeats(
      'worker-1',
      new Date('2026-08-01T18:05:00.000Z')
    )
    expect(claims).toEqual([
      expect.objectContaining({
        acquired: true,
        run: expect.objectContaining({
          configId: config.id,
          trigger: 'scheduled',
          scheduledFor: '2026-08-01T18:00:00.000Z',
          status: 'claimed',
          attemptCount: 1
        })
      })
    ])
    expect(
      database.claimDueHeartbeats(
        'worker-2',
        new Date('2026-08-01T18:05:00.000Z')
      )
    ).toEqual([])
    expect(database.getHeartbeatConfig(config.id)).toMatchObject({
      nextRunAt: '2026-08-02T18:00:00.000Z',
      lastStatus: 'claimed'
    })
    database.close()
  })

  it('skips runs missed by over two hours without catch-up storms', async () => {
    const { database } = await createDatabase()
    const config = database.createHeartbeatConfig(
      input,
      new Date('2026-08-01T12:00:00.000Z')
    )

    expect(
      database.claimDueHeartbeats(
        'worker-1',
        new Date('2026-08-02T21:00:00.000Z')
      )
    ).toEqual([])
    expect(database.listHeartbeatRuns(config.id)).toEqual([
      expect.objectContaining({
        scheduledFor: '2026-08-01T18:00:00.000Z',
        status: 'skipped',
        attemptCount: 0,
        error: 'Missed by more than 2 hours'
      })
    ])
    expect(database.getHeartbeatConfig(config.id)).toMatchObject({
      nextRunAt: '2026-08-03T18:00:00.000Z',
      lastStatus: 'skipped'
    })
    expect(
      database.claimDueHeartbeats(
        'worker-1',
        new Date('2026-08-02T21:01:00.000Z')
      )
    ).toEqual([])
    database.close()
  })

  it('reclaims expired leases and stops after three attempts', async () => {
    const { database } = await createDatabase()
    database.createHeartbeatConfig(
      input,
      new Date('2026-08-01T12:00:00.000Z')
    )
    const [first] = database.claimDueHeartbeats(
      'worker-1',
      new Date('2026-08-01T18:00:00.000Z')
    )
    expect(first).toBeDefined()

    const [second] = database.claimDueHeartbeats(
      'worker-2',
      new Date('2026-08-01T18:06:00.000Z')
    )
    expect(second?.run).toMatchObject({
      id: first!.run.id,
      attemptCount: 2
    })
    const secondFailure = database.failHeartbeatRun(
      second!,
      'temporary failure',
      new Date('2026-08-01T18:06:00.000Z')
    )
    expect(secondFailure.nextAttemptAt).toBe(
      '2026-08-01T18:11:00.000Z'
    )

    const [third] = database.claimDueHeartbeats(
      'worker-3',
      new Date('2026-08-01T18:11:00.000Z')
    )
    expect(third?.run.attemptCount).toBe(3)
    const terminal = database.failHeartbeatRun(
      third!,
      'still failing',
      new Date('2026-08-01T18:11:00.000Z')
    )
    expect(terminal.nextAttemptAt).toBeUndefined()
    expect(
      database.claimDueHeartbeats(
        'worker-4',
        new Date('2026-08-01T19:00:00.000Z')
      )
    ).toEqual([])
    database.close()
  })

  it('deduplicates manual claims and persists completion atomically', async () => {
    const { database } = await createDatabase()
    const project = database.listProjects()[0]!
    const config = database.createHeartbeatConfig(
      { ...input, projectId: project.id },
      new Date('2026-08-01T12:00:00.000Z')
    )
    const claim = database.claimHeartbeatNow(
      config.id,
      'button-click-1',
      'worker-1',
      new Date('2026-08-01T12:30:00.000Z')
    )
    const duplicate = database.claimHeartbeatNow(
      config.id,
      'button-click-1',
      'worker-2',
      new Date('2026-08-01T12:31:00.000Z')
    )
    expect(duplicate).toMatchObject({
      acquired: false,
      run: { id: claim.run.id }
    })
    const concurrent = database.claimHeartbeatNow(
      config.id,
      'button-click-2',
      'worker-3',
      new Date('2026-08-01T12:31:30.000Z')
    )
    expect(concurrent).toMatchObject({
      acquired: false,
      run: { id: claim.run.id }
    })

    const completed = database.completeHeartbeatRun(
      claim,
      summary,
      new Date('2026-08-01T12:32:00.000Z')
    )
    expect(completed).toMatchObject({
      status: 'completed',
      entryId: expect.any(String)
    })
    const [entry] = database.listHeartbeatEntries(config.id)
    expect(entry).toMatchObject({
      runId: claim.run.id,
      proposedMemoryIds: [expect.any(String)],
      followUpTaskIds: [expect.any(String)]
    })
    expect(
      database
        .listMemories()
        .find((memory) => memory.id === entry!.proposedMemoryIds[0])
    ).toMatchObject({ status: 'proposed' })
    const followUpTaskId = entry!.followUpTaskIds[0]!
    database.resolveAssistantSuggestionTask(
      followUpTaskId,
      'completed'
    )
    expect(
      database
        .listTasks()
        .find((task) => task.id === followUpTaskId)
    ).toMatchObject({ status: 'completed' })
    expect(() =>
      database.resolveAssistantSuggestionTask(
        followUpTaskId,
        'cancelled'
      )
    ).toThrow('状态已变化')
    database.close()
  })

  it('rejects completion after lease expiry and prunes retained history', async () => {
    const { database } = await createDatabase()
    const config = database.createHeartbeatConfig(
      { ...input, retentionDays: 1 },
      new Date('2026-08-01T12:00:00.000Z')
    )
    const expired = database.claimHeartbeatNow(
      config.id,
      'expired',
      'worker-1',
      new Date('2026-08-01T12:00:00.000Z'),
      1_000
    )
    expect(() =>
      database.completeHeartbeatRun(
        expired,
        summary,
        new Date('2026-08-01T12:00:02.000Z')
      )
    ).toThrow('lease is no longer active')

    const active = database.claimHeartbeatNow(
      config.id,
      'complete',
      'worker-2',
      new Date('2026-08-01T13:00:00.000Z')
    )
    database.completeHeartbeatRun(
      active,
      summary,
      new Date('2026-08-01T13:01:00.000Z')
    )
    database.pruneHeartbeatHistory(
      config.id,
      new Date('2026-08-03T13:01:00.000Z')
    )
    expect(database.listHeartbeatEntries(config.id)).toEqual([])
    expect(
      database
        .listHeartbeatRuns(config.id)
        .filter((run) => run.status === 'completed')
    ).toEqual([])
    database.close()
  })
})
