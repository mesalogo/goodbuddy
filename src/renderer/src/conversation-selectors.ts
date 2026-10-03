import { useCallback } from "react";
import type { AssistantTask } from "../../shared/assistant-contracts";
import type { Message } from "./ChatTimeline";
import { getConversationDisplayTitle, isUnusedConversation, type Conversation } from "./chat-conversation";
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
    tasks: readonly (Pick<AssistantTask, "conversationId" | "projectId" | "title"> & { status: string })[];
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

/**
 * What App shows of the active conversation: its header fields plus a few
 * values derived from its messages. Message content is not part of it, so a
 * streaming flush or tool update in the active conversation does not
 * re-render App; the history pane subscribes to the conversation itself.
 */
export type ActiveConversationView = Pick<
  Conversation,
  | "id" | "title" | "projectId" | "workMode" | "runtimeSelection" | "knowledgeLibraryIds"
  | "knowledgeRetrievalMode" | "remote" | "branch" | "contextMetrics" | "contextCompressionState"
> & {
  /** Untouched greeting-only conversation: shown with the default title. */
  unused: boolean;
  /** Messages are loaded (not a summary placeholder). */
  historyLoaded: boolean;
  /** Any message is still streaming. */
  running: boolean;
  messageCount: number;
  /** Artifact IDs referenced by messages, for hydration. */
  artifactIds: readonly string[];
};

const artifactIdsByMessages = new WeakMap<readonly Message[], string[]>();
function referencedArtifactIds(messages: readonly Message[]): string[] {
  let ids = artifactIdsByMessages.get(messages);
  if (!ids) {
    ids = [...new Set(messages.flatMap((message) => [
      ...(message.artifactIds ?? []),
      ...(message.imageOperations?.flatMap((operation) => operation.artifactIds) ?? []),
    ]))];
    artifactIdsByMessages.set(messages, ids);
  }
  return ids;
}

export function selectActiveConversationView(
  conversation: Conversation | undefined,
): ActiveConversationView | undefined {
  if (!conversation) return undefined;
  return {
    id: conversation.id,
    title: conversation.title,
    projectId: conversation.projectId,
    workMode: conversation.workMode,
    runtimeSelection: conversation.runtimeSelection,
    knowledgeLibraryIds: conversation.knowledgeLibraryIds,
    knowledgeRetrievalMode: conversation.knowledgeRetrievalMode,
    remote: conversation.remote,
    branch: conversation.branch,
    contextMetrics: conversation.contextMetrics,
    contextCompressionState: conversation.contextCompressionState,
    unused: isUnusedConversation(conversation),
    historyLoaded: !conversation.messageSummary,
    running: conversation.messages.some((message) => message.state === "streaming"),
    messageCount: conversation.messageSummary?.count ?? conversation.messages.length,
    artifactIds: referencedArtifactIds(conversation.messages),
  };
}

// Small plain-data fields: persisted refreshes replace them with equal copies.
function sameData(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function sameActiveConversationView(
  left: ActiveConversationView | undefined,
  right: ActiveConversationView | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.id === right.id && left.title === right.title &&
    left.projectId === right.projectId && left.workMode === right.workMode &&
    left.knowledgeRetrievalMode === right.knowledgeRetrievalMode &&
    left.unused === right.unused && left.historyLoaded === right.historyLoaded &&
    left.running === right.running && left.messageCount === right.messageCount &&
    sameArrayItems(left.knowledgeLibraryIds ?? [], right.knowledgeLibraryIds ?? []) &&
    (left.knowledgeLibraryIds === undefined) === (right.knowledgeLibraryIds === undefined) &&
    sameArrayItems(left.artifactIds, right.artifactIds) &&
    sameData(left.runtimeSelection, right.runtimeSelection) &&
    sameData(left.remote, right.remote) && sameData(left.branch, right.branch) &&
    sameData(left.contextMetrics, right.contextMetrics) &&
    sameData(left.contextCompressionState, right.contextCompressionState);
}

export function useActiveConversationView(
  store: ConversationStore,
  conversationId: string,
): ActiveConversationView | undefined {
  const selector = useCallback(
    (conversations: Conversation[]) => selectActiveConversationView(
      conversations.find((conversation) => conversation.id === conversationId),
    ),
    [conversationId],
  );
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeConversation(conversationId, listener),
    [conversationId, store],
  );
  return useConversationStoreSelector(store, selector, sameActiveConversationView, subscribe);
}

/**
 * The fields of one conversation the composer shows. Unlike the active
 * conversation view it leaves out the message count and artifact IDs, so a
 * new message or a tool result does not re-render the composer.
 */
export type ComposerConversationView = Pick<
  Conversation,
  | "id" | "runtimeSelection" | "knowledgeLibraryIds" | "knowledgeRetrievalMode"
  | "remote" | "contextMetrics" | "contextCompressionState"
> & { running: boolean };

export function selectComposerConversationView(
  conversation: Conversation | undefined,
): ComposerConversationView | undefined {
  if (!conversation) return undefined;
  return {
    id: conversation.id,
    runtimeSelection: conversation.runtimeSelection,
    knowledgeLibraryIds: conversation.knowledgeLibraryIds,
    knowledgeRetrievalMode: conversation.knowledgeRetrievalMode,
    remote: conversation.remote,
    contextMetrics: conversation.contextMetrics,
    contextCompressionState: conversation.contextCompressionState,
    running: conversation.messages.some((message) => message.state === "streaming"),
  };
}

export function sameComposerConversationView(
  left: ComposerConversationView | undefined,
  right: ComposerConversationView | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.id === right.id && left.running === right.running &&
    left.knowledgeRetrievalMode === right.knowledgeRetrievalMode &&
    sameArrayItems(left.knowledgeLibraryIds ?? [], right.knowledgeLibraryIds ?? []) &&
    (left.knowledgeLibraryIds === undefined) === (right.knowledgeLibraryIds === undefined) &&
    sameData(left.runtimeSelection, right.runtimeSelection) &&
    sameData(left.remote, right.remote) &&
    sameData(left.contextMetrics, right.contextMetrics) &&
    sameData(left.contextCompressionState, right.contextCompressionState);
}

export function useComposerConversationView(
  store: ConversationStore,
  conversationId: string,
): ComposerConversationView | undefined {
  const selector = useCallback(
    (conversations: Conversation[]) => selectComposerConversationView(
      conversations.find((conversation) => conversation.id === conversationId),
    ),
    [conversationId],
  );
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeConversation(conversationId, listener),
    [conversationId, store],
  );
  return useConversationStoreSelector(store, selector, sameComposerConversationView, subscribe);
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
