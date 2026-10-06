// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { conversationMessageSchema } from '../../shared/assistant-contracts'
import { conversationMessageResourceIds } from '../../shared/conversation-output'
import { storageDataBytes, STORAGE_MAX_BYTES } from '../desktop-storage-contracts'

it('round trips multi-megabyte bounded previews and nested references without dropping metadata', async () => {
  const parent = resolve('temp/goodbuddy-output-history')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'metadata-'))
  const path = join(root, 'assistant.sqlite')
  let database = new AssistantDatabase(path)
  try {
    await database.initialize(root)
    const header = { id: randomUUID(), title: 'Output history', updatedAt: 1 }
    const reference = { handle: `process:${randomUUID()}`, nextCursor: 100, totalBytes: 2000000 }
    const childReference = { ...reference, handle: `subagent:${randomUUID()}` }
    const attachmentId = randomUUID()
    const tools = Array.from({ length: 12 }, (_, index) => ({ callId: String(index), name: 'Process',
      state: 'completed' as const, summary: 'Output', output: 'x'.repeat(200000) + '-tail', outputReferences: [reference] }))
    const message = conversationMessageSchema.parse({ id: randomUUID(), role: 'assistant', content: '', state: 'complete', createdAt: 1,
      tools, blocks: tools.map(tool => ({ id: randomUUID(), type: 'tool', tool })),
      subagents: [{ childTaskId: randomUUID(), actor: { kind: 'direct-model', label: '编程 Subagent' },
        routingMode: 'native', state: 'cancelled', output: 'partial', outputReference: childReference,
        progress: [{ id: randomUUID(), type: 'tool', tool: tools[0] }] }],
      attachments: [{ id: attachmentId, resourceId: attachmentId, kind: 'text', name: 'source.txt', size: 5, preview: 'input' }]
    })
    const batch = [{ header, messages: [message] }]
    expect(Buffer.byteLength(JSON.stringify(message))).toBeGreaterThan(4 * 1024 * 1024)
    expect(storageDataBytes(batch)).toBeLessThan(STORAGE_MAX_BYTES)
    expect(() => storageDataBytes(batch, 1024)).toThrow('Storage payload capacity exceeded')
    database.saveLocalConversations(batch)
    database.close()
    database = new AssistantDatabase(path)
    await database.initialize(root)
    const restored = database.getConversation(header.id).messages[0]!
    expect(restored).toEqual(message)
    expect(conversationMessageResourceIds(restored)).toEqual([attachmentId, reference.handle.split(':')[1], childReference.handle.split(':')[1]])
    expect(conversationMessageResourceIds({ ...restored, tools: [], blocks: [] })).toEqual([attachmentId, childReference.handle.split(':')[1], reference.handle.split(':')[1]])
  } finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})
