import type {
  ConversationListSnapshot,
  ConversationMessage,
  ConversationSnapshot,
  LocalConversationHeader,
  LocalConversationSaveBatch,
} from "../../shared/assistant-contracts";
import type { Message } from "./ChatTimeline";
import { sortConversationsForDisplay, type Conversation } from "./chat-conversation";
import type { ConversationStore } from "./conversation-store";
import { mergeMessageImageState } from "./message-image-state";

/**
 * Local conversation persistence and history loading, outside React.
 *
 * Works against the conversation store directly (getState/set), so App never
 * re-renders for its bookkeeping: the acknowledged snapshots, the serialized
 * save queue, in-flight history requests and the "persist after commit" flag
 * all live here. App keeps aliases of the ref-like fields for the few
 * operations (delete, branch, clear data) that coordinate with the queue.
 */

export function toConversationMessage(message: Message): ConversationMessage {
  return {
    id: message.id,
    queueItemId: message.queueItemId,
    role: message.role,
    content: message.content,
    reasoning: message.reasoning,
    blocks: message.blocks,
    displayCaptureTruncated: message.displayCaptureTruncated,
    createdAt: message.createdAt,
    state: message.state,
    terminalStatus: message.terminalStatus,
    status: message.status,
    runtimeChecklist: message.runtimeChecklist,
    contextCompression: message.contextCompression,
    contextCompressions: message.contextCompressions,
    tools: message.tools,
    subagents: message.subagents,
    sources: message.sources,
    sourceReferences: message.sourceReferences,
    knowledgeRetrieval: message.knowledgeRetrieval,
    artifactIds: message.artifactIds,
    imageOperations: message.imageOperations,
    imageSourceArtifactIds: message.imageSourceArtifactIds,
    imageContextNotice: message.imageContextNotice,
    task: message.task,
    attachments: message.attachments,
    answeredQuestions: message.answeredQuestions,
  };
}

export function toLocalConversationHeader(
  conversation: Conversation,
): LocalConversationHeader {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    runtimeSelection: conversation.runtimeSelection,
    workMode: conversation.workMode,
    knowledgeLibraryIds: conversation.knowledgeLibraryIds,
    knowledgeRetrievalMode: conversation.knowledgeRetrievalMode,
    storyGraphEnabled: conversation.storyGraphEnabled,
    contextMetrics: conversation.contextMetrics,
    contextCompressionState: conversation.contextCompressionState,
    ...(conversation.branch ? { branch: conversation.branch } : {}),
    title: conversation.title,
    updatedAt: conversation.updatedAt,
  };
}

export function createLocalConversationSaveBatch(
  conversations: readonly Conversation[],
  persisted: ReadonlyMap<string, Conversation>,
  deletingConversationIds: ReadonlySet<string>,
): {
  batch: LocalConversationSaveBatch;
  acknowledgements: Conversation[];
} {
  const batch: LocalConversationSaveBatch = [];
  const acknowledgements: Conversation[] = [];
  for (const conversation of conversations) {
    if (
      conversation.remote ||
      deletingConversationIds.has(conversation.id) ||
      persisted.get(conversation.id) === conversation
    ) {
      continue;
    }
    const previous = persisted.get(conversation.id);
    const previousMessages = new Map(
      previous?.messages.map((message) => [message.id, message]) ?? [],
    );
    batch.push({
      header: toLocalConversationHeader(conversation),
      messages: conversation.messages
        .filter((message) => previousMessages.get(message.id) !== message)
        .map(toConversationMessage),
    });
    acknowledgements.push(conversation);
    if (batch.length === 100) {
      break;
    }
  }
  return { batch, acknowledgements };
}

/**
 * The persisted store is the authority for a message's terminal state.
 * A locally streaming message (or a locally interrupted one that the
 * remote recovery later completed) must never shadow a persisted
 * terminal state, even when the local conversation was touched later.
 */
function persistedTerminalStateOverridesLocal(
  local: Message,
  persisted: Message,
): boolean {
  return persisted.state !== "streaming" && local.state !== "complete";
}

export function withRecoveredQuestions(conversation: Conversation): Conversation {
  const active = conversation.activeRequest;
  if (!active) return conversation;
  return {
    ...conversation,
    messages: conversation.messages.map(message =>
      message.id === active.messageId && message.state === "streaming"
        ? { ...message, pendingQuestions: active.questions }
        : message,
    ),
  };
}

