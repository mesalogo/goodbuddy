import { KnowledgeService, type KnowledgeServiceOptions } from '../../src/main/knowledge/knowledge-service'
import { KnowledgeDatabase } from '../../src/main/knowledge/knowledge-database'
import { createKnowledgeStoragePort } from '../../src/main/knowledge/knowledge-storage-port'
import { publishStorageDocument } from '../../src/main/desktop-storage-publication'
import { replaceDocumentGraph } from '../../src/main/desktop-storage-knowledge-operations'
import type { DesktopStorageClient } from '../../src/main/desktop-storage-client'

/** Tests own their connection; production composition injects the storage client. */
export class TestKnowledgeService extends KnowledgeService {
  private readonly owner: KnowledgeDatabase

  constructor(options: Omit<KnowledgeServiceOptions, 'database'> & { databasePath: string }) {
    const owner = new KnowledgeDatabase(options.databasePath)
    owner.initialize()
    const call = async (domain: string, method: string, args: unknown[]) => {
      if (method === 'publishDocument') return publishStorageDocument(owner, ...args as Parameters<typeof publishStorageDocument> extends [unknown, ...infer A] ? A : never)
      if (method === 'replaceDocumentGraph') return replaceDocumentGraph(owner, ...args as Parameters<typeof replaceDocumentGraph> extends [unknown, ...infer A] ? A : never)
      const target = domain === 'external' ? owner.externalStore : owner
      return (target as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!.apply(target, args)
    }
    const database = createKnowledgeStoragePort({ call: call as DesktopStorageClient['call'] })
    super({ ...options, database })
    this.owner = owner
  }

  override async dispose(): Promise<void> {
    try { await super.dispose() } finally { this.owner.close() }
  }
}
