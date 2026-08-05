export type PortalSessionState =
  | 'idle'
  | 'creating'
  | 'selecting'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'stopped'
  | 'failed'

export type PortalRequest = {
  requestHandle: string
}

export type PortalResponse = {
  requestHandle: string
  response: number
  results: Readonly<Record<string, unknown>>
}

export interface ClosableResource {
  close(): void | Promise<void>
}

export interface PortalTransport {
  createSession(signal: AbortSignal): Promise<PortalRequest>
  selectDevices(
    sessionHandle: string,
    signal: AbortSignal
  ): Promise<PortalRequest>
  selectSources(
    sessionHandle: string,
    signal: AbortSignal
  ): Promise<PortalRequest>
  start(
    sessionHandle: string,
    parentWindow: string,
    signal: AbortSignal
  ): Promise<PortalRequest>
  waitForResponse(
    requestHandle: string,
    signal: AbortSignal
  ): Promise<PortalResponse>
  openPipeWireRemote(
    sessionHandle: string,
    signal: AbortSignal
  ): Promise<ClosableResource>
  connectEis?(
    sessionHandle: string,
    signal: AbortSignal
  ): Promise<ClosableResource>
  closeRequest(requestHandle: string): Promise<void>
  closeSession(sessionHandle: string): Promise<void>
}

export type PortalSessionOptions = {
  devices: boolean
  sources: boolean
  parentWindow?: string
  timeoutMs?: number
}

export type PortalDesktopSessionOptions = {
  cleanupTimeoutMs?: number
}

export class PortalSessionError extends Error {
  constructor(
    readonly reason:
      | 'cancelled'
      | 'denied'
      | 'protocol'
      | 'timeout'
      | 'aborted'
      | 'owner-lost',
    message: string
  ) {
    super(message)
    this.name = 'PortalSessionError'
  }
}

const getSessionHandle = (response: PortalResponse): string => {
  const handle = response.results.session_handle
  if (typeof handle !== 'string' || handle.length === 0) {
    throw new PortalSessionError(
      'protocol',
      'Portal did not return a session handle'
    )
  }
  return handle
}

const throwForResponse = (response: PortalResponse): void => {
  if (response.response === 0) {
    return
  }
  if (response.response === 1) {
    throw new PortalSessionError('cancelled', 'Portal consent was cancelled')
  }
  if (response.response === 2) {
    throw new PortalSessionError('denied', 'Portal consent was denied')
  }
  throw new PortalSessionError('protocol', 'Portal returned an unknown response')
}

export class PortalDesktopSession {
  private stateValue: PortalSessionState = 'idle'
  private generation = 0
  private operation: PortalOperation | undefined
  private openingPromise: Promise<void> | undefined
  private readonly cleanupTimeoutMs: number

  constructor(
    private readonly transport: PortalTransport,
    options: PortalDesktopSessionOptions = {}
  ) {
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 1_000
    if (
      !Number.isSafeInteger(this.cleanupTimeoutMs) ||
      this.cleanupTimeoutMs < 1 ||
      this.cleanupTimeoutMs > 30_000
    ) {
      throw new Error('Invalid portal cleanup timeout')
    }
  }

  get state(): PortalSessionState {
    return this.stateValue
  }

  get hasActiveConsent(): boolean {
    return (
      this.stateValue === 'active' &&
      this.operation !== undefined &&
      !this.operation.ownerLost
    )
  }

  async open(
    options: PortalSessionOptions,
    outerSignal: AbortSignal
  ): Promise<void> {
    if (this.stateValue !== 'idle' && this.stateValue !== 'stopped') {
      throw new PortalSessionError('protocol', 'Portal session is already open')
    }
    if (!options.devices && !options.sources) {
      throw new PortalSessionError(
        'protocol',
        'Portal session must request a concrete capability'
      )
    }
    const timeoutMs = options.timeoutMs ?? 30_000
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    ) {
      throw new PortalSessionError('protocol', 'Invalid portal timeout')
    }

