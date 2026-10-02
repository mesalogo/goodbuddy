import type {
  AssistantSchedule,
  AssistantTask,
  ConversationListSnapshot,
} from "../../shared/assistant-contracts";
import type { Message } from "./ChatTimeline";
import type { ConversationStore } from "./conversation-store";
import { mergePersistedConversations, type ConversationPersistence } from "./conversation-persistence";

/** A run App started and has not seen finish yet. */
export type ConversationRefreshRun = {
  conversationId: string;
  messageId: string;
  projectId?: string;
};

export type ConversationRefreshApi = {
  listTasks: () => Promise<AssistantTask[]>;
  listSchedules: () => Promise<AssistantSchedule[]>;
  listSummaries: (detailIds: string[]) => Promise<ConversationListSnapshot[]>;
  /** Main reports that persisted conversations, tasks or schedules changed. */
  onConversationsChanged: (listener: () => void) => () => void;
  onQueueChanged: (listener: () => void) => () => void;
};

export type ConversationRefreshDependencies = {
  store: ConversationStore;
  persistence: Pick<ConversationPersistence, "acknowledged">;
  /** Defaults to the preload bridge. */
  api?: ConversationRefreshApi;
  activeRuns: Map<string, ConversationRefreshRun>;
  activeConversationId: () => string;
  retainedConversationIds: () => Set<string>;
  pinState: () => { revision: number; pending: boolean };
  onTasks: (tasks: AssistantTask[]) => void;
  onSchedules: (schedules: AssistantSchedule[]) => void;
  /** Remote conversations updated while another conversation is open. */
  onUnread: (conversations: ConversationListSnapshot[]) => void;
  /** A run whose message reached a persisted terminal state. */
  onRunSettled: (requestId: string, run: ConversationRefreshRun, state: Message["state"]) => void;
  onError: (kind: "tasks" | "schedules" | "conversations") => void;
  /** Coalescing delay before a refresh; tests pass 0. */
  delayMs?: number;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  document?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
};

/**
 * Re-reads tasks, schedules and conversation summaries whenever Main reports a
 * change, the queue changes, or the window regains focus, and merges the
 * summaries into the conversation store. Refreshes are coalesced, never run
 * concurrently, and stale replies (a newer change arrived meanwhile) are
 * dropped. Returns the stop function.
 */
function desktopRefreshApi(): ConversationRefreshApi {
  const api = window.goodbuddy;
  return {
    listTasks: () => api.tasks.list(),
    listSchedules: () => api.schedules.list(),
    listSummaries: (detailIds) => api.conversations.listSummaries(detailIds),
    onConversationsChanged: (listener) => api.conversations.onChanged(listener),
    onQueueChanged: (listener) => api.conversationQueue.onChanged(() => listener()),
  };
}

export function startConversationRefresh(deps: ConversationRefreshDependencies): () => void {
  const { store } = deps;
  const api = deps.api ?? desktopRefreshApi();
  const target = deps.target ?? window;
  const doc = deps.document ?? document;
  const delayMs = deps.delayMs ?? 50;
  let active = true;
  let refreshSequence = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshInFlight = false;
  let refreshQueued = false;

  const queueRefresh = (): void => {
    refreshSequence += 1;
    refreshQueued = true;
    if (refreshInFlight || refreshTimer !== undefined) {
      return;
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refresh();
    }, delayMs);
  };

  // A run whose assistant message has already reached a persisted terminal
  // state (for example a remote task that finished while the desktop was
  // disconnected) must stop counting as in-flight, otherwise the renderer
  // keeps showing "processing" forever.
  const settleActiveRunsFromPersistedMessages = (
    persisted: readonly ConversationListSnapshot[],
  ): void => {
    if (deps.activeRuns.size === 0) {
      return;
    }
    const persistedMessageStates = new Map<string, Message["state"]>();
    for (const conversation of persisted) {
      for (const message of conversation.messages) {
        persistedMessageStates.set(`${conversation.id}\0${message.id}`, message.state);
      }
    }
    for (const [requestId, run] of deps.activeRuns) {
      const state = persistedMessageStates.get(`${run.conversationId}\0${run.messageId}`);
      if (state !== undefined && state !== "streaming") {
        deps.activeRuns.delete(requestId);
        deps.onRunSettled(requestId, run, state);
      }
    }
  };

  const refresh = (): void => {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    refreshQueued = false;
    const sequence = refreshSequence;
    const current = (): boolean => active && sequence === refreshSequence;
    const pinRevision = deps.pinState().revision;
    const tasksRefresh = api.listTasks()
      .then((tasks) => {
        if (current()) deps.onTasks(tasks);
      })
      .catch(() => {
        if (current()) deps.onError("tasks");
      });
    const schedulesRefresh = api.listSchedules()
      .then((schedules) => {
        if (current()) deps.onSchedules(schedules);
      })
      .catch(() => {
        if (current()) deps.onError("schedules");
      });
    const conversationsRefresh = api.listSummaries([...deps.retainedConversationIds()])
      .then((persisted) => {
        if (!current()) {
          return;
        }
        const pins = deps.pinState();
        if (pinRevision !== pins.revision) {
          queueRefresh();
          return;
        }
        if (pins.pending) {
          const currentPins = new Map(store.getState().map(item => [item.id, item.pinned]));
          persisted = persisted.map(item => ({ ...item, pinned: currentPins.has(item.id) ? currentPins.get(item.id) : item.pinned }));
        }
        const previousById = new Map(store.getState().map((conversation) => [conversation.id, conversation]));
        const updated = persisted.filter((conversation) => {
          if (!conversation.remote) return false;
          const previous = previousById.get(conversation.id);
          return previous === undefined || conversation.updatedAt > previous.updatedAt;
        });
        const activeId = deps.activeConversationId();
        const unread = updated.filter((conversation) => conversation.id !== activeId);
        if (unread.length > 0) {
          deps.onUnread(unread);
        }
        store.set((list) =>
          mergePersistedConversations(
            list,
            persisted,
            deps.persistence.acknowledged(),
            deps.retainedConversationIds(),
          ),
        );
        settleActiveRunsFromPersistedMessages(persisted);
      })
      .catch(() => {
        if (current()) deps.onError("conversations");
      });
    void Promise.allSettled([tasksRefresh, schedulesRefresh, conversationsRefresh]).finally(() => {
      refreshInFlight = false;
      if (active && refreshQueued) {
        queueRefresh();
      }
    });
  };

  const refreshWhenVisible = (): void => {
    if (doc.visibilityState !== "hidden") {
      queueRefresh();
    }
  };
  const removeConversations = api.onConversationsChanged(queueRefresh);
  const removeQueue = api.onQueueChanged(queueRefresh);
  target.addEventListener("focus", refreshWhenVisible);
  doc.addEventListener("visibilitychange", refreshWhenVisible);
  return () => {
    active = false;
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
    }
    removeConversations();
    removeQueue();
    target.removeEventListener("focus", refreshWhenVisible);
    doc.removeEventListener("visibilitychange", refreshWhenVisible);
  };
}
