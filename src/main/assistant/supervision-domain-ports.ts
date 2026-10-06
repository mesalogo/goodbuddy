import type { AssistantDatabase } from './assistant-database'
import type { DesktopStorageClient } from '../desktop-storage-client'
import type { ReviewState } from './supervision-review-store'
import { repositoryStorageMethods, type DesktopStorageDomains, type StorageArgs, type StorageMethod, type StorageResult } from '../desktop-storage-contracts'

export type Awaitable<T> = T | Promise<T>
export type DomainPort<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Awaitable<Awaited<R>> : never
}

export type ReviewDomainPort = DomainPort<DesktopStorageDomains['review']>
export type StoryDomainPort = DomainPort<DesktopStorageDomains['stories']>
export type ExperienceDomainPort = DomainPort<DesktopStorageDomains['experiences']>
export type SuggestionDomainPort = DomainPort<DesktopStorageDomains['suggestions']>
export type HeartbeatDomainPort = DomainPort<Pick<AssistantDatabase,
  'listHeartbeatConfigs' | 'createHeartbeatConfig' | 'updateHeartbeatConfig' | 'setHeartbeatPaused' |
  'removeHeartbeatConfig' | 'listHeartbeatRuns' | 'listHeartbeatEntries' | 'claimHeartbeatNow' |
  'claimDueHeartbeats' | 'getHeartbeatRun' | 'getHeartbeatConfig' | 'supervisionRunForHeartbeat' |
  'completeHeartbeatTrigger' | 'failHeartbeatRun' | 'setHeartbeatProjection' | 'markHeartbeatNoChange' |
  'setHeartbeatSuggestionStatus'>>

export type SupervisionDomainPort = DomainPort<Pick<AssistantDatabase,
  'createTask' | 'updateTaskStatus' | 'upsertModelUsageCall' | 'resolveReviewScope' | 'reviewSummary' |
  'reviewBackground' | 'startSupervisionRun' | 'failSupervisionRun' | 'noChangeSupervisionRun' |
  'saveSupervisionResult'>> & {
  supervisionCandidates(...args: Parameters<AssistantDatabase['listSupervisionCandidates']>): Awaitable<ReturnType<AssistantDatabase['listSupervisionCandidates']>>
  initializeSupervisionReview(runId: string, state: ReviewState, signal: AbortSignal): Awaitable<void>
  resumeSupervisionReview(runId: string, signal: AbortSignal): Awaitable<void>
  supervisionContext(...args: Parameters<DesktopStorageDomains['assistant']['supervisionContext']>): Awaitable<ReturnType<DesktopStorageDomains['assistant']['supervisionContext']>>
  supervisionReviewStore(): Awaitable<ReviewDomainPort>
  supervisionStories(): Awaitable<StoryDomainPort>
  supervisionExperiences(): Awaitable<ExperienceDomainPort>
  supervisionSuggestions(): Awaitable<SuggestionDomainPort>
}

/** Main-side facades contain only RPC closures, never repository instances. */
export function createSupervisionDomainPorts(storage: Pick<DesktopStorageClient, 'call'>) {
  function repository<D extends keyof typeof repositoryStorageMethods>(domain: D): DomainPort<DesktopStorageDomains[D]> {
    return Object.fromEntries(repositoryStorageMethods[domain].map(method => [method, (...args: unknown[]) => {
      const signalIndex = domain === 'review' ? method === 'initialize' ? 2 : method === 'resume' ? 1 : -1 : -1
      const signal = signalIndex < 0 ? undefined : args[signalIndex] as AbortSignal | undefined
      if (signalIndex >= 0) args = args.slice(0, signalIndex)
      return storage.call(domain, method as StorageMethod<D>, args as StorageArgs<D, StorageMethod<D>>, { signal })
    }])) as DomainPort<DesktopStorageDomains[D]>
  }
  const review = repository('review'), stories = repository('stories')
  const experiences = repository('experiences'), suggestions = repository('suggestions')
  const call = <M extends StorageMethod<'assistant'>>(method: M, ...args: StorageArgs<'assistant', M>): Promise<StorageResult<'assistant', M>> =>
    storage.call('assistant', method, args)
  const supervision: SupervisionDomainPort = {
    createTask: (...args) => call('createTask', ...args),
    updateTaskStatus: (...args) => call('updateTaskStatus', ...args),
    upsertModelUsageCall: (...args) => call('upsertModelUsageCall', ...args),
    resolveReviewScope: (...args) => call('resolveReviewScope', ...args),
    reviewSummary: (...args) => call('reviewSummary', ...args),
    reviewBackground: (...args) => call('reviewBackground', ...args),
    startSupervisionRun: (...args) => call('startSupervisionRun', ...args),
    failSupervisionRun: (...args) => call('failSupervisionRun', ...args),
    noChangeSupervisionRun: (...args) => call('noChangeSupervisionRun', ...args),
    supervisionCandidates: (...args) => call('listSupervisionCandidates', ...args),
    saveSupervisionResult: (...args) => call('saveSupervisionResult', ...args),
    initializeSupervisionReview: (runId, state, signal) => storage.call('review', 'initialize', [runId, state], { signal }),
    resumeSupervisionReview: (runId, signal) => storage.call('review', 'resume', [runId], { signal }),
    supervisionContext: (request, signal) => storage.call('assistant', 'supervisionContext', [request], { signal }),
    supervisionReviewStore: () => review, supervisionStories: () => stories,
    supervisionExperiences: () => experiences, supervisionSuggestions: () => suggestions
  }
  const heartbeat: HeartbeatDomainPort = {
    listHeartbeatConfigs: (...args) => call('listHeartbeatConfigs', ...args),
    createHeartbeatConfig: (...args) => call('createHeartbeatConfig', ...args),
    updateHeartbeatConfig: (...args) => call('updateHeartbeatConfig', ...args),
    setHeartbeatPaused: (...args) => call('setHeartbeatPaused', ...args),
    removeHeartbeatConfig: (...args) => call('removeHeartbeatConfig', ...args),
    listHeartbeatRuns: (...args) => call('listHeartbeatRuns', ...args),
    listHeartbeatEntries: (...args) => call('listHeartbeatEntries', ...args),
    claimHeartbeatNow: (...args) => call('claimHeartbeatNow', ...args),
    claimDueHeartbeats: (...args) => call('claimDueHeartbeats', ...args),
    getHeartbeatRun: (...args) => call('getHeartbeatRun', ...args),
    getHeartbeatConfig: (...args) => call('getHeartbeatConfig', ...args),
    supervisionRunForHeartbeat: (...args) => call('supervisionRunForHeartbeat', ...args),
    completeHeartbeatTrigger: (...args) => call('completeHeartbeatTrigger', ...args),
    failHeartbeatRun: (...args) => call('failHeartbeatRun', ...args),
    setHeartbeatProjection: (...args) => call('setHeartbeatProjection', ...args),
    markHeartbeatNoChange: (...args) => call('markHeartbeatNoChange', ...args),
    setHeartbeatSuggestionStatus: (...args) => call('setHeartbeatSuggestionStatus', ...args)
  }
  return { supervision, heartbeat, review, stories, experiences, suggestions }
}
