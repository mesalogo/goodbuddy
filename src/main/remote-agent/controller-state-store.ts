import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  acpBindingCursorsSchema,
  agentIdentifierSchema,
  agentSequenceSchema,
  positiveAgentSequenceSchema
} from '../../shared/agent-protocol'
import {
  isMissingFileError,
  writeJsonFileAtomically
} from '../settings-file-utils'

const MAXIMUM_CONNECTION_RECORDS = 128
const MAXIMUM_EVENT_CURSORS = 1_024
const MAXIMUM_NONTERMINAL_OPERATIONS = 4_096
const MAXIMUM_ACP_BINDINGS = 128
const ACP_BINDING_WRITE_DELAY_MS = 25

const eventCursorSchema = z
  .object({
    streamId: agentIdentifierSchema,
    streamEpoch: positiveAgentSequenceSchema,
    acknowledgedSequence: agentSequenceSchema
  })
  .strict()

const acpRecoveryBindingSchema = z
  .object({
    bindingId: agentIdentifierSchema,
    channelId: agentIdentifierSchema,
    channelEpoch: positiveAgentSequenceSchema,
    cursors: acpBindingCursorsSchema
  })
  .strict()

const connectionStateSchema = z
  .object({
    cacheKey: z.string().regex(/^[a-f0-9]{64}$/u),
    hostId: agentIdentifierSchema,
    installationId: agentIdentifierSchema,
    protocolMajor: z.number().int().min(0).max(65_535),
    previousConnectionId: agentIdentifierSchema,
    previousGeneration: z.number().int().min(1).max(0xffff_ffff),
    daemonBootId: agentIdentifierSchema,
    capabilityGeneration: z.number().int().min(1).max(0xffff_ffff),
    acpBindings: z
      .array(acpRecoveryBindingSchema)
      .max(MAXIMUM_ACP_BINDINGS)
      .default([])
  })
  .strict()
  .superRefine((state, context) => {
    const bindingIds = new Set<string>()
    for (let index = 0; index < state.acpBindings.length; index += 1) {
      const bindingId = state.acpBindings[index]!.bindingId
      if (bindingIds.has(bindingId)) {
        context.addIssue({
          code: 'custom',
          path: ['acpBindings', index, 'bindingId'],
          message: 'ACP recovery binding identities must be unique'
        })
      }
      bindingIds.add(bindingId)
    }
  })

const compatibleConnectionStateSchema = z
  .object({
    eventCursors: z
      .array(eventCursorSchema)
      .max(MAXIMUM_EVENT_CURSORS)
      .optional(),
    nonterminalOperationIds: z
      .array(agentIdentifierSchema)
      .max(MAXIMUM_NONTERMINAL_OPERATIONS)
      .optional(),
    acpBindingIds: z
      .array(agentIdentifierSchema)
      .max(MAXIMUM_ACP_BINDINGS)
      .optional()
  })
  .passthrough()
  .transform((state) => {
    const migrated = { ...state }
    delete migrated.eventCursors
    delete migrated.nonterminalOperationIds
    delete migrated.acpBindingIds
    return connectionStateSchema.parse(migrated)
  })

const persistedControllerStateSchema = z
  .object({
    version: z.literal(1),
    controllerId: agentIdentifierSchema,
    connections: z
      .array(connectionStateSchema)
      .max(MAXIMUM_CONNECTION_RECORDS)
  })
  .strict()
  .superRefine((state, context) => {
    const keys = new Set<string>()
    for (let index = 0; index < state.connections.length; index += 1) {
      const key = state.connections[index]!.cacheKey
      if (keys.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['connections', index, 'cacheKey'],
          message: 'Controller connection cache keys must be unique'
        })
      }
      keys.add(key)
    }
  })

const persistedControllerStateReadSchema = z
  .object({
    version: z.literal(1),
    controllerId: agentIdentifierSchema,
    connections: z
      .array(compatibleConnectionStateSchema)
      .max(MAXIMUM_CONNECTION_RECORDS)
  })
  .strict()
  .transform((state) => persistedControllerStateSchema.parse(state))

export type ControllerAcpRecoveryBinding = z.infer<
  typeof acpRecoveryBindingSchema
>
export type ControllerConnectionState = z.infer<
  typeof connectionStateSchema
