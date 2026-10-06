import type { AssistantStoragePort, Awaitable } from '../assistant-storage-port'
import type {
  DedupStore,
  Outbox,
  OutboxEntry
} from './channel-driver'
import type { ChannelResultMessage } from '../../shared/channel-contracts'

export class SqliteChannelDedupStore implements DedupStore {
  constructor(private readonly database: Pick<AssistantStoragePort, 'claimChannelEvent' | 'releaseChannelEvent'>) {}

  claim(channel: string, accountId: string, eventId: string): Awaitable<boolean> {
    return this.database.claimChannelEvent(channel, accountId, eventId)
  }

  release(channel: string, accountId: string, eventId: string): Awaitable<void> {
    return this.database.releaseChannelEvent(channel, accountId, eventId)
  }
}

export class SqliteChannelOutbox implements Outbox {
  constructor(private readonly database: Pick<AssistantStoragePort, 'enqueueChannelResult' | 'markChannelResult' | 'listUndeliveredChannelResults'>) {}

  enqueue(message: ChannelResultMessage): Awaitable<OutboxEntry> {
    return this.database.enqueueChannelResult(message)
  }

  markDelivered(id: string): Awaitable<void> {
    return this.database.markChannelResult(id, 'delivered')
  }

  markFailed(id: string): Awaitable<void> {
    return this.database.markChannelResult(id, 'failed')
  }

  markTerminal(id: string): Awaitable<void> {
    return this.database.markChannelResult(id, 'terminal')
  }

  listUndelivered(
    channel?: string,
    limit?: number
  ): Awaitable<readonly OutboxEntry[]> {
    return this.database.listUndeliveredChannelResults(
      channel,
      limit
    )
  }
}
