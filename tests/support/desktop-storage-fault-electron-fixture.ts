import assert from 'node:assert/strict'
import { join } from 'node:path'
import { app } from 'electron'
import { DesktopStorageClient } from '../../src/main/desktop-storage-client'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'

const root = process.env.GB_STORAGE_FAULT_ROOT!
process.umask(0o077)
app.setPath('userData', join(root, 'electron'))

function killTransport(storage: DesktopStorageClient): void {
  const transport = Reflect.get(storage, 'transport') as object
  const child = Reflect.get(transport, 'child') as { kill: () => void }
  child.kill()
}

async function run(): Promise<void> {
  await app.whenReady()
  const assistantPath = join(root, 'assistant.sqlite')
  const seed = new AssistantDatabase(assistantPath)
  seed.initialize(root)
  seed.close()
  const options = {
    assistantPath,
    knowledgePath: join(root, 'knowledge.sqlite'),
    defaultRootPath: root,
    userDataPath: root,
    entryPath: join(root, 'desktop-storage-entry.mjs'),
    readerWorkerPath: join(root, 'readonly-query-worker.cjs'),
    upgradeWorkerPath: join(root, 'assistant-storage-worker.cjs')
  }
  const storage = new DesktopStorageClient(options)
  await storage.ready
  const committedId = 'c05-committed'
  await storage.call('assistant', 'saveLocalConversations', [[{
    header: { id: committedId, title: 'C05 committed', updatedAt: 1 },
    messages: [{ id: 'c05-message', role: 'user', state: 'complete', content: 'committed', createdAt: 1 }]
  }]])

  let observedHighWater = 0
  const saturation = Array.from({ length: 96 }, () => storage.call('assistant', 'listConversationSummaries', []))
  while (storage.pendingCount > 0) {
    observedHighWater = Math.max(observedHighWater, storage.pendingCount)
    await new Promise(resolve => setImmediate(resolve))
  }
  await Promise.all(saturation)
  observedHighWater = Math.max(observedHighWater, storage.admissionHighWaterOperations)
  assert.ok(observedHighWater >= 96)

  const uncertainId = 'c05-uncertain'
  const requests: Promise<unknown>[] = [
    storage.call('assistant', 'saveLocalConversations', [[{
      header: { id: uncertainId, title: 'C05 uncertain', updatedAt: 2 },
      messages: [{ id: 'c05-uncertain-message', role: 'user', state: 'complete', content: 'may commit once', createdAt: 2 }]
    }]])
  ]
  requests.push(...Array.from({ length: 40 }, () => storage.call('assistant', 'listConversationSummaries', [])))
  killTransport(storage)
  requests.push(storage.call('assistant', 'listConversationSummaries', []))
  const settled = await Promise.allSettled(requests)
  assert.ok(settled.some(result => result.status === 'rejected'))
  assert.ok(settled.every(result => result.status === 'fulfilled' || result.status === 'rejected'))
  assert.equal(storage.pendingCount, 0)

  while (Reflect.get(storage, 'state') !== 'failed') await new Promise(resolve => setImmediate(resolve))
  await storage.retry()
  assert.equal((await storage.call('assistant', 'getConversation', [committedId])).messages[0]!.content, 'committed')
  let uncertain: Awaited<ReturnType<AssistantDatabase['getConversation']>> | undefined
  try { uncertain = await storage.call('assistant', 'getConversation', [uncertainId]) }
  catch { /* The write may have been rejected before commit. */ }
  assert.ok(!uncertain || uncertain.messages.filter(message => message.id === 'c05-uncertain-message').length <= 1)
  await storage.close()
  console.log(JSON.stringify({ status: 'passed', observedHighWater, pendingSettled: settled.length, committedReread: true, retried: true, replayed: false }))
  app.quit()
}

void run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  app.exit(1)
})