>
export type PersistedControllerState = z.infer<
  typeof persistedControllerStateSchema
>

export interface ControllerStateFile {
  read(): Promise<unknown | undefined>
  write(value: PersistedControllerState): Promise<void>
}

export class JsonControllerStateFile implements ControllerStateFile {
  constructor(readonly filePath: string) {}

  async read(): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined
      }
      throw error
    }
  }

  async write(value: PersistedControllerState): Promise<void> {
    await writeJsonFileAtomically(this.filePath, value)
  }
}

/**
 * The persisted shape deliberately excludes SSH targets, credentials,
 * operation payloads/results, event payloads, capabilities, and tokens.
 */
export class ControllerStateStore {
  readonly #file: ControllerStateFile
  #state?: PersistedControllerState
  #load?: Promise<PersistedControllerState>
  #updates: Promise<void> = Promise.resolve()
  #acpBindingWriteTimer?: ReturnType<typeof setTimeout>
  #acpBindingsDirty = false
  #disposed = false

  constructor(file: string | ControllerStateFile) {
    this.#file =
      typeof file === 'string' ? new JsonControllerStateFile(file) : file
  }

  async getControllerId(): Promise<string> {
    return (await this.#ensureLoaded()).controllerId
  }

  async getConnection(
    cacheKey: string
  ): Promise<ControllerConnectionState | undefined> {
    assertCacheKey(cacheKey)
    const state = await this.#ensureLoaded()
    const connection = state.connections.find(
      (candidate) => candidate.cacheKey === cacheKey
    )
    return connection === undefined
      ? undefined
      : structuredClone(connection)
  }

  updateConnection(connection: ControllerConnectionState): Promise<void> {
    const parsed = connectionStateSchema.parse(connection)
    return this.#queue(async () => {
      const state = structuredClone(await this.#ensureLoaded())
      const index = state.connections.findIndex(
        (candidate) => candidate.cacheKey === parsed.cacheKey
      )
      if (index >= 0) {
        state.connections[index] = parsed
      } else {
        if (state.connections.length >= MAXIMUM_CONNECTION_RECORDS) {
          throw new Error('Controller connection state limit reached')
        }
        state.connections.push(parsed)
      }
      await this.#writeState(state)
    })
  }

