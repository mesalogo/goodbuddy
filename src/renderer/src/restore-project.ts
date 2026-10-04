import type { AssistantProject } from '../../shared/assistant-contracts'
import type { ConversationStore } from './conversation-store'
import { mergePersistedConversations, type ConversationPersistence } from './conversation-persistence'

export async function restoreProject(
  projectId: string,
  store: ConversationStore,
  persistence: ConversationPersistence,
  retainedIds: () => Set<string>
): Promise<AssistantProject[]> {
  await window.goodbuddy.projects.setArchived(projectId, false)
  const [projects, summaries] = await Promise.all([
    window.goodbuddy.projects.list(false),
    window.goodbuddy.conversations.listSummaries()
  ])
  // Publish summaries before exposing the project to the normal selection path.
  store.set(current => mergePersistedConversations(current, summaries.filter(item => item.projectId === projectId), persistence.acknowledged(), retainedIds()))
  return projects
}
