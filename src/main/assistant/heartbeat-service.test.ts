import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { HeartbeatService, type HeartbeatActions } from './heartbeat-service'
import { asyncSupervisionStorage } from '../../../tests/support/async-supervision-storage'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createDatabase(): Promise<AssistantDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-heartbeat-'))
  temporaryDirectories.push(directory)
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize('C:\\Workspace')
  return database
}

const now = new Date('2026-08-01T12:00:00.000Z')

function configInput(projectId?: string) {
  return {
    scope: projectId ? ({ kind: 'projects', projectIds: [projectId] } as const) : ({ kind: 'global' } as const),
    name: 'Daily reflection',
    timezone: 'UTC',
    recurrence: { type: 'daily' as const, localTime: '18:00' },
    enabled: true,
    lookbackHours: 24,
    retentionDays: 30
  }
}

describe('HeartbeatService', () => {
  it('triggers the shared review without reading sources or writing a report', async () => {
    const database = await createDatabase()
    const review = vi.fn<HeartbeatActions['review']>(async () => ({ status: 'completed', runId: 'supervision-1' }))
    const suggest = vi.fn<NonNullable<HeartbeatActions['suggest']>>(async () => 2)
    const service = new HeartbeatService(asyncSupervisionStorage(database).heartbeat, { review, suggest })
    const config = await service.create(configInput(), now)
    expect(config.intervention).toBe('suggest')

    const run = await service.runNow({ id: config.id, idempotencyKey: 'first' }, now)

    expect(review).toHaveBeenCalledOnce()
    expect(review.mock.calls[0]![0]).toMatchObject({ config: { id: config.id }, run: { id: run.id } })
    expect(suggest).toHaveBeenCalledWith(expect.objectContaining({ supervisionRunId: 'supervision-1' }))
    expect(run).toMatchObject({ status: 'completed', entryId: undefined })
    expect((await service.history({ configId: config.id })).entries).toEqual([])
    expect(database.listArtifacts()).toEqual([])
    database.close()
  })

  it('stays quiet when the review finds no change', async () => {
    const database = await createDatabase()
    const suggest = vi.fn(async () => 1)
    const service = new HeartbeatService(asyncSupervisionStorage(database).heartbeat, { review: async () => ({ status: 'no_change', runId: 'r' }), suggest })
    const config = await service.create(configInput(), now)
    const run = await service.runNow({ id: config.id, idempotencyKey: 'quiet' }, now)
    expect(run.status).toBe('no_change')
    expect(suggest).not.toHaveBeenCalled()
    expect(database.getHeartbeatConfig(config.id).lastStatus).toBe('no_change')
    database.close()
  })

  it('only updates memory when the plan intervention is memory', async () => {
    const database = await createDatabase()
    const suggest = vi.fn(async () => 1)
    const service = new HeartbeatService(asyncSupervisionStorage(database).heartbeat, { review: async () => ({ status: 'completed', runId: 'r' }), suggest })
    const config = await service.create({ ...configInput(), intervention: 'memory' }, now)
    expect(config.intervention).toBe('memory')
    await service.runNow({ id: config.id, idempotencyKey: 'memory' }, now)
    expect(suggest).not.toHaveBeenCalled()
    database.close()
  })

  it('keeps the review when suggestions fail and exposes the failure in activity', async () => {
    const database = await createDatabase()
    const service = new HeartbeatService(asyncSupervisionStorage(database).heartbeat, {
      review: async () => ({ status: 'completed', runId: 'r' }),
      suggest: async () => { throw new Error('Phrase failed') }
    })
    const config = await service.create(configInput(), now)
    const run = await service.runNow({ id: config.id, idempotencyKey: 'suggest-fail' }, now)
    expect(run.status).toBe('completed')
    const [activity] = database.listSupervisionActivity(10, 0, config.id)
    expect(activity).toMatchObject({ status: 'completed', suggestionStatus: 'failed', suggestionError: 'Phrase failed' })
    database.close()
  })

  it('reports a failed review in activity without retrying the trigger', async () => {
    const database = await createDatabase()
    const review = vi.fn(async () => { throw new Error('Model timed out') })
    const service = new HeartbeatService(asyncSupervisionStorage(database).heartbeat, { review })
    const config = await service.create(configInput(), now)
    const run = await service.runNow({ id: config.id, idempotencyKey: 'review-fail' }, now)
    expect(run.status).toBe('completed')
    const [activity] = database.listSupervisionActivity(10, 0, config.id)
    expect(activity).toMatchObject({ status: 'failed', error: 'Model timed out' })
    const duplicate = await service.runNow({ id: config.id, idempotencyKey: 'review-fail' }, now)
    expect(duplicate.id).toBe(run.id)
    expect(review).toHaveBeenCalledOnce()
    database.close()
  })

  it('claims at most one due plan per tick', async () => {
    const database = await createDatabase()
    const review = vi.fn(async () => ({ status: 'no_change' as const }))
    const service = new HeartbeatService(asyncSupervisionStorage(database).heartbeat, { review })
    const first = await service.create(configInput(), now)
    await service.create({ ...configInput(), name: 'Second' }, now)
    const due = new Date(first.nextRunAt)
    expect(await service.processDue(due)).toHaveLength(1)
    expect(await service.processDue(due)).toHaveLength(1)
    expect(await service.processDue(due)).toHaveLength(0)
    expect(review).toHaveBeenCalledTimes(2)
    database.close()
  })

  it('validates inputs and supports update, pause, list, and remove', async () => {
    const database = await createDatabase()
    const service = new HeartbeatService(asyncSupervisionStorage(database).heartbeat, { review: async () => ({ status: 'no_change' }) })
    await expect(service.create({ ...configInput(), unknown: true }, now)).rejects.toThrow()
    await expect(service.create({ ...configInput(), intervention: 'interrupt' }, now)).rejects.toThrow()
    const config = await service.create(configInput(), now)
    const updated = await service.update({ id: config.id, config: {
      ...configInput(), name: 'Weekly review', intervention: 'memory',
      recurrence: { type: 'weekly', weekday: 1, localTime: '09:00' }
    } }, now)
    expect(updated).toMatchObject({ name: 'Weekly review', intervention: 'memory', nextRunAt: '2026-08-03T09:00:00.000Z' })
    // Editing without the field keeps the saved intervention.
    expect((await service.update({ id: config.id, config: configInput() }, now)).intervention).toBe('memory')
    await service.pause({ id: config.id, paused: true })
    expect(await service.list()).toEqual([expect.objectContaining({ id: config.id, enabled: false })])
    await expect(service.history({ configId: config.id, limit: 201 })).rejects.toThrow()
    await service.remove({ id: config.id })
    expect(await service.list()).toEqual([])
    database.close()
  })
})
