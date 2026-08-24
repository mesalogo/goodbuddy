import type {
  ModelBridgeIdentity,
  ModelBridgePolicy
} from '../../shared/model-bridge-contracts'
import {
  remoteModelGatewayResponseSchema,
  type RemoteModelGatewayRequest,
  type RemoteModelGatewayResponse
} from '../../shared/remote-model-gateway-contracts'

export type MainModelBridgeDispatchInput = {
  identity: ModelBridgeIdentity
  policy: ModelBridgePolicy
  request: RemoteModelGatewayRequest
  requestDigest: string
}

export type MainModelBridgeDispatch = (
  input: MainModelBridgeDispatchInput,
  signal: AbortSignal
) => Promise<RemoteModelGatewayResponse>

export type MainModelBridgeDelivered = (
  identity: ModelBridgeIdentity,
  requestDigest: string
) => void | Promise<void>

export type MainModelBridgeFinalizePrompt = (
  identity: Pick<
    ModelBridgeIdentity,
    'bindingId' | 'promptOperationId'
  >
) => void | Promise<void>

export type MainModelBridgePoison = (
  bindingId: string,
  promptOperationId: string,
  reason: string
) => void | Promise<void>

/**
 * Dispatch implementations may explicitly identify a failure that happened
 * before any provider side effect. All unclassified dispatch failures are
 * conservatively treated as outcome-unknown by the session.
 */
export class MainModelBridgeDispatchError extends Error {
  constructor(
    readonly code: string,
    options: {
      outcomeUnknown: boolean
      postDispatch: boolean
      cause?: unknown
    }
  ) {
    super('Remote model dispatch failed', {
      cause: options.cause
    })
    this.name = 'MainModelBridgeDispatchError'
    this.outcomeUnknown = options.outcomeUnknown
    this.postDispatch = options.postDispatch
  }

  readonly outcomeUnknown: boolean
  readonly postDispatch: boolean
}

export function validateMainModelBridgeDispatchResponse(
  value: unknown
): RemoteModelGatewayResponse {
  return remoteModelGatewayResponseSchema.parse(value)
}

export function dispatchFailureIsUncertain(error: unknown): boolean {
  return !(
    error instanceof MainModelBridgeDispatchError &&
    !error.outcomeUnknown &&
    !error.postDispatch
  )
}

export function dispatchFailureCode(error: unknown): string {
  return error instanceof MainModelBridgeDispatchError
    ? error.code
    : 'dispatch-failed'
}
