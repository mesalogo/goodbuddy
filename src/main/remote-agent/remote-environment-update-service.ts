import type {
  RemoteEnvironmentPreparationMethod,
  RemoteEnvironmentUpdateProgress,
  RemoteEnvironmentUpdateRequest
} from '../../shared/ssh-host-contracts'
import { settleBoundedly } from './bounded-settlement'

const DISPOSE_WAIT_TIMEOUT_MS = 5_000

export interface RemoteEnvironmentUpdateOwner {
  readonly id: number
  isDestroyed(): boolean
  on(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

export type RemoteEnvironmentUpdateProgressObserver = (
  progress: RemoteEnvironmentUpdateProgress
) => void

/**
 * Narrow boundary for the SSH-side download, verification, installation, and
 * adoption workflow. Its implementation remains Main-only.
 */
export interface RemoteEnvironmentPreparer {
  prepare(
    hostId: string,
    method: RemoteEnvironmentPreparationMethod,
    observer: RemoteEnvironmentUpdateProgressObserver | undefined,
    signal: AbortSignal
  ): Promise<void>
}

type ActiveUpdate = {
  request: RemoteEnvironmentUpdateRequest
  controller: AbortController
  observers: Set<RemoteEnvironmentUpdateProgressObserver>
  waiters: Set<UpdateWaiter>
  promise: Promise<void>
  settled: boolean
  lastEmittedPhase?: RemoteEnvironmentUpdateProgress['phase']
  lastEmittedMethod?: RemoteEnvironmentPreparationMethod
}

type UpdateWaiter = {
  owner: RemoteEnvironmentUpdateOwner
  active: ActiveUpdate
  observer?: RemoteEnvironmentUpdateProgressObserver
  promise: Promise<void>
  resolve: () => void
  reject: (reason: unknown) => void
  settled: boolean
}

type OwnerState = {
  listener: () => void
  waitersByHost: Map<string, Set<UpdateWaiter>>
}

export class RemoteEnvironmentUpdateService {
  readonly #preparer: RemoteEnvironmentPreparer
  readonly #afterUpdate?: (hostId: string) => void | Promise<void>
  readonly #activeByHost = new Map<string, ActiveUpdate>()
  readonly #owners = new Map<RemoteEnvironmentUpdateOwner, OwnerState>()
  #disposed = false
  #disposePromise?: Promise<void>

  constructor(
    preparer: RemoteEnvironmentPreparer,
    afterUpdate?: (hostId: string) => void | Promise<void>
  ) {
    this.#preparer = preparer
    this.#afterUpdate = afterUpdate
  }

  update(
    owner: RemoteEnvironmentUpdateOwner,
    request: RemoteEnvironmentUpdateRequest,
    observer?: RemoteEnvironmentUpdateProgressObserver
  ): Promise<void> {
    this.#assertAvailable(owner)
    const existing = this.#activeByHost.get(request.hostId)
    if (existing && existing.request.method !== request.method) {
      return Promise.reject(
        new Error(
          'A conflicting remote environment preparation method is already running for this Host'
        )
      )
    }

    const active = existing ?? this.#createActive(request)
    return this.#attachWaiter(owner, active, observer)
  }

  cancel(
    owner: RemoteEnvironmentUpdateOwner,
    hostId: string
  ): void {
    const state = this.#owners.get(owner)
    const waiters = state?.waitersByHost.get(hostId)
    if (!waiters || waiters.size === 0) {
      return
    }
    const reason = new DOMException(
      'Remote environment update was cancelled',
      'AbortError'
    )
    for (const waiter of [...waiters]) {
      this.#detachWaiter(waiter, reason)
    }
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose()
    return this.#disposePromise
  }

  #createActive(
    request: RemoteEnvironmentUpdateRequest
  ): ActiveUpdate {
    const controller = new AbortController()
    const active: ActiveUpdate = {
      request,
      controller,
      observers: new Set<RemoteEnvironmentUpdateProgressObserver>(),
      waiters: new Set<UpdateWaiter>(),
      promise: Promise.resolve(),
      settled: false,
      lastEmittedPhase: undefined,
      lastEmittedMethod: undefined
    }
    active.promise = Promise.resolve()
      .then(() => this.#run(active))
      .finally(() => {
        active.settled = true
        if (this.#activeByHost.get(request.hostId) === active) {
          this.#activeByHost.delete(request.hostId)
        }
      })
    // Every operation promise is observed by its waiters. This additional
    // handler prevents a late rejection from becoming unhandled if all
    // waiters cancel before the underlying operation notices cancellation.
    void active.promise.catch(() => undefined)
    this.#activeByHost.set(request.hostId, active)
    return active
  }

  #attachWaiter(
    owner: RemoteEnvironmentUpdateOwner,
    active: ActiveUpdate,
    observer?: RemoteEnvironmentUpdateProgressObserver
  ): Promise<void> {
    let resolve!: () => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const waiter: UpdateWaiter = {
      owner,
      active,
      observer,
      promise,
      resolve,
      reject,
      settled: false
    }
    active.waiters.add(waiter)
    if (observer) {
      active.observers.add(observer)
    }

    let ownerState = this.#owners.get(owner)
    if (!ownerState) {
      const listener = (): void => {
        this.#detachOwner(
          owner,
          new DOMException(
            'Remote environment update owner was destroyed',
            'AbortError'
          )
        )
      }
      ownerState = {
        listener,
        waitersByHost: new Map()
      }
      this.#owners.set(owner, ownerState)
      owner.on('destroyed', listener)
    }
    let hostWaiters = ownerState.waitersByHost.get(
      active.request.hostId
    )
    if (!hostWaiters) {
      hostWaiters = new Set()
      ownerState.waitersByHost.set(
        active.request.hostId,
        hostWaiters
      )
    }
    hostWaiters.add(waiter)

    void active.promise.then(
      () => this.#detachWaiter(waiter),
      (error) => this.#detachWaiter(waiter, error)
    )
    if (owner.isDestroyed()) {
      ownerState.listener()
    }
    return promise
  }

