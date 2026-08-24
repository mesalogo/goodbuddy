import {
  AGENT_PROTOCOL_LIMITS,
  agentFrameHeaderSchema,
  agentIdentifierSchema,
  positiveAgentSequenceSchema,
  type AgentFrameHeader
} from './contracts'

export class ChannelProtocolError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'identity-mismatch'
      | 'generation-mismatch'
      | 'epoch-mismatch'
      | 'direction-mismatch'
      | 'sequence-mismatch'
      | 'closed'
      | 'channel-limit'
      | 'channel-lifetime-exhausted'
  ) {
    super(message)
    this.name = 'ChannelProtocolError'
  }
}

export type ChannelStateOptions = {
  connectionId: string
  generation: number
  channelId: string
  channelEpoch: string
  inboundDirection: AgentFrameHeader['direction']
  nextInboundSequence?: string
  nextOutboundSequence?: string
}

export class AgentChannelState {
  readonly connectionId: string
  readonly generation: number
  readonly channelId: string
  readonly channelEpoch: string
  readonly inboundDirection: AgentFrameHeader['direction']
  #nextInboundSequence: bigint
  #nextOutboundSequence: bigint
  #nextInboundAckSequence = 1n
  #nextOutboundAckSequence = 1n
  #closing = false
  #closed = false

  constructor(options: ChannelStateOptions) {
    agentIdentifierSchema.parse(options.connectionId)
    agentIdentifierSchema.parse(options.channelId)
    positiveAgentSequenceSchema.parse(options.channelEpoch)
    positiveAgentSequenceSchema.parse(options.nextInboundSequence ?? '1')
    positiveAgentSequenceSchema.parse(options.nextOutboundSequence ?? '1')
    if (
      !Number.isSafeInteger(options.generation) ||
      options.generation < 1 ||
      options.generation > 0xffff_ffff
    ) {
      throw new RangeError('Invalid connection generation')
    }
    this.connectionId = options.connectionId
    this.generation = options.generation
    this.channelId = options.channelId
    this.channelEpoch = options.channelEpoch
    this.inboundDirection = options.inboundDirection
    this.#nextInboundSequence = BigInt(options.nextInboundSequence ?? '1')
    this.#nextOutboundSequence = BigInt(options.nextOutboundSequence ?? '1')
  }

  get closed(): boolean {
    return this.#closed
  }

  get closing(): boolean {
    return this.#closing
  }

  acceptInbound(headerInput: AgentFrameHeader): void {
    this.#assertInboundOpen()
    let header: AgentFrameHeader
    try {
      header = agentFrameHeaderSchema.parse(headerInput)
      this.#assertIdentity(header)
    } catch (error) {
      this.#closed = true
      throw error
    }
    if (header.direction !== this.inboundDirection) {
      this.#closed = true
      throw new ChannelProtocolError(
        'Frame direction does not match channel',
        'direction-mismatch'
      )
    }
    const expectedSequence =
      header.kind === 'ack'
        ? this.#nextInboundAckSequence
        : this.#nextInboundSequence
    if (BigInt(header.sequence) !== expectedSequence) {
      this.#closed = true
      throw new ChannelProtocolError(
        'Frame sequence is not the next expected value',
        'sequence-mismatch'
      )
    }
    if (header.kind === 'ack') {
      this.#nextInboundAckSequence += 1n
    } else {
      this.#nextInboundSequence += 1n
    }
  }

  reserveOutbound(
    header: Omit<AgentFrameHeader, 'sequence'>
  ): AgentFrameHeader {
    this.#assertOpen()
    const sequence =
      header.kind === 'ack'
        ? this.#nextOutboundAckSequence
        : this.#nextOutboundSequence
    const candidate = agentFrameHeaderSchema.parse({
      ...header,
      sequence: sequence.toString()
    })
    this.#assertIdentity(candidate)
    if (candidate.direction === this.inboundDirection) {
      throw new ChannelProtocolError(
        'Outbound direction matches inbound direction',
        'direction-mismatch'
      )
    }
    if (candidate.kind === 'ack') {
      this.#nextOutboundAckSequence += 1n
    } else {
      this.#nextOutboundSequence += 1n
    }
    return candidate
  }

  beginClose(): void {
    this.#assertOpen()
    this.#closing = true
  }

