import type { ConversationSnapshot, LocalConversationHeader } from '../../shared/assistant-contracts'
import type { AssistantDatabase } from './assistant-database'

/** Test fixture: stores local conversations through the production upsert path. */
export function seedConversations(
  database: Pick<AssistantDatabase, 'saveLocalConversations'>,
  conversations: readonly ConversationSnapshot[]
): void {
  const batch = conversations
    .filter((conversation) => !conversation.remote)
    .map(({ messages, ...conversation }) => {
      const header: LocalConversationHeader & Partial<Pick<ConversationSnapshot, 'pinned' | 'remote' | 'activeRequest'>> = { ...conversation }
      delete header.pinned
      delete header.remote
      delete header.activeRequest
      return { header: header as LocalConversationHeader, messages }
    })
  if (batch.length) database.saveLocalConversations(batch)
}
