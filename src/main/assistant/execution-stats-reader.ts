import { Worker } from 'node:worker_threads'
import type { ExecutionStats, ExecutionStatsInput } from '../../shared/assistant-contracts'

export class ExecutionStatsReader {
  private worker?: Worker
  private nextId = 0
  private readonly pending = new Map<number, {
    resolve: (value: ExecutionStats) => void
    reject: (error: Error) => void
  }>()

  constructor(private readonly databasePath: string, private readonly workerPath: string) {}

  read(scope: ExecutionStatsInput, activeRequestIds: ReadonlySet<string>): Promise<ExecutionStats> {
    if (!this.worker) {
      const worker = new Worker(this.workerPath, { workerData: { databasePath: this.databasePath } })
      this.worker = worker
      worker.on('message', (message: { id: number; result?: ExecutionStats; error?: string }) => {
        const request = this.pending.get(message.id)
        if (!request) return
        this.pending.delete(message.id)
        if (message.result) request.resolve(message.result)
        else request.reject(new Error(message.error ?? 'Statistics query failed'))
      })
      const failed = (error: Error): void => {
        if (this.worker !== worker) return
        this.worker = undefined
        for (const request of this.pending.values()) request.reject(error)
        this.pending.clear()
        void worker.terminate()
      }
      worker.once('error', failed)
      worker.once('exit', (code) => failed(new Error(`Statistics worker exited (${code})`)))
      worker.unref()
    }
    // Bound outstanding work when a window repeatedly changes scope during a slow read.
    if (this.pending.size >= 16) return Promise.reject(new Error('Statistics reader is busy'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, scope, activeRequestIds: [...activeRequestIds] })
    })
  }

  close(): void {
    const worker = this.worker
    this.worker = undefined
    for (const request of this.pending.values()) request.reject(new Error('Statistics reader closed'))
    this.pending.clear()
    if (worker) void worker.terminate()
  }
}
