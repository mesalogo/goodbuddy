import { describe, expect, it } from 'vitest'
import {
  AgentChannelState,
  AgentConnectionChannels,
  ChannelProtocolError
} from '../shared/agent-protocol/channel-state'
import {
  AGENT_PROTOCOL_VERSION,
  type AgentFrameHeader
} from '../shared/agent-protocol/contracts'

const base = {
  connectionId: 'connection-1',
  generation: 1,
  channelId: 'channel-1',
  channelEpoch: '1',
  inboundDirection: 'main-to-agent' as const
}

function inbound(
  overrides: Partial<AgentFrameHeader> = {}
): AgentFrameHeader {
  return {
    protocolMajor: AGENT_PROTOCOL_VERSION.major,
    protocolMinor: AGENT_PROTOCOL_VERSION.minor,
    connectionId: base.connectionId,
    generation: base.generation,
    channelId: base.channelId,
    channelEpoch: base.channelEpoch,
    direction: 'main-to-agent',
    sequence: '1',
    kind: 'acp',
    payloadLength: 1,
    ...overrides
  }
}

describe('AgentChannelState', () => {
  it('enforces identity, generation, direction, and contiguous sequence', () => {
    const channel = new AgentChannelState(base)
    expect(() => channel.acceptInbound(inbound())).not.toThrow()
    expect(() =>
      channel.acceptInbound(inbound({ sequence: '2' }))
    ).not.toThrow()

    const stale = new AgentChannelState(base)
    expect(() =>
      stale.acceptInbound(inbound({ generation: 2 }))
    ).toThrowError(ChannelProtocolError)
    expect(stale.closed).toBe(true)

    const wrongDirection = new AgentChannelState(base)
    expect(() =>
      wrongDirection.acceptInbound(
        inbound({ direction: 'agent-to-main' })
      )
    ).toThrowError(ChannelProtocolError)

    const gap = new AgentChannelState(base)
    expect(() =>
      gap.acceptInbound(inbound({ sequence: '2' }))
    ).toThrowError(ChannelProtocolError)
  })

  it('sequences durable ACKs independently from data', () => {
    const channel = new AgentChannelState(base)
    channel.acceptInbound(inbound({ kind: 'acp', sequence: '1' }))
    channel.acceptInbound(inbound({ kind: 'ack', sequence: '1' }))
    channel.acceptInbound(inbound({ kind: 'acp', sequence: '2' }))

    const reserve = (kind: AgentFrameHeader['kind']) =>
      channel.reserveOutbound({
        ...inbound({ kind }),
        direction: 'agent-to-main'
      })
    expect(reserve('acp').sequence).toBe('1')
    expect(reserve('ack').sequence).toBe('1')
    expect(reserve('acp').sequence).toBe('2')
  })

  it('rejects inbound data after close begins', () => {
    const channel = new AgentChannelState(base)
    channel.beginClose()
    expect(() => channel.acceptInbound(inbound())).toThrowError(
      ChannelProtocolError
    )
  })
})

describe('AgentConnectionChannels', () => {
  it('bounds active and lifetime channels without reusing IDs', () => {
    const connection = new AgentConnectionChannels({
      connectionId: 'connection-1',
      generation: 1,
      maximumChannels: 2,
      maximumLifetimeChannels: 3
    })
    connection.open({
      channelId: 'one',
      channelEpoch: '1',
      inboundDirection: 'main-to-agent'
    })
    connection.open({
      channelId: 'two',
      channelEpoch: '1',
      inboundDirection: 'main-to-agent'
    })
    expect(() =>
      connection.open({
        channelId: 'blocked',
        channelEpoch: '1',
        inboundDirection: 'main-to-agent'
      })
    ).toThrowError(ChannelProtocolError)

    connection.close('one')
    expect(() =>
      connection.open({
        channelId: 'one',
        channelEpoch: '2',
        inboundDirection: 'main-to-agent'
      })
    ).toThrowError(ChannelProtocolError)
    connection.open({
      channelId: 'three',
      channelEpoch: '1',
      inboundDirection: 'main-to-agent'
    })
    connection.close('two')
    expect(() =>
      connection.open({
        channelId: 'four',
        channelEpoch: '1',
        inboundDirection: 'main-to-agent'
      })
    ).toThrowError(ChannelProtocolError)
  })
})