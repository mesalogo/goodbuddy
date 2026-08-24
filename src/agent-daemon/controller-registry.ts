import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { agentIdentifierSchema } from '../shared/agent-protocol/contracts'
import {
  assertPrivateRegularFile,
  writePrivateFileAtomic
} from './managed-paths'

export type ControllerLease = {
  controllerId: string
  connectionId: string
  generation: number
  leaseExpiresAt: number
  capabilityGeneration: number
  ownedObjects: Readonly<Record<string, readonly string[]>>
}

type MutableController = {
  generation: number
  leaseExpiresAt: number
  capabilityGeneration: number
  connectionId?: string
  attached: boolean
  previousGeneration?: number
  previousConnectionId?: string
  ownedObjects: Map<string, Set<string>>
}

export class ControllerRegistryError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'stale-generation'
      | 'not-owner'
      | 'lease-expired'
      | 'not-attached'
      | 'takeover-mismatch'
  ) {
    super(message)
    this.name = 'ControllerRegistryError'
  }
}

export class ControllerRegistry {
  readonly #controllers = new Map<string, MutableController>()
  readonly #now: () => number
  readonly #leaseMs: number
  readonly #storagePath?: string

  constructor(options: {
    now?: () => number
    leaseMs?: number
    storagePath?: string
  } = {}) {
    this.#now = options.now ?? Date.now
    this.#leaseMs = options.leaseMs ?? 24 * 60 * 60 * 1000
    this.#storagePath = options.storagePath
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1) {
      throw new RangeError('Invalid controller lease duration')
    }
    this.#load()
  }

  attach(controllerIdInput: string): ControllerLease {
    const controllerId = agentIdentifierSchema.parse(controllerIdInput)
    let record = this.#controllers.get(controllerId)
    if (record === undefined) {
      record = {
        generation: 0,
        leaseExpiresAt: 0,
        capabilityGeneration: 1,
        attached: false,
        ownedObjects: new Map()
      }
      this.#controllers.set(controllerId, record)
    }
    const previousGeneration =
      record.generation === 0 ? undefined : record.generation
    const previousConnectionId = record.connectionId
    record.generation += 1
    if (record.generation > 0xffff_ffff) {
      throw new RangeError('Controller generation exhausted')
    }
    record.connectionId = `conn-${randomBytes(18).toString('base64url')}`
    record.attached = true
    record.previousGeneration = previousGeneration
    record.previousConnectionId = previousConnectionId
    record.leaseExpiresAt = this.#now() + this.#leaseMs
    this.#persist()
    return snapshot(controllerId, record)
  }

  resume(
    controllerId: string,
    generation: number,
    capabilityGeneration?: number
  ): ControllerLease {
    const record = this.#assertCurrent(controllerId, generation)
    if (
      capabilityGeneration !== undefined &&
      capabilityGeneration !== record.capabilityGeneration
    ) {
      throw new ControllerRegistryError(
        'Controller capability generation is stale',
        'stale-generation'
      )
    }
    record.leaseExpiresAt = this.#now() + this.#leaseMs
    this.#persist()
    return snapshot(controllerId, record)
  }

  takeover(
    controllerId: string,
    generation: number,
    input: {
      previousGeneration: number
      previousConnectionId: string
      capabilityGeneration: number
    }
  ): ControllerLease {
    const record = this.#assertCurrent(controllerId, generation)
    if (
      generation <= input.previousGeneration ||
      record.previousGeneration !== input.previousGeneration ||
      record.previousConnectionId !== input.previousConnectionId ||
      record.capabilityGeneration !== input.capabilityGeneration
    ) {
      throw new ControllerRegistryError(
        'Controller takeover does not exactly match the recorded predecessor',
        'takeover-mismatch'
      )
    }
    record.leaseExpiresAt = this.#now() + this.#leaseMs
    this.#persist()
    return snapshot(controllerId, record)
  }

  assertCurrent(controllerId: string, generation: number): ControllerLease {
    return snapshot(
      controllerId,
      this.#assertCurrent(controllerId, generation)
    )
  }

  claim(
    controllerId: string,
    generation: number,
    kind: string,
    objectIdInput: string
  ): void {
    const objectId = agentIdentifierSchema.parse(objectIdInput)
    const record = this.#assertCurrent(controllerId, generation)
    const objects = record.ownedObjects.get(kind) ?? new Set<string>()
    objects.add(objectId)
    record.ownedObjects.set(kind, objects)
    this.#persist()
  }

  assertOwner(
    controllerId: string,
    generation: number,
    kind: string,
    objectId: string
  ): void {
    const record = this.#assertCurrent(controllerId, generation)
    if (!record.ownedObjects.get(kind)?.has(objectId)) {
      throw new ControllerRegistryError(
        'Object belongs to another controller',
        'not-owner'
      )
    }
  }

  release(
    controllerId: string,
    generation: number,
    kind: string,
    objectId: string
  ): void {
    this.assertOwner(controllerId, generation, kind, objectId)
    this.#controllers.get(controllerId)?.ownedObjects.get(kind)?.delete(objectId)
    this.#persist()
  }

  revokeCapabilities(controllerId: string): number {
    const record = this.#controllers.get(controllerId)
    if (record === undefined) {
      throw new ControllerRegistryError(
        'Controller has not attached',
        'not-attached'
      )
    }
    record.capabilityGeneration += 1
    this.#persist()
    return record.capabilityGeneration
  }

  disconnect(controllerId: string, generation: number): void {
    const record = this.#assertCurrent(controllerId, generation)
    record.attached = false
    this.#persist()
  }

  #assertCurrent(controllerIdInput: string, generation: number): MutableController {
    const controllerId = agentIdentifierSchema.parse(controllerIdInput)
    const record = this.#controllers.get(controllerId)
    if (record === undefined) {
      throw new ControllerRegistryError(
        'Controller has not attached',
        'not-attached'
      )
    }
    if (record.generation !== generation) {
      throw new ControllerRegistryError(
        'Connection generation is stale',
        'stale-generation'
      )
    }
    if (!record.attached) {
      throw new ControllerRegistryError(
        'Controller is not currently attached',
        'not-attached'
      )
    }
    if (record.leaseExpiresAt < this.#now()) {
      throw new ControllerRegistryError(
        'Controller lease has expired',
        'lease-expired'
      )
    }
    return record
  }

  #load(): void {
    if (this.#storagePath === undefined) {
      return
    }
    let parsed: unknown
    try {
      assertPrivateRegularFile(this.#storagePath)
      parsed = JSON.parse(readFileSync(this.#storagePath, 'utf8'))
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        this.#persist()
        return
      }
      throw error
    }
    if (!Array.isArray(parsed)) {
      throw new Error('Controller registry is corrupt')
    }
    for (const item of parsed) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Controller registry is corrupt')
      }
      const value = item as Record<string, unknown>
      const controllerId = agentIdentifierSchema.parse(value.controllerId)
      if (
        !Number.isInteger(value.generation) ||
        (value.generation as number) < 0 ||
        (value.generation as number) > 0xffff_ffff ||
        !Number.isSafeInteger(value.leaseExpiresAt) ||
        !Number.isInteger(value.capabilityGeneration) ||
        (value.capabilityGeneration as number) < 1 ||
        value.ownedObjects === null ||
        typeof value.ownedObjects !== 'object' ||
        Array.isArray(value.ownedObjects)
      ) {
        throw new Error('Controller registry is corrupt')
      }
      const ownedObjects = new Map<string, Set<string>>()
      for (const [kind, objectIds] of Object.entries(
        value.ownedObjects as Record<string, unknown>
      )) {
        if (!Array.isArray(objectIds)) {
          throw new Error('Controller registry is corrupt')
        }
        ownedObjects.set(
          kind,
          new Set(objectIds.map((objectId) => agentIdentifierSchema.parse(objectId)))
        )
      }
      this.#controllers.set(controllerId, {
        generation: value.generation as number,
        leaseExpiresAt: value.leaseExpiresAt as number,
        capabilityGeneration: value.capabilityGeneration as number,
        connectionId:
          value.connectionId === undefined
            ? undefined
            : agentIdentifierSchema.parse(value.connectionId),
        attached: false,
        previousGeneration:
          value.previousGeneration === undefined
            ? undefined
            : generation(value.previousGeneration),
        previousConnectionId:
          value.previousConnectionId === undefined
            ? undefined
            : agentIdentifierSchema.parse(value.previousConnectionId),
        ownedObjects
      })
    }
  }

  #persist(): void {
    if (this.#storagePath === undefined) {
      return
    }
    writePrivateFileAtomic(
      this.#storagePath,
      JSON.stringify(
        [...this.#controllers].map(([controllerId, record]) => ({
          controllerId,
          generation: record.generation,
          leaseExpiresAt: record.leaseExpiresAt,
          capabilityGeneration: record.capabilityGeneration,
          connectionId: record.connectionId,
          previousGeneration: record.previousGeneration,
          previousConnectionId: record.previousConnectionId,
          ownedObjects: Object.fromEntries(
            [...record.ownedObjects].map(([kind, objects]) => [
              kind,
              [...objects]
            ])
          )
        }))
      )
    )
  }
}

function snapshot(
  controllerId: string,
  record: MutableController
): ControllerLease {
  if (record.connectionId === undefined || !record.attached) {
    throw new ControllerRegistryError(
      'Controller is not currently attached',
      'not-attached'
    )
  }
  return {
    controllerId,
    connectionId: record.connectionId,
    generation: record.generation,
    leaseExpiresAt: record.leaseExpiresAt,
    capabilityGeneration: record.capabilityGeneration,
    ownedObjects: Object.fromEntries(
      [...record.ownedObjects].map(([kind, objects]) => [
        kind,
        [...objects]
      ])
    )
  }
}

function generation(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 0xffff_ffff
  ) {
    throw new Error('Controller registry is corrupt')
  }
  return value as number
}
