import { useCallback } from "react";
import type { AssistantTask } from "../../shared/assistant-contracts";
import type { Message } from "./ChatTimeline";
import { getConversationDisplayTitle, type Conversation } from "./chat-conversation";
import {
  deriveConversationActivity,
  sameActivitySummary,
  type ConversationActivitySummary,
} from "./conversation-activity";
import { useConversationStoreSelector, type ConversationStore } from "./conversation-store";
import type { PendingSidebarApproval } from "./RightAssistantSidebar";
import { sameArrayItems, sameMapEntries } from "./stable-derived-value";

// Selectors over the conversation list. Each keeps its previous value while
// the selected content is unchanged, so consumers skip re-rendering when an
// unrelated conversation (or an unrelated field) changes.

const selectCount = (conversations: Conversation[]): number => conversations.length;

export function useConversationCount(store: ConversationStore): number {
  return useConversationStoreSelector(store, selectCount);
}

/** Display titles by conversation ID. */
export function useConversationTitles(
  store: ConversationStore,
  defaultTitle: string,
): ReadonlyMap<string, string> {
  const selector = useCallback(
    (conversations: Conversation[]) =>
      new Map(conversations.map((conversation) => [
        conversation.id,
        getConversationDisplayTitle(conversation, defaultTitle),
      ])),
    [defaultTitle],
  );
  return useConversationStoreSelector(store, selector, sameMapEntries);
}

// Message arrays are replaced, never mutated: unchanged conversations reuse
// their scan while another conversation streams.
const approvalMessagesByArray = new WeakMap<readonly Message[], Message[]>();
function messagesWithApprovals(messages: readonly Message[]): Message[] {
  let found = approvalMessagesByArray.get(messages);
  if (!found) {
    found = messages.filter((message) => message.approval);
    approvalMessagesByArray.set(messages, found);
  }
  return found;
}

export function selectPendingSidebarApprovals(
  conversations: readonly Conversation[],
): PendingSidebarApproval[] {
  return conversations.flatMap((conversation) =>
    messagesWithApprovals(conversation.messages).map((message) => ({
      conversationId: conversation.id,
      projectId: conversation.projectId,
      messageId: message.id,
      taskId: message.approval!.taskId ?? message.task?.id,
      approvalId: message.approval!.id,
      title: message.approval!.title,
      description: message.approval!.description,
      toolName: message.approval!.toolName,
    })),
  );
}

export function samePendingSidebarApprovals(
  left: readonly PendingSidebarApproval[],
  right: readonly PendingSidebarApproval[],
): boolean {
  return sameArrayItems(left, right, (a, b) =>
    a.conversationId === b.conversationId && a.projectId === b.projectId &&
    a.messageId === b.messageId && a.taskId === b.taskId &&
    a.approvalId === b.approvalId && a.title === b.title &&
    a.description === b.description && a.toolName === b.toolName);
}

export function usePendingSidebarApprovals(store: ConversationStore): PendingSidebarApproval[] {
  return useConversationStoreSelector(
    store,
    selectPendingSidebarApprovals,
    samePendingSidebarApprovals,
  );
}

/** Running/attention/completed summary across conversations and tasks. */
export function useConversationActivitySummary(
  store: ConversationStore,
  {
    activeConversationIds,
    completedConversationIds,
    defaultTitle,
    fallbackProjectName,
    projects,
    tasks,
  }: {
    activeConversationIds: ReadonlySet<string>;
    completedConversationIds: ReadonlySet<string>;
    defaultTitle: string;
    fallbackProjectName: string;
    projects: readonly { id: string; name: string }[];
    tasks: readonly AssistantTask[];
  },
): ConversationActivitySummary {
  const selector = useCallback(
    (conversations: Conversation[]) => deriveConversationActivity(
      conversations.map((conversation) => ({
        ...conversation,
        title: getConversationDisplayTitle(conversation, defaultTitle),
      })),
      tasks,
      activeConversationIds,
      projects,
      fallbackProjectName,
      completedConversationIds,
    ),
    [activeConversationIds, completedConversationIds, defaultTitle, fallbackProjectName, projects, tasks],
  );
  return useConversationStoreSelector(store, selector, sameActivitySummary);
}

/** The conversations with these IDs, in this order; stable while unchanged. */
export function useConversationsById(
  store: ConversationStore,
  conversationIds: readonly string[],
): Conversation[] {
  const selector = useCallback((conversations: Conversation[]) => {
    const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    return conversationIds.flatMap((conversationId) => {
      const conversation = byId.get(conversationId);
      return conversation ? [conversation] : [];
    });
  }, [conversationIds]);
  return useConversationStoreSelector(store, selector, sameArrayItems);
}
