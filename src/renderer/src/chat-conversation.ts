import type { ConversationListSnapshot } from "../../shared/assistant-contracts";
import type { Message } from "./ChatTimeline";

export type Conversation = Omit<ConversationListSnapshot, "messages"> & {
  messages: Message[];
};

export function sortConversationsForDisplay(conversations: readonly Conversation[]): Conversation[] {
  // updatedAt tracks snapshot freshness, including every streaming delta.
  // Compute stable message times once per conversation, not per comparison.
  return conversations.map(conversation => ({
    conversation,
    time: conversation.messages.reduce<number | undefined>(
      (latest, message) => Math.max(latest ?? message.createdAt, message.createdAt),
      conversation.messageSummary?.latestMessageAt,
    ) ?? conversation.updatedAt,
  })).sort((left, right) =>
    Number(Boolean(right.conversation.pinned)) - Number(Boolean(left.conversation.pinned)) ||
    right.time - left.time || left.conversation.id.localeCompare(right.conversation.id),
  ).map(item => item.conversation);
}

export function isUnusedConversation(conversation: Conversation): boolean {
  return (
    conversation.title === "新对话" &&
    (conversation.messageSummary?.count ?? conversation.messages.length) === 1 &&
    (conversation.messageSummary?.firstRole ?? conversation.messages[0]?.role) === "assistant"
  );
}
