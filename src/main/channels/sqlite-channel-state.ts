import type { AssistantDatabase } from '../assistant/assistant-database'
import type {
  DedupStore,
  Outbox,
  OutboxEntry
} from './channel-driver'
import type { ChannelResultMessage } from '../../shared/channel-contracts'

export class SqliteChannelDedupStore implements DedupStore {
  constructor(private readonly database: AssistantDatabase) {}

  claim(channel: string, accountId: string, eventId: string): boolean {
    return this.database.claimChannelEvent(channel, accountId, eventId)
  }

  release(channel: string, accountId: string, eventId: string): void {
    this.database.releaseChannelEvent(channel, accountId, eventId)
  }
}

export class SqliteChannelOutbox implements Outbox {
  constructor(private readonly database: AssistantDatabase) {}

  enqueue(message: ChannelResultMessage): OutboxEntry {
    return this.database.enqueueChannelResult(message)
  }

  markDelivered(id: string): void {
    this.database.markChannelResult(id, 'delivered')
  }

  markFailed(id: string): void {
    this.database.markChannelResult(id, 'failed')
  }

  listUndelivered(
    channel?: string,
    limit?: number
  ): readonly OutboxEntry[] {
    return this.database.listUndeliveredChannelResults(
      channel,
      limit
    )
  }
}
