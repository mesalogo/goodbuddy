import type { DesktopStorageClient } from './desktop-storage-client'
import { assistantStorageMethods, type StorageArgs, type StorageChange, type StorageMethod, type StorageResult } from './desktop-storage-contracts'

export type Awaitable<T> = T | Promise<T>
export type AssistantStorageMethod = StorageMethod<'assistant'>
// Borrowed domain consumers use ordinary repository methods. SSH save orchestration
// has its own data-only port; those composites remain on the full async facade.
export type AssistantStoragePort = {
  [M in Exclude<AssistantStorageMethod, 'createSshProject' | 'updateSshProject' | 'supervisionContext'>]: (...args: StorageArgs<'assistant', M>) => Awaitable<StorageResult<'assistant', M>>
}
export type AsyncAssistantStoragePort = {
  [M in AssistantStorageMethod]: (...args: StorageArgs<'assistant', M>) => Promise<StorageResult<'assistant', M>>
}

/** Only named data operations are bound; callbacks and repositories stay local. */
export function createAssistantStoragePort(client: Pick<DesktopStorageClient, 'call'>): AsyncAssistantStoragePort {
  return Object.fromEntries([...assistantStorageMethods, 'supervisionContext' as const].map(method => [
    method, (...args: StorageArgs<'assistant', typeof method>) => client.call('assistant', method, args)
  ])) as AsyncAssistantStoragePort
}

export function createAssistantStorageOnChanged(callbacks: {
  onMagicNotesChanged?: () => void
  onMagicTodosChanged?: () => void
  onModelUsageChanged?: () => void
  onExecutionStatsChanged?: () => void
}): (domain: StorageChange) => void {
  const listeners = {
    magicNotes: callbacks.onMagicNotesChanged,
    magicTodos: callbacks.onMagicTodosChanged,
    modelUsage: callbacks.onModelUsageChanged,
    executionStats: callbacks.onExecutionStatsChanged
  }
  return domain => listeners[domain]?.()
}
