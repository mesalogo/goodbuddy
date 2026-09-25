import { defaultSupervisorModelConcurrency } from '../../shared/application-settings-contracts'

export type SupervisionModelSlot = { signal: AbortSignal; release: () => void }

export class SupervisionModelPool {
  private limit = defaultSupervisorModelConcurrency
  private active = 0
  private readonly controllers = new Set<AbortController>()
  private readonly queue: Array<() => void> = []
  private disposed = false

  setLimit(limit: number): void {
    this.limit = limit
    this.dispatch()
  }

  private dispatch(): void {
    while (this.active < this.limit && this.queue.length) this.queue.shift()!()
  }

  cancelAll(reason: Error): void {
    for (const controller of this.controllers) controller.abort(reason)
  }

  dispose(): void {
    this.disposed = true
    this.cancelAll(new Error('Supervision is shutting down'))
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const slot = await this.acquire(signal)
    try {
      slot.signal.throwIfAborted()
      return await operation(slot.signal)
    } finally {
      slot.release()
    }
  }

  async acquire(signal?: AbortSignal): Promise<SupervisionModelSlot> {
    if (this.disposed) throw new Error('Supervision is shutting down')
    signal?.throwIfAborted()
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    this.controllers.add(controller)
    let acquired = false
    try {
      await new Promise<void>((resolve, reject) => {
        const admit = (): void => {
          controller.signal.removeEventListener('abort', abort)
          this.active++
          acquired = true
          resolve()
        }
        const abort = (): void => {
          const index = this.queue.indexOf(admit)
          if (index >= 0) this.queue.splice(index, 1)
          reject(controller.signal.reason)
        }
        controller.signal.addEventListener('abort', abort, { once: true })
        this.queue.push(admit)
        this.dispatch()
      })
      controller.signal.throwIfAborted()
      let released = false
      return { signal: controller.signal, release: () => {
        if (released) return
        released = true
        this.controllers.delete(controller)
        signal?.removeEventListener('abort', cancel)
        this.active--
        this.dispatch()
      } }
    } catch (error) {
      this.controllers.delete(controller)
      signal?.removeEventListener('abort', cancel)
      if (acquired) this.active--
      this.dispatch()
      throw error
    }
  }
}
