import type {
  RemoteEnvironmentUpdateProgress
} from '../../shared/ssh-host-contracts'
import type { AgentInstallationManager } from './agent-installation-manager'
import type {
  RemoteRuntimeInstallationManager
} from './remote-runtime-installation-manager'
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

type ActiveUpdate = {
  hostId: string
  controller: AbortController
  promise: Promise<void>
}

export class RemoteEnvironmentUpdateService {
  readonly #agentInstallationManager: Pick<
    AgentInstallationManager,
    'ensureInstalled'
  >
  readonly #runtimeInstallationManager: Pick<
    RemoteRuntimeInstallationManager,
    'ensureInstalled'
  >
  readonly #afterUpdate?: (hostId: string) => void | Promise<void>
  readonly #active = new Map<
    RemoteEnvironmentUpdateOwner,
    ActiveUpdate
  >()
  #disposed = false
  #disposePromise?: Promise<void>

  constructor(
    agentInstallationManager: Pick<
      AgentInstallationManager,
      'ensureInstalled'
    >,
    runtimeInstallationManager: Pick<
      RemoteRuntimeInstallationManager,
      'ensureInstalled'
    >,
    afterUpdate?: (hostId: string) => void | Promise<void>
  ) {
    this.#agentInstallationManager = agentInstallationManager
    this.#runtimeInstallationManager = runtimeInstallationManager
    this.#afterUpdate = afterUpdate
  }

  update(
    owner: RemoteEnvironmentUpdateOwner,
    hostId: string,
    onProgress?: RemoteEnvironmentUpdateProgressObserver
  ): Promise<void> {
    this.#assertAvailable(owner)
    const existing = this.#active.get(owner)
    if (existing) {
      if (existing.hostId === hostId) {
        return existing.promise
      }
      return Promise.reject(
        new Error(
          'A remote environment update is already running for another Host'
        )
      )
    }

    const controller = new AbortController()
    const destroyedListener = (): void => {
      controller.abort(
        new DOMException(
          'Remote environment update owner was destroyed',
          'AbortError'
        )
      )
    }
    const promise = this.#run(
      hostId,
      controller.signal,
      onProgress
    ).finally(() => {
      owner.removeListener('destroyed', destroyedListener)
      if (this.#active.get(owner)?.promise === promise) {
        this.#active.delete(owner)
      }
    })
    const active: ActiveUpdate = {
      hostId,
      controller,
      promise
    }
    this.#active.set(owner, active)
    owner.on('destroyed', destroyedListener)
    if (owner.isDestroyed()) {
      destroyedListener()
    }
    return promise
  }

  cancel(
    owner: RemoteEnvironmentUpdateOwner,
    hostId: string
  ): void {
    const active = this.#active.get(owner)
    if (!active) {
      return
    }
    if (active.hostId !== hostId) {
      throw new Error(
        'The active remote environment update targets another Host'
      )
    }
    active.controller.abort(
      new DOMException(
        'Remote environment update was cancelled',
        'AbortError'
      )
    )
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose()
    return this.#disposePromise
  }

  async #run(
    hostId: string,
    signal: AbortSignal,
    onProgress?: RemoteEnvironmentUpdateProgressObserver
  ): Promise<void> {
    this.#emit(onProgress, { hostId, phase: 'agent' })
    await this.#agentInstallationManager.ensureInstalled(hostId, {
      force: true,
      signal
    })
    signal.throwIfAborted()

    this.#emit(onProgress, { hostId, phase: 'runtime' })
    await this.#runtimeInstallationManager.ensureInstalled(hostId, {
      force: true,
      signal
    })
    signal.throwIfAborted()

    this.#emit(onProgress, { hostId, phase: 'finalizing' })
    await this.#afterUpdate?.(hostId)
  }

  #emit(
    observer: RemoteEnvironmentUpdateProgressObserver | undefined,
    progress: RemoteEnvironmentUpdateProgress
  ): void {
    try {
      observer?.(progress)
    } catch {
      // Progress observers cannot alter the update outcome.
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
    const operations = [...this.#active.values()]
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
