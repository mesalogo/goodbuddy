import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from "react";
import type { Conversation } from "./chat-conversation";
import { conversationActivityTime } from "./chat-conversation";
import type { ConversationActivity } from "./conversation-activity";
import {
  createLiveMessageStore,
  type ConversationsUpdate,
  type LiveMessageStore,
} from "./live-message-store";

/**
 * The conversation list, kept outside App state.
 *
 * `getState()` is always the latest list, synchronously after `set()`; it
 * replaces the former `conversationsRef`, which only caught up after commit.
 * Updates still go through the live-message store, so streaming deltas
 * captured at dispatch are absorbed in their original order.
 *
 * Components read the list through `useConversationStoreSelector`, which
 * re-renders only when the selected value changes. App selects the active and
 * cached conversations, so updates to background conversations (history
 * release, remote refreshes, other runs) no longer re-render the whole window.
 */
type Listener = () => void;

export type ConversationStore = ReturnType<typeof createConversationStore>;

export function createConversationStore(
  initial: Conversation[],
  liveMessages: LiveMessageStore,
) {
  let state = initial;
  const listeners = new Set<Listener>();
  const conversationListeners = new Map<string, Set<Listener>>();
  const lastOpenedByProject = new Map<string, string>();
  let activityTimes: ReadonlyMap<string, number> = new Map();
  let activityStatuses: ReadonlyMap<string, ConversationActivity['status']> | undefined;
  const activityListeners = new Set<Listener>();
  let lastActivityTime = 0;
  const touchActivity = (ids: readonly string[]): void => {
    if (!ids.length) return;
    lastActivityTime = Math.max(Date.now(), lastActivityTime + 1);
    const next = new Map(activityTimes);
    for (const id of ids) next.set(id, lastActivityTime);
    activityTimes = next;
    for (const listener of [...activityListeners]) listener();
  };

  const notify = (previous: readonly Conversation[]): void => {
    if (conversationListeners.size) {
      const before = new Map(previous.map((item) => [item.id, item]));
      const changed = new Set<string>();
      for (const item of state) {
        if (before.get(item.id) !== item) changed.add(item.id);
        before.delete(item.id);
      }
      for (const id of before.keys()) changed.add(id);
      for (const id of changed) {
        for (const listener of [...(conversationListeners.get(id) ?? [])]) listener();
      }
    }
    for (const listener of [...listeners]) listener();
  };

  return {
    rememberOpened(conversationId: string): void {
      const conversation = state.find((item) => item.id === conversationId);
      if (!conversation) return;
      if (conversation?.projectId) lastOpenedByProject.set(conversation.projectId, conversationId);
      touchActivity([conversationId]);
    },
    getActivityTimes(): ReadonlyMap<string, number> {
      return activityTimes;
    },
    subscribeActivityTimes(listener: Listener): () => void {
      activityListeners.add(listener);
      return () => { activityListeners.delete(listener); };
    },
    recordActivityStatuses(activities: readonly Pick<ConversationActivity, 'conversationId' | 'status'>[]): void {
      const next = new Map(activities.map((activity) => [activity.conversationId, activity.status]));
      const changed: string[] = [];
      // Initial activity is a baseline. Acknowledging a completion is not a new run.
      if (activityStatuses) for (const id of new Set([...activityStatuses.keys(), ...next.keys()])) {
        const before = activityStatuses.get(id);
        const after = next.get(id);
        if (before !== after && !(before === 'completed' && after === undefined)) changed.push(id);
      }
      activityStatuses = next;
      touchActivity(changed);
    },
    projectConversation(projectId: string, channel: boolean, candidates = state): Conversation | undefined {
      const remembered = lastOpenedByProject.get(projectId);
      let recent: Conversation | undefined;
      for (const item of candidates) {
        if (item.projectId !== projectId || (channel && !item.remote)) continue;
        if (item.id === remembered) return item;
        if (!recent || conversationActivityTime(item) > conversationActivityTime(recent)) recent = item;
      }
      return recent;
    },
    getState(): Conversation[] {
      return state;
    },
    getConversation(conversationId: string): Conversation | undefined {
      return state.find((item) => item.id === conversationId);
    },
    /** Applies `update` now, after absorbing the deltas pending at dispatch. */
    set(update: ConversationsUpdate): void {
      const captured = liveMessages.capture();
      const next = liveMessages.applyUpdate(state, update, captured);
      if (next === state) return;
      const previous = state;
      state = next;
      notify(previous);
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Notified only when this conversation object is replaced or removed. */
    subscribeConversation(conversationId: string, listener: Listener): () => void {
      let set = conversationListeners.get(conversationId);
      if (!set) {
        set = new Set();
        conversationListeners.set(conversationId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size && conversationListeners.get(conversationId) === set) {
          conversationListeners.delete(conversationId);
        }
      };
    },
  };
}

/**
 * The conversation store plus the live-message store feeding it, with the
 * slow flush that absorbs streaming deltas into the list.
 */
export function createConversationStores(
  initial: Conversation[],
  options: { flushIntervalMs: number; createId?: () => string },
) {
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const liveMessages = createLiveMessageStore({
    createId: options.createId,
    onPending: () => {
      if (flushTimer !== undefined) return;
      // A plain update: a transition would keep being interrupted by the
      // row's synchronous store updates and might never absorb anything.
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        if (!liveMessages.hasEntries()) return;
        conversations.set((current) => current);
      }, options.flushIntervalMs);
    },
  });
  const conversations = createConversationStore(initial, liveMessages);
  return {
    conversations,
    liveMessages,
    cancelLiveMessageFlush: (): void => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    },
  };
}

