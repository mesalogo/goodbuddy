import {
  operationIdentitySchema,
  operationMethodSchema,
  operationScopeSchema,
  type OperationIdentity,
  type OperationScope
} from './contracts'

type JsonPrimitive = boolean | null | number | string
export type CanonicalJsonValue =
  | JsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue }

export class CanonicalPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalPayloadError'
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set())
}

export async function digestCanonicalOperation(input: {
  method: string
  scope: OperationScope
  payload: unknown
}): Promise<string> {
  const scope = operationScopeSchema.parse(input.scope)
  const method = operationMethodSchema.parse(input.method)
  const canonical = canonicalJson({
    method,
    payload: input.payload,
    scope
  })
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical)
  )
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`
}

export async function createOperationIdentity(input: {
  controllerId: string
  operationId: string
  scope: OperationScope
  method: string
  payload: unknown
}): Promise<OperationIdentity> {
  return operationIdentitySchema.parse({
    controllerId: input.controllerId,
    operationId: input.operationId,
    scope: input.scope,
    method: input.method,
    payloadDigest: await digestCanonicalOperation(input)
  })
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalPayloadError('Non-finite numbers are not JSON')
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'undefined'
  ) {
    throw new CanonicalPayloadError(
      `Unsupported JSON value: ${typeof value}`
    )
  }
  if (typeof value !== 'object') {
    throw new CanonicalPayloadError('Unsupported JSON value')
  }
  if (ancestors.has(value)) {
    throw new CanonicalPayloadError('Circular JSON value')
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => {
          if (item === undefined) {
            throw new CanonicalPayloadError(
              'Undefined array values are not allowed'
            )
          }
          return serialize(item, ancestors)
        })
        .join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalPayloadError(
        'Only plain JSON objects are allowed'
      )
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys
      .map((key) => {
        const item = record[key]
        if (item === undefined) {
          throw new CanonicalPayloadError(
            'Undefined object values are not allowed'
          )
        }
        return `${JSON.stringify(key)}:${serialize(item, ancestors)}`
      })
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}
