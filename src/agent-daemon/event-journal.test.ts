import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EventJournal,
  EventJournalCapacityError,
  EventJournalSequenceError
} from './event-journal'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createJournal(
  overrides: ConstructorParameters<typeof EventJournal>[1] = {}
): Promise<{ journal: EventJournal; path: string }> {
  const directory = await mkdtemp(
    join(tmpdir(), 'goodbuddy-event-journal-')
  )
  directories.push(directory)
  const path = join(directory, 'events.sqlite')
  const journal = new EventJournal(path, {
    defaultStreamLimits: {
      maximumBytes: 100,
      maximumEvents: 10,
      terminalReserveBytes: 20,
      terminalReserveEvents: 2,
      maximumDurationMs: 60_000
    },
    maximumControllerBytes: 500,
    maximumDaemonBytes: 1_000,
    terminalReserveBytes: 50,
    ...overrides
  })
  return { journal, path }
}

function event(sequence: string) {
  return {
    controllerId: 'controller-1',
    streamId: 'run-1',
    streamEpoch: '1',
    sequence
  }
}

describe('EventJournal event streams', () => {
  it('persists before replay and survives reopening', async () => {
    const { journal, path } = await createJournal()
    journal.appendEvent({
      identity: event('1'),
      eventClass: 'data',
      payload: new Uint8Array([1, 2, 3])
    })
    journal.close()

    const reopened = new EventJournal(path, {
      maximumControllerBytes: 500,
      maximumDaemonBytes: 1_000
    })
    expect(
      reopened.replayEvents({
        controllerId: 'controller-1',
        streamId: 'run-1',
        streamEpoch: '1',
        afterSequence: '0'
      })
    ).toEqual([
      expect.objectContaining({
        identity: event('1'),
        payload: new Uint8Array([1, 2, 3])
      })
    ])
    reopened.close()
  })

  it('requires contiguous identity and idempotently accepts exact duplicates', async () => {
    const { journal } = await createJournal()
    const input = {
      identity: event('1'),
      eventClass: 'control' as const,
      payload: new Uint8Array([4])
    }
    expect(journal.appendEvent(input).created).toBe(true)
    expect(journal.appendEvent(input).created).toBe(false)
    expect(() =>
      journal.appendEvent({
        ...input,
        payload: new Uint8Array([5])
      })
    ).toThrow(EventJournalSequenceError)
    expect(() =>
      journal.appendEvent({
        ...input,
        identity: event('3')
      })
    ).toThrow(/contiguous/iu)
    journal.close()
  })

  it('reserves bytes for truncation/cancellation terminal events', async () => {
    const { journal } = await createJournal({
      defaultStreamLimits: {
        maximumBytes: 10,
        maximumEvents: 10,
        terminalReserveBytes: 4,
        terminalReserveEvents: 2,
        maximumDurationMs: 60_000
      },
      maximumControllerBytes: 20,
      maximumDaemonBytes: 30,
      terminalReserveBytes: 5
    })
    journal.appendEvent({
      identity: event('1'),
      eventClass: 'data',
      payload: new Uint8Array(6)
    })
    try {
      journal.appendEvent({
        identity: event('2'),
        eventClass: 'data',
        payload: new Uint8Array(1)
      })
    } catch (error) {
      expect(error).toMatchObject({
        level: 'stream',
        terminalWriteAllowed: true
      })
    }
    expect(
      journal.appendEvent({
        identity: event('2'),
        eventClass: 'terminal',
        payload: new Uint8Array(4)
      }).created
    ).toBe(true)
    expect(() =>
      journal.appendEvent({
        identity: event('3'),
        eventClass: 'terminal',
        payload: new Uint8Array(1)
      })
    ).toThrow(EventJournalCapacityError)
    journal.close()
  })

  it('ACK-prunes data immediately but retains terminal records for the floor', async () => {
    let now = 1_000
    const { journal } = await createJournal({
      now: () => now,
      minimumUnacknowledgedTerminalRetentionMs: 100
    })
    journal.appendEvent({
      identity: event('1'),
      eventClass: 'data',
      payload: new Uint8Array([1])
    })
    journal.appendEvent({
      identity: event('2'),
      eventClass: 'terminal',
      payload: new Uint8Array([2])
    })
    journal.acknowledgeEvents({
      controllerId: 'controller-1',
      streamId: 'run-1',
      streamEpoch: '1',
      sequence: '2'
    })
    expect(
      journal
        .replayEvents({
          controllerId: 'controller-1',
          streamId: 'run-1',
          streamEpoch: '1',
          afterSequence: '0'
        })
        .map((item) => item.identity.sequence)
    ).toEqual(['2'])
    now += 101
    expect(journal.pruneAcknowledged()).toBe(1)
    expect(
      journal.replayEvents({
        controllerId: 'controller-1',
        streamId: 'run-1',
        streamEpoch: '1',
        afterSequence: '0'
      })
    ).toEqual([])
    journal.close()
  })

  it('rejects ACKs beyond durable sequence or moving backwards', async () => {
    const { journal } = await createJournal()
    journal.appendEvent({
      identity: event('1'),
      eventClass: 'data',
      payload: new Uint8Array([1])
    })
    expect(() =>
      journal.acknowledgeEvents({
        controllerId: 'controller-1',
        streamId: 'run-1',
        streamEpoch: '1',
        sequence: '2'
      })
    ).toThrow(/exceeds/iu)
    journal.acknowledgeEvents({
      controllerId: 'controller-1',
      streamId: 'run-1',
      streamEpoch: '1',
      sequence: '1'
    })
    expect(() =>
      journal.acknowledgeEvents({
        controllerId: 'controller-1',
        streamId: 'run-1',
        streamEpoch: '1',
        sequence: '0'
      })
    ).toThrow()
    journal.close()
  })

  it('migrates legacy streams and reconstructs durable usage counters', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-event-journal-legacy-')
    )
    directories.push(directory)
    const path = join(directory, 'events.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE event_streams (
        controller_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_epoch INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        ack_sequence INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        maximum_bytes INTEGER NOT NULL,
        maximum_events INTEGER NOT NULL,
        terminal_reserve_bytes INTEGER NOT NULL,
        terminal_reserve_events INTEGER NOT NULL,
        maximum_duration_ms INTEGER NOT NULL,
        PRIMARY KEY (controller_id, stream_id, stream_epoch)
      ) STRICT;
      CREATE TABLE journal_events (
        controller_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_epoch INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        event_class TEXT NOT NULL,
        payload BLOB NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (
          controller_id, stream_id, stream_epoch, sequence
        ),
        FOREIGN KEY (controller_id, stream_id, stream_epoch)
          REFERENCES event_streams(
            controller_id, stream_id, stream_epoch
          ) ON DELETE CASCADE
      ) STRICT;
    `)
    legacy
      .prepare(
        `INSERT INTO event_streams VALUES (
           'controller-1', 'run-1', 1, 1, 0, 1000,
           10, 10, 2, 2, 60000
         )`
      )
      .run()
    legacy
      .prepare(
        `INSERT INTO journal_events VALUES (
           'controller-1', 'run-1', 1, 1, 'data', ?, 6, 1000
         )`
      )
      .run(new Uint8Array(6))
    legacy.close()

    const migrated = new EventJournal(path, {
      defaultStreamLimits: {
        maximumBytes: 10,
        maximumEvents: 10,
        terminalReserveBytes: 2,
        terminalReserveEvents: 2,
        maximumDurationMs: 60_000
      },
      maximumControllerBytes: 20,
      maximumDaemonBytes: 30,
      terminalReserveBytes: 2
    })
    expect(() =>
      migrated.appendEvent({
        identity: event('2'),
        eventClass: 'data',
        payload: new Uint8Array(3)
      })
    ).toThrow(EventJournalCapacityError)
    migrated.close()
  })

  it('repairs corrupted usage counters before enforcing quotas', async () => {
    const { journal, path } = await createJournal({
      defaultStreamLimits: {
        maximumBytes: 10,
        maximumEvents: 10,
        terminalReserveBytes: 2,
        terminalReserveEvents: 2,
        maximumDurationMs: 60_000
      }
    })
    journal.appendEvent({
      identity: event('1'),
      eventClass: 'data',
      payload: new Uint8Array(6)
    })
    journal.close()
    const corrupt = new DatabaseSync(path)
    corrupt.exec(`
      UPDATE event_streams
      SET stored_bytes = 0, stored_events = 0;
      UPDATE event_journal_usage SET total_bytes = 0;
      DELETE FROM event_controller_usage;
    `)
    corrupt.close()

    const repaired = new EventJournal(path, {
      maximumControllerBytes: 500,
      maximumDaemonBytes: 1_000
    })
    expect(() =>
      repaired.appendEvent({
        identity: event('2'),
        eventClass: 'data',
        payload: new Uint8Array(3)
      })
    ).toThrow(EventJournalCapacityError)
    repaired.close()
  })

  it('accounts for event and ACP bytes together and releases pruned quota', async () => {
    const { journal } = await createJournal({
      maximumControllerBytes: 6,
      maximumDaemonBytes: 8,
      terminalReserveBytes: 0
    })
    journal.appendEvent({
      identity: event('1'),
      eventClass: 'data',
      payload: new Uint8Array(4)
    })
    expect(() =>
      journal.appendAcpFrame({
        controllerId: 'controller-1',
        bindingId: 'binding-controller-limit',
        channelEpoch: '1',
        direction: 'runtime-to-main',
        sequence: '1',
        payload: new Uint8Array(3)
      })
    ).toThrow(
      expect.objectContaining({ level: 'controller' })
    )
    journal.appendAcpFrame({
      controllerId: 'controller-2',
      bindingId: 'binding-daemon-limit',
      channelEpoch: '1',
      direction: 'runtime-to-main',
      sequence: '1',
      payload: new Uint8Array(4)
    })
    expect(() =>
      journal.appendAcpFrame({
        controllerId: 'controller-2',
        bindingId: 'binding-daemon-limit',
        channelEpoch: '1',
        direction: 'runtime-to-main',
        sequence: '2',
        payload: new Uint8Array(1)
      })
    ).toThrow(expect.objectContaining({ level: 'daemon' }))

    journal.acknowledgeEvents({
      controllerId: 'controller-1',
      streamId: 'run-1',
      streamEpoch: '1',
      sequence: '1'
    })
    expect(
      journal.appendAcpFrame({
        controllerId: 'controller-2',
        bindingId: 'binding-daemon-limit',
        channelEpoch: '1',
        direction: 'runtime-to-main',
        sequence: '2',
        payload: new Uint8Array(1)
      }).created
    ).toBe(true)
    journal.close()
  })

  it('retires fully ACKed terminal stream metadata without permitting reuse', async () => {
    const { journal, path } = await createJournal({
      minimumUnacknowledgedTerminalRetentionMs: 0
    })
    journal.appendEvent({
      identity: event('1'),
      eventClass: 'terminal',
      payload: new Uint8Array([1])
    })
    journal.acknowledgeEvents({
      controllerId: 'controller-1',
      streamId: 'run-1',
      streamEpoch: '1',
      sequence: '1'
    })
    expect(() =>
      journal.acknowledgeEvents({
        controllerId: 'controller-1',
        streamId: 'run-1',
        streamEpoch: '1',
        sequence: '1'
      })
    ).not.toThrow()
    expect(() =>
      journal.appendEvent({
        identity: event('1'),
        eventClass: 'terminal',
        payload: new Uint8Array([1])
      })
    ).toThrow(EventJournalSequenceError)
    journal.close()

    const check = new DatabaseSync(path)
    expect(
      (
        check
          .prepare('SELECT COUNT(*) AS count FROM event_streams')
          .get() as { count: number }
      ).count
    ).toBe(0)
    expect(
      (
        check
          .prepare(
            'SELECT COUNT(*) AS count FROM retired_event_streams'
          )
          .get() as { count: number }
      ).count
    ).toBe(1)
    check.close()
  })
})

describe('EventJournal ACP directional journals', () => {
  it('enforces ACP frame caps before insert without advancing the journal cursor', async () => {
    const { journal } = await createJournal({
      maximumAcpChannelFrames: 1,
      maximumAcpControllerFrames: 2,
      maximumAcpDaemonFrames: 3
    })
    const append = (
      controllerId: string,
      bindingId: string,
      sequence = '1'
    ) =>
      journal.appendAcpFrame({
        controllerId,
        bindingId,
        channelEpoch: '1',
        direction: 'runtime-to-main',
        sequence,
        payload: Uint8Array.of(1)
      })
    append('controller-1', 'binding-1')
    expect(() => append('controller-1', 'binding-1', '2')).toThrow(
      expect.objectContaining({ level: 'stream' })
    )
    expect(
      journal.getAcpCursor(
        'binding-1',
        '1',
        'runtime-to-main'
      )?.journaledSequence
    ).toBe('1')
    append('controller-1', 'binding-2')
    expect(() => append('controller-1', 'binding-3')).toThrow(
      expect.objectContaining({ level: 'controller' })
    )
    append('controller-2', 'binding-4')
    expect(() => append('controller-2', 'binding-5')).toThrow(
      expect.objectContaining({ level: 'daemon' })
    )
    expect(
      journal.getAcpCursor(
        'binding-5',
        '1',
        'runtime-to-main'
      )
    ).toBeUndefined()
    journal.close()
  })

  it('transactionally prunes delivered outbound frames without retiring cursor history', async () => {
    const { journal } = await createJournal()
    journal.appendAcpFrame({
      controllerId: 'controller-1',
      bindingId: 'binding-1',
      channelEpoch: '9',
      direction: 'main-to-runtime',
      sequence: '1',
      payload: new TextEncoder().encode('{"method":"session/prompt"}\n')
    })
    expect(
      journal.getAcpCursor(
        'binding-1',
        '9',
        'main-to-runtime'
      )
    ).toEqual({
      bindingId: 'binding-1',
      channelEpoch: '9',
      direction: 'main-to-runtime',
      journaledSequence: '1',
      deliveredSequence: '0',
      mainAckSequence: '0'
    })
    journal.markAcpDelivered({
      bindingId: 'binding-1',
      channelEpoch: '9',
      sequence: '1'
    })
    expect(
      journal.getAcpCursor(
        'binding-1',
        '9',
        'main-to-runtime'
      )?.deliveredSequence
    ).toBe('1')
    expect(
      journal.replayAcpFrames({
        bindingId: 'binding-1',
        channelEpoch: '9',
        direction: 'main-to-runtime',
        afterSequence: '0'
      })
    ).toHaveLength(0)
    expect(
      journal.pruneReconciledAcpOutbound({
        bindingId: 'binding-1',
        channelEpoch: '9',
        throughSequence: '1'
      })
    ).toBe(0)
    expect(
      journal.appendAcpFrame({
        controllerId: 'controller-1',
        bindingId: 'binding-1',
        channelEpoch: '9',
        direction: 'main-to-runtime',
        sequence: '2',
        payload: new TextEncoder().encode('{"method":"session/load"}\n')
      }).created
    ).toBe(true)
    journal.close()
  })

  it('releases outbound frame capacity as each non-replayable input is delivered', async () => {
    const { journal } = await createJournal({
      maximumAcpChannelFrames: 1,
      maximumAcpControllerFrames: 1,
      maximumAcpDaemonFrames: 1
    })
    const identity = {
      controllerId: 'controller-1',
      bindingId: 'binding-input-capacity',
      channelEpoch: '7',
      direction: 'main-to-runtime' as const
    }
    journal.appendAcpFrame({
      ...identity,
      sequence: '1',
      payload: Uint8Array.of(1)
    })
    journal.markAcpDelivered({
      bindingId: identity.bindingId,
      channelEpoch: identity.channelEpoch,
      sequence: '1'
    })
    expect(
      journal.appendAcpFrame({
        ...identity,
        sequence: '2',
        payload: Uint8Array.of(2)
      }).created
    ).toBe(true)
    expect(
      journal.getAcpCursor(
        identity.bindingId,
        identity.channelEpoch,
        identity.direction
      )
    ).toMatchObject({
      journaledSequence: '2',
      deliveredSequence: '1'
    })
    journal.close()
  })

  it('tracks inbound journaled and Main ACK cursors then prunes ACKed bytes', async () => {
    const { journal } = await createJournal()
    for (const sequence of ['1', '2']) {
      journal.appendAcpFrame({
        controllerId: 'controller-1',
        bindingId: 'binding-1',
        channelEpoch: '1',
        direction: 'runtime-to-main',
        sequence,
        payload: new Uint8Array([Number(sequence)])
      })
    }
    journal.acknowledgeAcpFromMain({
      bindingId: 'binding-1',
      channelEpoch: '1',
      sequence: '1'
    })
    expect(
      journal.getAcpCursor(
        'binding-1',
        '1',
        'runtime-to-main'
      )?.mainAckSequence
    ).toBe('1')
    expect(
      journal.replayAcpFrames({
        bindingId: 'binding-1',
        channelEpoch: '1',
        direction: 'runtime-to-main',
        afterSequence: '0'
      })
    ).toEqual([
      expect.objectContaining({
        sequence: '2',
        payload: new Uint8Array([2])
      })
    ])
    expect(() =>
      journal.acknowledgeAcpFromMain({
        bindingId: 'binding-1',
        channelEpoch: '1',
        sequence: '3'
      })
    ).toThrow(/exceeds/iu)
    journal.close()
  })

  it('keeps an active inbound channel appendable after ACK reaches its current tail', async () => {
    const { journal } = await createJournal()
    const frame = {
      controllerId: 'controller-1',
      bindingId: 'binding-streaming',
      channelEpoch: '4',
      direction: 'runtime-to-main' as const
    }
    journal.appendAcpFrame({
      ...frame,
      sequence: '1',
      payload: new Uint8Array([1])
    })
    journal.acknowledgeAcpFromMain({
      bindingId: frame.bindingId,
      channelEpoch: frame.channelEpoch,
      sequence: '1'
    })

    expect(
      journal.getAcpCursor(
        frame.bindingId,
        frame.channelEpoch,
        frame.direction
      )
    ).toEqual({
      bindingId: frame.bindingId,
      channelEpoch: frame.channelEpoch,
      direction: frame.direction,
      journaledSequence: '1',
      deliveredSequence: '0',
      mainAckSequence: '1'
    })
    expect(
      journal.appendAcpFrame({
        ...frame,
        sequence: '2',
        payload: new Uint8Array([2])
      }).created
    ).toBe(true)
    expect(
      journal.replayAcpFrames({
        bindingId: frame.bindingId,
        channelEpoch: frame.channelEpoch,
        direction: frame.direction,
        afterSequence: '1'
      })
    ).toEqual([
      expect.objectContaining({
        sequence: '2',
        payload: new Uint8Array([2])
      })
    ])
    journal.close()
  })

  it('never reuses an ACP epoch/direction sequence with other bytes', async () => {
    const { journal } = await createJournal()
    const input = {
      controllerId: 'controller-1',
      bindingId: 'binding-1',
      channelEpoch: '2',
      direction: 'runtime-to-main' as const,
      sequence: '1',
      payload: new Uint8Array([1])
    }
    expect(journal.appendAcpFrame(input).created).toBe(true)
    expect(journal.appendAcpFrame(input).created).toBe(false)
    expect(() =>
      journal.appendAcpFrame({
        ...input,
        payload: new Uint8Array([2])
      })
    ).toThrow(EventJournalSequenceError)
    journal.close()
  })

  it('retires a binding atomically, discards terminal frames, and preserves epoch safety', async () => {
    const { journal, path } = await createJournal()
    const input = {
      controllerId: 'controller-1',
      bindingId: 'binding-retired',
      channelEpoch: '3',
      direction: 'runtime-to-main' as const,
      sequence: '1',
      payload: new Uint8Array([1])
    }
    journal.appendAcpFrame(input)
    journal.appendAcpFrame({
      ...input,
      direction: 'main-to-runtime',
      payload: new Uint8Array([2])
    })
    expect(journal.retireAcpBinding({
      controllerId: input.controllerId,
      bindingId: input.bindingId,
      channelEpoch: input.channelEpoch
    })).toBe(2)
    expect(
      journal.getAcpCursor(
        input.bindingId,
        input.channelEpoch,
        input.direction
      )
    ).toBeUndefined()
    expect(() =>
      journal.appendAcpFrame({
        ...input,
        sequence: '2',
        payload: new Uint8Array([2])
      })
    ).toThrow(EventJournalSequenceError)
    expect(journal.retireAcpBinding({
      controllerId: input.controllerId,
      bindingId: input.bindingId,
      channelEpoch: input.channelEpoch
    })).toBe(0)
    expect(() => journal.appendAcpFrame(input)).toThrow(
      EventJournalSequenceError
    )
    expect(() =>
      journal.appendAcpFrame({
        ...input,
        direction: 'main-to-runtime',
        sequence: '1'
      })
    ).toThrow(EventJournalSequenceError)
    journal.close()

    const check = new DatabaseSync(path)
    expect(
      (
        check
          .prepare('SELECT COUNT(*) AS count FROM acp_channels')
          .get() as { count: number }
      ).count
    ).toBe(0)
    expect(
      (
        check
          .prepare(
            'SELECT COUNT(*) AS count FROM retired_acp_channels'
          )
          .get() as { count: number }
      ).count
    ).toBe(2)
    expect(
      (
        check
          .prepare('SELECT COUNT(*) AS count FROM acp_frames')
          .get() as { count: number }
      ).count
    ).toBe(0)
    expect(
      (
        check
          .prepare(
            'SELECT total_bytes FROM event_journal_usage WHERE id = 1'
          )
          .get() as { total_bytes: number }
      ).total_bytes
    ).toBe(0)
    expect(
      (
        check
          .prepare(
            `SELECT total_bytes FROM event_controller_usage
             WHERE controller_id = 'controller-1'`
          )
          .get() as { total_bytes: number }
      ).total_bytes
    ).toBe(0)
    check.close()
  })
})
