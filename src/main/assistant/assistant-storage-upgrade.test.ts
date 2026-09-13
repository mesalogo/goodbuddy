// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConversationMessageBlock } from '../../shared/assistant-contracts'
import type { SubagentEvent } from '../../shared/contracts'
import { AssistantDatabase } from './assistant-database'
import { upgradeAssistantStorage } from './assistant-storage-upgrade'
import {
  compactSubagentPayload,
  restoreSubagentPayload
} from './subagent-progress-storage'

const directories: string[] = []
const databases: AssistantDatabase[] = []
afterEach(async () => {
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
      tool: { name: 'read', summary: 'Read', state: 'completed', output: 'x'.repeat(200_000) }
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
        expect(restored).toEqual(event)
      } finally { inspection.close() }
    } finally { database.close() }
  })

  it('keeps remote replay deduplication and conflicting payload checks after compaction', async () => {
    const { database, taskId, path } = await fixture()
    const event = subagent(taskId)
    const textId = randomUUID()
    const provenance = { taskId, bindingId: 'binding', operationId: 'operation', eventIndex: 0, kind: 'subagent' }
    const first = { ...event, progress: [{ id: textId, type: 'text' as const, content: 'seed' }] }
    const second = { ...event, progress: [{ id: textId, type: 'text' as const, content: 'seed tail' }] }
    try {
      expect(database.appendRemoteTaskEventOnce({ ...provenance, semanticSequence: '1', payload: first })).toBe(true)
      expect(database.appendRemoteTaskEventOnce({ ...provenance, semanticSequence: '2', payload: second })).toBe(true)
      expect(database.appendRemoteTaskEventOnce({ ...provenance, semanticSequence: '1', payload: first })).toBe(false)
      expect(() => database.appendRemoteTaskEventOnce({ ...provenance, semanticSequence: '1', payload: second })).toThrow('conflicts')
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

  it('converts legacy rows in batches, resumes after cancellation and actually shrinks the file', async () => {
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
      legacy.exec('PRAGMA user_version = 33; BEGIN')
      const insert = legacy.prepare(
        `INSERT INTO task_events(task_id, kind, payload_json, created_at)
         VALUES (?, 'subagent', ?, ?)`
      )
      for (let index = 0; index < 150; index++) {
        const full = {
          ...event,
          progress: [tool, { id: textId, type: 'text' as const, content: `seed${'中'.repeat(index)}` }]
        }
        expected.push(full)
        insert.run(taskId, JSON.stringify(full), '2026-09-13T00:00:00Z')
      }
      legacy.exec('COMMIT')
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
        `SELECT payload_json, created_at FROM task_events WHERE kind = 'subagent' ORDER BY id`
      ).all() as Array<{ payload_json: string; created_at: string }>
      expect(rows).toHaveLength(expected.length)
      const blocks = new Map<string, ConversationMessageBlock[]>()
      rows.forEach((row, index) => {
        expect(restoreSubagentPayload(JSON.parse(row.payload_json), blocks)).toEqual(expected[index])
        expect(row.created_at).toBe('2026-09-13T00:00:00Z')
      })
    } finally { inspected.close() }
    const reopened = new AssistantDatabase(path)
    reopened.initialize(tmpdir())
    reopened.close()
    const messages: unknown[] = []
    upgradeAssistantStorage(path, (value) => messages.push(value))
    expect(messages).toEqual([])
  }, 30_000)
})
