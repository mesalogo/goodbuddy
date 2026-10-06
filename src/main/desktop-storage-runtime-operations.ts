import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { AgentModelCallLedger, ModelCallLedgerFactory } from '../agent-daemon/agent-model-gateway'
import type { RuntimeSessionBindingStore, SqliteRuntimeSessionBindingStore } from './agent/runtime-session-binding-store'
import type { StorageArgs, StorageResult } from './desktop-storage-contracts'

export const runtimeStorageMethods = [
  'getByConversation', 'getById', 'claimAcpSession', 'rotateTransport',
  'put', 'pruneClosed', 'listByController',
  'openLedger', 'claimModelCall', 'completeModelCall', 'markModelCallUnknown',
  'deliverModelCall', 'getModelCall', 'closeLedger'
] as const satisfies readonly (keyof DesktopStorageRuntimeOperations)[]

/** Add this domain to DesktopStorageDomains and dispatch its allowlist in the owner. */
export interface DesktopStorageRuntimeOperations extends RuntimeSessionBindingStore {
  openLedger(id: string, path: string): Promise<void>
  claimModelCall(id: string, input: Parameters<AgentModelCallLedger['claim']>[0]): void
  completeModelCall(id: string, callId: string): void
  markModelCallUnknown(id: string, callId: string, code: string): void
  deliverModelCall(id: string, callId: string): void
  getModelCall(id: string, callId: string): ReturnType<AgentModelCallLedger['get']>
  closeLedger(id: string): void
}

/** Construct once in the storage host; never instantiate in Main. */
export class DesktopStorageRuntimeOwner implements DesktopStorageRuntimeOperations {
  private readonly ledgers = new Map<string, { path: string; ledger: AgentModelCallLedger }>()
  private closed = false

  private constructor(
    private readonly bindings: SqliteRuntimeSessionBindingStore,
    private readonly Ledger: typeof AgentModelCallLedger
  ) {}

  static async open(userDataPath: string): Promise<DesktopStorageRuntimeOwner> {
    // Lazy imports keep concrete storage implementation out of Main initialization.
    const [{ SqliteRuntimeSessionBindingStore }, { AgentModelCallLedger }] = await Promise.all([
      import('./agent/runtime-session-binding-store'), import('../agent-daemon/agent-model-gateway')
    ])
    return new DesktopStorageRuntimeOwner(
      new SqliteRuntimeSessionBindingStore(join(userDataPath, 'remote-runtime-bindings.sqlite')),
      AgentModelCallLedger
    )
  }

  getByConversation(...args: Parameters<RuntimeSessionBindingStore['getByConversation']>) { return this.bindings.getByConversation(...args) }
  getById(...args: Parameters<RuntimeSessionBindingStore['getById']>) { return this.bindings.getById(...args) }
  claimAcpSession(...args: Parameters<RuntimeSessionBindingStore['claimAcpSession']>) { return this.bindings.claimAcpSession(...args) }
  rotateTransport(...args: Parameters<RuntimeSessionBindingStore['rotateTransport']>) { return this.bindings.rotateTransport(...args) }
  put(...args: Parameters<RuntimeSessionBindingStore['put']>) { return this.bindings.put(...args) }
  pruneClosed(...args: Parameters<RuntimeSessionBindingStore['pruneClosed']>) { return this.bindings.pruneClosed(...args) }
  listByController(...args: Parameters<RuntimeSessionBindingStore['listByController']>) { return this.bindings.listByController(...args) }

  async openLedger(id: string, path: string): Promise<void> {
    if (this.closed) throw new Error('Runtime storage is closed')
    const normalized = resolve(path)
    if (this.ledgers.has(id) || [...this.ledgers.values()].some(entry => entry.path === normalized)) {
      throw new Error('Model ledger already has an owner')
    }
    this.ledgers.set(id, { path: normalized, ledger: new this.Ledger(normalized) })
  }

  claimModelCall(id: string, input: Parameters<AgentModelCallLedger['claim']>[0]): void { this.ledger(id).claim(input) }
  completeModelCall(id: string, callId: string): void { this.ledger(id).complete(callId) }
  markModelCallUnknown(id: string, callId: string, code: string): void { this.ledger(id).outcomeUnknown(callId, code) }
  deliverModelCall(id: string, callId: string): void { this.ledger(id).delivered(callId) }
  getModelCall(id: string, callId: string): ReturnType<AgentModelCallLedger['get']> { return this.ledger(id).get(callId) }

  closeLedger(id: string): void {
    this.ledgers.get(id)?.ledger.close()
    this.ledgers.delete(id)
  }

  /** The outer owner drains admitted operations before calling this. */
  close(): void {
    this.closed = true
    for (const id of this.ledgers.keys()) this.closeLedger(id)
    this.bindings.close()
  }

  private ledger(id: string): AgentModelCallLedger {
    const entry = this.ledgers.get(id)
    if (!entry) throw new Error('Model ledger is not open')
    return entry.ledger
  }
}

/** Pass DesktopStorageClient.call bound to that client after adding the runtime domain. */
export type DesktopRuntimeStorageCall = <M extends keyof DesktopStorageRuntimeOperations>(
  domain: 'runtime', method: M, args: StorageArgs<'runtime', M>
) => Promise<StorageResult<'runtime', M>>

export function createDesktopRuntimeStorageAdapters(call: DesktopRuntimeStorageCall): {
  bindingStore: RuntimeSessionBindingStore
  openModelCallLedger: ModelCallLedgerFactory
} {
  return {
    bindingStore: {
      getByConversation: (...args) => call('runtime', 'getByConversation', args),
      getById: (...args) => call('runtime', 'getById', args),
      claimAcpSession: (...args) => call('runtime', 'claimAcpSession', args),
      rotateTransport: (...args) => call('runtime', 'rotateTransport', args),
      put: (...args) => call('runtime', 'put', args),
      pruneClosed: (...args) => call('runtime', 'pruneClosed', args),
      listByController: (...args) => call('runtime', 'listByController', args)
    },
    openModelCallLedger: async path => {
      const id = randomUUID()
      await call('runtime', 'openLedger', [id, path])
      let closing: Promise<void> | undefined
      return {
        claim: input => call('runtime', 'claimModelCall', [id, input]),
        complete: callId => call('runtime', 'completeModelCall', [id, callId]),
        outcomeUnknown: (callId, code) => call('runtime', 'markModelCallUnknown', [id, callId, code]),
        delivered: callId => call('runtime', 'deliverModelCall', [id, callId]),
        get: callId => call('runtime', 'getModelCall', [id, callId]),
        close: () => closing ??= call('runtime', 'closeLedger', [id])
      }
    }
  }
}
