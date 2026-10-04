import type { ConversationListSnapshot } from "../../shared/assistant-contracts";
import type { Message } from "./ChatTimeline";

export type Conversation = Omit<ConversationListSnapshot, "messages"> & {
  messages: Message[];
};

// Message arrays are replaced, never mutated, so a conversation whose messages
// did not change (every conversation except the streaming one) reuses its scan.
const latestMessageTimes = new WeakMap<readonly Message[], number | undefined>();

function latestMessageTime(messages: readonly Message[]): number | undefined {
  if (latestMessageTimes.has(messages)) {
    return latestMessageTimes.get(messages);
  }
  const latest = messages.reduce<number | undefined>(
    (current, message) => Math.max(current ?? message.createdAt, message.createdAt),
    undefined,
  );
  latestMessageTimes.set(messages, latest);
  return latest;
}

export function conversationActivityTime(conversation: Conversation): number {
  const summaryTime = conversation.messageSummary?.latestMessageAt;
  const messageTime = latestMessageTime(conversation.messages);
  return (summaryTime === undefined ? messageTime : messageTime === undefined
    ? summaryTime : Math.max(summaryTime, messageTime)) ?? conversation.updatedAt;
}

export function sortConversationsForDisplay(conversations: readonly Conversation[]): Conversation[] {
  // updatedAt tracks snapshot freshness, including every streaming delta.
  // Compute stable message times once per conversation, not per comparison.
  return conversations.map(conversation => {
    return { conversation, time: conversationActivityTime(conversation) };
  }).sort((left, right) =>
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

export function getConversationDisplayTitle(
  conversation: Conversation,
  defaultTitle: string,
): string {
  return isUnusedConversation(conversation) ? defaultTitle : conversation.title;
}
