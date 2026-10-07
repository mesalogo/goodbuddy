import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReadonlyQueryReader, deserializeWorkerError } from './readonly-query-reader'
import { DesktopStorageTransport } from './desktop-storage-transport'
import {
  storageDataBytes, type DesktopStorageOptions, type StorageArgs, type StorageChange, type StorageDomain, type StorageMethod,
  type StorageResponse, type StorageResult
} from './desktop-storage-contracts'
import type { AssistantStorageProgress } from '../shared/assistant-storage-contracts'

export interface DesktopStorageClientOptions extends DesktopStorageOptions {
  entryPath?: string
  onProgress?: (progress: AssistantStorageProgress) => void
  onChanged?: (domain: StorageChange) => void
  onFailure?: (error: Error) => void
}

export class DesktopStorageClient {
  private transport!: DesktopStorageTransport
  private requests!: ReadonlyQueryReader
  private state: 'opening' | 'ready' | 'failed' | 'closing' | 'closed' = 'opening'
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  ready: Promise<void>
  private closing?: Promise<void>
  private restarting?: Promise<void>
  private confirmedUpgrade?: DesktopStorageOptions['confirmedUpgrade']

  constructor(private readonly options: DesktopStorageClientOptions) {
    this.ready = this.readiness()
    this.confirmedUpgrade = options.confirmedUpgrade
    this.startHost()
  }

  private startHost(): void {
    const options = this.options
    const transport = new DesktopStorageTransport(options.entryPath ?? join(dirname(fileURLToPath(import.meta.url)), 'desktop-storage-entry.js'))
    this.transport = transport
    this.requests = new ReadonlyQueryReader('assistant', '', '', Date.now, {
      createTransport: () => transport
    })
    transport.on('storageMessage', (message: StorageResponse) => {
      if (this.transport !== transport) return
      if (message.type === 'ready' && this.state === 'opening') { this.state = 'ready'; this.resolveReady() }
      else if (message.type === 'failed') this.failed(deserializeWorkerError(message.error))
      else if (message.type === 'upgrade') this.confirmedUpgrade = message.upgrade
      else if (message.type === 'progress') options.onProgress?.(message.progress)
      else if (message.type === 'changed') options.onChanged?.(message.domain)
    })
    transport.on('storageFailure', error => {
      if (this.transport !== transport) return
      this.requests.failTransport(error)
      this.failed(error)
    })
    transport.on('exit', () => {
      if (this.transport !== transport) return
      if (this.state !== 'closing' && this.state !== 'closed') {
        const error = new Error('Desktop storage exited; unconfirmed writes require domain reconciliation')
        this.requests.failTransport(error)
        this.failed(error)
      }
    })
    transport.once('spawn', () => { if (this.transport === transport && this.state === 'opening') this.open() })
  }

  private readiness(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    // Startup can fail before application composition attaches its await.
    void ready.catch(() => undefined)
    return ready
  }

  private open(): void {
    const transport = this.transport
    const { assistantPath, knowledgePath, defaultRootPath, userDataPath, readerWorkerPath, upgradeWorkerPath } = this.options
    try { transport.send({ type: 'open', options: { assistantPath, knowledgePath, defaultRootPath, userDataPath, readerWorkerPath, upgradeWorkerPath, confirmedUpgrade: this.confirmedUpgrade } }) }
    catch (error) { if (this.transport === transport) this.failed(error as Error) }
  }

  private failed(error: Error): void {
    if (this.state === 'closing' || this.state === 'closed') return
    this.state = 'failed'
    this.rejectReady(error)
    this.options.onFailure?.(error)
  }

  /** Retain live startup context, or replace a lost child only after confirmed exit. */
  retry(): Promise<void> {
    if (this.state !== 'failed') return this.ready
    this.state = 'opening'
    this.ready = this.readiness()
    const transport = this.transport
    this.restarting = (async () => {
      if (transport.needsReplacement) {
        await transport.waitForExit()
        await this.requests.close(false)
        if (this.state !== 'opening') return
        transport.removeAllListeners()
        this.startHost()
      } else this.open()
    })().catch(error => this.failed(error))
    return this.ready
  }

  call<D extends StorageDomain, M extends StorageMethod<D>>(
    domain: D, method: M, args: StorageArgs<D, M>, options: { signal?: AbortSignal } = {}
  ): Promise<StorageResult<D, M>> {
    if (this.state !== 'ready') return Promise.reject(new Error('Desktop storage is not ready; await storage.ready before calling'))
    // Reject callbacks and live objects with a clear error before structured clone.
    try { storageDataBytes(args, Infinity) } catch (error) { return Promise.reject(error) }
    return this.requests.call(`${domain}.${method}`, args as unknown[], options.signal)
  }

  get pendingCount(): number { return this.requests.pendingCount + this.requests.waitingCount }
  get admissionHighWaterOperations(): number { return this.requests.admissionHighWaterOperations }

  /** Stop producers first. Resolves only after admitted work, DB close and host exit. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.state = 'closing'
    this.rejectReady(new Error('Desktop storage closed before readiness'))
    this.closing = (async () => {
      await this.restarting
      await this.requests.close()
      // Also closes a host that never received a business request.
      await this.transport.terminate()
      this.state = 'closed'
    })()
    return this.closing
  }
}
