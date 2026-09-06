import { createHash } from 'node:crypto'
import type { SubagentEvent } from '../../shared/contracts'
import type { ConversationMessageBlock } from '../../shared/assistant-contracts'
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
  const detail = isRecord(update.output)
    ? update.output.output ?? update.output.error
    : update.output
  const result = typeof detail === 'string'
    ? detail.match(
        /^\s*<task\b[^>]*>\s*<task_result>\s*([\s\S]*?)\s*<\/task_result>\s*<\/task>\s*$/u
      )?.[1] ?? detail
    : detail
  const output = failed
    ? undefined
    : boundedDetail(result, 16_000)
  const error = failed
    ? boundedDetail(update.error ?? detail, 1_000)
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

/**
 * Tracks only sessions explicitly linked by a Task's metadata.sessionId.
 * The same snapshots travel through the local SDK and the remote ACP bridge.
 */
export class OpenCodeSubagentProgress {
  private readonly roles = new Map<string, string>()
  private readonly reasoning = new Set<string>()
  private readonly tasks = new Map<string, {
    event: SubagentEvent
    sessionId?: string
    blocks: ConversationMessageBlock[]
  }>()

  constructor(
    private readonly requestId: string,
    private readonly parentSessionId?: string
  ) {}

  update(value: unknown, ownerCallId?: string): SubagentEvent | undefined {
    if (!isRecord(value) || !isRecord(value.properties)) return undefined
    const properties = value.properties
    const part = properties.part
    if (
      value.type === 'message.part.updated' &&
      isRecord(part) && part.type === 'tool' &&
      part.tool === 'task' && isRecord(part.state) &&
      (!this.parentSessionId || properties.sessionID === this.parentSessionId) &&
      ![...this.tasks.values()].some(
        (task) => task.sessionId === properties.sessionID
      )
    ) {
      const callId = boundedText(part.callID ?? part.id, 256)
      if (!callId) return undefined
      const event = toOpenCodeSubagentEvent({
        requestId: this.requestId,
        callId,
        input: part.state.input,
        state: part.state.status as OpenCodeSubagentState,
        output: part.state.output,
        error: part.state.error
      })
      if (!event) return undefined
      const previous = this.tasks.get(callId)
      const metadata = part.state.metadata
      const task = {
        event,
        sessionId: (isRecord(metadata)
          ? boundedText(metadata.sessionId, 256)
          : undefined) ?? previous?.sessionId,
        blocks: previous?.blocks ?? []
      }
      this.tasks.set(callId, task)
      return { ...event, progress: [...task.blocks] }
    }
    const task = [...this.tasks.values()].find(
      (candidate) => candidate.sessionId === properties.sessionID
    ) ?? (ownerCallId ? this.tasks.get(ownerCallId) : undefined)
    if (!task) return undefined
    if (value.type === 'message.updated' && isRecord(properties.info)) {
      this.roles.set(String(properties.info.id), String(properties.info.role))
      return undefined
    }
    const messageId = isRecord(part) ? part.messageID : properties.messageID
    if (this.roles.get(String(messageId)) === 'user') return undefined
    const partId = isRecord(part) ? part.id : properties.partID
    if (typeof partId !== 'string') return undefined
    const id = deterministicUuid(`${task.event.childTaskId}\0${partId}`)
    const index = task.blocks.findIndex((block) => block.id === id)
    const previous = task.blocks[index]
    let block: ConversationMessageBlock | undefined
    if (value.type === 'message.part.updated' && isRecord(part)) {
      if (part.type === 'reasoning') this.reasoning.add(id)
      if (
        (part.type === 'text' || part.type === 'reasoning') &&
        typeof part.text === 'string' && part.text &&
        part.ignored !== true && part.synthetic !== true
      ) {
        block = { id, type: part.type, content: part.text.slice(0, 16_000) }
      } else if (part.type === 'tool' && isRecord(part.state)) {
        block = {
          id,
          type: 'tool',
          tool: {
            callId: String(part.callID ?? partId).slice(0, 256),
            name: String(part.tool).slice(0, 200),
            summary: boundedText(part.state.title, 240) ?? String(part.tool),
            state: part.state.status === 'error'
              ? 'failed'
              : part.state.status as 'pending' | 'running' | 'completed',
            input: boundedDetail(part.state.input, 4_000),
            output: boundedDetail(part.state.output, 16_000),
            error: boundedDetail(part.state.error, 1_000)
          }
        }
      }
    } else if (
      value.type === 'message.part.delta' &&
      typeof properties.delta === 'string' && properties.delta &&
      (properties.field === 'text' || properties.field === 'reasoning')
    ) {
      block = {
        id,
        type: this.reasoning.has(id) || previous?.type === 'reasoning' || properties.field === 'reasoning'
          ? 'reasoning'
          : 'text',
        content: (
          (previous?.type === 'text' || previous?.type === 'reasoning'
            ? previous.content : '') + properties.delta
        ).slice(0, 16_000)
      }
    }
    if (!block) return undefined
    if (index >= 0) task.blocks[index] = block
    else task.blocks.push(block)
    return { ...task.event, progress: [...task.blocks] }
  }

  retain(event: SubagentEvent): SubagentEvent {
    const task = event.runtimeCallId
      ? this.tasks.get(event.runtimeCallId)
      : undefined
    if (!task) {
      if (event.runtimeCallId && event.progress) {
        this.tasks.set(event.runtimeCallId, {
          event, blocks: [...event.progress]
        })
      }
      return event
    }
    task.event = event
    return { ...event, progress: [...task.blocks] }
  }
}