export function mergePersistedConversations(
  current: readonly Conversation[],
  incoming: readonly ConversationListSnapshot[],
  persistedLocal: Map<string, Conversation>,
  retainDetails: ReadonlySet<string> = new Set(),
): Conversation[] {
  const incomingById = new Map(
    incoming.map((conversation) => [conversation.id, conversation]),
  );
  const currentById = new Map(
    current.map((conversation) => [conversation.id, conversation]),
  );
  const merged = incoming.map((conversation): Conversation => {
    if (conversation.messageSummary) {
      const local = currentById.get(conversation.id);
      const acknowledged = persistedLocal.get(conversation.id);
      const dirtyMessages = local &&
        local.messages.some(message => !acknowledged?.messages.includes(message));
      const keepMessages = local && (dirtyMessages ||
        local.messages.some(message => message.approval || message.pendingQuestions?.length || message.state === "streaming") ||
        (!local.messageSummary && retainDetails.has(conversation.id)));
      const next = local && local.updatedAt > conversation.updatedAt
        ? { ...local, pinned: conversation.pinned, messageSummary: conversation.messageSummary, messages: [] }
        : conversation;
      if (keepMessages) {
        // A list reply started before navigation must not unload the newly
        // opened history, or any messages not acknowledged by Main yet.
        return {
          ...next, messages: local.messages,
          messageSummary: local.messageSummary ? conversation.messageSummary : undefined,
        };
      }
      if (!conversation.remote) persistedLocal.set(conversation.id, conversation);
      return next;
    }
    if (conversation.remote) {
      return conversation;
    }
    const local = currentById.get(conversation.id);
    if (!local || local.remote) {
      persistedLocal.set(conversation.id, conversation);
      return withRecoveredQuestions(conversation);
    }
    const localMessageById = new Map(
      local.messages.map((message) => [message.id, message]),
    );
    const localIsNewer = local.updatedAt > conversation.updatedAt;
    const serverMessageIds = new Set(
      conversation.messages.map((message) => message.id),
    );
    const messages = [
      ...conversation.messages.map((persistedMessage) => {
        const localMessage = localMessageById.get(persistedMessage.id);
        const message = mergeMessageImageState(persistedMessage, persistedMessage, localMessage);
        // A newer conversation timestamp can still contain an older message
        // snapshot while a terminal event is being persisted.
        if (localMessage && localMessage.state !== "streaming" && message.state === "streaming") {
          return mergeMessageImageState(localMessage, persistedMessage, localMessage);
        }
        if (!conversation.activeRequest && local.activeRequest?.messageId === message.id) {
          return { ...message, pendingQuestions: undefined };
        }
        if (!localIsNewer) {
          // Pending prompts are live-only and are omitted from persisted messages.
          if (localMessage?.state === "streaming" && message.state === "streaming") {
            return mergeMessageImageState(localMessage, persistedMessage, localMessage);
          }
          return message;
        }
        if (
          !localMessage ||
          persistedTerminalStateOverridesLocal(localMessage, message)
        ) {
          return message;
        }
        return mergeMessageImageState(localMessage, persistedMessage, localMessage);
      }),
      ...local.messages.filter((message) => !serverMessageIds.has(message.id)),
    ];
    const next = localIsNewer
      ? { ...local, pinned: conversation.pinned, messages, messageSummary: undefined, activeRequest: conversation.activeRequest }
      : { ...conversation, messages };
    persistedLocal.set(conversation.id, conversation);
    return withRecoveredQuestions(next);
  });
  for (const conversation of current) {
    if (!incomingById.has(conversation.id)) {
      merged.push(conversation);
    }
  }
  return sortConversationsForDisplay(merged);
}


export type ConversationPersistenceApi = {
  saveLocal: (batch: LocalConversationSaveBatch) => Promise<unknown>;
  get: (conversationId: string) => Promise<ConversationSnapshot>;
};

/** What persistence needs from App; connected after each commit. */
export type ConversationPersistenceHost = {
  /** IDs whose loaded history must stay in memory (open panes, runs). */
  retainedConversationIds: () => Set<string>;
  /** Whether a task of this conversation is still running or waiting. */
  hasBusyTask: (conversationId: string) => boolean;
  /** Pin edits in flight: a history reply must not overwrite them. */
  pinState: () => { revision: number; pending: boolean };
  historyUnavailableError: () => Error;
  onSaveFailed: () => void;
};

export type ConversationPersistenceOptions = {
  store: ConversationStore;
  /** Defaults to the preload bridge. */
  api?: ConversationPersistenceApi;
  intervalMs: number;
};

export type ConversationPersistence = ReturnType<typeof createConversationPersistence>;

const detachedHost: ConversationPersistenceHost = {
  retainedConversationIds: () => new Set(),
  hasBusyTask: () => false,
  pinState: () => ({ revision: 0, pending: false }),
  historyUnavailableError: () => new Error("Conversation history is unavailable"),
  onSaveFailed: () => undefined,
};

/**
 * Local conversation persistence. Owns the acknowledged snapshots, the
 * serialized save queue (every write to Main's local copy goes through it,
 * in order), the delete/pause guards and in-flight history requests.
 */
