import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import {
  assistantIdSchema,
  conversationMessageBlockSchema,
  type ConversationMessageBlock
} from '../../shared/assistant-contracts'

export const subagentProgressUpdateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('append'),
    id: assistantIdSchema,
    blockType: z.enum(['text', 'reasoning']),
    delta: z.string()
  }).strict(),
  z.object({
    type: z.literal('upsert'),
    block: conversationMessageBlockSchema
  }).strict(),
  z.object({
    type: z.literal('reset'),
    blocks: z.array(conversationMessageBlockSchema)
  }).strict()
])

export type SubagentProgressUpdate = z.infer<
  typeof subagentProgressUpdateSchema
>

type ProgressEvent = {
  progress?: ConversationMessageBlock[]
  progressUpdates?: SubagentProgressUpdate[]
}

export function applySubagentProgress(
  previous: ConversationMessageBlock[] | undefined,
  event: ProgressEvent
): ConversationMessageBlock[] | undefined {
  let blocks = event.progress ?? previous
  if (!event.progressUpdates?.length) return blocks
  blocks = [...(blocks ?? [])]
  for (const update of event.progressUpdates) {
    if (update.type === 'reset') {
      blocks = [...update.blocks]
      continue
    }
    const id = update.type === 'upsert' ? update.block.id : update.id
    const index = blocks.findIndex((block) => block.id === id)
    const prior = blocks[index]
    const block: ConversationMessageBlock = update.type === 'upsert'
      ? update.block
      : {
          id,
          type: update.blockType,
          content: (
            prior?.type === update.blockType ? prior.content : ''
          ) + update.delta
        }
    if (index < 0) blocks.push(block)
    else blocks[index] = block
  }
  return blocks
}

export function diffSubagentProgress(
  previous: readonly ConversationMessageBlock[],
  next: readonly ConversationMessageBlock[]
): SubagentProgressUpdate[] {
  if (
    previous.length > next.length ||
    previous.some((block, index) => block.id !== next[index]?.id)
  ) {
    return [{ type: 'reset', blocks: [...next] }]
  }
  const updates: SubagentProgressUpdate[] = []
  for (let index = 0; index < next.length; index += 1) {
    const block = next[index]!
    const prior = previous[index]
    if (block === prior) continue
    if (
      (block.type === 'text' || block.type === 'reasoning') &&
      prior?.type === block.type &&
      block.content.startsWith(prior.content)
    ) {
      const delta = block.content.slice(prior.content.length)
      if (delta) {
        updates.push({
          type: 'append', id: block.id, blockType: block.type, delta
        })
      }
    } else if (!prior || !isDeepStrictEqual(prior, block)) {
      updates.push({ type: 'upsert', block })
    }
  }
  return updates
}

type StoredSubagent = ProgressEvent & {
  childTaskId: string
  [key: string]: unknown
}

function asSubagent(payload: unknown): StoredSubagent | undefined {
  if (
    typeof payload !== 'object' || payload === null ||
    !('childTaskId' in payload) || typeof payload.childTaskId !== 'string'
  ) return undefined
  return payload as StoredSubagent
}

export function compactSubagentPayload(
  payload: unknown,
  progress: ReadonlyMap<string, ConversationMessageBlock[]>
): unknown {
  const event = asSubagent(payload)
  if (!event || !Array.isArray(event.progress)) return payload
  const compact = { ...event }
  delete compact.progress
  compact.progressUpdates = diffSubagentProgress(
    progress.get(event.childTaskId) ?? [],
    event.progress
  )
  return compact
}

export function restoreSubagentPayload(
  payload: unknown,
  progress: Map<string, ConversationMessageBlock[]>
): unknown {
  const event = asSubagent(payload)
  if (!event) return payload
  const blocks = applySubagentProgress(
    progress.get(event.childTaskId), event
  )
  if (blocks) progress.set(event.childTaskId, blocks)
  if (!event.progressUpdates) return payload
  const restored = { ...event, progress: blocks ?? [] }
  delete restored.progressUpdates
  return restored
}

type TaskProgress = {
  lastId: number
  blocks: Map<string, ConversationMessageBlock[]>
}

/** The conversation keeps the display snapshot; its event history stores changes. */
export class SubagentProgressStorage {
  private readonly tasks = new Map<string, TaskProgress>()

  constructor(private readonly database: DatabaseSync) {}

  serialize(taskId: string, kind: string, payload: unknown): string {
    return JSON.stringify(kind === 'subagent'
      ? compactSubagentPayload(payload, this.current(taskId).blocks)
      : payload)
  }

  inserted(taskId: string, kind: string, id: number, payloadJson: string): void {
    if (kind !== 'subagent') return
    const task = this.tasks.get(taskId)
    if (!task) return
    restoreSubagentPayload(JSON.parse(payloadJson), task.blocks)
    task.lastId = id
  }

  matches(taskId: string, eventId: number, payload: unknown): boolean {
    const blocks = new Map<string, ConversationMessageBlock[]>()
    const rows = this.database.prepare(
      `SELECT id, payload_json FROM task_events
       WHERE task_id = ? AND kind = 'subagent' AND id <= ?
       ORDER BY id`
    ).iterate(taskId, eventId)
    for (const row of rows) {
      const restored = restoreSubagentPayload(
        JSON.parse(row.payload_json as string), blocks
      )
      if (row.id === eventId) return isDeepStrictEqual(restored, payload)
    }
    return false
  }

  private current(taskId: string): TaskProgress {
    const last = this.database.prepare(
      `SELECT id FROM task_events WHERE task_id = ? AND kind = 'subagent'
       ORDER BY id DESC LIMIT 1`
    ).get(taskId) as { id: number } | undefined
    let task = this.tasks.get(taskId)
    if (task?.lastId === (last?.id ?? 0)) return task
    // A rolled-back transaction or reopened task is rebuilt from committed rows.
    task = { lastId: last?.id ?? 0, blocks: new Map() }
    const rows = this.database.prepare(
      `SELECT payload_json FROM task_events
       WHERE task_id = ? AND kind = 'subagent' ORDER BY id`
    ).iterate(taskId)
    for (const row of rows) {
      restoreSubagentPayload(JSON.parse(row.payload_json as string), task.blocks)
    }
    this.tasks.delete(taskId)
    this.tasks.set(taskId, task)
    if (this.tasks.size > 16) {
      this.tasks.delete(this.tasks.keys().next().value!)
    }
    return task
  }
}
