import assert from 'node:assert/strict'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { DesktopStorageClient } from './desktop-storage-client'
import { DesktopStorageTransport } from './desktop-storage-transport'
import { createDesktopStorageFiles } from './desktop-storage-files'
import { createDesktopRuntimeStorageAdapters } from './desktop-storage-runtime-operations'
import { defaultDocumentParsingSettings } from './document-parsing-settings-store'
import { MAGIC_NOTE_MAX_VIDEO_BYTES, type MagicNoteContent } from '../shared/magic-notes-contracts'
import { createHash } from 'node:crypto'

const root = process.env.GB_STORAGE_TEST_ROOT!
process.umask(0o077)
app.setPath('userData', join(root, 'electron'))

async function run(): Promise<void> {
  await app.whenReady()
  await chmod(root, 0o700)
  const options = { assistantPath: join(root, 'assistant.sqlite'), knowledgePath: join(root, 'knowledge.sqlite'),
    defaultRootPath: root, userDataPath: root, entryPath: join(root, 'desktop-storage-entry.mjs'),
    readerWorkerPath: join(root, 'readonly-query-worker.cjs'), upgradeWorkerPath: join(root, 'assistant-storage-worker.cjs') }
  const changes: string[] = []
  const progress: string[] = []
  const storage = new DesktopStorageClient({ ...options, onChanged: domain => changes.push(domain), onProgress: update => progress.push(update.stage) })
  await assert.rejects(storage.call('assistant', 'listProjects', []), /not ready/)
  await storage.ready
  assert.ok(progress.includes('upgrading'))
  const projects = await storage.call('assistant', 'listProjects', [])
  assert.ok(projects.length > 0)
  // More requests than the in-flight bound wait in order; none fail for capacity.
  const burst = Array.from({ length: 100 }, (_, index) =>
    index % 2 ? storage.call('assistant', 'listConversationQueueItems', [`burst-${index}`]) : storage.call('assistant', 'listConversationSummaries', []))
  assert.equal((await Promise.all(burst)).length, 100)
  assert.ok(storage.admissionHighWaterOperations >= 100)
  const sshWrite = { project: { name: 'Remote project', description: '', rootPath: '/srv/work' },
    executionSpace: { kind: 'ssh' as const, hostId: randomUUID(), remoteRootPath: '/srv/work' } }
  const ssh = await storage.call('assistant', 'createSshProject', [sshWrite])
  const renamed = await storage.call('assistant', 'updateSshProject', [ssh.id, ssh.updatedAt, {
    ...sshWrite, project: { ...sshWrite.project, name: 'Renamed remote' }
  }])
  assert.equal(renamed.name, 'Renamed remote')
  await assert.rejects(storage.call('assistant', 'updateSshProject', [ssh.id, ssh.updatedAt, sshWrite]))
  assert.equal((await storage.call('assistant', 'getProject', [ssh.id])).name, 'Renamed remote')
  const id = randomUUID()
  const messageId = randomUUID()
  await storage.call('assistant', 'saveLocalConversations', [[{
    header: { id, title: 'storage fixture', updatedAt: 123 },
    messages: [{ id: messageId, role: 'user', state: 'complete', content: 'preserved body', createdAt: 123 }]
  }]])
  assert.equal((await storage.call('assistant', 'getConversation', [id])).messages[0]!.content, 'preserved body')
  await storage.call('assistant', 'createMagicNote', [{ title: 'note', content: { version: 1, ops: [{ insert: 'body\n' }] } }])
  assert.ok(changes.includes('magicNotes'))
  const library = await storage.call('knowledge', 'createKnowledgeBase', [{ name: 'Storage test', storageMode: 'reference' }])
  const source = await storage.call('knowledge', 'upsertSource', [{ knowledgeBaseId: library.id, type: 'file',
    location: join(root, 'doc.md'), displayName: 'doc', status: 'ready' }])
  const documentInput = { id: randomUUID(), knowledgeBaseId: library.id, sourceId: source.id, externalId: 'doc', title: 'Document' }
  const chunks = [{ id: randomUUID(), ordinal: 0, content: 'lighthouse harbor', location: 'line 1' }]
  await storage.call('knowledge', 'publishDocument', [documentInput, chunks])
  assert.equal((await storage.call('knowledge', 'search', [{ knowledgeBaseId: library.id, query: 'lighthouse' }]))[0]!.chunk.id, chunks[0]!.id)
  assert.deepEqual(await storage.call('knowledge', 'graphSearch', [library.id, 'harbor']), [])
  assert.deepEqual(await storage.call('knowledge', 'vectorSearch', [{ knowledgeBaseId: library.id, provider: 'p', model: 'm', vector: [1, 0] }]), [])
  await assert.rejects(storage.call('knowledge', 'replaceEvidenceForDocument' as never, [documentInput.id] as never), /Unknown storage operation/)
  const counts = await storage.call('knowledge', 'getKnowledgeBaseCounts', [])
  assert.ok(counts instanceof Map)
  assert.ok(counts.has(library.id))
  // A failure inside the owner-created graph callback rolls back the document/chunks.
  await assert.rejects(storage.call('knowledge', 'publishDocument', [{ ...documentInput, title: 'must roll back' }, chunks, {
    graph: { strategy: 'rules', requiresModelApproval: false, entities: [{ id: 'e', name: 'Harbor', type: 'concept', aliases: [], evidence: [{
      chunkId: 'missing-chunk', quote: 'harbor', start: 11, end: 17, confidence: 1, source: 'rules'
    }] }], relations: [], warnings: [] }
  }]))
  assert.equal((await storage.call('knowledge', 'getDocument', [documentInput.id]))!.title, 'Document')
  await storage.call('knowledge', 'publishDocument', [documentInput, chunks, {
    graph: { strategy: 'rules', requiresModelApproval: false, entities: [{ id: 'e', name: 'Harbor', type: 'CONCEPT', aliases: [], evidence: [{
      chunkId: chunks[0]!.id, quote: 'harbor', start: 11, end: 17, confidence: 1, source: 'rules'
    }] }], relations: [], warnings: [] }
  }])
  assert.equal((await storage.call('knowledge', 'listEvidence', [library.id])).length, 1)
  const document = (await storage.call('knowledge', 'getDocument', [documentInput.id]))!
  await assert.rejects(storage.call('knowledge', 'replaceDocumentGraph', [library, document, {
    strategy: 'rules', requiresModelApproval: false, entities: [{ id: 'e', name: 'Harbor', type: 'CONCEPT', aliases: [], evidence: [{
      chunkId: 'missing', quote: 'harbor', start: 11, end: 17, confidence: 1, source: 'rules'
    }] }], relations: [], warnings: []
  }]))
  assert.equal((await storage.call('knowledge', 'listEvidence', [library.id])).length, 1)
  await storage.call('knowledge', 'replaceDocumentGraph', [library, document, {
    strategy: 'rules', requiresModelApproval: false, entities: [], relations: [], warnings: []
  }])
  assert.equal((await storage.call('knowledge', 'listEvidence', [library.id])).length, 0)

  const files = createDesktopStorageFiles(storage)
  const runtime = createDesktopRuntimeStorageAdapters((domain, method, args) => storage.call(domain, method, args))
  assert.equal(await runtime.bindingStore.getByConversation('missing'), undefined)
  const ledgerPath = join(root, 'model-calls.sqlite')
  const ledger = await runtime.openModelCallLedger(ledgerPath)
  await ledger.claim({ callId: 'call', bindingId: 'binding', operationId: 'operation', promptSequence: 0,
    roundIndex: 0, profileDigest: 'profile', requestDigest: 'request' })
  const handle = `process:${randomUUID()}`
  await files.attachments.outputCreate('call', handle)
  await files.attachments.outputAppend('call', handle, Buffer.from('complete'))
  await files.attachments.outputFinish('call', handle, 8)
  await files.attachments.outputAdopt('call', handle, id, 'message', messageId)
  await files.attachments.outputRelease('call', handle)
  const parsed = { title: 'Source', sourceFormat: '.txt', content: 'Parsed text', sections: [], warnings: [] }
  const parsedResult = await files.results.save('source.txt', Buffer.from('original'), parsed, defaultDocumentParsingSettings, 1)
  await files.results.move(parsedResult.id, join(root, 'knowledge-assets', library.id, document.id, parsedResult.id))
  await writeFile(source.location, 'original')
  await storage.call('knowledge', 'publishDocument', [{ ...documentInput, sourceLocation: source.location,
    metadata: { parsedResultId: parsedResult.id, nested: { values: [1, null, { preserved: true }] } } }, chunks])
  await files.results.detach(parsedResult.id)
  assert.equal((await files.results.get(parsedResult.id)).content, 'Parsed text')
  assert.ok(await storage.call('stories', 'directCounts', [projects[0]!.id]) instanceof Map)
  assert.deepEqual(await storage.call('external', 'listInstances', []), [])
  await assert.rejects(storage.call('knowledge', 'search', [{ knowledgeBaseId: library.id, query: 'x', limit: 10000 }]), RangeError)
  await assert.rejects(storage.call('assistant', 'saveLocalConversations', [(() => undefined) as never]), /callbacks/)
  let peakRss = process.memoryUsage().rss
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 10)
  const videoBytes = Buffer.alloc(MAGIC_NOTE_MAX_VIDEO_BYTES)
  videoBytes.writeUInt32BE(24, 0)
  videoBytes.write('ftypisom', 4, 'ascii')
  videoBytes.write('isomiso2', 16, 'ascii')
  videoBytes.writeUInt32BE(videoBytes.length - 24, 24)
  videoBytes.write('mdat', 28, 'ascii')
  const video = `data:video/mp4;base64,${videoBytes.toString('base64')}`
  const content: MagicNoteContent = { version: 1, ops: [{ insert: { localVideo: {
    name: 'supported.mp4', mimeType: 'video/mp4', size: MAGIC_NOTE_MAX_VIDEO_BYTES, dataUrl: video
  } } }, { insert: '\n' }] }
  const savingVideo = storage.call('assistant', 'createMagicNote', [{ title: 'Full video', content }])
  // A large write retains its write budget without blocking an unrelated read.
  assert.ok((await storage.call('assistant', 'listProjects', [])).length > 0)
  const videoNote = await savingVideo
  await storage.call('assistant', 'createMagicNoteEntry', [{ noteId: videoNote.id, content, plainText: '' }])
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const expectedVideo = digest(video)
  for (let i = 0; i < 2; i++) {
    const note = await storage.call('assistant', 'getMagicNote', [videoNote.id])
    assert.equal(note.entries.length, 2)
    for (const entry of note.entries) {
      assert.ok(entry.content.version === 1)
      const insert = entry.content.ops[0]!.insert
      assert.ok(typeof insert === 'object' && 'localVideo' in insert)
      assert.equal(insert.localVideo.size, MAGIC_NOTE_MAX_VIDEO_BYTES)
      assert.equal(digest(insert.localVideo.dataUrl), expectedVideo)
    }
  }
  const historyId = randomUUID()
  const histories = Array.from({ length: 80 }, (_, index) => ({ id: randomUUID(), role: 'user' as const,
    state: 'complete' as const, content: `${index}:` + 'history '.repeat(40_000), createdAt: index }))
  await storage.call('assistant', 'saveLocalConversations', [[{ header: { id: historyId, title: 'Large history', updatedAt: 123 }, messages: histories }]])
  const history = await storage.call('assistant', 'getConversation', [historyId])
  assert.equal(history.messages.length, histories.length)
  assert.deepEqual(history.messages.map(row => digest(row.content)), histories.map(row => digest(row.content)))
  clearInterval(sample)
  const aborted = new AbortController()
  aborted.abort(new Error('not dispatched'))
  await assert.rejects(storage.call('assistant', 'deleteLocalConversation', [id], { signal: aborted.signal }), /not dispatched/)
  const writes = Array.from({ length: 8 }, (_, index) => storage.call('knowledge', 'updateKnowledgeBase', [library.id, { name: `Saved ${index}` }]))
  const temporarySave = files.results.save('temporary.txt', Buffer.from('temporary'), parsed, defaultDocumentParsingSettings, 1)
  const closing = storage.close()
  await assert.rejects(storage.call('assistant', 'listProjects', []), /not ready/)
  await Promise.all(writes)
  const temporary = await temporarySave
  await closing
  console.log('storage-memory:' + JSON.stringify({ peakMainRss: peakRss,
    videoBytes: MAGIC_NOTE_MAX_VIDEO_BYTES, historyCharacters: histories.reduce((n, row) => n + row.content.length, 0) }))
  await assert.rejects(stat(join(root, 'temp', 'document-parsing', temporary.id)), { code: 'ENOENT' })
  assert.equal(storage.pendingCount, 0)
  const reopened = new DesktopStorageClient(options)
  await reopened.ready
  assert.equal((await reopened.call('knowledge', 'getKnowledgeBase', [library.id]))!.name, 'Saved 7')
  assert.equal((await reopened.call('assistant', 'getConversation', [id])).messages[0]!.content, 'preserved body')
  const reopenedFiles = createDesktopStorageFiles(reopened)
  assert.equal((await reopenedFiles.results.get(parsedResult.id)).content, 'Parsed text')
  assert.equal(await reopenedFiles.results.original(parsedResult.id), source.location)
  assert.equal(Buffer.from(await reopenedFiles.attachments.outputRead(id, handle, 0, 8)).toString(), 'complete')
  const reopenedRuntime = createDesktopRuntimeStorageAdapters((domain, method, args) => reopened.call(domain, method, args))
  const reopenedLedger = await reopenedRuntime.openModelCallLedger(ledgerPath)
  assert.equal((await reopenedLedger.get('call'))!.status, 'outcome-unknown')
  await reopenedLedger.close()
  await reopened.close()

  const retrying = new DesktopStorageClient({ ...options, knowledgePath: join(root, 'retry', 'knowledge.sqlite') })
  await assert.rejects(retrying.ready)
  await mkdir(join(root, 'retry'))
  await retrying.retry()
  assert.ok((await retrying.call('assistant', 'listProjects', [])).length)
  await retrying.close()

  const failureRoot = join(root, 'runtime-failure')
  await mkdir(join(failureRoot, 'remote-runtime-bindings.sqlite'), { recursive: true })
  const runtimeRetry = new DesktopStorageClient({ ...options, userDataPath: failureRoot,
    assistantPath: join(failureRoot, 'assistant.sqlite'), knowledgePath: join(failureRoot, 'knowledge.sqlite') })
  await assert.rejects(runtimeRetry.ready)
  await rm(join(failureRoot, 'remote-runtime-bindings.sqlite'), { recursive: true })
  await runtimeRetry.retry()
  assert.equal(await runtimeRetry.call('attachments', 'has', ['missing']), false)
  await runtimeRetry.close()

  const lost = new DesktopStorageClient(options)
  await lost.ready
  const lostFiles = createDesktopStorageFiles(lost)
  const abandoned = `process:${randomUUID()}`
  await lostFiles.attachments.outputCreate('crashed-call', abandoned)
  await lostFiles.attachments.outputAppend('crashed-call', abandoned, Buffer.from('orphan'))
  await lostFiles.attachments.outputFinish('crashed-call', abandoned, 6)
  const internal = lost as unknown as { transport: { child: { kill(): boolean; postMessage(message: unknown): void } } }
  const post = internal.transport.child.postMessage.bind(internal.transport.child)
  let killed = false
  internal.transport.child.postMessage = message => {
    post(message)
    if (!killed && (message as { type: string }).type === 'call') {
      killed = true
      assert.ok(internal.transport.child.kill())
    }
  }
  const neverReplayId = randomUUID()
  await assert.rejects(lost.call('assistant', 'saveLocalConversations', [[{
    header: { id: neverReplayId, title: 'Never replay', updatedAt: 123 }, messages: histories
  }]]), { code: 'STORAGE_UNCONFIRMED' })
  await assert.rejects(lost.call('assistant', 'listProjects', []), /not ready/)
  await lost.retry()
  await lost.ready
  assert.deepEqual(await lost.call('assistant', 'searchConversations', ['Never replay']), [])
  const recoveredFiles = createDesktopStorageFiles(lost)
  assert.equal(await recoveredFiles.attachments.has(abandoned.split(':')[1]!), false)
  assert.equal(Buffer.from(await recoveredFiles.attachments.outputRead(id, handle, 0, 8)).toString(), 'complete')
  await lost.close()

  const largeChange = (title: string) => [{ header: { id: randomUUID(), title, updatedAt: 123 },
    messages: [{ id: randomUUID(), role: 'user' as const, state: 'complete' as const, content: 'large '.repeat(100_000), createdAt: 123 }] }]
  const cancelled = new DesktopStorageClient(options)
  await cancelled.ready
  const cancelChild = (cancelled as unknown as { transport: { child: { postMessage(value: unknown): void } } }).transport.child
  const cancelPost = cancelChild.postMessage.bind(cancelChild)
  const cancellation = new AbortController()
  let interrupted = false
  cancelChild.postMessage = value => {
    cancelPost(value)
    if (!interrupted && (value as { type: string }).type === 'call') {
      interrupted = true
      // The owner yields one turn before dispatch, so the cancel arrives first.
      cancellation.abort()
      assert.equal(cancelled.pendingCount, 1)
    }
  }
  await assert.rejects(cancelled.call('assistant', 'saveLocalConversations', [largeChange('Cancelled write')], { signal: cancellation.signal }), { name: 'AbortError' })
  cancelChild.postMessage = cancelPost
  assert.deepEqual(await cancelled.call('assistant', 'searchConversations', ['Cancelled write']), [])
  assert.equal((cancelled as unknown as { transport: { child: unknown } }).transport.child, cancelChild)
  await cancelled.close()

  const faulted = new DesktopStorageClient(options)
  await faulted.ready
  const faultChild = (faulted as unknown as { transport: { child: { postMessage(value: unknown): void } } }).transport.child
  const faultPost = faultChild.postMessage.bind(faultChild)
  let injected = false
  faultChild.postMessage = value => {
    if (!injected && (value as { type: string }).type === 'call') { injected = true; throw new Error('Injected posting failure') }
    faultPost(value)
  }
  // A request that was never posted fails without poisoning the healthy host.
  await assert.rejects(faulted.call('assistant', 'saveLocalConversations', [largeChange('Failed post')]), /could not be posted/)
  assert.deepEqual(await faulted.call('assistant', 'searchConversations', ['Failed post']), [])
  const complete = largeChange('Drain writes')
  const writing = faulted.call('assistant', 'saveLocalConversations', [complete])
  const draining = faulted.close()
  await writing
  await draining
  const drained = new DesktopStorageClient(options)
  await drained.ready
  assert.equal((await drained.call('assistant', 'getConversation', [complete[0]!.header.id])).messages[0]!.content, complete[0]!.messages[0]!.content)
  await drained.close()

  let startupKilled = false
  const retryProgress: string[] = []
  const startupLost = new DesktopStorageClient({ ...options, confirmedUpgrade: { migrateNotes: false, reclaimSpace: false },
    onProgress: update => retryProgress.push(update.stage) })
  const startupInternal = startupLost as unknown as { transport: {
    on(event: string, listener: (message: { type: string; upgrade?: unknown }) => void): void
    child: { kill(): boolean }
    waitForExit(): Promise<number>
  } }
  startupInternal.transport.on('storageMessage', message => {
    if (!startupKilled && message.type === 'upgrade' && message.upgrade) {
      startupKilled = true
      assert.ok(startupInternal.transport.child.kill())
    }
  })
  await assert.rejects(startupLost.ready)
  const beforeRetry = retryProgress.length
  await startupLost.retry()
  assert.ok(retryProgress.length > beforeRetry, 'replacement must retain the confirmed upgrade decision')
  assert.ok((await startupLost.call('assistant', 'listProjects', [])).length)
  const afterUpgrade = retryProgress.length
  assert.ok(startupInternal.transport.child.kill())
  await startupInternal.transport.waitForExit()
  await startupLost.retry()
  assert.equal(retryProgress.length, afterUpgrade, 'completed upgrades must not be repeated after a later crash')
  await startupLost.close()

  const earlyClose = new DesktopStorageClient(options)
  await earlyClose.close()
  await assert.rejects(earlyClose.ready, /closed before readiness/)

  // Exercise actual Electron serialization without adding a test-only owner endpoint.
  const transport = new DesktopStorageTransport(join(root, 'desktop-storage-echo.cjs'))
  await new Promise<void>(resolve => transport.once('spawn', resolve))
  const result = new Promise<unknown>(resolve => transport.once('message', message => resolve(message.result)))
  transport.postMessage({ type: 'query', id: 1, op: 'test.echo', args: [Buffer.from([0, 128, 255]), new Map([['key', 3]])], cancel: new SharedArrayBuffer(4) })
  const values = await result as [Uint8Array, Map<string, number>]
  assert.ok(values[0] instanceof Uint8Array)
  assert.deepEqual([...values[0]], [0, 128, 255])
  assert.ok(values[1] instanceof Map)
  assert.equal(values[1].get('key'), 3)
  await transport.terminate()
  console.log('desktop-storage-electron: passed')
}

void run().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
