import type { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { createSupervisionDomainPorts } from '../../src/main/assistant/supervision-domain-ports'
import type { DesktopStorageClient } from '../../src/main/desktop-storage-client'
import { storageDataBytes } from '../../src/main/desktop-storage-contracts'
import type { ReadonlyQueryReader } from '../../src/main/readonly-query-reader'
import type { ReviewState } from '../../src/main/assistant/supervision-review-store'

/** Exercise the real caller facades and repository commits across an asynchronous data boundary. */
export function asyncSupervisionStorage(database: AssistantDatabase, before?: (domain: string, method: string, args: unknown[]) => Promise<void>, reader?: ReadonlyQueryReader) {
  const call = async (domain: string, method: string, args: unknown[], options?: { signal?: AbortSignal }) => {
    storageDataBytes(args)
    const data = structuredClone(args)
    if (before) await before(domain, method, data)
    options?.signal?.throwIfAborted()
    if (domain === 'assistant' && method === 'supervisionContext') {
      if (reader) return reader.call('reviewContext', data, options?.signal)
      const { scope } = data[0] as ReviewState['request']
      return database.readSnapshot(() => ({ summary: database.reviewSummary(scope, 'supervisor'), background: database.reviewBackground(scope) }))
    }
    if (domain === 'assistant' && method === 'listSupervisionCandidates' && reader) return reader.call('reviewCandidates', data, options?.signal)
    if (domain === 'review' && reader && (method === 'initialize' || method === 'resume')) {
      const store = database.supervisionReviewStore()
      const runId = String(data[0])
      return method === 'initialize'
        ? store.initializeWithReader(runId, data[1] as ReviewState, reader.reviewManifest(runId), options?.signal)
        : store.resumeWithReader(runId, reader.reviewManifest(runId), options?.signal)
    }
    const target = domain === 'assistant' ? database : domain === 'review' ? database.supervisionReviewStore(options?.signal)
      : domain === 'stories' ? database.supervisionStories() : domain === 'experiences' ? database.supervisionExperiences()
      : database.supervisionSuggestions()
    const operation = (target as unknown as Record<string, (...input: unknown[]) => unknown>)[method]!
    return structuredClone(await operation.apply(target, data))
  }
  return createSupervisionDomainPorts({ call: call as DesktopStorageClient['call'] })
}
