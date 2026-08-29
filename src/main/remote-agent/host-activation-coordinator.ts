import { settleBoundedly } from './bounded-settlement'

const DISPOSE_WAIT_TIMEOUT_MS = 5_000

type ActiveActivation<TValue, TPhase extends string> = {
  promise: Promise<TValue>
  controller: AbortController
  progressCallbacks: Set<(phase: TPhase) => void>
  waiters: number
  settled: boolean
}

export class HostActivationCoordinator<
  TValue,
  TPhase extends string
> {
  readonly #maximumConcurrentHosts: number
  readonly #capacityError: () => Error
  readonly #disposeMessage: string
  readonly #active =
    new Map<string, ActiveActivation<TValue, TPhase>>()
  readonly #current = new Map<
    string,
    {
      targetKey: string
      variantKey: string
      value: TValue
    }
  >()
  readonly #cacheGenerations = new Map<string, number>()
  #closed = false
  #disposePromise: Promise<void> | undefined

  constructor(options: {
    maximumConcurrentHosts?: number
    capacityError: () => Error
    disposeMessage: string
  }) {
    this.#maximumConcurrentHosts =
      options.maximumConcurrentHosts ?? 8
    this.#capacityError = options.capacityError
    this.#disposeMessage = options.disposeMessage
    if (
      !Number.isSafeInteger(this.#maximumConcurrentHosts) ||
      this.#maximumConcurrentHosts <= 0 ||
      this.#maximumConcurrentHosts > 32
    ) {
      throw new Error(
        'Host activation concurrency limit is invalid'
      )
    }
  }

  assertAvailable(): void {
    if (this.#closed) {
      throw new Error(this.#disposeMessage)
    }
  }

  cached(
    hostId: string,
    targetKey: string,
    variantKey: string
  ): TValue | undefined {
    this.assertAvailable()
    const cached = this.#current.get(hostId)
    return (
      cached?.targetKey === targetKey &&
      cached.variantKey === variantKey
    )
      ? cached.value
      : undefined
  }

  cachedForHost(
    hostId: string,
    variantKey: string
  ): TValue | undefined {
    this.assertAvailable()
    const cached = this.#current.get(hostId)
    return cached?.variantKey === variantKey
      ? cached.value
      : undefined
  }

  run(options: {
    hostId: string
    targetKey: string
    variantKey: string
    signal?: AbortSignal
    onProgress?: (phase: TPhase) => void
    operation: (
      signal: AbortSignal,
      progress: (phase: TPhase) => void
    ) => Promise<TValue>
  }): Promise<TValue> {
    this.assertAvailable()
    options.signal?.throwIfAborted()
    const operationKey =
      `${options.targetKey}\0${options.variantKey}`
    const existing = this.#active.get(operationKey)
    if (existing) {
      return this.#waitForActive(existing, options)
    }
    if (this.#active.size >= this.#maximumConcurrentHosts) {
      throw this.#capacityError()
    }

    const cacheGeneration =
      this.#cacheGenerations.get(options.hostId) ?? 0
    const progressCallbacks = new Set<
      (phase: TPhase) => void
    >()
    if (options.onProgress) {
      progressCallbacks.add(options.onProgress)
    }
    const progress = (phase: TPhase): void => {
      for (const callback of progressCallbacks) {
        emitProgress(callback, phase)
      }
    }
    const controller = new AbortController()
    const promise = options.operation(
      controller.signal,
      progress
    ).then((value) => {
      if (
        (this.#cacheGenerations.get(options.hostId) ?? 0) ===
        cacheGeneration
      ) {
        this.#current.set(options.hostId, {
          targetKey: options.targetKey,
          variantKey: options.variantKey,
          value
        })
      }
      return value
    })
    const active: ActiveActivation<TValue, TPhase> = {
      promise,
      controller,
      progressCallbacks,
      waiters: 0,
      settled: false
    }
    this.#active.set(operationKey, active)
    void promise.finally(() => {
      active.settled = true
      if (this.#active.get(operationKey) === active) {
        this.#active.delete(operationKey)
      }
    }).catch(() => undefined)
    return this.#waitForActive(active, options)
  }

  invalidate(hostId: string): void {
    this.#current.delete(hostId)
    this.#cacheGenerations.set(
      hostId,
      (this.#cacheGenerations.get(hostId) ?? 0) + 1
    )
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) {
      return this.#disposePromise
    }
    this.#closed = true
    this.#current.clear()
    this.#cacheGenerations.clear()
    const operations = [...this.#active.values()]
    const reason = new DOMException(
      this.#disposeMessage,
      'AbortError'
    )
    for (const operation of operations) {
      operation.controller.abort(reason)
    }
    this.#disposePromise = settleBoundedly(
      operations.map((operation) => operation.promise),
      DISPOSE_WAIT_TIMEOUT_MS
    )
    return this.#disposePromise
  }

  async #waitForActive(
    active: ActiveActivation<TValue, TPhase>,
    options: {
      signal?: AbortSignal
      onProgress?: (phase: TPhase) => void
    }
  ): Promise<TValue> {
    active.waiters += 1
    if (options.onProgress) {
      active.progressCallbacks.add(options.onProgress)
    }
    try {
      return await waitForOperation(
        active.promise,
        options.signal
      )
    } finally {
      if (options.onProgress) {
        active.progressCallbacks.delete(options.onProgress)
      }
      active.waiters -= 1
      if (
        active.waiters === 0 &&
        !active.settled &&
        !active.controller.signal.aborted
      ) {
        active.controller.abort(
          new DOMException(
            'Host activation has no remaining waiters',
            'AbortError'
          )
        )
      }
    }
  }
}

function emitProgress<TPhase extends string>(
  callback: (phase: TPhase) => void,
  phase: TPhase
): void {
  try {
    callback(phase)
  } catch {
    // Progress observers cannot alter activation state.
  }
}

function waitForOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return operation
  }
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(
      signal.reason ??
      new DOMException(
        'The operation was aborted',
        'AbortError'
      )
    )
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}
