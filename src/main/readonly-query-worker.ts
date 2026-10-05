import { parentPort, workerData } from 'node:worker_threads'
import { z } from 'zod'
import { AssistantDatabase } from './assistant/assistant-database'
import { KnowledgeDatabase } from './knowledge/knowledge-database'
import type { ReadonlyQueryKind, ReadonlyQueryRequest } from './readonly-query-reader'
import type { ReviewState } from './assistant/supervision-review-store'

// Read-only query worker (PERF-15/16 first slice). One worker per database file.
// It reuses the production classes on a read-only connection, so results are
// produced by exactly the same code as the synchronous path.
// This packaged entry also hosts the WAL checkpointer and the dedicated,
// separately connected supervision manifest writer.

const { kind, databasePath, intervalMs } = workerData as {
  kind: ReadonlyQueryKind | 'checkpoint' | 'supervision'
  databasePath: string
  intervalMs?: number
}

type Handler = (args: unknown[], signal: AbortSignal) => unknown
let handlers: Record<string, Handler>
let close: () => void

if (kind === 'checkpoint') {
  // WAL checkpointer for AssistantDatabase.enableWalCheckpointWorker (PERF-15):
  // PASSIVE checkpoints never wait for, or block, Main's readers and writers.
  const database = new AssistantDatabase(databasePath)
  database.openCheckpointer()
  const timer = setInterval(() => {
    try {
      database.checkpointWal()
    } catch {
      // SQLITE_BUSY and similar: try again on the next tick.
    }
  }, intervalMs ?? 1_000)
  close = () => {
    clearInterval(timer)
    database.close()
  }
  handlers = {}
  parentPort!.postMessage({ ready: true })
} else if (kind === 'supervision') {
  // Only manifest initialization and resume validation write here. Publication
  // and checkpoints remain in Main's existing atomic result transaction.
  const database = new AssistantDatabase(databasePath)
  database.openSupervisionWorker()
  close = () => database.close()
  handlers = {
    initialize: ([runId, state], signal) => database.supervisionReviewStore(signal).initializeSources(String(runId), state as ReviewState, signal),
    resume: ([runId], signal) => database.supervisionReviewStore(signal).resume(String(runId), signal)
  }
} else if (kind === 'knowledge') {
  const database = new KnowledgeDatabase(databasePath)
  database.openReadOnly()
  close = () => database.close()
  handlers = {
    search: ([options]) => database.search(options as Parameters<KnowledgeDatabase['search']>[0]),
    hybridSearchWithDiagnostics: ([options], signal) => database.hybridSearchWithDiagnostics({
      ...(options as Parameters<KnowledgeDatabase['hybridSearchWithDiagnostics']>[0]), signal
    })
  }
} else {
  const database = new AssistantDatabase(databasePath)
  database.openReadOnly()
  close = () => database.close()
  handlers = {
    readStoryGraph: ([name, input, projectId], signal) => database.readStoryGraph(
      name as Parameters<AssistantDatabase['readStoryGraph']>[0], input, projectId as string | undefined, signal),
    supervisionOverview: ([limit, target, resultId]) => database.readSnapshot(() => database.listSupervisionResults(
      limit as number, target as Parameters<AssistantDatabase['listSupervisionResults']>[1], resultId as string | undefined)),
    supervisionGraph: ([input]) => database.readSnapshot(() => database.getSupervisionGraph(input as Parameters<AssistantDatabase['getSupervisionGraph']>[0])),
    supervisionStories: ([scope]) => database.readSnapshot(() => database.getSupervisionStories(scope as ReviewState['request']['scope'])),
    searchConversations: ([query]) => database.searchConversations(query as string),
    // Several statements each: read them from one snapshot.
    listConversationSummaries: ([detailIds]) => database.readSnapshot(() =>
      database.listConversationSummaries(detailIds as string[])),
    getConversation: ([conversationId]) => database.readSnapshot(() =>
      database.getConversation(conversationId as string)),
    activityHistoryPage: ([input]) => database.getActivityHistoryPage(input),
    activityHistorySummary: ([input]) => database.getActivityHistorySummary(input),
    reviewContext: ([request]) => {
      const scope = (request as ReviewState['request']).scope
      return database.readSnapshot(() => ({ summary: database.reviewSummary(scope, 'supervisor'), background: database.reviewBackground(scope) }))
    },
    reviewCandidates: ([request, batch]) => database.listSupervisionCandidates(request as ReviewState['request'],
      batch as Parameters<AssistantDatabase['listSupervisionCandidates']>[1])
  }
}

/** A signal backed by the shared cancel flag; queries poll it via throwIfAborted(). */
function sharedSignal(cancel: SharedArrayBuffer): AbortSignal {
  const flag = new Int32Array(cancel)
  const reason = (): Error => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  const signal = new AbortController().signal
  Object.defineProperties(signal, {
    aborted: { get: () => Atomics.load(flag, 0) === 1 },
    reason: { get: () => (Atomics.load(flag, 0) === 1 ? reason() : undefined) },
    throwIfAborted: { value: () => { if (Atomics.load(flag, 0) === 1) throw reason() } }
  })
  return signal
}

function serializeError(error: unknown): { name: string; message: string; issues?: unknown } {
  if (error instanceof z.ZodError) return { name: 'ZodError', message: error.message, issues: error.issues }
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}

parentPort!.on('message', (message: ReadonlyQueryRequest) => {
  try {
    const handler = Object.hasOwn(handlers, message.op) ? handlers[message.op] : undefined
    if (!handler) throw new Error(`Unknown readonly query: ${message.op}`)
    const signal = sharedSignal(message.cancel)
    signal.throwIfAborted()
    parentPort!.postMessage({ id: message.id, result: handler(message.args, signal) })
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: serializeError(error) })
  }
})
parentPort!.on('close', () => close())
