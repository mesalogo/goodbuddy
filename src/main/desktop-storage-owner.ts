import { stat } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { AssistantDatabase } from './assistant/assistant-database'
import { KnowledgeDatabase } from './knowledge/knowledge-database'
import { getPendingAssistantStorageUpgrade, type AssistantStorageUpgrade } from './assistant/assistant-storage-upgrade'
import { ReadonlyQueryReader } from './readonly-query-reader'
import { publishStorageDocument } from './desktop-storage-publication'
import { replaceDocumentGraph } from './desktop-storage-knowledge-operations'
import { openDesktopStorageFiles, type DesktopStorageFilesOwner } from './desktop-storage-files'
import { DesktopStorageRuntimeOwner, runtimeStorageMethods } from './desktop-storage-runtime-operations'
import type { ReviewState } from './assistant/supervision-review-store'
import {
  assistantStorageMethods, knowledgeStorageMethods, repositoryStorageMethods, STORAGE_MAX_PENDING,
  type DesktopStorageDomains, type DesktopStorageOptions, type StorageError, type StorageRequest, type StorageResponse
} from './desktop-storage-contracts'

export function storageError(error: unknown, depth = 0): StorageError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  const details = error as Error & { code?: string; issues?: unknown }
  return { name: error.name, message: error.message, code: details.code, issues: details.issues,
    cause: error.cause && depth < 3 ? storageError(error.cause, depth + 1) : undefined }
}

const assistantReads: Record<string, string> = {
  listConversationSummaries: 'listConversationSummaries', getConversation: 'getConversation',
  searchConversations: 'searchConversations', readStoryGraph: 'readStoryGraph',
  getActivityHistoryPage: 'activityHistoryPage', getActivityHistorySummary: 'activityHistorySummary',
  listSupervisionResults: 'supervisionOverview', getSupervisionGraph: 'supervisionGraph',
  getSupervisionStories: 'supervisionStories', supervisionContext: 'reviewContext',
  listSupervisionCandidates: 'reviewCandidates'
}

/** Runs only in the storage host. No model/network work or transported callbacks. */
export class DesktopStorageOwner {
  private assistant?: AssistantDatabase
  private knowledge?: KnowledgeDatabase
  private files?: DesktopStorageFilesOwner
  private runtime?: DesktopStorageRuntimeOwner
  private readers?: { assistant: ReadonlyQueryReader; knowledge: ReadonlyQueryReader }
  private checkpoint?: Worker
  private checkpointExit?: Promise<void>
  private startup?: Promise<void>
  private upgrade?: AssistantStorageUpgrade
  private upgradeCancel?: Int32Array
  private state: 'new' | 'opening' | 'ready' | 'failed' | 'closing' | 'closed' = 'new'
  private readonly active = new Map<number, { controller: AbortController; done: Promise<void> }>()
  private closing?: Promise<void>
  private readonly reviewing = new Set<string>()
  private readonly cancelled = new Set<number>()
  private lastCallId = 0

  constructor(private readonly post: (response: StorageResponse) => void | Promise<void>) {}

