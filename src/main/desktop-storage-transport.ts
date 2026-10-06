import { EventEmitter } from 'node:events'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { ReadonlyQueryRequest, QueryTransport } from './readonly-query-reader'
import type { StorageRequest, StorageResponse } from './desktop-storage-contracts'

const EXIT_TIMEOUT_MS = 10_000

/** Adapts Electron messages to the existing query reader, without another request queue. */
export class DesktopStorageTransport extends EventEmitter implements QueryTransport {
  private readonly child: UtilityProcess
  private readonly exit: Promise<number>
  private exitCode?: number
  private closeAcknowledged = false
  private closing?: Promise<number>
  private failed = false

  constructor(modulePath: string) {
    super()
    this.child = utilityProcess.fork(modulePath, [], {
      serviceName: 'GoodBuddy Desktop Storage', stdio: 'ignore', allowLoadingUnsignedLibraries: false
    })
    this.exit = new Promise(resolve => this.child.once('exit', code => {
      this.exitCode = code
      resolve(code)
      this.emit('exit', code)
    }))
    this.child.on('error', () => this.fail(new Error('Desktop storage process failed')))
    this.child.on('spawn', () => this.emit('spawn'))
    this.child.on('message', (message: StorageResponse) => {
      if (message.type === 'closed') this.closeAcknowledged = true
      if (message.type === 'failed' && message.error.code === 'STORAGE_CLOSE_FAILED') this.failed = true
      if (message.type === 'result') this.emit('message', { id: message.id, result: message.result })
      else if (message.type === 'error') this.emit('message', { id: message.id, error: message.error })
      else this.emit('storageMessage', message)
    })
  }

  private fail(error: unknown): void {
    if (this.failed || this.exitCode !== undefined) return
    this.failed = true
    try { this.emit('storageFailure', error) } finally { this.child.kill() }
  }

  send(message: StorageRequest): void {
    if (this.exitCode !== undefined) throw new Error('Desktop storage process has exited; unconfirmed writes must not be replayed automatically')
    this.child.postMessage(message)
  }

  postMessage(message: ReadonlyQueryRequest | { type: 'cancel'; id: number }): void {
    if (message.type === 'cancel') {
      if (this.exitCode === undefined) this.child.postMessage(message)
      return
    }
    const separator = message.op.indexOf('.')
    // Throws synchronously (for example DataCloneError); the reader rejects that call.
    this.send({ type: 'call', id: message.id,
      domain: message.op.slice(0, separator) as Extract<StorageRequest, { type: 'call' }>['domain'],
      method: message.op.slice(separator + 1), args: message.args })
  }

  get needsReplacement(): boolean { return this.failed || this.exitCode !== undefined }

  waitForExit(): Promise<number> {
    return withTimeout(this.exit, 'Desktop storage exit was not confirmed; replacement was not started')
  }

  ref(): void { /* Utility process lifetime is owned by application shutdown. */ }
  unref(): void { /* No worker-thread ref counting is needed for utilityProcess. */ }

  terminate(): Promise<number> {
    this.closing ??= withTimeout((async () => {
      if (this.exitCode === undefined) this.send({ type: 'close' })
      return this.exit
    })(), 'Desktop storage exit was not confirmed').then(code => {
      if (!this.closeAcknowledged || code !== 0) throw new Error(`Desktop storage exited without a successful drain (${code}); unconfirmed writes require domain reconciliation`)
      return code
    })
    return this.closing
  }
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), EXIT_TIMEOUT_MS) })])
  } finally { clearTimeout(timer) }
}