    this.stateValue = 'creating'
    const operation: PortalOperation = {
      generation: ++this.generation,
      controller: new AbortController(),
      requestHandles: new Set(),
      resources: new Set(),
      ownerLost: false,
      stopRequested: false
    }
    this.operation = operation
    const opening = this.openOperation(
      operation,
      options,
      outerSignal,
      timeoutMs
    )
    this.openingPromise = opening
    opening
      .finally(() => {
        if (this.openingPromise === opening) {
          this.openingPromise = undefined
        }
      })
      .catch(() => {
        // The caller receives the original open rejection.
      })
    return opening
  }

  private async openOperation(
    operation: PortalOperation,
    options: PortalSessionOptions,
    outerSignal: AbortSignal,
    timeoutMs: number
  ): Promise<void> {
    const controller = operation.controller
    const abort = (): void => controller.abort(outerSignal.reason)
    outerSignal.addEventListener('abort', abort, { once: true })
    if (outerSignal.aborted) {
      abort()
    }
    const timer = setTimeout(
      () => controller.abort(new PortalSessionError('timeout', 'Portal timed out')),
      timeoutMs
    )

    try {
      const created = await this.request(
        operation,
        () => this.transport.createSession(controller.signal),
        controller.signal
      )
      operation.sessionHandle = getSessionHandle(created)

      this.setOwnedState(operation, 'selecting')
      if (options.devices) {
        await this.request(
          operation,
          () =>
            this.transport.selectDevices(
              this.requireSessionHandle(operation),
              controller.signal
            ),
          controller.signal
        )
      }
      if (options.sources) {
        await this.request(
          operation,
          () =>
            this.transport.selectSources(
              this.requireSessionHandle(operation),
              controller.signal
            ),
          controller.signal
        )
      }

      this.setOwnedState(operation, 'starting')
      await this.request(
        operation,
        () =>
          this.transport.start(
            this.requireSessionHandle(operation),
            options.parentWindow ?? '',
            controller.signal
          ),
        controller.signal
      )

      if (options.sources) {
        operation.resources.add(
          await this.acquireResource(
            this.transport.openPipeWireRemote(
              this.requireSessionHandle(operation),
              controller.signal
            ),
            controller.signal
          )
        )
      }
      if (options.devices && this.transport.connectEis) {
        operation.resources.add(
          await this.acquireResource(
            this.transport.connectEis(
              this.requireSessionHandle(operation),
              controller.signal
            ),
            controller.signal
          )
        )
      }
      if (controller.signal.aborted) {
        throw controller.signal.reason
      }
      this.setOwnedState(operation, 'active')
    } catch (error) {
      await this.cleanup(operation)
      this.setOwnedState(
        operation,
        operation.stopRequested ? 'stopped' : 'failed'
      )
      if (operation.ownerLost) {
        throw new PortalSessionError('owner-lost', 'Portal owner disappeared')
      }
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof PortalSessionError) {
          throw reason
        }
        throw new PortalSessionError('aborted', 'Portal session was aborted')
      }
      throw error
    } finally {
      clearTimeout(timer)
      outerSignal.removeEventListener('abort', abort)
    }
  }

  async stop(): Promise<void> {
    if (this.stateValue === 'stopped' || this.stateValue === 'idle') {
      this.stateValue = 'stopped'
      return
    }
    this.stateValue = 'stopping'
    const operation = this.operation
    if (!operation) {
      this.stateValue = 'stopped'
      return
    }
    operation.stopRequested = true
    operation.controller.abort(
      new PortalSessionError('aborted', 'Portal session stopped')
    )
    await this.cleanup(operation)
    await this.awaitOpening(operation)
    if (this.operation === operation) {
      this.operation = undefined
      this.stateValue = 'stopped'
    }
  }

  async portalOwnerLost(): Promise<void> {
    const operation = this.operation
    if (!operation) {
      this.stateValue = 'failed'
      return
    }
    operation.ownerLost = true
    operation.controller.abort(
      new PortalSessionError('owner-lost', 'Portal owner disappeared')
    )
    await this.cleanup(operation)
    await this.awaitOpening(operation)
    if (this.operation === operation) {
      this.operation = undefined
      this.stateValue = 'failed'
    }
  }

  private async request(
    operation: PortalOperation,
    initiate: () => Promise<PortalRequest>,
    signal: AbortSignal
  ): Promise<PortalResponse> {
    const initiating = Promise.resolve().then(initiate)
    let request: PortalRequest
    try {
      request = await this.abortable(initiating, signal)
    } catch (error) {
      void initiating
        .then((lateRequest) =>
          this.runCleanup([
            () => this.transport.closeRequest(lateRequest.requestHandle)
          ])
        )
        .catch(() => undefined)
      throw error
    }
    operation.requestHandles.add(request.requestHandle)
    const response = await this.abortable(
      this.transport.waitForResponse(request.requestHandle, signal),
      signal
    )
    if (response.requestHandle !== request.requestHandle) {
      throw new PortalSessionError(
        'protocol',
        'Portal response handle did not match its request'
      )
    }
    throwForResponse(response)
    return response
  }

  private requireSessionHandle(operation: PortalOperation): string {
    if (!operation.sessionHandle) {
      throw new PortalSessionError(
        'protocol',
        'Portal session handle is unavailable'
      )
    }
    return operation.sessionHandle
  }

  private async cleanup(operation: PortalOperation): Promise<void> {
    if (operation.cleanupPromise) {
      return operation.cleanupPromise
    }
    const resources = [...operation.resources]
    const requests = [...operation.requestHandles]
    const sessionHandle = operation.sessionHandle
    operation.resources.clear()
    operation.requestHandles.clear()
    operation.sessionHandle = undefined
    operation.cleanupPromise = this.runCleanup([
      ...resources.map((resource) => () => resource.close()),
      ...requests.map(
        (handle) => () => this.transport.closeRequest(handle)
      ),
      ...(sessionHandle
        ? [() => this.transport.closeSession(sessionHandle)]
        : [])
    ])
    return operation.cleanupPromise
  }

  private async acquireResource(
    resourcePromise: Promise<ClosableResource>,
    signal: AbortSignal
  ): Promise<ClosableResource> {
    try {
      return await this.abortable(resourcePromise, signal)
    } catch (error) {
      void resourcePromise
        .then((resource) =>
          this.runCleanup([() => resource.close()])
        )
        .catch(() => undefined)
      throw error
    }
  }

  private abortable<T>(
    promise: Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    if (signal.aborted) {
      promise.catch(() => undefined)
      return Promise.reject(signal.reason)
    }
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        promise.catch(() => undefined)
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener('abort', abort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        }
      )
    })
  }

  private async runCleanup(
    operations: Array<() => void | Promise<void>>
  ): Promise<void> {
    const cleanup = Promise.allSettled(
      operations.map((operation) =>
        Promise.resolve().then(operation)
      )
    ).then(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.cleanupTimeoutMs)
    })
    await Promise.race([cleanup, timeout])
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }

  private async awaitOpening(operation: PortalOperation): Promise<void> {
    const opening = this.openingPromise
    if (!opening || this.operation !== operation) {
      return
    }
    await opening.catch(() => undefined)
  }

  private setOwnedState(
    operation: PortalOperation,
    state: PortalSessionState
  ): void {
    if (
      this.operation === operation &&
      this.operation.generation === operation.generation
    ) {
      this.stateValue = state
    }
  }
}

