type ScheduledWork<T> = (signal: AbortSignal) => Promise<T>

type QueueEntry<T> = {
  work: ScheduledWork<T>
  signal?: AbortSignal
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  removeAbortListener?: () => void
}

export type SubagentSchedulerOptions = {
  concurrency?: number
  queueLimit?: number
  timeoutMs?: number
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) {
    return reason
  }
  const error = new Error('子专家任务已取消')
  error.name = 'AbortError'
  return error
}

export class SubagentScheduler {
  private readonly concurrency: number
  private readonly queueLimit: number
  private readonly timeoutMs: number
  private readonly queue: QueueEntry<unknown>[] = []
  private readonly activeControllers = new Set<AbortController>()
  private active = 0
  private disposed = false
  private readonly idleWaiters = new Set<() => void>()

  constructor(options: SubagentSchedulerOptions = {}) {
    this.concurrency = options.concurrency ?? 3
    this.queueLimit = options.queueLimit ?? 20
    this.timeoutMs = options.timeoutMs ?? 120_000
    if (
      !Number.isSafeInteger(this.concurrency) ||
      this.concurrency < 1 ||
      !Number.isSafeInteger(this.queueLimit) ||
      this.queueLimit < 0 ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1
    ) {
      throw new RangeError('子专家调度器配置无效')
    }
  }

  schedule<T>(
    work: ScheduledWork<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('子专家调度器已关闭'))
    }
    if (signal?.aborted) {
      return Promise.reject(abortError(signal))
    }
    if (this.active >= this.concurrency && this.queue.length >= this.queueLimit) {
      return Promise.reject(new Error('子专家任务队列已满'))
    }
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = { work, signal, resolve, reject }
      if (signal) {
        const onAbort = (): void => {
          const index = this.queue.indexOf(entry as QueueEntry<unknown>)
          if (index >= 0) {
            this.queue.splice(index, 1)
            entry.removeAbortListener?.()
            reject(abortError(signal))
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
        entry.removeAbortListener = () =>
          signal.removeEventListener('abort', onAbort)
      }
      if (this.active < this.concurrency) {
        this.start(entry)
      } else {
        this.queue.push(entry as QueueEntry<unknown>)
      }
    })
  }

  cancelAll(reason = new Error('子专家任务已取消')): void {
    for (const entry of this.queue.splice(0)) {
      entry.removeAbortListener?.()
      entry.reject(reason)
    }
    for (const controller of this.activeControllers) {
      controller.abort(reason)
    }
  }

  waitForIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  dispose(): void {
    this.disposed = true
    this.cancelAll(new Error('子专家调度器已关闭'))
  }

  private start<T>(entry: QueueEntry<T>): void {
    entry.removeAbortListener?.()
    this.active += 1
    const controller = new AbortController()
    this.activeControllers.add(controller)
    const forwardAbort = (): void =>
      controller.abort(abortError(entry.signal))
    entry.signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeout = setTimeout(() => {
      controller.abort(new Error('子专家任务超过 120 秒超时限制'))
    }, this.timeoutMs)

    const workPromise = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return entry.work(controller.signal)
      })
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        controller.signal.removeEventListener('abort', onAbort)
        reject(abortError(controller.signal))
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    void Promise.race([workPromise, abortPromise]).then(
      entry.resolve,
      entry.reject
    )
    void workPromise
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout)
        entry.signal?.removeEventListener('abort', forwardAbort)
        this.activeControllers.delete(controller)
        this.active -= 1
        this.drain()
        if (this.active === 0 && this.queue.length === 0) {
          for (const resolve of this.idleWaiters) {
            resolve()
          }
          this.idleWaiters.clear()
        }
      })
  }

  private drain(): void {
    while (
      !this.disposed &&
      this.active < this.concurrency &&
      this.queue.length > 0
    ) {
      const entry = this.queue.shift()!
      if (entry.signal?.aborted) {
        entry.removeAbortListener?.()
        entry.reject(abortError(entry.signal))
        continue
      }
      this.start(entry)
    }
  }
}
