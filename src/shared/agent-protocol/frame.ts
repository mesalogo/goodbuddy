import {
  AGENT_PROTOCOL_LIMITS,
  agentFrameHeaderSchema,
  type AgentFrameHeader,
  type AgentFrameKind,
  maximumPayloadLength
} from './contracts'

const MAGIC = new Uint8Array([0x47, 0x42, 0x41, 0x31])
const ENVELOPE_VERSION = 1
export const AGENT_FRAME_FIXED_HEADER_BYTES = 40
const FIXED_HEADER_BYTES = AGENT_FRAME_FIXED_HEADER_BYTES
export const MAXIMUM_ENCODED_AGENT_FRAME_BYTES =
  AGENT_FRAME_FIXED_HEADER_BYTES +
  AGENT_PROTOCOL_LIMITS.maximumIdentifierBytes * 2 +
  Math.max(
    AGENT_PROTOCOL_LIMITS.maximumControlFrameBytes,
    AGENT_PROTOCOL_LIMITS.maximumAcpFrameBytes,
    AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes,
    AGENT_PROTOCOL_LIMITS.maximumAckFrameBytes
  )

const kindCodes = {
  control: 0,
  acp: 1,
  blob: 2,
  ack: 3
} as const satisfies Record<AgentFrameKind, number>

const kinds = [
  'control',
  'acp',
  'blob',
  'ack'
] as const satisfies readonly AgentFrameKind[]

export type AgentFrame = {
  header: AgentFrameHeader
  payload: Uint8Array
}

export class AgentFrameError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'incomplete'
      | 'invalid'
      | 'unsupported'
      | 'oversized'
  ) {
    super(message)
    this.name = 'AgentFrameError'
  }
}

export function inspectAgentFramePrefix(bytes: Uint8Array): {
  kind: AgentFrameKind
  encodedByteLength: number
} {
  if (bytes.byteLength < FIXED_HEADER_BYTES) {
    throw new AgentFrameError('Incomplete fixed frame header', 'incomplete')
  }
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (bytes[index] !== MAGIC[index]) {
      throw new AgentFrameError('Invalid frame magic', 'invalid')
    }
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  )
  if (view.getUint8(4) !== ENVELOPE_VERSION) {
    throw new AgentFrameError(
      'Unsupported envelope version',
      'unsupported'
    )
  }
  if (view.getUint8(7) !== 0) {
    throw new AgentFrameError('Reserved frame flags are non-zero', 'invalid')
  }
  const kind = kinds[view.getUint8(5)]
  if (kind === undefined) {
    throw new AgentFrameError('Unknown frame kind', 'unsupported')
  }
  if (view.getUint8(6) > 1) {
    throw new AgentFrameError('Unknown frame direction', 'invalid')
  }
  const connectionLength = view.getUint16(32)
  const channelLength = view.getUint16(34)
  if (
    connectionLength === 0 ||
    channelLength === 0 ||
    connectionLength > AGENT_PROTOCOL_LIMITS.maximumIdentifierBytes ||
    channelLength > AGENT_PROTOCOL_LIMITS.maximumIdentifierBytes
  ) {
    throw new AgentFrameError('Invalid frame identifier length', 'invalid')
  }
  const payloadLength = view.getUint32(36)
  if (payloadLength > maximumPayloadLength(kind)) {
    throw new AgentFrameError('Frame payload exceeds its limit', 'oversized')
  }
  return {
    kind,
    encodedByteLength:
      FIXED_HEADER_BYTES +
      connectionLength +
      channelLength +
      payloadLength
  }
}

export function encodeAgentFrame(frame: AgentFrame): Uint8Array {
  const header = agentFrameHeaderSchema.parse({
    ...frame.header,
    payloadLength: frame.payload.byteLength
  })
  const connection = encodeIdentifier(header.connectionId)
  const channel = encodeIdentifier(header.channelId)
  const output = new Uint8Array(
    FIXED_HEADER_BYTES +
      connection.byteLength +
      channel.byteLength +
      frame.payload.byteLength
  )
  output.set(MAGIC, 0)
  const view = new DataView(output.buffer)
  view.setUint8(4, ENVELOPE_VERSION)
  view.setUint8(5, kindCodes[header.kind])
  view.setUint8(6, header.direction === 'main-to-agent' ? 0 : 1)
  view.setUint8(7, 0)
  view.setUint16(8, header.protocolMajor)
  view.setUint16(10, header.protocolMinor)
  view.setUint32(12, header.generation)
  view.setBigUint64(16, BigInt(header.channelEpoch))
  view.setBigUint64(24, BigInt(header.sequence))
  view.setUint16(32, connection.byteLength)
  view.setUint16(34, channel.byteLength)
  view.setUint32(36, frame.payload.byteLength)
  output.set(connection, FIXED_HEADER_BYTES)
  output.set(channel, FIXED_HEADER_BYTES + connection.byteLength)
  output.set(
    frame.payload,
    FIXED_HEADER_BYTES + connection.byteLength + channel.byteLength
  )
  return output
}