type PortalOperation = {
  generation: number
  controller: AbortController
  sessionHandle?: string
  requestHandles: Set<string>
  resources: Set<ClosableResource>
  ownerLost: boolean
  stopRequested: boolean
  cleanupPromise?: Promise<void>
}

export type PipeWirePlaneMetadata = {
  offset: number
  stride: number
  bytes: number
}

export type PipeWireFrameMetadata = {
  width: number
  height: number
  stride: number
  planes: PipeWirePlaneMetadata[]
  byteLength: number
  fpsNumerator: number
  fpsDenominator: number
}

const isPositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0

export function validatePipeWireFrameMetadata(
  metadata: PipeWireFrameMetadata
): PipeWireFrameMetadata {
  if (
    !isPositiveInteger(metadata.width) ||
    !isPositiveInteger(metadata.height) ||
    metadata.width > 16_384 ||
    metadata.height > 16_384 ||
    !isPositiveInteger(metadata.stride) ||
    metadata.stride < metadata.width ||
    metadata.stride > 1_048_576 ||
    !isPositiveInteger(metadata.byteLength) ||
    metadata.byteLength > 256 * 1024 * 1024 ||
    !isPositiveInteger(metadata.fpsNumerator) ||
    !isPositiveInteger(metadata.fpsDenominator) ||
    metadata.fpsNumerator / metadata.fpsDenominator > 240 ||
    metadata.planes.length < 1 ||
    metadata.planes.length > 4
  ) {
    throw new Error('Invalid PipeWire frame metadata')
  }
  let previousEnd = 0
  for (const [index, plane] of metadata.planes.entries()) {
    if (
      !Number.isSafeInteger(plane.offset) ||
      plane.offset < 0 ||
      !isPositiveInteger(plane.stride) ||
      plane.stride > 1_048_576 ||
      !isPositiveInteger(plane.bytes) ||
      (index === 0 && plane.offset !== 0) ||
      plane.offset < previousEnd ||
      plane.offset + plane.bytes > metadata.byteLength ||
      (index === 0 &&
        (plane.stride !== metadata.stride ||
          plane.bytes < metadata.stride * metadata.height))
    ) {
      throw new Error('Invalid PipeWire plane metadata')
    }
    previousEnd = plane.offset + plane.bytes
  }
  if (previousEnd !== metadata.byteLength) {
    throw new Error('PipeWire plane metadata does not cover the frame buffer')
  }
  return structuredClone(metadata)
}
