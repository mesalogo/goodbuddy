import type { ConversationListSnapshot } from "../../shared/assistant-contracts";
import type { Message } from "./ChatTimeline";

export type Conversation = Omit<ConversationListSnapshot, "messages"> & {
  messages: Message[];
};

export function isUnusedConversation(conversation: Conversation): boolean {
  return (
    conversation.title === "新对话" &&
    (conversation.messageSummary?.count ?? conversation.messages.length) === 1 &&
    (conversation.messageSummary?.firstRole ?? conversation.messages[0]?.role) === "assistant"
  );
}