export function decodeAgentFrame(
  bytes: Uint8Array,
  expected?: {
    protocolMajor?: number
    maximumProtocolMinor?: number
    connectionId?: string
    generation?: number
  }
): AgentFrame {
  if (bytes.byteLength < FIXED_HEADER_BYTES) {
    throw new AgentFrameError('Incomplete fixed frame header', 'incomplete')
  }
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (bytes[index] !== MAGIC[index]) {
      throw new AgentFrameError('Invalid frame magic', 'invalid')
    }
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  )
  if (view.getUint8(4) !== ENVELOPE_VERSION) {
    throw new AgentFrameError(
      'Unsupported envelope version',
      'unsupported'
    )
  }
  if (view.getUint8(7) !== 0) {
    throw new AgentFrameError('Reserved frame flags are non-zero', 'invalid')
  }
  const kind = kinds[view.getUint8(5)]
  if (kind === undefined) {
    throw new AgentFrameError('Unknown frame kind', 'unsupported')
  }
  const directionCode = view.getUint8(6)
  if (directionCode > 1) {
    throw new AgentFrameError('Unknown frame direction', 'invalid')
  }
  const connectionLength = view.getUint16(32)
  const channelLength = view.getUint16(34)
  if (
    connectionLength === 0 ||
    channelLength === 0 ||
    connectionLength > AGENT_PROTOCOL_LIMITS.maximumIdentifierBytes ||
    channelLength > AGENT_PROTOCOL_LIMITS.maximumIdentifierBytes
  ) {
    throw new AgentFrameError('Invalid frame identifier length', 'invalid')
  }
  const payloadLength = view.getUint32(36)
  if (payloadLength > maximumPayloadLength(kind)) {
    throw new AgentFrameError('Frame payload exceeds its limit', 'oversized')
  }
  const expectedLength =
    FIXED_HEADER_BYTES +
    connectionLength +
    channelLength +
    payloadLength
  if (bytes.byteLength < expectedLength) {
    throw new AgentFrameError('Incomplete frame payload', 'incomplete')
  }
  if (bytes.byteLength !== expectedLength) {
    throw new AgentFrameError('Trailing bytes after frame', 'invalid')
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let connectionId: string
  let channelId: string
  try {
    connectionId = decoder.decode(
      bytes.subarray(
        FIXED_HEADER_BYTES,
        FIXED_HEADER_BYTES + connectionLength
      )
    )
    channelId = decoder.decode(
      bytes.subarray(
        FIXED_HEADER_BYTES + connectionLength,
        FIXED_HEADER_BYTES + connectionLength + channelLength
      )
    )
  } catch {
    throw new AgentFrameError('Invalid UTF-8 frame identifier', 'invalid')
  }
  const header = agentFrameHeaderSchema.parse({
    protocolMajor: view.getUint16(8),
    protocolMinor: view.getUint16(10),
    connectionId,
    generation: view.getUint32(12),
    channelId,
    channelEpoch: view.getBigUint64(16).toString(),
    direction:
      directionCode === 0 ? 'main-to-agent' : 'agent-to-main',
    sequence: view.getBigUint64(24).toString(),
    kind,
    payloadLength
  })
  if (
    expected?.protocolMajor !== undefined &&
    header.protocolMajor !== expected.protocolMajor
  ) {
    throw new AgentFrameError('Protocol major mismatch', 'unsupported')
  }
  if (
    expected?.maximumProtocolMinor !== undefined &&
    header.protocolMinor > expected.maximumProtocolMinor
  ) {
    throw new AgentFrameError('Protocol minor was not negotiated', 'unsupported')
  }
  if (
    expected?.connectionId !== undefined &&
    header.connectionId !== expected.connectionId
  ) {
    throw new AgentFrameError('Connection identity mismatch', 'invalid')
  }
  if (
    expected?.generation !== undefined &&
    header.generation !== expected.generation
  ) {
    throw new AgentFrameError('Connection generation mismatch', 'invalid')
  }
  const payloadOffset =
    FIXED_HEADER_BYTES + connectionLength + channelLength
  return {
    header,
    payload: bytes.slice(payloadOffset, expectedLength)
  }
}

function encodeIdentifier(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value)
  if (
    encoded.byteLength === 0 ||
    encoded.byteLength > AGENT_PROTOCOL_LIMITS.maximumIdentifierBytes
  ) {
    throw new AgentFrameError('Frame identifier is oversized', 'oversized')
  }
  return encoded
}