  updateConnectionPreservingRecovery(
    connection: ControllerConnectionState
  ): Promise<void> {
    const parsed = connectionStateSchema.parse(connection)
    return this.#queue(async () => {
      const state = structuredClone(await this.#ensureLoaded())
      const index = state.connections.findIndex(
        (candidate) => candidate.cacheKey === parsed.cacheKey
      )
      if (index < 0) {
        throw new Error('Controller connection state is unavailable')
      }
      const current = state.connections[index]!
      state.connections[index] = connectionStateSchema.parse({
        ...parsed,
        acpBindings: current.acpBindings
      })
      await this.#writeState(state)
    })
  }

  updateAcpBinding(
    cacheKey: string,
    bindingId: string,
    binding: ControllerAcpRecoveryBinding | undefined
  ): Promise<void> {
    assertCacheKey(cacheKey)
    const parsedBindingId = agentIdentifierSchema.parse(bindingId)
    let parsed =
      binding === undefined
        ? undefined
        : acpRecoveryBindingSchema.parse(binding)
    if (parsed !== undefined && parsed.bindingId !== parsedBindingId) {
      throw new Error('Controller ACP recovery binding identity mismatch')
    }
    return this.#queue(async () => {
      const state = await this.#ensureLoaded()
      const connection = state.connections.find(
        (candidate) => candidate.cacheKey === cacheKey
      )
      if (connection === undefined) {
        throw new Error('Controller connection state is unavailable')
      }
      const previous = connection.acpBindings.find(
        (candidate) => candidate.bindingId === parsedBindingId
      )
      if (
        parsed !== undefined &&
        previous !== undefined
      ) {
        const candidate = parsed
        const channelChanged =
          candidate.channelId !== previous.channelId
        const epochChanged =
          candidate.channelEpoch !== previous.channelEpoch
        const isOpenClaim = Object.values(
          candidate.cursors
        ).every((value) => value === '0')
        const cursorsRegress = Object.keys(candidate.cursors).some(
          (key) =>
            BigInt(
              candidate.cursors[
                key as keyof typeof candidate.cursors
              ]
            ) <
            BigInt(
              previous.cursors[
                key as keyof typeof previous.cursors
              ]
            )
        )
        if (
          channelChanged ||
          (epochChanged && !isOpenClaim)
        ) {
          throw new Error(
            'Controller ACP recovery identity or cursors cannot regress'
          )
        }
        if (!epochChanged && cursorsRegress) {
          if (!isOpenClaim) {
            throw new Error(
              'Controller ACP recovery identity or cursors cannot regress'
            )
          }
          parsed = previous
        }
      }
      connection.acpBindings = connection.acpBindings.filter(
        (candidate) => candidate.bindingId !== parsedBindingId
      )
      if (parsed !== undefined) {
        if (connection.acpBindings.length >= MAXIMUM_ACP_BINDINGS) {
          throw new Error('Controller ACP recovery state limit reached')
        }
        connection.acpBindings.push(parsed)
      }
      this.#acpBindingsDirty = true
      this.#scheduleAcpBindingWrite()
    })
  }

  removeConnection(cacheKey: string): Promise<void> {
    assertCacheKey(cacheKey)
    return this.#queue(async () => {
      const state = structuredClone(await this.#ensureLoaded())
      const next = state.connections.filter(
        (connection) => connection.cacheKey !== cacheKey
      )
      if (next.length === state.connections.length) {
        return
      }
      state.connections = next
      await this.#writeState(state)
    })
  }

  invalidateHost(hostId: string): Promise<void> {
    const parsedHostId = agentIdentifierSchema.parse(hostId)
    return this.#queue(async () => {
      const state = structuredClone(await this.#ensureLoaded())
      const next = state.connections.filter(
        (connection) => connection.hostId !== parsedHostId
      )
      if (next.length === state.connections.length) {
        return
      }
      state.connections = next
      await this.#writeState(state)
    })
  }

  async flush(): Promise<void> {
    await this.#enqueue(async () => {
      await this.#writePendingAcpBindings()
    })
  }

  dispose(): void {
    if (this.#acpBindingsDirty) {
      clearTimeout(this.#acpBindingWriteTimer)
      this.#acpBindingWriteTimer = undefined
      void this.#enqueue(async () => {
        await this.#writePendingAcpBindings()
      }).catch(() => undefined)
    }
    this.#disposed = true
  }

  async #ensureLoaded(): Promise<PersistedControllerState> {
    if (this.#state !== undefined) {
      return this.#state
    }
    if (this.#load !== undefined) {
      return await this.#load
    }
    this.#load = this.#loadState()
    try {
      return await this.#load
    } finally {
      this.#load = undefined
    }
  }

  async #loadState(): Promise<PersistedControllerState> {
    const value = await this.#file.read()
    const state =
      value === undefined
        ? {
            version: 1 as const,
            controllerId: randomUUID(),
            connections: []
          }
        : persistedControllerStateReadSchema.parse(value)
    if (value === undefined) {
      await this.#file.write(state)
    }
    this.#state = state
    return state
  }

  #queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new Error('Controller state store is closed'))
    }
    return this.#enqueue(operation)
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#updates.then(operation, operation)
    this.#updates = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  #scheduleAcpBindingWrite(): void {
    if (this.#acpBindingWriteTimer !== undefined) {
      return
    }
    this.#acpBindingWriteTimer = setTimeout(() => {
      this.#acpBindingWriteTimer = undefined
      void this.#queue(async () => {
        await this.#writePendingAcpBindings()
      }).catch(() => undefined)
    }, ACP_BINDING_WRITE_DELAY_MS)
  }

  async #writePendingAcpBindings(): Promise<void> {
    if (!this.#acpBindingsDirty) {
      return
    }
    const state = await this.#ensureLoaded()
    await this.#file.write(state)
    this.#acpBindingsDirty = false
  }

  async #writeState(state: PersistedControllerState): Promise<void> {
    await this.#file.write(state)
    this.#state = state
    this.#acpBindingsDirty = false
    if (this.#acpBindingWriteTimer !== undefined) {
      clearTimeout(this.#acpBindingWriteTimer)
      this.#acpBindingWriteTimer = undefined
    }
  }
}

function assertCacheKey(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('Invalid controller state cache key')
  }
}
