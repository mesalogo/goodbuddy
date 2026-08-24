import type { DatabaseSync, StatementSync } from 'node:sqlite'
import {
  AGENT_PROTOCOL_LIMITS,
  acpFrameDirectionSchema,
  agentIdentifierSchema,
  agentSequenceSchema,
  eventIdentitySchema,
  positiveAgentSequenceSchema,
  type AcpFrameDirection,
  type EventIdentity
} from '../shared/agent-protocol/contracts'
import type { AcpJournalCursor } from '../shared/remote-agent-contracts'
import { openPrivateSqliteDatabase } from '../shared/node/private-sqlite-database'

export type JournalEventClass = 'data' | 'control' | 'terminal'

export type JournalEvent = {
  identity: EventIdentity
  eventClass: JournalEventClass
  payload: Uint8Array
  createdAt: number
}

export type EventStreamLimits = {
  maximumBytes: number
  maximumEvents: number
  terminalReserveBytes: number
  terminalReserveEvents: number
  maximumDurationMs: number
}

export type EventJournalOptions = {
  defaultStreamLimits?: Partial<EventStreamLimits>
  maximumControllerBytes?: number
  maximumDaemonBytes?: number
  terminalReserveBytes?: number
  minimumUnacknowledgedTerminalRetentionMs?: number
  maximumPayloadBytes?: number
  maximumAcpChannelBytes?: number
  maximumAcpChannelFrames?: number
  maximumAcpControllerFrames?: number
  maximumAcpDaemonFrames?: number
  now?: () => number
}

export class EventJournalCapacityError extends Error {
  constructor(
    message: string,
    readonly level: 'stream' | 'controller' | 'daemon',
    readonly terminalWriteAllowed: boolean
  ) {
    super(message)
    this.name = 'EventJournalCapacityError'
  }
}

export class EventJournalSequenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EventJournalSequenceError'
  }
}

type StreamRow = {
  controller_id: string
  stream_id: string
  stream_epoch: number
  last_sequence: number
  ack_sequence: number
  created_at: number
  maximum_bytes: number
  maximum_events: number
  terminal_reserve_bytes: number
  terminal_reserve_events: number
  maximum_duration_ms: number
  stored_bytes: number
  stored_events: number
  terminal_sequence: number
}

type EventRow = {
  controller_id: string
  stream_id: string
  stream_epoch: number
  sequence: number
  event_class: JournalEventClass
  payload: Uint8Array
  byte_length: number
  created_at: number
}

type AcpChannelRow = {
  binding_id: string
  channel_epoch: number
  direction: AcpFrameDirection
  journaled_sequence: number
  delivered_sequence: number
  main_ack_sequence: number
  controller_id: string
  stored_bytes: number
  stored_frames: number
}

type AcpFrameRow = {
  sequence: number
  payload: Uint8Array
  created_at: number
}

const defaultStreamLimits: EventStreamLimits = {
  maximumBytes: AGENT_PROTOCOL_LIMITS.runEventJournalBytes,
  maximumEvents: AGENT_PROTOCOL_LIMITS.runPendingEvents,
  terminalReserveBytes:
    AGENT_PROTOCOL_LIMITS.runTerminalReserveBytes,
  terminalReserveEvents: 4,
  maximumDurationMs: 24 * 60 * 60 * 1000
}

