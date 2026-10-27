// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import type { ConversationSnapshot } from '../../shared/assistant-contracts'
import { ConversationAttachmentStorage } from '../conversation-attachment-storage'
import { DocumentResultStorage } from '../document-result-storage'
import { conversationMessageResourceIds } from '../../shared/conversation-output'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function fixture(count = 6) {
  const parent = resolve('temp/message-edit-branch')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'db-'))
  const path = join(root, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  await db.initialize(root)
  const source: ConversationSnapshot = {
    id: randomUUID(), projectId: db.listProjects()[0]!.id, title: 'original', updatedAt: 1,
    selectedExpertId: 'team', storyGraphEnabled: false,
    contextMetrics: { runtimeSelectionKey: 'model', contextTokens: 900, source: 'estimated', basis: 'conversation' },
    contextCompressionState: { summary: 'OLD SUFFIX', coveredHistoryDigest: 'a'.repeat(64), coveredMessageCount: count },
    messages: Array.from({ length: count }, (_, i) => ({ id: randomUUID(), role: i % 2 ? 'assistant' : 'user', content: `message-${i}`, state: 'complete', createdAt: i + 1 })),
  }
  db.replaceConversations([source])
  cleanup.push(async () => { db.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  return { root, path, db, source }
}

it.each([0, 2, 500])('branches before user message %s, keeps immutable source and reloads provenance', async index => {
  const { db, source, path, root } = await fixture(502)
  const before = db.getConversation(source.id)
  const branch = db.branchLocalConversation({ sourceConversationId: source.id, beforeMessageId: source.messages[index]!.id, title: 'edited' })
  expect(branch.messages.map(m => m.content)).toEqual(source.messages.slice(0, index).map(m => m.content))
  expect(branch.messages.every((m, i) => m.id !== source.messages[i]!.id && m.copiedFromMessageId === source.messages[i]!.id)).toBe(true)
  expect(branch).toMatchObject({ selectedExpertId: 'team', storyGraphEnabled: false, branch: { sourceConversationId: source.id, sourceMessageId: source.messages[index]!.id } })
  expect(branch.contextCompressionState).toBeUndefined()
  expect(branch.contextMetrics).toBeUndefined()
  expect(db.getConversation(source.id)).toEqual(before)
  const { messages, ...header } = branch
  db.saveLocalConversations([{ header, messages }])
  db.close()
  await db.initialize(root)
  expect(db.getConversation(branch.id).branch).toEqual(branch.branch)
  expect(db.getConversation(branch.id).messages).toEqual(branch.messages)
  const sql = new DatabaseSync(path)
  try { expect(sql.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' }) } finally { sql.close() }
})

it('rejects missing, foreign and assistant boundaries without creating a branch, and rolls back a failed copy', async () => {
  const { db, source, path } = await fixture()
  const sql = new DatabaseSync(path)
  try {
    const foreignId = randomUUID()
    db.saveLocalConversations([{ header: { id: randomUUID(), title: 'other', updatedAt: 1 }, messages: [{ id: foreignId, role: 'user', content: 'foreign', state: 'complete', createdAt: 1 }] }])
    const count = () => sql.prepare('SELECT count(*) AS n FROM conversations').get()!.n
    const initial = count()
    for (const beforeMessageId of [randomUUID(), foreignId, source.messages[1]!.id]) {
      expect(() => db.branchLocalConversation({ sourceConversationId: source.id, beforeMessageId, title: 'invalid' })).toThrow('用户消息')
      expect(count()).toBe(initial)
    }
    sql.exec("CREATE TRIGGER fail_branch BEFORE INSERT ON messages WHEN NEW.conversation_id != '" + source.id + "' BEGIN SELECT RAISE(ABORT, 'copy failed'); END")
    expect(() => db.branchLocalConversation({ sourceConversationId: source.id, beforeMessageId: source.messages[2]!.id, title: 'failed' })).toThrow('copy failed')
    expect(count()).toBe(initial)
    expect(db.getConversation(source.id).messages).toHaveLength(6)
  } finally { sql.close() }
})

it('preserves attachments, child output references and image IDs across deletion of the source', async () => {
  const { db, source, root } = await fixture()
  const results = new DocumentResultStorage(join(root, 'results'))
  const assets = new ConversationAttachmentStorage(root, results)
  try {
    const id = randomUUID()
    const attachment = { id, resourceId: id, name: 'source.txt', kind: 'text' as const, preview: 'source', size: 6 }
    assets.save(attachment, JSON.stringify(attachment), Buffer.from('source'))
    source.messages[0]!.attachments = [attachment]
    source.messages[1]!.artifactIds = [randomUUID()]
    source.messages[1]!.subagents = [{ childTaskId: randomUUID(), actor: { kind: 'direct-model', label: '编程 Subagent' }, routingMode: 'native', state: 'completed', output: 'history' }]
    db.replaceConversations([source])
    assets.reference(source.id, 'message', source.messages[0]!.id, [id])
    const branch = db.branchLocalConversation({ sourceConversationId: source.id, beforeMessageId: source.messages[2]!.id, title: 'edited' })
    for (const message of branch.messages) assets.reference(branch.id, 'message', message.id, conversationMessageResourceIds(message))
    expect(branch.messages[1]!.subagents).toEqual(source.messages[1]!.subagents)
    expect(branch.messages[1]!.artifactIds).toEqual(source.messages[1]!.artifactIds)
    db.deleteLocalConversation(source.id)
    assets.deleteConversation(source.id)
    expect(assets.original(id).data.toString()).toBe('source')
    expect(db.getConversation(branch.id).messages[0]!.attachments).toEqual([attachment])
  } finally { assets.close(); await results.close() }
})