  close(): void {
    this.#closing = true
    this.#closed = true
  }

  #assertInboundOpen(): void {
    this.#assertOpen()
    if (this.#closing) {
      this.#closed = true
      throw new ChannelProtocolError('Channel is closing', 'closed')
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ChannelProtocolError('Channel is closed', 'closed')
    }
  }

  #assertIdentity(header: AgentFrameHeader): void {
    if (
      header.connectionId !== this.connectionId ||
      header.channelId !== this.channelId
    ) {
      throw new ChannelProtocolError(
        'Frame identity does not match channel',
        'identity-mismatch'
      )
    }
    if (header.generation !== this.generation) {
      throw new ChannelProtocolError(
        'Frame belongs to an obsolete connection generation',
        'generation-mismatch'
      )
    }
    if (header.channelEpoch !== this.channelEpoch) {
      throw new ChannelProtocolError(
        'Frame belongs to another channel epoch',
        'epoch-mismatch'
      )
    }
  }
}

export class AgentConnectionChannels {
  readonly #channels = new Map<string, AgentChannelState>()
  readonly #retiredChannelIds = new Set<string>()
  readonly #connectionId: string
  readonly #generation: number
  readonly #maximumChannels: number
  readonly #maximumLifetimeChannels: number
  #openedChannels = 0

  constructor(options: {
    connectionId: string
    generation: number
    maximumChannels?: number
    maximumLifetimeChannels?: number
  }) {
    agentIdentifierSchema.parse(options.connectionId)
    if (
      !Number.isSafeInteger(options.generation) ||
      options.generation < 1 ||
      options.generation > 0xffff_ffff
    ) {
      throw new RangeError('Invalid connection generation')
    }
    if (
      options.maximumChannels !== undefined &&
      (!Number.isSafeInteger(options.maximumChannels) ||
        options.maximumChannels < 1 ||
        options.maximumChannels >
          AGENT_PROTOCOL_LIMITS.maximumChannelsPerConnection)
    ) {
      throw new RangeError('Invalid connection channel limit')
    }
    const maximumChannels =
      options.maximumChannels ??
      AGENT_PROTOCOL_LIMITS.maximumChannelsPerConnection
    const maximumLifetimeChannels =
      options.maximumLifetimeChannels ??
      AGENT_PROTOCOL_LIMITS.maximumChannelsPerConnection * 64
    if (
      !Number.isSafeInteger(maximumLifetimeChannels) ||
      maximumLifetimeChannels < maximumChannels ||
      maximumLifetimeChannels >
        AGENT_PROTOCOL_LIMITS.maximumChannelsPerConnection * 64
    ) {
      throw new RangeError('Invalid connection channel lifetime limit')
    }
    this.#connectionId = options.connectionId
    this.#generation = options.generation
    this.#maximumChannels = maximumChannels
    this.#maximumLifetimeChannels = maximumLifetimeChannels
  }

  open(
    options: Omit<
      ChannelStateOptions,
      'connectionId' | 'generation'
    >
  ): AgentChannelState {
    if (
      this.#channels.has(options.channelId) ||
      this.#retiredChannelIds.has(options.channelId)
    ) {
      throw new ChannelProtocolError(
        'Channel ID cannot be reused in a connection',
        'identity-mismatch'
      )
    }
    if (this.#openedChannels >= this.#maximumLifetimeChannels) {
      throw new ChannelProtocolError(
        'Connection channel lifetime is exhausted',
        'channel-lifetime-exhausted'
      )
    }
    if (this.#channels.size >= this.#maximumChannels) {
      throw new ChannelProtocolError(
        'Connection channel limit reached',
        'channel-limit'
      )
    }
    const channel = new AgentChannelState({
      ...options,
      connectionId: this.#connectionId,
      generation: this.#generation
    })
    this.#channels.set(options.channelId, channel)
    this.#openedChannels += 1
    return channel
  }

  get(channelId: string): AgentChannelState | undefined {
    return this.#channels.get(channelId)
  }

  close(channelId: string): void {
    const channel = this.#channels.get(channelId)
    if (channel === undefined) {
      return
    }
    channel.close()
    this.#channels.delete(channelId)
    this.#retiredChannelIds.add(channelId)
  }
}