export class EventJournal {
  readonly #database: DatabaseSync
  readonly #streamLimits: EventStreamLimits
  readonly #maximumControllerBytes: number
  readonly #maximumDaemonBytes: number
  readonly #terminalReserveBytes: number
  readonly #minimumTerminalRetentionMs: number
  readonly #maximumPayloadBytes: number
  readonly #maximumAcpChannelBytes: number
  readonly #maximumAcpChannelFrames: number
  readonly #maximumAcpControllerFrames: number
  readonly #maximumAcpDaemonFrames: number
  readonly #now: () => number
  readonly #statements: {
    getStream: StatementSync
    getEvent: StatementSync
    insertEvent: StatementSync
    updateEventSequence: StatementSync
    replayEvents: StatementSync
    updateEventAck: StatementSync
    streamsToPrune: StatementSync
    pruneEventRows: StatementSync
    archiveEventStream: StatementSync
    retireEventStream: StatementSync
    getControllerUsage: StatementSync
    getDaemonUsage: StatementSync
    getAcpControllerFrames: StatementSync
    getAcpDaemonFrames: StatementSync
    insertStream: StatementSync
    getAcpChannel: StatementSync
    getAcpFrame: StatementSync
    insertAcpFrame: StatementSync
    updateAcpJournaled: StatementSync
    replayAcpFrames: StatementSync
    updateAcpDelivered: StatementSync
    updateAcpMainAck: StatementSync
    pruneAcpInbound: StatementSync
    pruneAcpOutbound: StatementSync
    deleteAcpBindingFrames: StatementSync
    archiveAcpInbound: StatementSync
    archiveAcpOutbound: StatementSync
    retireAcpInbound: StatementSync
    retireAcpOutbound: StatementSync
    getRetiredStream: StatementSync
    getRetiredAcpChannel: StatementSync
    getAcpEpochOwner: StatementSync
    insertAcpChannel: StatementSync
  }

  constructor(path: string, options: EventJournalOptions = {}) {
    this.#streamLimits = {
      ...defaultStreamLimits,
      ...options.defaultStreamLimits
    }
    this.#maximumControllerBytes =
      options.maximumControllerBytes ??
      AGENT_PROTOCOL_LIMITS.controllerJournalBytes
    this.#maximumDaemonBytes =
      options.maximumDaemonBytes ??
      AGENT_PROTOCOL_LIMITS.daemonJournalBytes
    this.#terminalReserveBytes =
      options.terminalReserveBytes ??
      Math.min(
        AGENT_PROTOCOL_LIMITS.runTerminalReserveBytes,
        this.#maximumControllerBytes,
        this.#maximumDaemonBytes
      )
    this.#minimumTerminalRetentionMs =
      options.minimumUnacknowledgedTerminalRetentionMs ??
      24 * 60 * 60 * 1000
    this.#maximumPayloadBytes =
      options.maximumPayloadBytes ??
      AGENT_PROTOCOL_LIMITS.maximumEventPayloadBytes
    this.#maximumAcpChannelBytes =
      options.maximumAcpChannelBytes ??
      AGENT_PROTOCOL_LIMITS.runEventJournalBytes
    this.#maximumAcpChannelFrames =
      options.maximumAcpChannelFrames ??
      AGENT_PROTOCOL_LIMITS.maximumAcpFramesPerChannel
    this.#maximumAcpControllerFrames =
      options.maximumAcpControllerFrames ??
      AGENT_PROTOCOL_LIMITS.maximumAcpFramesPerController
    this.#maximumAcpDaemonFrames =
      options.maximumAcpDaemonFrames ??
      AGENT_PROTOCOL_LIMITS.maximumAcpFramesPerDaemon
    this.#now = options.now ?? Date.now
    validateLimits(
      this.#streamLimits,
      this.#maximumControllerBytes,
      this.#maximumDaemonBytes,
      this.#terminalReserveBytes
    )
    if (
      !Number.isSafeInteger(this.#minimumTerminalRetentionMs) ||
      this.#minimumTerminalRetentionMs < 0 ||
      !Number.isSafeInteger(this.#maximumPayloadBytes) ||
      this.#maximumPayloadBytes < 0 ||
      !Number.isSafeInteger(this.#maximumAcpChannelBytes) ||
      this.#maximumAcpChannelBytes < 1 ||
      !Number.isSafeInteger(this.#maximumAcpChannelFrames) ||
      this.#maximumAcpChannelFrames < 1 ||
      !Number.isSafeInteger(this.#maximumAcpControllerFrames) ||
      this.#maximumAcpControllerFrames < this.#maximumAcpChannelFrames ||
      !Number.isSafeInteger(this.#maximumAcpDaemonFrames) ||
      this.#maximumAcpDaemonFrames < this.#maximumAcpControllerFrames
    ) {
      throw new RangeError('Invalid event journal limits')
    }
    this.#database = openPrivateSqliteDatabase(path)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS event_streams (
        controller_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_epoch INTEGER NOT NULL CHECK (stream_epoch > 0),
        last_sequence INTEGER NOT NULL DEFAULT 0,
        ack_sequence INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        maximum_bytes INTEGER NOT NULL,
        maximum_events INTEGER NOT NULL,
        terminal_reserve_bytes INTEGER NOT NULL,
        terminal_reserve_events INTEGER NOT NULL,
        maximum_duration_ms INTEGER NOT NULL,
        stored_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (stored_bytes >= 0),
        stored_events INTEGER NOT NULL DEFAULT 0
          CHECK (stored_events >= 0),
        terminal_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (terminal_sequence >= 0),
        PRIMARY KEY (controller_id, stream_id, stream_epoch)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS journal_events (
        controller_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_epoch INTEGER NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        event_class TEXT NOT NULL CHECK (
          event_class IN ('data', 'control', 'terminal')
        ),
        payload BLOB NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (
          controller_id, stream_id, stream_epoch, sequence
        ),
        FOREIGN KEY (controller_id, stream_id, stream_epoch)
          REFERENCES event_streams(
            controller_id, stream_id, stream_epoch
          ) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS journal_events_replay
        ON journal_events(
          controller_id, stream_id, stream_epoch, sequence
        );
      CREATE TABLE IF NOT EXISTS acp_channels (
        binding_id TEXT NOT NULL,
        channel_epoch INTEGER NOT NULL CHECK (channel_epoch > 0),
        direction TEXT NOT NULL CHECK (
          direction IN ('main-to-runtime', 'runtime-to-main')
        ),
        controller_id TEXT NOT NULL,
        journaled_sequence INTEGER NOT NULL DEFAULT 0,
        delivered_sequence INTEGER NOT NULL DEFAULT 0,
        main_ack_sequence INTEGER NOT NULL DEFAULT 0,
        stored_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (stored_bytes >= 0),
        stored_frames INTEGER NOT NULL DEFAULT 0
          CHECK (stored_frames >= 0),
        PRIMARY KEY (binding_id, channel_epoch, direction)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS acp_frames (
        binding_id TEXT NOT NULL,
        channel_epoch INTEGER NOT NULL,
        direction TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        payload BLOB NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (
          binding_id, channel_epoch, direction, sequence
        ),
        FOREIGN KEY (binding_id, channel_epoch, direction)
          REFERENCES acp_channels(binding_id, channel_epoch, direction)
          ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS retired_event_streams (
        controller_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_epoch INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        PRIMARY KEY (controller_id, stream_id, stream_epoch)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS retired_acp_channels (
        binding_id TEXT NOT NULL,
        channel_epoch INTEGER NOT NULL,
        direction TEXT NOT NULL,
        controller_id TEXT NOT NULL,
        journaled_sequence INTEGER NOT NULL,
        PRIMARY KEY (binding_id, channel_epoch, direction)
      ) STRICT;
    `)
    this.#migrateAndRepairUsage()
    this.#statements = {
      getStream: this.#database.prepare(
        `SELECT * FROM event_streams
         WHERE controller_id = ? AND stream_id = ?
           AND stream_epoch = ?`
      ),
      getEvent: this.#database.prepare(
        `SELECT * FROM journal_events
         WHERE controller_id = ? AND stream_id = ?
           AND stream_epoch = ? AND sequence = ?`
      ),
      insertEvent: this.#database.prepare(
        `INSERT INTO journal_events (
           controller_id, stream_id, stream_epoch, sequence,
           event_class, payload, byte_length, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      updateEventSequence: this.#database.prepare(
        `UPDATE event_streams
         SET last_sequence = ?,
             terminal_sequence = CASE
               WHEN ? = 'terminal' THEN ? ELSE terminal_sequence
             END
         WHERE controller_id = ? AND stream_id = ?
           AND stream_epoch = ?`
      ),
      replayEvents: this.#database.prepare(
        `SELECT * FROM journal_events
         WHERE controller_id = ? AND stream_id = ?
           AND stream_epoch = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`
      ),
      updateEventAck: this.#database.prepare(
        `UPDATE event_streams SET ack_sequence = ?
         WHERE controller_id = ? AND stream_id = ?
           AND stream_epoch = ?`
      ),
      streamsToPrune: this.#database.prepare(
        'SELECT * FROM event_streams WHERE ack_sequence > 0'
      ),
      pruneEventRows: this.#database.prepare(
        `DELETE FROM journal_events
         WHERE controller_id = ? AND stream_id = ?
           AND stream_epoch = ? AND sequence <= ?
           AND (event_class != 'terminal' OR created_at <= ?)`
      ),
      archiveEventStream: this.#database.prepare(
        `INSERT OR IGNORE INTO retired_event_streams (
           controller_id, stream_id, stream_epoch, last_sequence
         )
         SELECT controller_id, stream_id, stream_epoch, last_sequence
         FROM event_streams
         WHERE controller_id = ? AND stream_id = ?
           AND stream_epoch = ?
           AND terminal_sequence > 0
           AND ack_sequence >= last_sequence
           AND stored_events = 0`
      ),
      retireEventStream: this.#database.prepare(
        `DELETE FROM event_streams
         WHERE controller_id = ? AND stream_id = ?
           AND stream_epoch = ?
           AND terminal_sequence > 0
           AND ack_sequence >= last_sequence
           AND stored_events = 0`
      ),
      getControllerUsage: this.#database.prepare(
        `SELECT total_bytes FROM event_controller_usage
         WHERE controller_id = ?`
      ),
      getDaemonUsage: this.#database.prepare(
        'SELECT total_bytes FROM event_journal_usage WHERE id = 1'
      ),
      getAcpControllerFrames: this.#database.prepare(
        `SELECT COALESCE(SUM(stored_frames), 0) AS total_frames
         FROM acp_channels WHERE controller_id = ?`
      ),
      getAcpDaemonFrames: this.#database.prepare(
        `SELECT COALESCE(SUM(stored_frames), 0) AS total_frames
         FROM acp_channels`
      ),
      insertStream: this.#database.prepare(
        `INSERT INTO event_streams (
           controller_id, stream_id, stream_epoch, created_at,
           maximum_bytes, maximum_events, terminal_reserve_bytes,
           terminal_reserve_events, maximum_duration_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      getAcpChannel: this.#database.prepare(
        `SELECT * FROM acp_channels
         WHERE binding_id = ? AND channel_epoch = ? AND direction = ?`
      ),
      getAcpFrame: this.#database.prepare(
        `SELECT * FROM acp_frames
         WHERE binding_id = ? AND channel_epoch = ?
           AND direction = ? AND sequence = ?`
      ),
      insertAcpFrame: this.#database.prepare(
        `INSERT INTO acp_frames (
           binding_id, channel_epoch, direction, sequence,
           payload, byte_length, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      updateAcpJournaled: this.#database.prepare(
        `UPDATE acp_channels SET journaled_sequence = ?
         WHERE binding_id = ? AND channel_epoch = ? AND direction = ?`
      ),
      replayAcpFrames: this.#database.prepare(
        `SELECT sequence, payload, created_at FROM acp_frames
         WHERE binding_id = ? AND channel_epoch = ?
           AND direction = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`
      ),
      updateAcpDelivered: this.#database.prepare(
        `UPDATE acp_channels SET delivered_sequence = ?
         WHERE binding_id = ? AND channel_epoch = ? AND direction = ?`
      ),
      updateAcpMainAck: this.#database.prepare(
        `UPDATE acp_channels SET main_ack_sequence = ?
         WHERE binding_id = ? AND channel_epoch = ? AND direction = ?`
      ),
      pruneAcpInbound: this.#database.prepare(
        `DELETE FROM acp_frames
         WHERE binding_id = ? AND channel_epoch = ?
           AND direction = 'runtime-to-main' AND sequence <= ?`
      ),
      pruneAcpOutbound: this.#database.prepare(
        `DELETE FROM acp_frames
         WHERE binding_id = ? AND channel_epoch = ?
           AND direction = 'main-to-runtime' AND sequence <= ?`
      ),
      deleteAcpBindingFrames: this.#database.prepare(
        `DELETE FROM acp_frames
         WHERE binding_id = ? AND channel_epoch = ?`
      ),
      archiveAcpInbound: this.#database.prepare(
        `INSERT OR IGNORE INTO retired_acp_channels (
           binding_id, channel_epoch, direction, controller_id,
           journaled_sequence
         )
         SELECT binding_id, channel_epoch, direction, controller_id,
                journaled_sequence
         FROM acp_channels
         WHERE binding_id = ? AND channel_epoch = ?
           AND direction = 'runtime-to-main'`
      ),
      archiveAcpOutbound: this.#database.prepare(
        `INSERT OR IGNORE INTO retired_acp_channels (
           binding_id, channel_epoch, direction, controller_id,
           journaled_sequence
         )
         SELECT binding_id, channel_epoch, direction, controller_id,
                journaled_sequence
         FROM acp_channels
         WHERE binding_id = ? AND channel_epoch = ?
           AND direction = 'main-to-runtime'`
      ),
      retireAcpInbound: this.#database.prepare(
        `DELETE FROM acp_channels
         WHERE binding_id = ? AND channel_epoch = ?
           AND direction = 'runtime-to-main'`
      ),
      retireAcpOutbound: this.#database.prepare(
        `DELETE FROM acp_channels
         WHERE binding_id = ? AND channel_epoch = ?
           AND direction = 'main-to-runtime'`
      ),
      getRetiredStream: this.#database.prepare(
        `SELECT last_sequence FROM retired_event_streams
         WHERE controller_id = ? AND stream_id = ?
           AND stream_epoch = ?`
      ),
      getRetiredAcpChannel: this.#database.prepare(
        `SELECT controller_id, journaled_sequence
         FROM retired_acp_channels
         WHERE binding_id = ? AND channel_epoch = ? AND direction = ?`
      ),
      getAcpEpochOwner: this.#database.prepare(
        `SELECT controller_id, channel_epoch
         FROM (
           SELECT controller_id, channel_epoch, binding_id
           FROM acp_channels
           UNION ALL
           SELECT controller_id, channel_epoch, binding_id
           FROM retired_acp_channels
         )
         WHERE binding_id = ?
         ORDER BY channel_epoch DESC LIMIT 1`
      ),
      insertAcpChannel: this.#database.prepare(
        `INSERT INTO acp_channels (
           binding_id, channel_epoch, direction, controller_id
         ) VALUES (?, ?, ?, ?)`
      )
    }
  }

  appendEvent(input: {
    identity: EventIdentity
    eventClass: JournalEventClass
    payload: Uint8Array
    limits?: Partial<EventStreamLimits>
  }): { created: boolean; event: JournalEvent } {
    const identity = eventIdentitySchema.parse(input.identity)
    validateEventClass(input.eventClass)
    this.#assertPayload(input.payload)
    return this.#transaction(() => {
      const stream = this.#ensureStream(identity, input.limits)
      const sequence = sequenceNumber(identity.sequence)
      if (sequence <= stream.last_sequence) {
        const existing = this.#getEvent(identity)
        if (
          existing === undefined ||
          existing.event_class !== input.eventClass ||
          !equalBytes(existing.payload, input.payload)
        ) {
          throw new EventJournalSequenceError(
            'Event sequence is already bound to different content'
          )
        }
        return { created: false, event: eventRowToEvent(existing) }
      }
      if (sequence !== stream.last_sequence + 1) {
        throw new EventJournalSequenceError(
          'Event sequence must be contiguous'
        )
      }
      const terminal = input.eventClass === 'terminal'
      this.#assertEventCapacity(
        stream,
        input.payload.byteLength,
        terminal
      )
      const now = this.#now()
      this.#statements.insertEvent.run(
        identity.controllerId,
        identity.streamId,
        sequenceNumber(identity.streamEpoch),
        sequence,
        input.eventClass,
        input.payload,
        input.payload.byteLength,
        now
      )
      this.#statements.updateEventSequence.run(
        sequence,
        input.eventClass,
        sequence,
        identity.controllerId,
        identity.streamId,
        sequenceNumber(identity.streamEpoch)
      )
      return {
        created: true,
        event: {
          identity,
          eventClass: input.eventClass,
          payload: input.payload.slice(),
          createdAt: now
        }
      }
    })
  }

  replayEvents(input: {
    controllerId: string
    streamId: string
    streamEpoch: string
    afterSequence: string
    limit?: number
  }): JournalEvent[] {
    agentIdentifierSchema.parse(input.controllerId)
    agentIdentifierSchema.parse(input.streamId)
    positiveAgentSequenceSchema.parse(input.streamEpoch)
    agentSequenceSchema.parse(input.afterSequence)
    const limit = input.limit ?? AGENT_PROTOCOL_LIMITS.runPendingEvents
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError('Invalid replay limit')
    }
    return (
      this.#statements.replayEvents.all(
          input.controllerId,
          input.streamId,
          sequenceNumber(input.streamEpoch),
          sequenceNumber(input.afterSequence),
          limit
        ) as EventRow[]
    ).map(eventRowToEvent)
  }

  acknowledgeEvents(input: {
    controllerId: string
    streamId: string
    streamEpoch: string
    sequence: string
  }): void {
    eventIdentitySchema.parse({
      ...input,
      sequence: input.sequence
    })
    const changes = this.#transaction(() => {
      const stream = this.#getStream(
        input.controllerId,
        input.streamId,
        sequenceNumber(input.streamEpoch)
      )
      if (stream === undefined) {
        const retired = this.#statements.getRetiredStream.get(
          input.controllerId,
          input.streamId,
          sequenceNumber(input.streamEpoch)
        ) as { last_sequence: number } | undefined
        if (
          retired !== undefined &&
          sequenceNumber(input.sequence) === retired.last_sequence
        ) {
          return 0
        }
        throw new EventJournalSequenceError('Event stream does not exist')
      }
      const sequence = sequenceNumber(input.sequence)
      if (sequence < stream.ack_sequence) {
        throw new EventJournalSequenceError('Event ACK moved backwards')
      }
      if (sequence > stream.last_sequence) {
        throw new EventJournalSequenceError(
          'Event ACK exceeds journaled sequence'
        )
      }
      this.#statements.updateEventAck.run(
        sequence,
        input.controllerId,
        input.streamId,
        sequenceNumber(input.streamEpoch)
      )
      return this.#pruneAckedForStream(
        input.controllerId,
        input.streamId,
        sequenceNumber(input.streamEpoch),
        sequence
      )
    })
    this.#checkpointAfterSubstantialPrune(changes)
  }

  pruneAcknowledged(): number {
    let changes = 0
    this.#transaction(() => {
      const streams = this.#statements.streamsToPrune.all() as StreamRow[]
      for (const stream of streams) {
        changes += this.#pruneAckedForStream(
          stream.controller_id,
          stream.stream_id,
          stream.stream_epoch,
          stream.ack_sequence
        )
      }
    })
    this.#checkpointAfterSubstantialPrune(changes)
    return changes
  }

  appendAcpFrame(input: {
    controllerId: string
    bindingId: string
    channelEpoch: string
    direction: AcpFrameDirection
    sequence: string
    payload: Uint8Array
  }): { created: boolean } {
    agentIdentifierSchema.parse(input.controllerId)
    agentIdentifierSchema.parse(input.bindingId)
    positiveAgentSequenceSchema.parse(input.channelEpoch)
    acpFrameDirectionSchema.parse(input.direction)
    agentSequenceSchema.parse(input.sequence)
    this.#assertPayload(input.payload)
    return this.#transaction(() => {
      const channel = this.#ensureAcpChannel(input)
      const sequence = sequenceNumber(input.sequence)
      if (sequence <= channel.journaled_sequence) {
        const existing = this.#statements.getAcpFrame.get(
            input.bindingId,
            sequenceNumber(input.channelEpoch),
            input.direction,
            sequence
          ) as AcpFrameRow | undefined
        if (
          existing === undefined ||
          !equalBytes(existing.payload, input.payload)
        ) {
          throw new EventJournalSequenceError(
            'ACP sequence is already bound to different content'
          )
        }
        return { created: false }
      }
      if (sequence !== channel.journaled_sequence + 1) {
        throw new EventJournalSequenceError(
          'ACP frame sequence must be contiguous'
        )
      }
      this.#assertGlobalCapacity(
        input.controllerId,
        input.payload.byteLength,
        false
      )
      if (
        channel.stored_bytes + input.payload.byteLength >
        this.#maximumAcpChannelBytes
      ) {
        throw new EventJournalCapacityError(
          'ACP channel journal quota reached',
          'stream',
          false
        )
      }
      this.#assertAcpFrameCapacity(channel)
      this.#statements.insertAcpFrame.run(
        input.bindingId,
        sequenceNumber(input.channelEpoch),
        input.direction,
        sequence,
        input.payload,
        input.payload.byteLength,
        this.#now()
      )
      this.#statements.updateAcpJournaled.run(
        sequence,
        input.bindingId,
        sequenceNumber(input.channelEpoch),
        input.direction
      )
      return { created: true }
    })
  }

  markAcpDelivered(input: {
    bindingId: string
    channelEpoch: string
    sequence: string
  }): void {
    const changes = this.#advanceAcpCursor({
      ...input,
      direction: 'main-to-runtime',
      column: 'delivered_sequence'
    })
    this.#checkpointAfterSubstantialPrune(changes)
  }

  acknowledgeAcpFromMain(input: {
    bindingId: string
    channelEpoch: string
    sequence: string
  }): void {
    agentIdentifierSchema.parse(input.bindingId)
    positiveAgentSequenceSchema.parse(input.channelEpoch)
    agentSequenceSchema.parse(input.sequence)
    const changes = this.#transaction(() => {
      const epoch = sequenceNumber(input.channelEpoch)
      const channel = this.#getAcpChannel(
        input.bindingId,
        epoch,
        'runtime-to-main'
      )
      if (channel === undefined) {
        const retired = this.#statements.getRetiredAcpChannel.get(
          input.bindingId,
          epoch,
          'runtime-to-main'
        ) as
          | { controller_id: string; journaled_sequence: number }
          | undefined
        if (
          retired !== undefined &&
          sequenceNumber(input.sequence) ===
            retired.journaled_sequence
        ) {
          return 0
        }
        throw new EventJournalSequenceError('ACP channel does not exist')
      }
      const next = sequenceNumber(input.sequence)
      this.#assertAcpCursor(channel, next, 'main_ack_sequence')
      if (next === channel.main_ack_sequence) {
        return 0
      }
      this.#statements.updateAcpMainAck.run(
        next,
        input.bindingId,
        epoch,
        'runtime-to-main'
      )
      const pruned = Number(
        this.#statements.pruneAcpInbound.run(
          input.bindingId,
          epoch,
          next
        ).changes
      )
      return pruned
    })
    this.#checkpointAfterSubstantialPrune(changes)
  }

  retireAcpBinding(input: {
    controllerId: string
    bindingId: string
    channelEpoch: string
  }): number {
    agentIdentifierSchema.parse(input.controllerId)
    agentIdentifierSchema.parse(input.bindingId)
    positiveAgentSequenceSchema.parse(input.channelEpoch)
    const changes = this.#transaction(() => {
      const epoch = sequenceNumber(input.channelEpoch)
      const inbound = this.#ensureAcpRetirementChannel({
        ...input,
        channelEpoch: epoch,
        direction: 'runtime-to-main'
      })
      const outbound = this.#ensureAcpRetirementChannel({
        ...input,
        channelEpoch: epoch,
        direction: 'main-to-runtime'
      })
      const storedFrames =
        (inbound?.stored_frames ?? 0) +
        (outbound?.stored_frames ?? 0)
      this.#statements.archiveAcpInbound.run(input.bindingId, epoch)
      this.#statements.archiveAcpOutbound.run(input.bindingId, epoch)
      this.#statements.deleteAcpBindingFrames.run(
        input.bindingId,
        epoch
      )
      this.#statements.retireAcpInbound.run(input.bindingId, epoch)
      this.#statements.retireAcpOutbound.run(input.bindingId, epoch)
      return storedFrames
    })
    this.#checkpointAfterSubstantialPrune(changes)
    return changes
  }

  pruneReconciledAcpOutbound(input: {
    bindingId: string
    channelEpoch: string
    throughSequence: string
  }): number {
    agentIdentifierSchema.parse(input.bindingId)
    positiveAgentSequenceSchema.parse(input.channelEpoch)
    agentSequenceSchema.parse(input.throughSequence)
    const changes = this.#transaction(() => {
      const epoch = sequenceNumber(input.channelEpoch)
      const through = sequenceNumber(input.throughSequence)
      const channel = this.#getAcpChannel(
        input.bindingId,
        epoch,
        'main-to-runtime'
      )
      if (
        channel === undefined
      ) {
        const retired = this.#statements.getRetiredAcpChannel.get(
          input.bindingId,
          epoch,
          'main-to-runtime'
        ) as
          | { controller_id: string; journaled_sequence: number }
          | undefined
        if (
          retired !== undefined &&
          through <= retired.journaled_sequence
        ) {
          return 0
        }
        throw new EventJournalSequenceError(
          'Cannot prune outbound ACP before delivery reconciliation'
        )
      }
      if (through > channel.delivered_sequence) {
        throw new EventJournalSequenceError(
          'Cannot prune outbound ACP before delivery reconciliation'
        )
      }
      const pruned = Number(
        this.#statements.pruneAcpOutbound.run(
          input.bindingId,
          epoch,
          through
        ).changes
      )
      return pruned
    })
    this.#checkpointAfterSubstantialPrune(changes)
    return changes
  }

  replayAcpFrames(input: {
    bindingId: string
    channelEpoch: string
    direction: AcpFrameDirection
    afterSequence: string
    limit?: number
  }): Array<{ sequence: string; payload: Uint8Array; createdAt: number }> {
    agentIdentifierSchema.parse(input.bindingId)
    positiveAgentSequenceSchema.parse(input.channelEpoch)
    acpFrameDirectionSchema.parse(input.direction)
    agentSequenceSchema.parse(input.afterSequence)
    const limit = input.limit ?? AGENT_PROTOCOL_LIMITS.runPendingEvents
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError('Invalid replay limit')
    }
    return (
      this.#statements.replayAcpFrames.all(
          input.bindingId,
          sequenceNumber(input.channelEpoch),
          input.direction,
          sequenceNumber(input.afterSequence),
          limit
        ) as AcpFrameRow[]
    ).map((row) => ({
      sequence: String(row.sequence),
      payload: new Uint8Array(row.payload),
      createdAt: row.created_at
    }))
  }

  getAcpCursor(
    bindingId: string,
    channelEpoch: string,
    direction: AcpFrameDirection
  ): AcpJournalCursor | undefined {
    agentIdentifierSchema.parse(bindingId)
    positiveAgentSequenceSchema.parse(channelEpoch)
    acpFrameDirectionSchema.parse(direction)
    const row = this.#getAcpChannel(
      bindingId,
      sequenceNumber(channelEpoch),
      direction
    )
    if (row === undefined) {
      return undefined
    }
    return {
      bindingId,
      channelEpoch,
      direction,
      journaledSequence: String(row.journaled_sequence),
      deliveredSequence: String(row.delivered_sequence),
      mainAckSequence: String(row.main_ack_sequence)
    }
  }

  close(): void {
    this.#database.close()
  }

  #ensureStream(
    identity: EventIdentity,
    overrides: Partial<EventStreamLimits> | undefined
  ): StreamRow {
    const epoch = sequenceNumber(identity.streamEpoch)
    const existing = this.#getStream(
      identity.controllerId,
      identity.streamId,
      epoch
    )
    if (existing !== undefined) {
      return existing
    }
    if (
      this.#statements.getRetiredStream.get(
        identity.controllerId,
        identity.streamId,
        epoch
      ) !== undefined
    ) {
      throw new EventJournalSequenceError(
        'Event stream has already been terminally acknowledged'
      )
    }
    const limits = { ...this.#streamLimits, ...overrides }
    validateStreamLimits(limits)
    const now = this.#now()
    this.#statements.insertStream.run(
      identity.controllerId,
      identity.streamId,
      epoch,
      now,
      limits.maximumBytes,
      limits.maximumEvents,
      limits.terminalReserveBytes,
      limits.terminalReserveEvents,
      limits.maximumDurationMs
    )
    return this.#getStream(
      identity.controllerId,
      identity.streamId,
      epoch
    )!
  }

  #getStream(
    controllerId: string,
    streamId: string,
    streamEpoch: number
  ): StreamRow | undefined {
    return this.#statements.getStream.get(
      controllerId,
      streamId,
      streamEpoch
    ) as
      | StreamRow
      | undefined
  }

  #getEvent(identity: EventIdentity): EventRow | undefined {
    return this.#statements.getEvent.get(
        identity.controllerId,
        identity.streamId,
        sequenceNumber(identity.streamEpoch),
        sequenceNumber(identity.sequence)
      ) as EventRow | undefined
  }

  #assertEventCapacity(
    stream: StreamRow,
    addedBytes: number,
    terminal: boolean
  ): void {
    const streamByteLimit = terminal
      ? stream.maximum_bytes
      : stream.maximum_bytes - stream.terminal_reserve_bytes
    const streamEventLimit = terminal
      ? stream.maximum_events
      : stream.maximum_events - stream.terminal_reserve_events
    if (
      stream.stored_events + 1 > streamEventLimit ||
      stream.stored_bytes + addedBytes > streamByteLimit ||
      (!terminal &&
        this.#now() - stream.created_at > stream.maximum_duration_ms)
    ) {
      throw new EventJournalCapacityError(
        'Event stream quota reached',
        'stream',
        stream.stored_bytes + addedBytes <= stream.maximum_bytes &&
          stream.stored_events + 1 <= stream.maximum_events
      )
    }
    this.#assertGlobalCapacity(
      stream.controller_id,
      addedBytes,
      terminal
    )
  }

  #assertGlobalCapacity(
    controllerId: string,
    addedBytes: number,
    terminal: boolean
  ): void {
    const controllerBytes = this.#controllerBytes(controllerId)
    const daemonBytes = this.#daemonBytes()
    const controllerLimit = terminal
      ? this.#maximumControllerBytes
      : this.#maximumControllerBytes - this.#terminalReserveBytes
    const daemonLimit = terminal
      ? this.#maximumDaemonBytes
      : this.#maximumDaemonBytes - this.#terminalReserveBytes
    if (controllerBytes + addedBytes > controllerLimit) {
      throw new EventJournalCapacityError(
        'Controller journal quota reached',
        'controller',
        controllerBytes + addedBytes <= this.#maximumControllerBytes
      )
    }
    if (daemonBytes + addedBytes > daemonLimit) {
      throw new EventJournalCapacityError(
        'Daemon journal quota reached',
        'daemon',
        daemonBytes + addedBytes <= this.#maximumDaemonBytes
      )
    }
  }

  #assertAcpFrameCapacity(channel: AcpChannelRow): void {
    if (channel.stored_frames + 1 > this.#maximumAcpChannelFrames) {
      throw new EventJournalCapacityError(
        'ACP channel frame quota reached',
        'stream',
        false
      )
    }
    const controller = this.#statements.getAcpControllerFrames.get(
      channel.controller_id
    ) as { total_frames: number } | undefined
    const daemon = this.#statements.getAcpDaemonFrames.get() as
      | { total_frames: number }
      | undefined
    if (
      controller === undefined ||
      !Number.isSafeInteger(controller.total_frames) ||
      controller.total_frames < 0 ||
      controller.total_frames + 1 > this.#maximumAcpControllerFrames
    ) {
      throw new EventJournalCapacityError(
        'ACP controller frame quota reached',
        'controller',
        false
      )
    }
    if (
      daemon === undefined ||
      !Number.isSafeInteger(daemon.total_frames) ||
      daemon.total_frames < 0 ||
      daemon.total_frames + 1 > this.#maximumAcpDaemonFrames
    ) {
      throw new EventJournalCapacityError(
        'ACP daemon frame quota reached',
        'daemon',
        false
      )
    }
  }

  #controllerBytes(controllerId: string): number {
    const usage = this.#statements.getControllerUsage.get(
      controllerId
    ) as { total_bytes: number } | undefined
    if (
      usage === undefined ||
      !Number.isSafeInteger(usage.total_bytes) ||
      usage.total_bytes < 0
    ) {
      throw new EventJournalCapacityError(
        'Controller journal usage is unavailable',
        'controller',
        false
      )
    }
    return usage.total_bytes
  }

  #daemonBytes(): number {
    const usage = this.#statements.getDaemonUsage.get() as
      | { total_bytes: number }
      | undefined
    if (
      usage === undefined ||
      !Number.isSafeInteger(usage.total_bytes) ||
      usage.total_bytes < 0
    ) {
      throw new EventJournalCapacityError(
        'Daemon journal usage is unavailable',
        'daemon',
        false
      )
    }
    return usage.total_bytes
  }

  #ensureAcpChannel(input: {
    controllerId: string
    bindingId: string
    channelEpoch: string
    direction: AcpFrameDirection
  }): AcpChannelRow {
    const epoch = sequenceNumber(input.channelEpoch)
    const existing = this.#getAcpChannel(
      input.bindingId,
      epoch,
      input.direction
    )
    if (existing !== undefined) {
      if (existing.controller_id !== input.controllerId) {
        throw new EventJournalSequenceError(
          'ACP channel belongs to another controller'
        )
      }
      return existing
    }
    if (
      this.#statements.getRetiredAcpChannel.get(
        input.bindingId,
        epoch,
        input.direction
      ) !== undefined
    ) {
      throw new EventJournalSequenceError(
        'ACP channel has already been reconciled'
      )
    }
    const epochOwner = this.#statements.getAcpEpochOwner.get(
      input.bindingId
    ) as
      | { controller_id: string; channel_epoch: number }
      | undefined
    if (
      epochOwner !== undefined &&
      (epoch < epochOwner.channel_epoch ||
        epochOwner.controller_id !== input.controllerId)
    ) {
      throw new EventJournalSequenceError(
        'ACP channel epoch is obsolete or belongs to another controller'
      )
    }
    this.#statements.insertAcpChannel.run(
      input.bindingId,
      epoch,
      input.direction,
      input.controllerId
    )
    return this.#getAcpChannel(
      input.bindingId,
      epoch,
      input.direction
    )!
  }

  #getAcpChannel(
    bindingId: string,
    channelEpoch: number,
    direction: AcpFrameDirection
  ): AcpChannelRow | undefined {
    return this.#statements.getAcpChannel.get(
      bindingId,
      channelEpoch,
      direction
    ) as
      | AcpChannelRow
      | undefined
  }

  #ensureAcpRetirementChannel(input: {
    controllerId: string
    bindingId: string
    channelEpoch: number
    direction: AcpFrameDirection
  }): AcpChannelRow | undefined {
    let channel = this.#getAcpChannel(
      input.bindingId,
      input.channelEpoch,
      input.direction
    )
    if (channel === undefined) {
      const retired = this.#statements.getRetiredAcpChannel.get(
        input.bindingId,
        input.channelEpoch,
        input.direction
      ) as
        | { controller_id: string; journaled_sequence: number }
        | undefined
      if (retired !== undefined) {
        if (retired.controller_id !== input.controllerId) {
          throw new EventJournalSequenceError(
            'ACP channel belongs to another controller'
          )
        }
        return undefined
      }
      channel = this.#ensureAcpChannel({
        controllerId: input.controllerId,
        bindingId: input.bindingId,
        channelEpoch: input.channelEpoch.toString(),
        direction: input.direction
      })
    } else if (channel.controller_id !== input.controllerId) {
      throw new EventJournalSequenceError(
        'ACP channel belongs to another controller'
      )
    }
    return channel
  }

  #advanceAcpCursor(input: {
    bindingId: string
    channelEpoch: string
    sequence: string
    direction: AcpFrameDirection
    column: 'delivered_sequence' | 'main_ack_sequence'
  }): number {
    agentIdentifierSchema.parse(input.bindingId)
    positiveAgentSequenceSchema.parse(input.channelEpoch)
    agentSequenceSchema.parse(input.sequence)
    return this.#transaction(() => {
      const epoch = sequenceNumber(input.channelEpoch)
      const channel = this.#getAcpChannel(
        input.bindingId,
        epoch,
        input.direction
      )
      if (channel === undefined) {
        const retired = this.#statements.getRetiredAcpChannel.get(
          input.bindingId,
          epoch,
          input.direction
        ) as
          | { controller_id: string; journaled_sequence: number }
          | undefined
        if (
          retired !== undefined &&
          sequenceNumber(input.sequence) ===
            retired.journaled_sequence
        ) {
          return 0
        }
        throw new EventJournalSequenceError('ACP channel does not exist')
      }
      const next = sequenceNumber(input.sequence)
      this.#assertAcpCursor(channel, next, input.column)
      if (next !== channel[input.column]) {
        const statement =
          input.column === 'delivered_sequence'
            ? this.#statements.updateAcpDelivered
            : this.#statements.updateAcpMainAck
        statement.run(
          next,
          input.bindingId,
          epoch,
          input.direction
        )
      }
      return Number(
        this.#statements.pruneAcpOutbound.run(
          input.bindingId,
          epoch,
          next
        ).changes
      )
    })
  }

  #assertAcpCursor(
    channel: AcpChannelRow,
    next: number,
    column: 'delivered_sequence' | 'main_ack_sequence'
  ): void {
    const current = channel[column]
    if (next < current) {
      throw new EventJournalSequenceError('ACP cursor moved backwards')
    }
    if (next > channel.journaled_sequence) {
      throw new EventJournalSequenceError(
        'ACP cursor exceeds journaled sequence'
      )
    }
    if (column === 'delivered_sequence' && next > current + 1) {
      throw new EventJournalSequenceError(
        'ACP delivery cursor must be contiguous'
      )
    }
  }

  #pruneAckedForStream(
    controllerId: string,
    streamId: string,
    streamEpoch: number,
    sequence: number
  ): number {
    const cutoff = this.#now() - this.#minimumTerminalRetentionMs
    const result = this.#statements.pruneEventRows.run(
      controllerId,
      streamId,
      streamEpoch,
      sequence,
      cutoff
    )
    this.#statements.archiveEventStream.run(
      controllerId,
      streamId,
      streamEpoch
    )
    this.#statements.retireEventStream.run(
      controllerId,
      streamId,
      streamEpoch
    )
    return Number(result.changes)
  }

  #migrateAndRepairUsage(): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const streamColumns = new Set(
        (
          this.#database
            .prepare('PRAGMA table_info(event_streams)')
            .all() as Array<{ name: string }>
        ).map((column) => column.name)
      )
      if (!streamColumns.has('stored_bytes')) {
        this.#database.exec(
          `ALTER TABLE event_streams
           ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0
             CHECK (stored_bytes >= 0)`
        )
      }
      if (!streamColumns.has('stored_events')) {
        this.#database.exec(
          `ALTER TABLE event_streams
           ADD COLUMN stored_events INTEGER NOT NULL DEFAULT 0
             CHECK (stored_events >= 0)`
        )
      }
      if (!streamColumns.has('terminal_sequence')) {
        this.#database.exec(
          `ALTER TABLE event_streams
           ADD COLUMN terminal_sequence INTEGER NOT NULL DEFAULT 0
             CHECK (terminal_sequence >= 0)`
        )
      }
      const channelColumns = new Set(
        (
          this.#database
            .prepare('PRAGMA table_info(acp_channels)')
            .all() as Array<{ name: string }>
        ).map((column) => column.name)
      )
      if (!channelColumns.has('stored_bytes')) {
        this.#database.exec(
          `ALTER TABLE acp_channels
           ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0
             CHECK (stored_bytes >= 0)`
        )
      }
      if (!channelColumns.has('stored_frames')) {
        this.#database.exec(
          `ALTER TABLE acp_channels
           ADD COLUMN stored_frames INTEGER NOT NULL DEFAULT 0
             CHECK (stored_frames >= 0)`
        )
      }
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS event_journal_usage (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS event_controller_usage (
          controller_id TEXT PRIMARY KEY,
          total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0)
        ) STRICT;
        INSERT OR IGNORE INTO event_journal_usage (id, total_bytes)
          VALUES (1, 0);

        DROP TRIGGER IF EXISTS journal_events_usage_insert;
        DROP TRIGGER IF EXISTS journal_events_usage_delete;
        DROP TRIGGER IF EXISTS acp_frames_usage_insert;
        DROP TRIGGER IF EXISTS acp_frames_usage_delete;
        DROP TRIGGER IF EXISTS event_stream_controller_usage_insert;
        DROP TRIGGER IF EXISTS acp_channel_controller_usage_insert;

        CREATE TRIGGER event_stream_controller_usage_insert
        AFTER INSERT ON event_streams
        BEGIN
          INSERT OR IGNORE INTO event_controller_usage (
            controller_id, total_bytes
          ) VALUES (NEW.controller_id, 0);
        END;
        CREATE TRIGGER acp_channel_controller_usage_insert
        AFTER INSERT ON acp_channels
        BEGIN
          INSERT OR IGNORE INTO event_controller_usage (
            controller_id, total_bytes
          ) VALUES (NEW.controller_id, 0);
        END;
        CREATE TRIGGER journal_events_usage_insert
        AFTER INSERT ON journal_events
        BEGIN
          UPDATE event_streams
          SET stored_bytes = stored_bytes + NEW.byte_length,
              stored_events = stored_events + 1
          WHERE controller_id = NEW.controller_id
            AND stream_id = NEW.stream_id
            AND stream_epoch = NEW.stream_epoch;
          UPDATE event_journal_usage
          SET total_bytes = total_bytes + NEW.byte_length
          WHERE id = 1;
          INSERT INTO event_controller_usage (
            controller_id, total_bytes
          ) VALUES (NEW.controller_id, NEW.byte_length)
          ON CONFLICT(controller_id) DO UPDATE
          SET total_bytes = total_bytes + NEW.byte_length;
        END;
        CREATE TRIGGER journal_events_usage_delete
        AFTER DELETE ON journal_events
        BEGIN
          UPDATE event_streams
          SET stored_bytes = stored_bytes - OLD.byte_length,
              stored_events = stored_events - 1
          WHERE controller_id = OLD.controller_id
            AND stream_id = OLD.stream_id
            AND stream_epoch = OLD.stream_epoch;
          UPDATE event_journal_usage
          SET total_bytes = total_bytes - OLD.byte_length
          WHERE id = 1;
          UPDATE event_controller_usage
          SET total_bytes = total_bytes - OLD.byte_length
          WHERE controller_id = OLD.controller_id;
        END;
        CREATE TRIGGER acp_frames_usage_insert
        AFTER INSERT ON acp_frames
        BEGIN
          UPDATE acp_channels
          SET stored_bytes = stored_bytes + NEW.byte_length,
              stored_frames = stored_frames + 1
          WHERE binding_id = NEW.binding_id
            AND channel_epoch = NEW.channel_epoch
            AND direction = NEW.direction;
          UPDATE event_journal_usage
          SET total_bytes = total_bytes + NEW.byte_length
          WHERE id = 1;
          INSERT INTO event_controller_usage (
            controller_id, total_bytes
          )
          SELECT controller_id, NEW.byte_length
          FROM acp_channels
          WHERE binding_id = NEW.binding_id
            AND channel_epoch = NEW.channel_epoch
            AND direction = NEW.direction
          ON CONFLICT(controller_id) DO UPDATE
          SET total_bytes = total_bytes + NEW.byte_length;
        END;
        CREATE TRIGGER acp_frames_usage_delete
        AFTER DELETE ON acp_frames
        BEGIN
          UPDATE event_journal_usage
          SET total_bytes = total_bytes - OLD.byte_length
          WHERE id = 1;
          UPDATE event_controller_usage
          SET total_bytes = total_bytes - OLD.byte_length
          WHERE controller_id = (
            SELECT controller_id FROM acp_channels
            WHERE binding_id = OLD.binding_id
              AND channel_epoch = OLD.channel_epoch
              AND direction = OLD.direction
          );
          UPDATE acp_channels
          SET stored_bytes = stored_bytes - OLD.byte_length,
              stored_frames = stored_frames - 1
          WHERE binding_id = OLD.binding_id
            AND channel_epoch = OLD.channel_epoch
            AND direction = OLD.direction;
        END;

        UPDATE event_streams
        SET stored_bytes = (
              SELECT COALESCE(SUM(byte_length), 0)
              FROM journal_events
              WHERE controller_id = event_streams.controller_id
                AND stream_id = event_streams.stream_id
                AND stream_epoch = event_streams.stream_epoch
            ),
            stored_events = (
              SELECT COUNT(*)
              FROM journal_events
              WHERE controller_id = event_streams.controller_id
                AND stream_id = event_streams.stream_id
                AND stream_epoch = event_streams.stream_epoch
            ),
            terminal_sequence = COALESCE((
              SELECT MAX(sequence)
              FROM journal_events
              WHERE controller_id = event_streams.controller_id
                AND stream_id = event_streams.stream_id
                AND stream_epoch = event_streams.stream_epoch
                AND event_class = 'terminal'
            ), terminal_sequence);
        UPDATE acp_channels
        SET stored_bytes = (
              SELECT COALESCE(SUM(byte_length), 0)
              FROM acp_frames
              WHERE binding_id = acp_channels.binding_id
                AND channel_epoch = acp_channels.channel_epoch
                AND direction = acp_channels.direction
            ),
            stored_frames = (
              SELECT COUNT(*)
              FROM acp_frames
              WHERE binding_id = acp_channels.binding_id
                AND channel_epoch = acp_channels.channel_epoch
                AND direction = acp_channels.direction
            );
        DELETE FROM event_controller_usage;
        INSERT INTO event_controller_usage (controller_id, total_bytes)
        SELECT controller_id, SUM(bytes)
        FROM (
          SELECT controller_id, SUM(byte_length) AS bytes
          FROM journal_events GROUP BY controller_id
          UNION ALL
          SELECT channel.controller_id, SUM(frame.byte_length) AS bytes
          FROM acp_frames frame
          JOIN acp_channels channel
            ON channel.binding_id = frame.binding_id
           AND channel.channel_epoch = frame.channel_epoch
           AND channel.direction = frame.direction
          GROUP BY channel.controller_id
        )
        GROUP BY controller_id;
        INSERT OR IGNORE INTO event_controller_usage (
          controller_id, total_bytes
        )
        SELECT controller_id, 0 FROM event_streams
        UNION
        SELECT controller_id, 0 FROM acp_channels;
        UPDATE event_journal_usage
        SET total_bytes =
          (SELECT COALESCE(SUM(total_bytes), 0)
           FROM event_controller_usage)
        WHERE id = 1;
      `)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #checkpointAfterSubstantialPrune(changes: number): void {
    if (changes >= 100) {
      this.#database.exec('PRAGMA wal_checkpoint(PASSIVE)')
    }
  }

  #assertPayload(payload: Uint8Array): void {
    if (payload.byteLength > this.#maximumPayloadBytes) {
      throw new EventJournalCapacityError(
        'Journal payload is oversized',
        'stream',
        false
      )
    }
  }

  #transaction<T>(action: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }
}

function eventRowToEvent(row: EventRow): JournalEvent {
  return {
    identity: {
      controllerId: row.controller_id,
      streamId: row.stream_id,
      streamEpoch: String(row.stream_epoch),
      sequence: String(row.sequence)
    },
    eventClass: row.event_class,
    payload: new Uint8Array(row.payload),
    createdAt: row.created_at
  }
}

function sequenceNumber(sequence: string): number {
  return Number(agentSequenceSchema.parse(sequence))
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false
  }
  return left.every((byte, index) => byte === right[index])
}

function validateEventClass(
  value: string
): asserts value is JournalEventClass {
  if (value !== 'data' && value !== 'control' && value !== 'terminal') {
    throw new TypeError('Invalid journal event class')
  }
}

function validateLimits(
  stream: EventStreamLimits,
  controllerBytes: number,
  daemonBytes: number,
  terminalReserveBytes: number
): void {
  validateStreamLimits(stream)
  if (
    !Number.isSafeInteger(controllerBytes) ||
    !Number.isSafeInteger(daemonBytes) ||
    controllerBytes < 1 ||
    daemonBytes < controllerBytes ||
    !Number.isSafeInteger(terminalReserveBytes) ||
    terminalReserveBytes < 0 ||
    terminalReserveBytes > controllerBytes
  ) {
    throw new RangeError('Invalid event journal limits')
  }
}

function validateStreamLimits(limits: EventStreamLimits): void {
  if (
    !Number.isSafeInteger(limits.maximumBytes) ||
    limits.maximumBytes < 1 ||
    !Number.isSafeInteger(limits.maximumEvents) ||
    limits.maximumEvents < 1 ||
    !Number.isSafeInteger(limits.terminalReserveBytes) ||
    limits.terminalReserveBytes < 0 ||
    limits.terminalReserveBytes > limits.maximumBytes ||
    !Number.isSafeInteger(limits.terminalReserveEvents) ||
    limits.terminalReserveEvents < 1 ||
    limits.terminalReserveEvents > limits.maximumEvents ||
    !Number.isSafeInteger(limits.maximumDurationMs) ||
    limits.maximumDurationMs < 1
  ) {
    throw new RangeError('Invalid event stream limits')
  }
}
