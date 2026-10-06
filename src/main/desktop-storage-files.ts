import { join } from 'node:path'
import type { ConversationAttachmentStorage } from './conversation-attachment-storage'
import type { DocumentResultStorage } from './document-result-storage'
import type { PagedOutputBackingStore } from './agent/paged-output-store'
import type { StorageArgs, StorageResult } from './desktop-storage-contracts'

export const attachmentStorageMethods = [
  'has', 'save', 'saveDocument', 'discardResult', 'adoptDocument', 'get', 'update',
  'copyResult', 'request', 'original', 'reference', 'draft', 'release',
  'deleteConversation', 'deleteProject', 'collect', 'beginParsing', 'parsingFailed', 'pendingParsing',
  'outputCreate', 'outputAppend', 'outputFinish', 'outputRead', 'outputAdopt', 'outputRelease'
] as const satisfies readonly (keyof ConversationAttachmentStorage)[]
export const documentResultStorageMethods = [
  'save', 'get', 'image', 'original', 'release', 'move', 'detach', 'isTemporaryResult'
] as const satisfies readonly (keyof DocumentResultStorage)[]

type AttachmentOperations = Pick<ConversationAttachmentStorage, typeof attachmentStorageMethods[number]>
type ResultOperations = Pick<DocumentResultStorage, typeof documentResultStorageMethods[number]>
type AsyncAccess<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never }
type OwnerAccess<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<Awaited<R>> : never }
// OwnerAccess also permits direct owner instances in focused tests. Main receives only facades.
export type AttachmentStorageAccess = OwnerAccess<AttachmentOperations>
export type DocumentResultStorageAccess = OwnerAccess<ResultOperations> & { close(): Promise<void> }

export type DesktopFileStorageDomains = {
  attachments: AttachmentOperations & { reconcile(startup?: boolean, protectedIds?: readonly string[]): void }
  documentResults: Omit<ResultOperations, 'save'> & {
    save(...args: Parameters<DocumentResultStorage['save']> extends [...infer A, signal?: AbortSignal] ? A : never): ReturnType<DocumentResultStorage['save']>
  }
}
type FileArgs<D extends keyof DesktopFileStorageDomains, M extends keyof DesktopFileStorageDomains[D] & string> = StorageArgs<D, M>

export interface DesktopFilesCaller {
  call<D extends keyof DesktopFileStorageDomains, M extends keyof DesktopFileStorageDomains[D] & string>(
    domain: D, method: M,
    args: FileArgs<D, M>,
    options?: { signal?: AbortSignal }
  ): Promise<StorageResult<D, M>>
}

/** Named domain facades over DesktopStorageClient.call; no extra transport or queue. */
export function createDesktopStorageFiles(client: DesktopFilesCaller): {
  attachments: AsyncAccess<DesktopFileStorageDomains['attachments']>
  results: AsyncAccess<ResultOperations> & { close(): Promise<void> }
  backingStore: PagedOutputBackingStore
} {
  const a = <K extends keyof DesktopFileStorageDomains['attachments']>(method: K) =>
    (...args: FileArgs<'attachments', K>) => client.call('attachments', method, args)
  const r = <K extends keyof DesktopFileStorageDomains['documentResults']>(method: K) =>
    (...args: FileArgs<'documentResults', K>) => client.call('documentResults', method, args)
  const attachments = {
    has: a('has'), save: a('save'), saveDocument: a('saveDocument'), discardResult: a('discardResult'),
    adoptDocument: a('adoptDocument'), get: a('get'), update: a('update'), copyResult: a('copyResult'),
    request: a('request'), original: async (id: string) => {
      const value = await client.call('attachments', 'original', [id])
      return { ...value, data: Buffer.from(value.data) }
    },
    reference: a('reference'), draft: a('draft'), release: a('release'), deleteConversation: a('deleteConversation'),
    deleteProject: a('deleteProject'), collect: a('collect'), beginParsing: a('beginParsing'),
    parsingFailed: a('parsingFailed'), pendingParsing: a('pendingParsing'), reconcile: a('reconcile'),
    outputCreate: a('outputCreate'), outputAppend: a('outputAppend'), outputFinish: a('outputFinish'),
    outputRead: a('outputRead'), outputAdopt: a('outputAdopt'), outputRelease: a('outputRelease')
  }
  const results = {
    get: r('get'), image: r('image'), original: r('original'), release: r('release'), move: r('move'),
    detach: r('detach'), isTemporaryResult: r('isTemporaryResult'),
    save: async (...args: Parameters<DocumentResultStorage['save']>) => {
      const [name, original, parsed, settings, duration, originalPath, signal] = args
      const result = await client.call('documentResults', 'save', [name, original, parsed, settings, duration, originalPath], { signal })
      if (signal?.aborted) {
        await client.call('documentResults', 'release', [result.id])
        signal.throwIfAborted()
      }
      return result
    },
    // The shared host owns closing results, after every producer has drained.
    close: async () => undefined
  }
  return { attachments, results, backingStore: {
    create: attachments.outputCreate, append: attachments.outputAppend,
    finish: attachments.outputFinish, read: attachments.outputRead, release: attachments.outputRelease
  } }
}

