// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationMessageBlock } from '../../shared/assistant-contracts'
import type { SubagentEvent } from '../../shared/contracts'
import { AssistantDatabase, ASSISTANT_DATABASE_SCHEMA_VERSION } from './assistant-database'
import {
  hasPendingAssistantStorageUpgrade,
  upgradeAssistantStorage
} from './assistant-storage-upgrade'
import {
  compactSubagentPayload,
  restoreSubagentPayload,
  SubagentProgressStorage
} from './subagent-progress-storage'

const directories: string[] = []
const databases: AssistantDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map(
    (path) => rm(path, { recursive: true, force: true })
  ))
})

async function fixture(): Promise<{
  path: string; database: AssistantDatabase; taskId: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-storage-upgrade-'))
  directories.push(directory)
  const path = join(directory, 'assistant.sqlite')
  const database = new AssistantDatabase(path)
  databases.push(database)
  database.initialize(directory)
  const taskId = randomUUID()
  database.createTask({
    id: taskId, title: 'Storage regression', instructions: 'Synthetic fixture',
    workMode: 'execute'
  })
  return { path, database, taskId }
}

function subagent(requestId: string): SubagentEvent {
  return {
    requestId, type: 'subagent', childTaskId: randomUUID(),
    expertId: randomUUID(), expertName: 'general', routingMode: 'native',
    runtimeCallId: 'test-call', state: 'running', progress: []
  }
}

