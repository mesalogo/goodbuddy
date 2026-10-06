import { z } from 'zod'
import type { ConversationMessage } from './assistant-contracts'

export const conversationOutputReadSchema = z.object({
  conversationId: z.string().uuid(),
  handle: z.string().regex(/^(?:process|rg|subagent):[0-9a-f-]{36}$/iu),
  cursor: z.number().int().nonnegative().default(0),
  limitBytes: z.number().int().min(1).max(32768).default(32768)
}).strict()

export type ConversationOutputPage = {
  content: string
  cursor: number
  nextCursor: number
  totalBytes: number
  eof: boolean
}

export function conversationMessageResourceIds(message: ConversationMessage): string[] {
  const ids = new Set(message.attachments?.map(attachment => attachment.resourceId ?? attachment.id))
  for (const handle of conversationMessageOutputHandles(message)) ids.add(handle.slice(handle.lastIndexOf(':') + 1))
  return [...ids]
}

export function conversationMessageOutputHandles(message: ConversationMessage): string[] {
  const handles = new Set<string>()
  const add = (handle: string): void => {
    if (/^(?:process|rg|subagent):[0-9a-f-]{36}$/iu.test(handle)) handles.add(handle)
  }
  for (const tool of message.tools ?? []) for (const reference of tool.outputReferences ?? []) add(reference.handle)
  for (const block of message.blocks ?? []) {
    if (block.type === 'tool') for (const reference of block.tool.outputReferences ?? []) add(reference.handle)
  }
  for (const subagent of message.subagents ?? []) {
    if (subagent.outputReference) add(subagent.outputReference.handle)
    for (const block of subagent.progress ?? []) {
      if (block.type === 'tool') for (const reference of block.tool.outputReferences ?? []) add(reference.handle)
    }
  }
  return [...handles]
}