  #detachOwner(
    owner: RemoteEnvironmentUpdateOwner,
    reason: unknown
  ): void {
    const state = this.#owners.get(owner)
    if (!state) {
      return
    }
    const waiters = [...state.waitersByHost.values()]
      .flatMap((entries) => [...entries])
    for (const waiter of waiters) {
      this.#detachWaiter(waiter, reason)
    }
  }

  #detachWaiter(
    waiter: UpdateWaiter,
    rejection?: unknown
  ): void {
    if (waiter.settled) {
      return
    }
    waiter.settled = true
    const { active, owner, observer } = waiter
    active.waiters.delete(waiter)
    if (
      observer &&
      ![...active.waiters].some(
        (candidate) => candidate.observer === observer
      )
    ) {
      active.observers.delete(observer)
    }

    const ownerState = this.#owners.get(owner)
    const hostWaiters = ownerState?.waitersByHost.get(
      active.request.hostId
    )
    hostWaiters?.delete(waiter)
    if (hostWaiters?.size === 0) {
      ownerState?.waitersByHost.delete(active.request.hostId)
    }
    if (ownerState?.waitersByHost.size === 0) {
      owner.removeListener('destroyed', ownerState.listener)
      this.#owners.delete(owner)
    }

    if (rejection === undefined) {
      waiter.resolve()
    } else {
      waiter.reject(rejection)
    }
    if (
      active.waiters.size === 0 &&
      !active.settled &&
      !active.controller.signal.aborted
    ) {
      active.controller.abort(
        new DOMException(
          'Remote environment update has no remaining waiters',
          'AbortError'
        )
      )
    }
  }

  async #run(active: ActiveUpdate): Promise<void> {
    const { request, controller } = active
    await this.#preparer.prepare(
      request.hostId,
      request.method,
      (progress) => {
        if (
          progress.phase === 'finalizing' ||
          progress.phase === 'complete'
        ) {
          return
        }
        this.#emit(active, {
          ...progress,
          hostId: request.hostId
        })
      },
      controller.signal
    )
    controller.signal.throwIfAborted()

    const resolvedMethod =
      active.lastEmittedMethod ?? request.method
    this.#emit(active, {
      hostId: request.hostId,
      method: resolvedMethod,
      phase: 'finalizing'
    })
    await this.#afterUpdate?.(request.hostId)
    controller.signal.throwIfAborted()
    this.#emit(active, {
      hostId: request.hostId,
      method: resolvedMethod,
      phase: 'complete'
    })
  }

  #emit(
    active: ActiveUpdate,
    progress: RemoteEnvironmentUpdateProgress
  ): void {
    if (
      active.lastEmittedPhase === progress.phase &&
      active.lastEmittedMethod === progress.method
    ) {
      return
    }
    active.lastEmittedPhase = progress.phase
    active.lastEmittedMethod = progress.method
    for (const observer of active.observers) {
      try {
        observer(progress)
      } catch {
        // Progress observers cannot alter the update outcome.
      }
    }
  }

  #assertAvailable(owner: RemoteEnvironmentUpdateOwner): void {
    if (this.#disposed) {
      throw new Error('Remote environment update service was disposed')
    }
    if (owner.isDestroyed()) {
      throw new Error('Remote environment update owner was destroyed')
    }
  }

  async #dispose(): Promise<void> {
    this.#disposed = true
    const operations = [...this.#activeByHost.values()]
    for (const active of operations) {
      active.controller.abort(
        new DOMException(
          'Remote environment update service was disposed',
          'AbortError'
        )
      )
    }
    if (operations.length === 0) {
      return
    }
    await settleBoundedly(
      operations.map((active) => active.promise),
      DISPOSE_WAIT_TIMEOUT_MS
    )
  }
}
