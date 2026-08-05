import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVITY_STORAGE_KEY,
  MAX_ACTIVITY_DETAIL_LENGTH,
  MAX_ACTIVITY_RECORDS,
  loadActivityRecords,
  reconcileActivityRecords,
  saveActivityRecords,
  upsertActivityRecord,
  type ActivityRecord
} from './activity-store'

function makeRecord(index: number): ActivityRecord {
  return {
    id: `activity-${index}`,
    conversationId: 'conversation-1',
    requestId: 'request-1',
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
    expect(loadActivityRecords()).toEqual([])

    const inaccessibleStorage = {
      getItem: () => {
        throw new Error('blocked')
      }
    } as unknown as Storage
    expect(loadActivityRecords(inaccessibleStorage)).toEqual([])
  })

  it('keeps only schema-valid records from untrusted storage', () => {
    const validRecord = makeRecord(1)
    localStorage.setItem(
      ACTIVITY_STORAGE_KEY,
      JSON.stringify([
        validRecord,
        { ...validRecord, status: 'unknown' },
        { ...validRecord, detail: 'x'.repeat(MAX_ACTIVITY_DETAIL_LENGTH + 1) },
        null
      ])
    )

    expect(loadActivityRecords()).toEqual([validRecord])
  })

  it('persists no more than the record limit', () => {
    const records = Array.from(
      { length: MAX_ACTIVITY_RECORDS + 1 },
      (_, index) => makeRecord(index)
    )

    expect(saveActivityRecords(records)).toBe(true)
    expect(loadActivityRecords()).toHaveLength(MAX_ACTIVITY_RECORDS)
    expect(loadActivityRecords().at(-1)?.id).toBe(
      `activity-${MAX_ACTIVITY_RECORDS - 1}`
    )
  })

  it('reports rejected writes without throwing', () => {
    const rejectingStorage = {
      setItem: () => {
        throw new Error('quota exceeded')
      }
    } as unknown as Storage

    expect(saveActivityRecords([makeRecord(1)], rejectingStorage)).toBe(
      false
    )
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
        status: 'failed'
      })
  })

  it('persists and upserts Subagent state transitions', () => {
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
    expect(saveActivityRecords(completed)).toBe(true)
    expect(loadActivityRecords()).toEqual(completed)
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
})
