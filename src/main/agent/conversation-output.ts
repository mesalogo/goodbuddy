import { conversationOutputReadSchema, type ConversationOutputPage } from '../../shared/conversation-output'
import type { AttachmentStorageAccess } from '../desktop-storage-files'

export async function readConversationOutput(
  storage: Pick<AttachmentStorageAccess, 'get' | 'outputRead'>,
  input: unknown
): Promise<ConversationOutputPage> {
  const { conversationId, handle, cursor, limitBytes } = conversationOutputReadSchema.parse(input)
  const { size: totalBytes } = await storage.get(handle.slice(handle.lastIndexOf(':') + 1))
  if (cursor > totalBytes) throw new Error('Output cursor exceeds stored content')
  const requested = Math.min(limitBytes + 3, totalBytes - cursor)
  const bytes = Buffer.from(await storage.outputRead(conversationId, handle, cursor, requested))
  if (bytes.length !== requested) throw new Error('Incomplete stored output')
  if (bytes.length && (bytes[0]! & 0xc0) === 0x80) throw new Error('Output cursor must be a UTF-8 boundary')
  let end = Math.min(limitBytes, bytes.length)
  if (end && end < bytes.length) {
    let start = end - 1
    while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--
    const lead = bytes[start]!
    const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
    if (start + width > end) end = start || Math.min(width, bytes.length)
  }
  const nextCursor = cursor + end
  return { content: bytes.subarray(0, end).toString('utf8'), cursor, nextCursor, totalBytes, eof: nextCursor === totalBytes }
}
