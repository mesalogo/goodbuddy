import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantDatabase } from '../assistant/assistant-database'
import type { ComputerControlAuditEvent } from './audit'
import { DatabaseComputerControlAuditSink } from './database-audit'

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
  databasePath: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-control-audit-'))
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'assistant.sqlite')
  const database = new AssistantDatabase(databasePath)
  database.initialize('C:\\Workspace')
  return { database, databasePath }
}

const createTask = (database: AssistantDatabase, taskId: string): void => {
  database.createTask({
    id: taskId,
    title: '计算机控制审计',
    instructions: '验证持久审计',
    workMode: 'execute'
  })
}

describe('DatabaseComputerControlAuditSink', () => {
  it('persists redacted events idempotently across close and reopen', async () => {
    const { database, databasePath } = await createDatabase()
    const taskId = '00000000-0000-4000-8000-000000000401'
    const typedText = 'secret typed content 不得持久化'
    const textDigest = createHash('sha256')
      .update(typedText, 'utf8')
      .digest('hex')
    createTask(database, taskId)
    const sink = new DatabaseComputerControlAuditSink(database)
    const event: ComputerControlAuditEvent = {
      timestamp: 1_775_000_000_000,
      taskId,
      conversationId: 'conversation-control-0001',
      leaseId: 'lease_control_000000001',
      commandId: 'command_control_0000001',
      action: 'replace_text',
      risk: 'input',
      outcome: 'completed',
      textLength: typedText.length,
      textDigest
    }

    sink.write(event)
    sink.write({ ...event, timestamp: event.timestamp + 1 })
    expect(database.listRecentComputerControlAudit()).toEqual([event])
    database.close()

    const reopened = new AssistantDatabase(databasePath)
    reopened.initialize('C:\\Workspace')
    expect(reopened.listRecentComputerControlAudit(1)).toEqual([event])
    reopened.close()

    const raw = new DatabaseSync(databasePath)
    const auditRows = raw
      .prepare('SELECT * FROM computer_control_actions')
      .all()
    const taskEvents = raw
      .prepare(
        `SELECT payload_json FROM task_events
         WHERE task_id = ? AND kind = 'computer_control'`
      )
      .all(taskId) as Array<{ payload_json: string }>
    expect(auditRows).toHaveLength(1)
    expect(taskEvents).toHaveLength(1)
    expect(JSON.stringify(auditRows)).not.toContain(typedText)
    expect(JSON.stringify(taskEvents)).not.toContain(typedText)
    expect(taskEvents[0]?.payload_json).toContain(textDigest)
    raw.close()
    expect((await readFile(databasePath)).toString('utf8')).not.toContain(
      typedText
    )
  })

  it('enforces task foreign keys and cascades task audit deletion', async () => {
    const { database } = await createDatabase()
    const taskId = '00000000-0000-4000-8000-000000000402'
    const base: ComputerControlAuditEvent = {
      timestamp: 1_775_000_000_000,
      taskId,
      conversationId: 'conversation-control-0002',
      leaseId: 'lease_control_000000002',
      commandId: 'command_control_0000002',
      action: 'observe',
      risk: 'observe',
      outcome: 'completed'
    }

    expect(() => database.persistComputerControlAudit(base)).toThrow()
    createTask(database, taskId)
    database.persistComputerControlAudit(base)
    database.clearAssistantData()
    expect(database.listRecentComputerControlAudit()).toEqual([])
    database.close()
  })

  it('rejects invalid audit fields before persistence', async () => {
    const { database } = await createDatabase()
    const taskId = '00000000-0000-4000-8000-000000000403'
    createTask(database, taskId)
    const valid: ComputerControlAuditEvent = {
      timestamp: 1_775_000_000_000,
      taskId,
      conversationId: 'conversation-control-0003',
      leaseId: 'lease_control_000000003',
      commandId: 'command_control_0000003',
      action: 'observe',
      risk: 'observe',
      outcome: 'completed'
    }
    const invalidEvents: unknown[] = [
      { ...valid, timestamp: Number.NaN },
      { ...valid, taskId: '' },
      { ...valid, conversationId: 'x'.repeat(129) },
      { ...valid, leaseId: 'short' },
      { ...valid, action: 'type_secret' },
      { ...valid, risk: 'unsafe' },
      { ...valid, outcome: 'failed' },
      {
        ...valid,
        action: 'replace_text',
        risk: 'input',
        textLength: 10,
        textDigest: 'not-a-sha256'
      },
      { ...valid, textLength: 1, textDigest: 'a'.repeat(64) }
    ]

    for (const invalid of invalidEvents) {
      expect(() =>
        database.persistComputerControlAudit(
          invalid as ComputerControlAuditEvent
        )
      ).toThrow()
    }
    expect(() => database.listRecentComputerControlAudit(0)).toThrow()
    expect(database.listRecentComputerControlAudit()).toEqual([])
    database.close()
  })
})