/** Storage-host composition. Await before advertising readiness. */
export async function openDesktopStorageFiles(
  root: string,
  hasOwner: (conversationId: string, kind: string, ownerId: string) => boolean,
  persistentResultLookup?: Parameters<DocumentResultStorage['setPersistentLookup']>[0]
): Promise<DesktopStorageFilesOwner> {
  const [{ ConversationAttachmentStorage }, { DocumentResultStorage }] = await Promise.all([
    import('./conversation-attachment-storage'), import('./document-result-storage')
  ])
  const results = new DocumentResultStorage(join(root, 'temp', 'document-parsing'))
  if (persistentResultLookup) results.setPersistentLookup(persistentResultLookup)
  const attachments = new ConversationAttachmentStorage(root, results)
  return new DesktopStorageFilesOwner(attachments, results, hasOwner)
}

export class DesktopStorageFilesOwner {
  private closing?: Promise<void>
  constructor(
    readonly attachments: ConversationAttachmentStorage,
    readonly results: DocumentResultStorage,
    private readonly hasOwner: (conversationId: string, kind: string, ownerId: string) => boolean
  ) {}

  dispatch(domain: string, method: string, args: unknown[], signal?: AbortSignal): unknown {
    signal?.throwIfAborted()
    if (domain === 'attachments' && method === 'reconcile') {
      return this.attachments.reconcile(this.hasOwner, args[0] as boolean | undefined, args[1] as string[] | undefined)
    }
    if (domain === 'documentResults' && method === 'save') {
      const [name, original, parsed, settings, duration, originalPath] = args as Parameters<DocumentResultStorage['save']>
      return this.results.save(name, original === undefined ? undefined : Buffer.from(original), parsed, settings, duration, originalPath, signal)
    }
    if (domain === 'attachments' && method === 'saveDocument') {
      const [name, original, parsed] = args as Parameters<ConversationAttachmentStorage['saveDocument']>
      return this.attachments.saveDocument(name, Buffer.from(original), parsed)
    }
    const target = domain === 'attachments' ? this.attachments : domain === 'documentResults' ? this.results : undefined
    const allowed: readonly string[] = domain === 'attachments' ? attachmentStorageMethods : documentResultStorageMethods
    if (!target || !allowed.includes(method)) throw new Error('Unknown file storage operation')
    const operation = (target as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!
    return operation.apply(target, args)
  }

  close(): Promise<void> {
    // DesktopStorageOwner drains admitted calls before invoking this barrier.
    this.closing ??= (async () => {
      this.attachments.releaseOutputs()
      await this.results.close()
      this.attachments.close()
    })()
    return this.closing
  }
}
