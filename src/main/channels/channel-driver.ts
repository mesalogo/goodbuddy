import type {
  ChannelInboundText,
  ChannelMediaAttachment,
  ChannelResultMessage
} from '../../shared/channel-contracts'

export type ChannelAcknowledge = () => void | Promise<void>

export type ChannelInboundHandler = (
  message: unknown,
  acknowledge: ChannelAcknowledge
) => void | Promise<void>

export interface ChannelDriver {
  readonly channel: string

  start(handler: ChannelInboundHandler): void | Promise<void>
  send(message: ChannelResultMessage, signal: AbortSignal): Promise<void>
  stop(): void | Promise<void>
}

export interface DedupStore {
  claim(channel: string, eventId: string): boolean | Promise<boolean>
  release(channel: string, eventId: string): void | Promise<void>
}

export class MemoryDedupStore implements DedupStore {
  private readonly claimed = new Map<string, number>()

  constructor(private readonly maximumEntries = 10_000) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error('通道去重容量无效')
    }
  }

  claim(channel: string, eventId: string): boolean {
    const key = this.key(channel, eventId)
    if (this.claimed.has(key)) {
      return false
    }

    this.claimed.set(key, Date.now())
    while (this.claimed.size > this.maximumEntries) {
      const oldest = this.claimed.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.claimed.delete(oldest)
    }
    return true
  }

  release(channel: string, eventId: string): void {
    this.claimed.delete(this.key(channel, eventId))
  }

  clear(): void {
    this.claimed.clear()
  }

  private key(channel: string, eventId: string): string {
    return `${channel}\u0000${eventId}`
  }
}

export type OutboxEntry = {
  id: string
  message: ChannelResultMessage
  state: 'pending' | 'delivered' | 'failed'
  attempts: number
  createdAt: number
}

export interface Outbox {
  enqueue(message: ChannelResultMessage): OutboxEntry | Promise<OutboxEntry>
  markDelivered(id: string): void | Promise<void>
  markFailed(id: string): void | Promise<void>
  listUndelivered(
    channel?: string,
    limit?: number
  ): readonly OutboxEntry[] | Promise<readonly OutboxEntry[]>
}

export class MemoryOutbox implements Outbox {
  private readonly entries = new Map<string, OutboxEntry>()

  constructor(private readonly maximumEntries = 10_000) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error('通道发件箱容量无效')
    }
  }

  enqueue(message: ChannelResultMessage): OutboxEntry {
    const entry: OutboxEntry = {
      id: crypto.randomUUID(),
      message: structuredClone(message),
      state: 'pending',
      attempts: 0,
      createdAt: Date.now()
    }
    this.entries.set(entry.id, entry)
    this.enforceLimit()
    return this.clone(entry)
  }

  markDelivered(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) {
      return
    }
    entry.state = 'delivered'
    entry.attempts += 1
    entry.message = this.withoutAttachments(entry.message)
  }

  markFailed(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) {
      return
    }
    entry.state = 'failed'
    entry.attempts += 1
    if (entry.attempts >= 5) {
      entry.message = this.withoutAttachments(entry.message)
    }
  }

  listUndelivered(
    channel?: string,
    limit = this.maximumEntries
  ): readonly OutboxEntry[] {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.state !== 'delivered' &&
          (channel === undefined || entry.message.channel === channel)
      )
      .sort(
        (left, right) =>
          left.attempts - right.attempts ||
          left.createdAt - right.createdAt
      )
      .slice(0, limit)
      .map((entry) => this.clone(entry))
  }

  private enforceLimit(): void {
    while (this.entries.size > this.maximumEntries) {
      const delivered = [...this.entries.values()].find(
        (entry) => entry.state === 'delivered'
      )
      const oldest = delivered ?? this.entries.values().next().value
      if (!oldest) {
        return
      }
      this.entries.delete(oldest.id)
    }
  }

  private clone(entry: OutboxEntry): OutboxEntry {
    return {
      ...entry,
      message: structuredClone(entry.message)
    }
  }

  private withoutAttachments(
    message: ChannelResultMessage
  ): ChannelResultMessage {
    const sanitized = structuredClone(message)
    delete sanitized.attachments
    return sanitized
  }
}

export type ChannelExecutor = (
  message: ChannelInboundText,
  signal: AbortSignal,
  reportProgress: (result: {
    status: string
    output?: string
    error?: string
  }) => Promise<void>
) => Promise<{
  status: string
  output?: string
  error?: string
  attachments?: ChannelMediaAttachment[]
}>
