import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVITY_STORAGE_KEY,
  clearLegacyActivityHistory,
  loadLegacyActivityHistory,
  mergeActivityRecords,
  reconcileActivityRecords,
  upsertActivityRecord,
  type ActivityRecord
} from './activity-store'
import { changeUiLocale } from './i18n'

function makeRecord(index: number): ActivityRecord {
  return {
    id: `activity-${index}`,
    conversationId: 'conversation-1',
    requestId: 'request-1',
    scope: { kind: 'global' },
    kind: 'tool',
    title: `工具调用 ${index}`,
    detail: '读取文件',
    status: 'completed',
    createdAt: index
  }
}

describe('activity-store', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns an empty history for inaccessible or corrupt storage', () => {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, '{invalid')
    expect(loadLegacyActivityHistory().records).toEqual([])

    const inaccessibleStorage = {
      getItem: () => {
        throw new Error('blocked')
      }
    } as unknown as Storage
    expect(loadLegacyActivityHistory(inaccessibleStorage).records).toEqual([])
  })

  it('keeps only schema-valid records from untrusted storage', () => {
    const validRecord = makeRecord(1)
    localStorage.setItem(
      ACTIVITY_STORAGE_KEY,
      JSON.stringify([
        validRecord,
        { ...validRecord, status: 'unknown' },
        null
      ])
    )

    expect(loadLegacyActivityHistory().records).toEqual([validRecord])
  })

  it('loads legacy records with an explicit unavailable scope', () => {
    const { scope, ...legacyRecord } = makeRecord(1)
    void scope
    localStorage.setItem(
      ACTIVITY_STORAGE_KEY,
      JSON.stringify([legacyRecord])
    )

    expect(loadLegacyActivityHistory().records).toEqual([
      expect.objectContaining({
        id: legacyRecord.id,
        scope: { kind: 'unavailable' }
      })
    ])
  })

  it('rejects malformed project snapshots from untrusted storage', () => {
    const record = makeRecord(1)
    localStorage.setItem(
      ACTIVITY_STORAGE_KEY,
      JSON.stringify([
        {
          ...record,
          scope: {
            kind: 'project',
            projectId: 'project-1',
            projectName: 'x'.repeat(121)
          }
        }
      ])
    )

    expect(loadLegacyActivityHistory().records).toEqual([])
  })

  it('loads more than the former record limit without shortening details', () => {
    const records = Array.from(
      { length: 501 },
      (_, index) => ({
        ...makeRecord(index),
        detail: index === 500 ? 'x'.repeat(4_001) : '读取文件'
      })
    )
    localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(records))

    const legacy = loadLegacyActivityHistory()
    expect(legacy.records).toHaveLength(501)
    expect(legacy.records.at(-1)?.detail).toHaveLength(4_001)
    expect(legacy.historyMayBeIncomplete).toBe(true)
  })

  it('marks a legacy maximum-length detail as possibly incomplete', () => {
    localStorage.setItem(
      ACTIVITY_STORAGE_KEY,
      JSON.stringify([{ ...makeRecord(1), detail: 'x'.repeat(4_000) }])
    )

    expect(loadLegacyActivityHistory()).toMatchObject({
      historyMayBeIncomplete: true
    })
  })

  it('clears the legacy migration source without throwing', () => {
    localStorage.setItem(
      ACTIVITY_STORAGE_KEY,
      JSON.stringify([makeRecord(1)])
    )
    clearLegacyActivityHistory()
    expect(localStorage.getItem(ACTIVITY_STORAGE_KEY)).toBeNull()

    expect(() =>
      clearLegacyActivityHistory({
        removeItem: () => {
          throw new Error('blocked')
        }
      } as unknown as Storage)
    ).not.toThrow()
  })

  it('upserts transitions for one call while preserving distinct calls', () => {
    const first = {
      ...makeRecord(1),
      callId: 'call-1',
      status: 'running' as const
    }
    const updated = upsertActivityRecord([first], {
      ...makeRecord(2),
      callId: 'call-1',
      status: 'failed'
    })
    const withSecondCall = upsertActivityRecord(updated, {
      ...makeRecord(3),
      callId: 'call-2',
      status: 'completed'
    })

    expect(withSecondCall).toHaveLength(2)
    expect(withSecondCall.find((record) => record.callId === 'call-1'))
      .toMatchObject({
        id: first.id,
        createdAt: first.createdAt,
        scope: first.scope,
        status: 'failed'
      })
  })

  it('keeps the original scope snapshot when a call is updated', () => {
    const first: ActivityRecord = {
      ...makeRecord(1),
      callId: 'call-1',
      scope: {
        kind: 'project',
        projectId: 'project-1',
        projectName: '原项目名称'
      },
      status: 'running'
    }

    expect(
      upsertActivityRecord([first], {
        ...first,
        scope: { kind: 'global' },
        status: 'completed'
      })[0]?.scope
    ).toEqual(first.scope)
  })

  it.each(['tool', 'subagent'] as const)(
    'reuses an unchanged leading %s record and readonly array',
    (kind) => {
      const first: ActivityRecord = {
        ...makeRecord(1),
        kind,
        callId: 'call-1'
      }
      const records: readonly ActivityRecord[] = Object.freeze([
        first,
        makeRecord(2)
      ])
      const updated = upsertActivityRecord(records, {
        ...first,
        id: 'replacement-id',
        createdAt: 99,
        scope: { kind: 'unavailable' }
      })

      expect(updated).toBe(records)
      expect(updated[0]).toBe(first)
    }
  )

  it('moves interleaved unchanged calls to the front without rebuilding records', () => {
    const first = { ...makeRecord(1), callId: 'call-1' }
    const second = { ...makeRecord(2), callId: 'call-2' }
    const third = { ...makeRecord(3), callId: 'call-3' }
    const records = Object.freeze([third, second, first])
    const updated = upsertActivityRecord(records, { ...first })
    expect(updated).not.toBe(records)
    expect(updated[0]).toBe(first)
    expect(updated[1]).toBe(third)
    expect(updated[2]).toBe(second)

    const interleaved = upsertActivityRecord(updated, { ...second })
    expect(interleaved[0]).toBe(second)
    expect(interleaved[1]).toBe(first)
    expect(interleaved[2]).toBe(third)
    expect(upsertActivityRecord(interleaved, { ...second })).toBe(interleaved)
    expect(records).toEqual([third, second, first])
  })

  it.each([
    { conversationId: 'conversation-2' },
    { title: 'Updated title' },
    { detail: 'Updated detail' },
    { status: 'failed' as const }
  ])('replaces a record when effective fields change: %o', (change) => {
    const first = { ...makeRecord(1), callId: 'call-1' }
    const other = makeRecord(2)
    const records = [other, first]
    const updated = upsertActivityRecord(records, {
      ...first,
      ...change,
      id: 'replacement-id',
      createdAt: 99,
      scope: { kind: 'unavailable' }
    })

    expect(updated).not.toBe(records)
    expect(updated[0]).not.toBe(first)
    expect(updated[0]).toEqual({ ...first, ...change })
    expect(updated[0]?.scope).toBe(first.scope)
    expect(updated[1]).toBe(other)
    expect(records).toEqual([other, first])
  })

  it('upserts Subagent state transitions', () => {
    const queued: ActivityRecord = {
      ...makeRecord(1),
      kind: 'subagent',
      callId: 'child-task-1',
      title: '研究专家',
      status: 'pending'
    }
    const completed = upsertActivityRecord([queued], {
      ...queued,
      id: 'replacement-id',
      createdAt: 99,
      status: 'completed'
    })

    expect(completed).toEqual([
      expect.objectContaining({
        id: queued.id,
        createdAt: queued.createdAt,
        kind: 'subagent',
        status: 'completed'
      })
    ])
  })

  it('keeps more than 500 distinct activity records', () => {
    const records = Array.from({ length: 501 }, (_, index) =>
      makeRecord(index)
    )

    expect(
      upsertActivityRecord(records, makeRecord(501))
    ).toHaveLength(502)
  })

  it('merges migrated and persisted records without duplicating IDs', () => {
    expect(
      mergeActivityRecords(
        [makeRecord(2), makeRecord(1)],
        [makeRecord(1), makeRecord(0)]
      ).map((record) => record.id)
    ).toEqual(['activity-2', 'activity-1', 'activity-0'])
  })

  it('reconciles stale active records with durable task outcomes', () => {
    const records: ActivityRecord[] = [
      { ...makeRecord(1), status: 'running' },
      {
        ...makeRecord(2),
        requestId: 'missing-task',
        status: 'pending'
      }
    ]
    const reconciled = reconcileActivityRecords(records, [
      {
        id: 'request-1',
        title: 'task',
        instructions: 'task',
        origin: 'user',
        status: 'cancelled',
        createdAt: new Date(0).toISOString()
      }
    ])

    expect(reconciled.map((record) => record.status)).toEqual([
      'cancelled',
      'interrupted'
    ])
  })

  it('localizes interrupted activity details after restart', async () => {
    await changeUiLocale('en-US')
    try {
      const [record] = reconcileActivityRecords(
        [
          {
            ...makeRecord(1),
            requestId: 'missing-task',
            status: 'running'
          }
        ],
        []
      )

      expect(record?.detail).toContain(
        'This activity had not finished when the app restarted.'
      )
    } finally {
      await changeUiLocale('zh-CN')
    }
  })
})
