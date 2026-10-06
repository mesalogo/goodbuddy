import { afterEach, describe, expect, it } from 'vitest'
import { AssistantDatabase } from '../assistant/assistant-database'
import { SqliteChannelOutbox } from './sqlite-channel-state'

const databases: AssistantDatabase[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function createOutbox(): SqliteChannelOutbox {
  const database = new AssistantDatabase(':memory:')
  databases.push(database)
  database.initialize('C:\\Workspace')
  return new SqliteChannelOutbox(database)
}

const message = {
  channel: 'telegram' as const,
  eventId: 'event-1',
  conversationId: 'chat-1',
  recipientId: 'user-1',
  status: 'completed' as const,
  output: 'Result',
  attachments: [{ name: 'result.txt', mimeType: 'text/plain', size: 1, kind: 'file' as const, dataBase64: 'eA==' }]
}

describe('SqliteChannelOutbox', () => {
  it('marks a permanent failure terminal, releases media and counts the attempt once', async () => {
    const outbox = createOutbox()
    const entry = await outbox.enqueue(message)
    await outbox.markTerminal(entry.id)
    await outbox.markTerminal(entry.id)
    await outbox.markFailed(entry.id)
    await outbox.markDelivered(entry.id)
    expect(await outbox.listUndelivered()).toEqual([{
      ...entry, state: 'terminal', attempts: 1,
      message: { ...message, attachments: undefined }
    }])
    expect((await outbox.listUndelivered())[0]!.message).not.toHaveProperty('attachments')
  })

  it('keeps retryable entries ahead of terminal entries under channel and global limits', async () => {
    const outbox = createOutbox()
    const terminal = await outbox.enqueue(message)
    await outbox.markTerminal(terminal.id)
    const retry = await outbox.enqueue({ ...message, eventId: 'retry' })
    await outbox.markFailed(retry.id)
    await outbox.markFailed(retry.id)
    for (const channel of [undefined, 'telegram']) {
      expect((await outbox.listUndelivered(channel, 1)).map(entry => entry.id)).toEqual([retry.id])
      expect((await outbox.listUndelivered(channel)).map(entry => entry.id)).toEqual([retry.id, terminal.id])
    }
    expect(await outbox.listUndelivered('weixin')).toEqual([])
  })

  it('budgets retry bytes after putting terminal results last in both windows', async () => {
    const outbox = createOutbox()
    // Retained terminal text alone exceeds the 20 MiB retry window.
    for (let index = 0; index < 22; index++) {
      const entry = await outbox.enqueue({ ...message, eventId: `terminal-${index}`, output: 'x'.repeat(1024 * 1024) })
      await outbox.markTerminal(entry.id)
    }
    const retry = await outbox.enqueue({ ...message, eventId: 'retry' })
    await outbox.markFailed(retry.id)
    await outbox.markFailed(retry.id)
    for (const channel of [undefined, 'telegram']) {
      const entries = await outbox.listUndelivered(channel)
      expect(entries[0]!.id).toBe(retry.id)
      expect(entries.length).toBeLessThan(23)
    }
  })
})