describe('subagent progress storage', () => {
  it('does not migrate or vacuum ordinary chat free pages on repeated startup', async () => {
    const { path, database } = await fixture()
    const header = { id: randomUUID(), title: 'Chat restart', updatedAt: 1000 }
    const message = {
      id: randomUUID(), role: 'assistant' as const, state: 'complete' as const,
      content: 'Long draft'.repeat(100_000), createdAt: 1000
    }
    database.saveLocalConversations([{ header, messages: [message] }])
    database.saveLocalConversations([{ header, messages: [{ ...message, content: 'Final response' }] }])
    const expected = database.getConversation(header.id)
    database.close()
    const sql = new DatabaseSync(path)
    try {
      const free = sql.prepare('PRAGMA freelist_count').get()!.freelist_count
      expect(free).toBeGreaterThan(0)
      expect(sql.prepare('PRAGMA user_version').get()!.user_version).toBe(ASSISTANT_DATABASE_SCHEMA_VERSION)
      expect(hasPendingAssistantStorageUpgrade(path)).toBe(false)
      const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
      for (let restart = 0; restart < 2; restart++) {
        const progress = vi.fn()
        upgradeAssistantStorage(path, progress)
        expect(progress).not.toHaveBeenCalled()
        expect(exec.mock.calls.some(([statement]) => /VACUUM/i.test(statement))).toBe(false)
        const reopened = new AssistantDatabase(path)
        try {
          reopened.initialize(tmpdir())
          expect(reopened.getConversation(header.id)).toEqual(expected)
        } finally { reopened.close() }
      }
      expect(sql.prepare('PRAGMA freelist_count').get()!.freelist_count).toBe(free)
      expect(sql.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally { sql.close() }
  })

  it('roundtrips every snapshot including corrections, reordered blocks and empty progress', () => {
    const event = subagent(randomUUID())
    const textId = randomUUID()
    const toolId = randomUUID()
    const text: ConversationMessageBlock = { id: textId, type: 'text', content: 'seed' }
    const tool: ConversationMessageBlock = {
      id: toolId, type: 'tool', tool: { name: 'read', state: 'completed', summary: 'Read', output: 'seed' }
    }
    const encoder = new Map<string, ConversationMessageBlock[]>()
    const decoder = new Map<string, ConversationMessageBlock[]>()
    for (const progress of [
      [], [text], [text, tool],
      [{ ...text, content: 'seed tail' }, tool],
      [{ ...text, content: 'corrected' }, tool],
      [tool, text], [], [text]
    ]) {
      const full = { ...event, progress }
      const compact = compactSubagentPayload(full, encoder)
      restoreSubagentPayload(full, encoder)
      expect(restoreSubagentPayload(compact, decoder)).toEqual(full)
    }
  })

  it('stores small changes without repeating large tool outputs, including across reopen', async () => {
    const fixtureData = await fixture()
    let database = fixtureData.database
    const event = subagent(fixtureData.taskId)
    const tool: ConversationMessageBlock = {
      id: randomUUID(), type: 'tool',
      tool: {
        name: 'read', summary: 'Read', state: 'completed',
        input: undefined, output: 'x'.repeat(200_000), error: undefined
      }
    }
    const textId = randomUUID()
    try {
      for (let index = 0; index < 200; index++) {
        event.progress = [tool, { id: textId, type: 'text', content: `seed${'中'.repeat(index)}` }]
        database.appendTaskEvent(fixtureData.taskId, 'subagent', event)
        if (index === 99) {
          database.close()
          database = new AssistantDatabase(fixtureData.path)
          database.initialize(tmpdir())
        }
      }
      database.close()
      const inspection = new DatabaseSync(fixtureData.path)
      try {
        const rows = inspection.prepare(
          `SELECT payload_json FROM task_events WHERE kind = 'subagent' ORDER BY id`
        ).all() as Array<{ payload_json: string }>
        expect(rows).toHaveLength(200)
        expect(rows.reduce((sum, row) => sum + row.payload_json.length, 0)).toBeLessThan(400_000)
        const state = new Map<string, ConversationMessageBlock[]>()
        let restored: unknown
        for (const row of rows) restored = restoreSubagentPayload(JSON.parse(row.payload_json), state)
        expect(restored).toStrictEqual(JSON.parse(JSON.stringify(event)))
      } finally { inspection.close() }
    } finally { database.close() }
  })

  it('ignores omitted optional tool fields but preserves every actual field change', () => {
    const event = subagent(randomUUID())
    const block: ConversationMessageBlock = {
      id: randomUUID(), type: 'tool',
      tool: {
        callId: 'read-1', name: 'read', summary: 'Read', state: 'completed',
        input: undefined, output: 'unchanged', error: undefined
      }
    }
    const state = new Map<string, ConversationMessageBlock[]>([
      [event.childTaskId, JSON.parse(JSON.stringify([block]))]
    ])
    expect(compactSubagentPayload({ ...event, progress: [block] }, state))
      .toMatchObject({ progressUpdates: [] })
    for (const change of [
      { callId: 'read-2' }, { name: 'write' }, { summary: 'Updated' },
      { state: 'failed' as const }, { input: '' }, { output: 'changed' },
      { error: 'failed' }, { output: undefined }
    ]) {
      const updated = { ...block, tool: { ...block.tool, ...change } }
      const compact = compactSubagentPayload({ ...event, progress: [updated] }, state)
      expect(compact).toMatchObject({
        progressUpdates: [{ type: 'upsert', block: updated }]
      })
    }
  })

  it('releases terminal task caches without clearing peers, and rebuilds after rollback', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`CREATE TABLE task_events(
      id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT, payload_json TEXT
    )`)
    const storage = new SubagentProgressStorage(database)
    const caches = (storage as unknown as { tasks: Map<string, unknown> }).tasks
    const tool: ConversationMessageBlock = {
      id: randomUUID(), type: 'tool',
      tool: {
        name: 'read', state: 'completed', summary: 'Read',
        output: 'x'.repeat(200_000), error: undefined
      }
    }
    let id = 0
    const append = (taskId: string, kind: string, event: unknown) => {
      const payload = storage.serialize(taskId, kind, event)
      database.prepare('INSERT INTO task_events VALUES (?, ?, ?, ?)')
        .run(++id, taskId, kind, payload)
      storage.inserted(taskId, kind, id, payload)
      return JSON.parse(payload) as { progressUpdates: unknown[] }
    }
    try {
      const peer = subagent(randomUUID())
      append(peer.requestId, 'subagent', { ...peer, progress: [tool] })
      for (const [kind, payload] of [
        ['done', {}], ['error', {}],
        ...['completed', 'failed', 'cancelled', 'interrupted']
          .map((status) => ['status', { status }])
      ] as Array<[string, unknown]>) {
        const event = { ...subagent(randomUUID()), progress: [tool] }
        append(event.requestId, 'subagent', event)
        expect(caches.size).toBe(2)
        database.exec('BEGIN')
        append(event.requestId, kind, payload)
        expect(caches.has(event.requestId)).toBe(false)
        expect(caches.has(peer.requestId)).toBe(true)
        database.exec('ROLLBACK')
        expect(append(event.requestId, 'subagent', event).progressUpdates).toEqual([])
        append(event.requestId, kind, payload)
        expect(caches.size).toBe(1)
      }
      for (let index = 0; index < 40; index++) {
        const event = subagent(randomUUID())
        append(event.requestId, 'subagent', { ...event, progress: [tool] })
        expect(caches.size).toBeLessThanOrEqual(16)
      }
    } finally { database.close() }
  })

  it('keeps remote replay deduplication and conflicting payload checks after compaction', async () => {
    const { database, taskId, path } = await fixture()
    const event = subagent(taskId)
    const textId = randomUUID()
    const tool: ConversationMessageBlock = {
      id: randomUUID(), type: 'tool',
      tool: {
        name: 'read', summary: 'Read', state: 'completed',
        input: undefined, output: 'x'.repeat(20_000), error: undefined
      }
    }
    const provenance = { taskId, bindingId: 'binding', operationId: 'operation', eventIndex: 0, kind: 'subagent' }
    const first = { ...event, progress: [tool, { id: textId, type: 'text' as const, content: 'seed' }] }
    const second = { ...event, progress: [tool, { id: textId, type: 'text' as const, content: 'seed tail' }] }
    try {
      expect(database.appendRemoteTaskEventOnce({ ...provenance, semanticSequence: '1', payload: first })).toBe(true)
      expect(database.appendRemoteTaskEventOnce({ ...provenance, semanticSequence: '2', payload: second })).toBe(true)
      expect(database.appendRemoteTaskEventOnce({ ...provenance, semanticSequence: '1', payload: first })).toBe(false)
      expect(() => database.appendRemoteTaskEventOnce({ ...provenance, semanticSequence: '1', payload: second })).toThrow('conflicts')
      database.appendTaskEvent(taskId, 'done', {})
      const caches = (database as unknown as {
        subagentProgress: { tasks: Map<string, unknown> }
      }).subagentProgress.tasks
      expect(caches.size).toBe(0)
      expect(database.appendRemoteTaskEventOnce({
        ...provenance, semanticSequence: '2', payload: second
      })).toBe(false)
      expect(caches.size).toBe(0)
    } finally { database.close() }
    const reopened = new AssistantDatabase(path)
    reopened.initialize(tmpdir())
    try {
      expect(reopened.appendRemoteTaskEventOnce({ ...provenance, semanticSequence: '2', payload: second })).toBe(false)
      expect(reopened.getHighestCommittedRemoteTaskEventSequence('binding', 'operation')).toBe('2')
    } finally { reopened.close() }
  })

  it('rebuilds progress after a remote batch rolls back', async () => {
    const { database, taskId } = await fixture()
    const event = subagent(taskId)
    const textId = randomUUID()
    const base = { taskId, bindingId: 'binding', operationId: 'operation', eventIndex: 0, kind: 'subagent' }
    const first = { ...event, progress: [{ id: textId, type: 'text' as const, content: 'seed' }] }
    try {
      database.appendRemoteTaskEventOnce({ ...base, semanticSequence: '2', payload: first })
      expect(() => database.appendRemoteTaskEventsBatch([
        { ...base, semanticSequence: '1', payload: { ...first, progress: [] } },
        { ...base, semanticSequence: '2', payload: { ...first, output: 'conflict' } }
      ])).toThrow('conflicts')
      expect(database.appendRemoteTaskEventOnce({ ...base, semanticSequence: '3', payload: first })).toBe(true)
      expect(database.appendRemoteTaskEventOnce({ ...base, semanticSequence: '3', payload: first })).toBe(false)
    } finally { database.close() }
  })

  it('keeps full remote conversation progress atomic with compact events', async () => {
    const { database, path } = await fixture()
    const hostId = randomUUID()
    const project = database.createSshProject({
      project: {
        name: 'Remote regression', description: '', rootPath: '/tmp/goodbuddy-storage-test',
        defaultWorkMode: 'execute', runtimeSelection: { provider: 'opencode' }
      },
      executionSpace: { kind: 'ssh', hostId, remoteRootPath: '/tmp/goodbuddy-storage-test' },
      assertCurrent: () => undefined
    })
    const conversationId = randomUUID()
    const userMessageId = randomUUID()
    const assistantMessageId = randomUUID()
    database.saveLocalConversations([{
      header: { id: conversationId, projectId: project.id, title: 'Atomic regression', updatedAt: Date.now() },
      messages: []
    }])
    const remoteTaskId = randomUUID()
    database.createTask({
      id: remoteTaskId, projectId: project.id, conversationId,
      title: 'Atomic remote', instructions: 'Synthetic', workMode: 'execute',
      remoteRecovery: {
        recoverable: true, currentUserMessageId: userMessageId,
        currentAssistantMessageId: assistantMessageId
      }
    })
    const event = subagent(remoteTaskId)
    const textId = randomUUID()
    const first = { ...event, progress: [{ id: textId, type: 'text' as const, content: 'seed' }] }
    const second = { ...event, state: 'completed' as const, output: 'Complete', progress: [
      { id: textId, type: 'text' as const, content: 'seed tail' }
    ] }
    const owner = {
      taskId: remoteTaskId, conversationId, assistantMessageId,
      bindingId: 'atomic-binding', operationId: 'atomic-operation', eventIndex: 0
    }
    const inspection = new DatabaseSync(path)
    try {
      database.appendRemoteConversationTaskEventOnce({ ...owner, semanticSequence: '1', event: first })
      inspection.exec(`CREATE TRIGGER reject_message BEFORE UPDATE ON messages
        BEGIN SELECT RAISE(ABORT, 'fixture message write failed'); END;`)
      expect(() => database.appendRemoteConversationTaskEventOnce({
        ...owner, semanticSequence: '2', event: second
      })).toThrow('fixture message write failed')
      expect(database.getHighestCommittedRemoteTaskEventSequence('atomic-binding', 'atomic-operation')).toBe('1')
      inspection.exec('DROP TRIGGER reject_message')
      expect(database.appendRemoteConversationTaskEventOnce({
        ...owner, semanticSequence: '2', event: second
      })).toBe(true)
      expect(database.appendRemoteConversationTaskEventOnce({
        ...owner, semanticSequence: '2', event: second
      })).toBe(false)
      const message = database.getConversation(conversationId).messages.find((row) => row.id === assistantMessageId)
      expect(message?.subagents?.[0]).toMatchObject({
        state: 'completed', progress: second.progress, output: 'Complete'
      })
      expect(inspection.prepare(
        `SELECT COUNT(*) AS count FROM task_events WHERE task_id = ? AND kind = 'subagent'`
      ).get(remoteTaskId)).toEqual({ count: 2 })
    } finally { inspection.close(); database.close() }
  })

  it.each([33, 34])('converts schema %i rows, resumes and shrinks without losing provenance', async (sourceVersion) => {
    const { database, taskId, path } = await fixture()
    database.close()
    const event = subagent(taskId)
    const tool: ConversationMessageBlock = {
      id: randomUUID(), type: 'tool',
      tool: { name: 'read', summary: 'Read', state: 'completed', output: 'x'.repeat(300_000) }
    }
    const textId = randomUUID()
    const legacy = new DatabaseSync(path)
    const expected: SubagentEvent[] = []
    try {
      legacy.exec(`ALTER TABLE conversations DROP COLUMN pinned;
        PRAGMA user_version = ${sourceVersion}; BEGIN`)
      const insert = legacy.prepare(
        `INSERT INTO task_events(
          task_id, kind, payload_json, created_at, remote_binding_id,
          remote_operation_id, remote_semantic_sequence, remote_event_index
         ) VALUES (?, 'subagent', ?, ?, 'binding', 'operation', ?, 0)`
      )
      for (let index = 0; index < 150; index++) {
        const full = {
          ...event,
          progress: [tool, { id: textId, type: 'text' as const, content: `seed${'中'.repeat(index)}` }]
        }
        expected.push(full)
        const { progress, ...metadata } = full
        const stored = sourceVersion === 34 ? {
          ...metadata,
          progressUpdates: progress.map((block) => ({ type: 'upsert', block }))
        } : full
        insert.run(taskId, JSON.stringify(stored), '2026-09-13T00:00:00Z', String(index + 1))
      }
      legacy.exec(`COMMIT;
        CREATE TRIGGER reject_unchanged_payload BEFORE UPDATE OF payload_json ON task_events
        WHEN OLD.payload_json = NEW.payload_json
        BEGIN SELECT RAISE(ABORT, 'unchanged payload rewritten'); END;`)
    } finally { legacy.close() }
    const before = (await stat(path)).size
    expect(before).toBeGreaterThan(40_000_000)
    let cancelled = false
    expect(() => upgradeAssistantStorage(path, (progress) => {
      if (progress.processed >= 32) cancelled = true
    }, () => cancelled)).toThrow('cancelled')
    upgradeAssistantStorage(path, () => undefined)
    const after = (await stat(path)).size
    expect(after).toBeLessThan(before / 20)
    const inspected = new DatabaseSync(path)
    try {
      expect(inspected.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      const rows = inspected.prepare(
        `SELECT id, task_id, payload_json, created_at, remote_binding_id,
           remote_operation_id, remote_semantic_sequence, remote_event_index
         FROM task_events WHERE kind = 'subagent' ORDER BY id`
      ).all() as Array<{
        id: number; task_id: string; payload_json: string; created_at: string
        remote_binding_id: string; remote_operation_id: string
        remote_semantic_sequence: string; remote_event_index: number
      }>
      expect(rows).toHaveLength(expected.length)
      const blocks = new Map<string, ConversationMessageBlock[]>()
      rows.forEach((row, index) => {
        expect(restoreSubagentPayload(JSON.parse(row.payload_json), blocks)).toEqual(expected[index])
        expect(row.created_at).toBe('2026-09-13T00:00:00Z')
        expect(row.task_id).toBe(taskId)
        expect(row.remote_binding_id).toBe('binding')
        expect(row.remote_operation_id).toBe('operation')
        expect(row.remote_semantic_sequence).toBe(String(index + 1))
        expect(row.remote_event_index).toBe(0)
        if (index > 0) expect(row.id).toBe(rows[index - 1]!.id + 1)
      })
    } finally { inspected.close() }
    const reopened = new AssistantDatabase(path)
    reopened.initialize(tmpdir())
    reopened.close()
    const messages: unknown[] = []
    upgradeAssistantStorage(path, (value) => messages.push(value))
    expect(messages).toEqual([])
    const latest = new DatabaseSync(path)
    try {
      expect(latest.prepare('PRAGMA user_version').get()).toEqual({
        user_version: ASSISTANT_DATABASE_SCHEMA_VERSION
      })
    } finally { latest.close() }
  }, 30_000)

  it('recompacts mixed full and delta events without changing corrections, resets or child state', () => {
    const first = subagent(randomUUID())
    const second = { ...subagent(first.requestId), state: 'completed' as const, output: 'Done' }
    const textId = randomUUID()
    const tool: ConversationMessageBlock = {
      id: randomUUID(), type: 'tool',
      tool: { name: 'read', state: 'completed', summary: 'Read', output: 'payload' }
    }
    const text: ConversationMessageBlock = { id: textId, type: 'text', content: 'seed' }
    const stored = [
      { ...first, progress: [tool, text] },
      { ...second, progressUpdates: [{ type: 'upsert', block: text }] },
      { ...first, progress: undefined, progressUpdates: [
        { type: 'upsert', block: tool },
        { type: 'append', id: textId, blockType: 'text', delta: ' tail' }
      ] },
      { ...first, progress: undefined, progressUpdates: [
        { type: 'upsert', block: { ...text, content: 'corrected' } }
      ] },
      { ...first, progress: undefined, progressUpdates: [
        { type: 'reset', blocks: [text, tool] }
      ] },
      { ...second, progressUpdates: [] },
      { ...first, progress: [] },
      { ...first, progress: [text] }
    ]
    const oldState = new Map<string, ConversationMessageBlock[]>()
    const newState = new Map<string, ConversationMessageBlock[]>()
    for (const input of stored) {
      const event = JSON.parse(JSON.stringify(input))
      const compact = compactSubagentPayload(event, oldState)
      const expected = restoreSubagentPayload(event, oldState)
      expect(restoreSubagentPayload(compact, newState)).toStrictEqual(expected)
    }
  })
})