export function createConversationPersistence(options: ConversationPersistenceOptions) {
  const { store } = options;
  const api: ConversationPersistenceApi = options.api ?? {
    saveLocal: (batch) => window.goodbuddy.conversations.saveLocal(batch),
    get: (conversationId) => window.goodbuddy.conversations.get(conversationId),
  };
  let host = detachedHost;
  /** The last snapshot of each local conversation acknowledged by Main. */
  let acknowledged = new Map<string, Conversation>();
  /** Serializes every local save; await it before reading Main's copy. */
  let queue: Promise<void> = Promise.resolve();
  let paused = false;
  const deleting = new Set<string>();
  /** Set by run completion; the next list commit persists at once. */
  let flushRequested = false;
  const historyRequests = new Map<string, Promise<Conversation>>();
  let started = false;

  const releaseUnretainedHistories = (): void => {
    const retained = host.retainedConversationIds();
    store.set(current => {
      let changed = false;
      const next = current.map(conversation => {
        if (conversation.messageSummary || retained.has(conversation.id) ||
          historyRequests.has(conversation.id) ||
          conversation.activeRequest ||
          (!conversation.remote && acknowledged.get(conversation.id) !== conversation) ||
          conversation.messages.some(message => message.state === "streaming" ||
            message.approval || message.pendingQuestions?.length) ||
          host.hasBusyTask(conversation.id)) return conversation;
        changed = true;
        const summary: Conversation = {
          ...conversation, messages: [],
          messageSummary: { count: conversation.messages.length, firstRole: conversation.messages[0]?.role },
        };
        if (!conversation.remote) acknowledged.set(conversation.id, summary);
        return summary;
      });
      return changed ? next : current;
    });
  };

  /** Queues a save of every changed local conversation, then releases idle history. */
  const persist = (): void => {
    const operation = queue.then(async () => {
      if (paused) {
        return;
      }
      const { batch, acknowledgements } = createLocalConversationSaveBatch(
        store.getState(),
        acknowledged,
        deleting,
      );
      if (batch.length === 0) {
        releaseUnretainedHistories();
        return;
      }
      await api.saveLocal(batch);
      for (const conversation of acknowledgements) {
        acknowledged.set(conversation.id, conversation);
      }
      releaseUnretainedHistories();
    });
    queue = operation.catch(() => undefined);
    void operation.catch(() => host.onSaveFailed());
  };

  const ensureHistory = (conversationId: string): Promise<Conversation> => {
    const current = store.getConversation(conversationId);
    if (!current) return Promise.reject(host.historyUnavailableError());
    if (!current.messageSummary) return Promise.resolve(current);
    const pending = historyRequests.get(conversationId);
    if (pending) return pending;
    const pinRevision = host.pinState().revision;
    const request = api.get(conversationId).then(snapshot => {
      const latest = store.getConversation(conversationId);
      if (!latest || deleting.has(conversationId)) {
        throw host.historyUnavailableError();
      }
      if (!latest.messageSummary) return latest;
      const pins = host.pinState();
      if (pinRevision !== pins.revision || pins.pending) {
        snapshot = { ...snapshot, pinned: latest.pinned };
      }
      const next = mergePersistedConversations(
        store.getState(), [snapshot], acknowledged,
        host.retainedConversationIds(),
      );
      store.set(next);
      return next.find(item => item.id === conversationId)!;
    }).finally(() => { historyRequests.delete(conversationId); });
    historyRequests.set(conversationId, request);
    return request;
  };

  return {
    connect(next: ConversationPersistenceHost): void {
      host = next;
    },
    /** Acknowledged snapshots; merges update it in place. */
    acknowledged: (): Map<string, Conversation> => acknowledged,
    replaceAcknowledged(next: Map<string, Conversation>): void {
      acknowledged = next;
    },
    /** Resolves after every save queued so far. */
    idle: (): Promise<void> => queue,
    /** Runs `task` after every queued save, as part of the queue. */
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const operation = queue.then(task);
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    /** Makes the queue wait for `operation` (initial load or migration). */
    chain(operation: Promise<unknown>): void {
      queue = operation.then(() => undefined, () => undefined);
    },
    setPaused(value: boolean): void {
      paused = value;
    },
    markDeleting(conversationId: string, value: boolean): void {
      if (value) deleting.add(conversationId);
      else deleting.delete(conversationId);
    },
    /** A run ended: persist with the next committed list change. */
    requestFlushAfterCommit(): void {
      flushRequested = true;
    },
    persist,
    ensureHistory,
    releaseUnretainedHistories,
    /**
     * Starts periodic saves once the store holds Main's conversations.
     * The returned stop function saves once more.
     */
    start(): () => void {
      started = true;
      persist();
      const interval = setInterval(persist, options.intervalMs);
      return () => {
        clearInterval(interval);
        started = false;
        persist();
      };
    },
    /** Called after each committed list change. */
    flushAfterCommit(): void {
      if (!started || !flushRequested) return;
      flushRequested = false;
      persist();
    },
    /** Saves what is pending and resolves when the queue is drained. */
    async flushForQuit(): Promise<void> {
      if (!started) return;
      flushRequested = false;
      persist();
      await queue;
    },
  };
}
