import { parentPort, workerData } from 'node:worker_threads'
import { z } from 'zod'
import { AssistantDatabase } from './assistant/assistant-database'
import { KnowledgeDatabase } from './knowledge/knowledge-database'
import type { ReadonlyQueryKind, ReadonlyQueryRequest } from './readonly-query-reader'

// Read-only query worker (PERF-15/16 first slice). One worker per database file.
// It reuses the production classes on a read-only connection, so results are
// produced by exactly the same code as the synchronous path.

const { kind, databasePath } = workerData as { kind: ReadonlyQueryKind; databasePath: string }

type Handler = (args: unknown[], signal: AbortSignal) => unknown
let handlers: Record<string, Handler>
let close: () => void

if (kind === 'knowledge') {
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
    searchConversations: ([query]) => database.searchConversations(query as string),
    // Several statements each: read them from one snapshot.
    listConversationSummaries: ([detailIds]) => database.readSnapshot(() =>
      database.listConversationSummaries(detailIds as string[])),
    getConversation: ([conversationId]) => database.readSnapshot(() =>
      database.getConversation(conversationId as string))
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