  receive(message: StorageRequest): void {
    if (message.type === 'close') { void this.close(); return }
    if (message.type === 'cancel') {
      const active = this.active.get(message.id)
      if (active) active.controller.abort()
      else if (message.id > this.lastCallId && this.cancelled.size < STORAGE_MAX_PENDING) this.cancelled.add(message.id)
      return
    }
    if (message.type === 'open') {
      if (this.state !== 'new' && this.state !== 'failed') return
      this.state = 'opening'
      this.startup = this.open(message.options).then(() => {
        if (this.state === 'opening') { this.state = 'ready'; this.post({ type: 'ready' }) }
      }, async error => {
        try { await this.release() } catch (closeError) {
          this.state = 'closed'
          this.post({ type: 'failed', error: storageError(closeError) })
          return
        }
        if (this.state === 'opening') { this.state = 'failed'; this.post({ type: 'failed', error: storageError(error) }) }
      })
      return
    }
    const { id, domain, method, args } = message
    this.lastCallId = Math.max(this.lastCallId, id)
    // The client bounds in-flight requests; the owner only rejects invalid states.
    if (this.state !== 'ready' || this.active.has(id)) {
      this.post({ type: 'error', id, error: storageError(new Error(this.state !== 'ready' ? 'Storage is not ready' : 'Duplicate storage request')) })
      return
    }
    const controller = new AbortController()
    if (this.cancelled.delete(id)) controller.abort()
    // One execution turn before dispatch lets queued cancellation remove work.
    const done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      try {
        controller.signal.throwIfAborted()
        const result = await this.dispatch(domain, method, args, controller.signal)
        await this.post({ type: 'result', id, result })
      } catch (error) { await this.post({ type: 'error', id, error: storageError(error) }) }
      finally { this.active.delete(id) }
    })
    this.active.set(id, { controller, done })
  }

  private async open(options: DesktopStorageOptions): Promise<void> {
    const file = await stat(options.assistantPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    this.upgrade ??= options.confirmedUpgrade ?? (file ? getPendingAssistantStorageUpgrade(options.assistantPath) : undefined)
    await this.post({ type: 'upgrade', upgrade: this.upgrade })
    if (this.upgrade) {
      const cancellation = new SharedArrayBuffer(4)
      this.upgradeCancel = new Int32Array(cancellation)
      if (this.state === 'closing') Atomics.store(this.upgradeCancel, 0, 1)
      await new Promise<void>((resolve, reject) => {
        const worker = new Worker(options.upgradeWorkerPath!, {
          workerData: { databasePath: options.assistantPath, cancellation, upgrade: this.upgrade }
        })
        let failure: Error | undefined
        let done = false
        worker.on('message', message => {
          if (message.progress) this.post({ type: 'progress', progress: message.progress })
          if (message.error) failure = new Error(message.error)
          if (message.done) done = true
        })
        worker.once('error', error => { failure = error instanceof Error ? error : new Error(String(error)) })
        worker.once('exit', code => {
          this.upgradeCancel = undefined
          if (failure) reject(failure)
          else if (done && code === 0) resolve()
          else reject(new Error('Storage upgrade did not complete'))
        })
      })
      this.upgrade = undefined
      await this.post({ type: 'upgrade' })
    }
    if (this.state === 'closing') return
    this.assistant = new AssistantDatabase(options.assistantPath, {
      onMagicNotesChanged: () => this.post({ type: 'changed', domain: 'magicNotes' }),
      onMagicTodosChanged: () => this.post({ type: 'changed', domain: 'magicTodos' }),
      onModelUsageChanged: () => this.post({ type: 'changed', domain: 'modelUsage' })
    })
    this.assistant.initialize(options.defaultRootPath)
    this.assistant.onExecutionStatsChanged(() => this.post({ type: 'changed', domain: 'executionStats' }))
    this.knowledge = new KnowledgeDatabase(options.knowledgePath)
    this.knowledge.initialize()
    this.files = await openDesktopStorageFiles(options.userDataPath,
      (conversationId, kind, ownerId) => this.assistant!.hasAttachmentOwner(conversationId, kind, ownerId),
      id => {
        const document = this.knowledge!.getDocumentByParsedResultId(id)
        if (!document?.sourceLocation) return undefined
        return { directory: join(options.userDataPath, 'knowledge-assets', document.knowledgeBaseId, document.id, id), original: document.sourceLocation }
      })
    this.files.dispatch('attachments', 'reconcile', [true])
    this.runtime = await DesktopStorageRuntimeOwner.open(options.userDataPath)
    this.readers = {
      assistant: new ReadonlyQueryReader('assistant', options.assistantPath, options.readerWorkerPath!),
      knowledge: new ReadonlyQueryReader('knowledge', options.knowledgePath, options.readerWorkerPath!)
    }
    // Reuse the existing PASSIVE checkpoint entry; observe its exit before DB close.
    const checkpoint = new Worker(options.readerWorkerPath!, {
      workerData: { kind: 'checkpoint', databasePath: options.assistantPath, intervalMs: 250 }
    })
    this.checkpoint = checkpoint
    this.checkpointExit = new Promise(resolve => checkpoint.once('exit', () => resolve()))
    checkpoint.on('error', () => { /* SQLite automatic checkpoints remain enabled. */ })
  }

  private dispatch(domain: string, method: string, args: unknown[], signal: AbortSignal): unknown {
    const assistant = this.assistant!
    const knowledge = this.knowledge!
    if (domain === 'attachments' || domain === 'documentResults') return this.files!.dispatch(domain, method, args, signal)
    // Main validates the live host/runtime before posting. The database retains
    // its project revision checks; its synchronous callback stays owner-local.
    if (domain === 'assistant' && method === 'createSshProject') {
      const [write] = args as Parameters<DesktopStorageDomains['assistant']['createSshProject']>
      return assistant.createSshProject({ ...write, assertCurrent: () => signal.throwIfAborted() })
    }
    if (domain === 'assistant' && method === 'updateSshProject') {
      const [projectId, expectedUpdatedAt, write] = args as Parameters<DesktopStorageDomains['assistant']['updateSshProject']>
      return assistant.updateSshProject(projectId, expectedUpdatedAt, { ...write, assertCurrent: () => signal.throwIfAborted() })
    }
    if (domain === 'assistant' && Object.hasOwn(assistantReads, method)) {
      return this.readers!.assistant.call(assistantReads[method]!, args, signal)
    }
    if (domain === 'knowledge' && ['search', 'vectorSearch', 'graphSearch', 'hybridSearch', 'hybridSearchWithDiagnostics'].includes(method)) {
      const result = this.readers!.knowledge.call<ReturnType<KnowledgeDatabase['hybridSearchWithDiagnostics']>>(
        method === 'hybridSearch' ? 'hybridSearchWithDiagnostics' : method, args, signal)
      return method === 'hybridSearch' ? result.then(page => page.results) : result
    }
    if (domain === 'knowledge' && method === 'publishDocument') {
      return publishStorageDocument(knowledge, ...args as Parameters<DesktopStorageDomains['knowledge']['publishDocument']>)
    }
    if (domain === 'knowledge' && method === 'replaceDocumentGraph') {
      return replaceDocumentGraph(knowledge, ...args as Parameters<DesktopStorageDomains['knowledge']['replaceDocumentGraph']>)
    }
    if (domain === 'review' && (method === 'initialize' || method === 'resume')) {
      const runId = String(args[0])
      if (this.reviewing.has(runId)) throw new Error('Review manifest operation is already running')
      const manifest = this.readers!.assistant.reviewManifest(runId)
      const store = assistant.supervisionReviewStore()
      this.reviewing.add(runId)
      const operation = method === 'initialize'
        ? store.initializeWithReader(runId, args[1] as ReviewState, manifest, signal)
        : store.resumeWithReader(runId, manifest, signal)
      return operation.finally(() => this.reviewing.delete(runId))
    }
    let target: object
    let allowed: readonly string[]
    if (domain === 'assistant') { target = assistant; allowed = assistantStorageMethods }
    else if (domain === 'knowledge') { target = knowledge; allowed = knowledgeStorageMethods }
    else if (domain === 'runtime') { target = this.runtime!; allowed = runtimeStorageMethods }
    else {
      if (!Object.hasOwn(repositoryStorageMethods, domain)) throw new Error('Unknown storage domain')
      allowed = repositoryStorageMethods[domain as keyof typeof repositoryStorageMethods]
      if (!allowed.includes(method)) throw new Error('Unknown storage operation')
      switch (domain) {
        case 'review': target = assistant.supervisionReviewStore(signal); break
        case 'stories': target = assistant.supervisionStories(); break
        case 'experiences': target = assistant.supervisionExperiences(); break
        case 'suggestions': target = assistant.supervisionSuggestions(); break
        default: target = knowledge.externalStore
      }
    }
    if (!allowed.includes(method)) throw new Error('Unknown storage operation')
    const operation = (target as Record<string, (...input: unknown[]) => unknown>)[method]!
    return operation.apply(target, args)
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.state = 'closing'
    if (this.upgradeCancel) Atomics.store(this.upgradeCancel, 0, 1)
    this.closing = (async () => {
      let results: PromiseSettledResult<void>[]
      try {
        await this.startup
        results = await Promise.allSettled([...this.active.values()].map(request => request.done))
      } finally { await this.release() }
      for (const result of results) if (result.status === 'rejected') throw result.reason
      this.state = 'closed'
      await this.post({ type: 'closed' })
    })()
    return this.closing
  }

  private async release(): Promise<void> {
    const errors: unknown[] = []
    // Attempt every close even if an earlier file cleanup fails. Dependencies stay
    // open until the file owner and all readers have reached their close barriers.
    for (const close of [
      async () => { await this.files?.close(); this.files = undefined },
      async () => { this.runtime?.close(); this.runtime = undefined },
      async () => {
        const results = await Promise.allSettled([this.readers?.assistant.close(), this.readers?.knowledge.close()])
        this.readers = undefined
        for (const result of results) if (result.status === 'rejected') throw result.reason
      },
      async () => {
        if (this.checkpoint) {
          this.checkpoint.postMessage({ type: 'close' })
          await this.checkpointExit
          this.checkpoint = undefined
        }
      },
      async () => { this.knowledge?.close(); this.knowledge = undefined },
      async () => { this.assistant?.close(); this.assistant = undefined }
    ]) {
      try { await close() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw Object.assign(new AggregateError(errors, 'Storage close did not complete', { cause: errors[0] }), { code: 'STORAGE_CLOSE_FAILED' })
  }
}
