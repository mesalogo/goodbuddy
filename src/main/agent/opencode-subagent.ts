import { createHash } from 'node:crypto'
import type { SubagentEvent } from '../../shared/contracts'
import { boundedToolDetail } from './approval-summary'

type OpenCodeSubagentState =
  | 'pending'
  | 'running'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'error'

export type OpenCodeSubagentToolUpdate = {
  requestId: string
  callId: string
  state: OpenCodeSubagentState
  input: unknown
  output?: unknown
  error?: unknown
}

export type OpenCodeSubagentInput = {
  subagent_type: string
  prompt: string
  description?: string
  command?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function boundedText(
  value: unknown,
  maximum: number
): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maximum) : undefined
}

function boundedDetail(
  value: unknown,
  maximum: number
): string | undefined {
  if (typeof value === 'string') {
    return boundedText(value, maximum)
  }
  if (value === undefined || value === null) {
    return undefined
  }
  return boundedToolDetail(value, maximum)
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

export function parseOpenCodeSubagentInput(
  value: unknown
): OpenCodeSubagentInput | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const subagentType = boundedText(value.subagent_type, 80)
  const prompt = boundedText(value.prompt, 20_000)
  if (!subagentType || !prompt) {
    return undefined
  }
  const description = boundedText(value.description, 240)
  const command = boundedText(value.command, 240)
  return {
    subagent_type: subagentType,
    prompt,
    ...(description ? { description } : {}),
    ...(command ? { command } : {})
  }
}

export function toOpenCodeSubagentEvent(
  update: OpenCodeSubagentToolUpdate
): SubagentEvent | undefined {
  const input = parseOpenCodeSubagentInput(update.input)
  if (!input) {
    return undefined
  }
  const expertName = input.subagent_type
  const description =
    input.description ?? input.command
  const state =
    update.state === 'pending'
      ? 'queued'
      : update.state === 'running' ||
          update.state === 'in_progress'
        ? 'running'
        : update.state === 'completed'
          ? 'completed'
          : 'failed'
  const failed = state === 'failed'
  const output = failed
    ? undefined
    : boundedDetail(update.output, 16_000)
  const error = failed
    ? boundedDetail(update.error ?? update.output, 1_000)
    : undefined

  return {
    requestId: update.requestId,
    type: 'subagent',
    childTaskId: deterministicUuid(
      `opencode-subagent-call\0${update.requestId}\0${update.callId}`
    ),
    expertId: deterministicUuid(
      `opencode-subagent-type\0${expertName}`
    ),
    expertName,
    routingMode: 'native',
    runtimeCallId: update.callId.slice(0, 256),
    state,
    ...(description ? { reason: description } : {}),
    ...(output ? { output } : {}),
    ...(error ? { error } : {})
  }
}