type Selection<T> = {
  state: readonly Conversation[];
  selector: (conversations: Conversation[]) => T;
  value: T;
};
type LatestSelector<T> = {
  selector: (conversations: Conversation[]) => T;
  isEqual: (left: T, right: T) => boolean;
};

// Keyed by a per-hook slot, as in stable-derived-value.ts.
const selections = new WeakMap<object, Selection<unknown>>();
const latestSelectors = new WeakMap<object, LatestSelector<unknown>>();

/**
 * Selects a value from the conversation list and re-renders only when it is
 * no longer `isEqual` to the previous one; equal values keep their identity.
 *
 * Unlike useSyncExternalStore, the re-render is a plain state update made
 * from `set()`, so it has the priority of the code that changed the list and
 * batches with that code's other state updates (for example `setActiveId`
 * after an await), exactly like the former App state. Keep `selector` stable
 * (useCallback) when it is expensive; a new selector recomputes on render.
 */
export function useConversationStoreSelector<T>(
  store: ConversationStore,
  selector: (conversations: Conversation[]) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
  subscribe: (listener: Listener) => () => void = store.subscribe,
): T {
  const [slot] = useState(() => ({}));
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const state = store.getState();
  const cached = selections.get(slot) as Selection<T> | undefined;
  let value: T;
  if (cached && cached.state === state && cached.selector === selector) {
    value = cached.value;
  } else {
    const next = selector(state);
    value = cached && isEqual(cached.value, next) ? cached.value : next;
    selections.set(slot, { state, selector, value });
  }
  useLayoutEffect(() => {
    latestSelectors.set(slot, { selector, isEqual } as LatestSelector<unknown>);
  });
  useLayoutEffect(() => {
    const check = (): void => {
      const current = selections.get(slot) as Selection<T> | undefined;
      const latest = latestSelectors.get(slot) as LatestSelector<T> | undefined;
      const next = store.getState();
      if (!latest || current?.state === next) return;
      const selected = latest.selector(next);
      if (current && latest.isEqual(current.value, selected)) {
        selections.set(slot, { state: next, selector: latest.selector, value: current.value });
        return;
      }
      selections.set(slot, { state: next, selector: latest.selector, value: selected });
      rerender();
    };
    // Catch updates made between render and subscription.
    check();
    return subscribe(check);
  }, [slot, store, subscribe]);
  return value;
}

const selectAll = (conversations: Conversation[]): Conversation[] => conversations;

/** The whole list; re-renders on every change. */
export function useConversationList(store: ConversationStore): Conversation[] {
  return useConversationStoreSelector(store, selectAll);
}

/** One conversation; re-renders only when that conversation changes. */
export function useConversation(
  store: ConversationStore,
  conversationId: string,
): Conversation | undefined {
  const selector = useMemo(
    () => (conversations: Conversation[]) =>
      conversations.find((item) => item.id === conversationId),
    [conversationId],
  );
  const subscribe = useCallback(
    (listener: Listener) => store.subscribeConversation(conversationId, listener),
    [conversationId, store],
  );
  return useConversationStoreSelector(store, selector, Object.is, subscribe);
}

/** Renders `children` with the whole list; for rarely mounted consumers. */
export function ConversationListView({
  children,
  store,
}: {
  children: (conversations: Conversation[]) => ReactNode;
  store: ConversationStore;
}): ReactNode {
  return children(useConversationList(store));
}

/**
 * Commits that change the list: prunes deltas the committed list contains
 * (after the panes showing them have committed, so text never flickers) and
 * runs `onCommit` after each change, like an App effect on `conversations`.
 */
export function ConversationStoreEffects({
  liveMessages,
  onCommit,
  store,
}: {
  liveMessages: LiveMessageStore;
  onCommit: () => void;
  store: ConversationStore;
}): null {
  const conversations = useConversationList(store);
  useLayoutEffect(() => {
    liveMessages.prune(conversations);
  }, [conversations, liveMessages]);
  useEffect(() => {
    onCommit();
    // Only list changes run the callback; its identity is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]);
  return null;
}

export const ConversationStoreContext = createContext<ConversationStore | null>(null);

export function useConversationStore(): ConversationStore {
  const store = useContext(ConversationStoreContext);
  if (!store) throw new Error("ConversationStoreContext is missing");
  return store;
}
