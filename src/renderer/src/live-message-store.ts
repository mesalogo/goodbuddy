import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ConversationMessageBlock } from "../../shared/assistant-contracts";
import type { Message } from "./ChatTimeline";
import type { Conversation } from "./chat-conversation";

/**
 * Streaming text and reasoning deltas for in-flight assistant messages.
 *
 * Each delta used to replace the whole conversations array, re-rendering the
 * entire App for every IPC batch. Deltas now land here first: only the row
 * showing the message re-renders, and App state absorbs them on a slow cadence
 * or as part of the next conversations update.
 *
 * Every delta has a sequence number and the text/reasoning lengths the message
 * reaches after it. To know which deltas a message object already contains:
 * - objects produced while absorbing deltas (or derived from those by a
 *   functional update) are tagged with the last absorbed sequence;
 * - any other object (persisted snapshots, replaced state) is measured by
 *   length, because deltas only ever append.
 * Display folds only newer deltas, so nothing is shown twice or dropped. An
 * update absorbs only deltas captured when it was dispatched, which keeps
 * text, tool and other blocks in their original order.
 */
export type LiveDeltaKind = "text" | "reasoning";

type LiveDelta = {
  seq: number;
  kind: LiveDeltaKind;
  delta: string;
  blockId: string;
  /** Message lengths after this delta is applied. */
  textLength: number;
  reasoningLength: number;
};

export type LiveMessageSnapshot = {
  readonly conversationId: string;
  readonly messageId: string;
  readonly lastSeq: number;
  readonly deltas: readonly LiveDelta[];
};

export type ConversationsUpdate =
  | Conversation[]
  | ((current: Conversation[]) => Conversation[]);

type Listener = () => void;

export type LiveMessageStore = ReturnType<typeof createLiveMessageStore>;

const noSnapshots: readonly LiveMessageSnapshot[] = [];

function appendBlock(
  blocks: ConversationMessageBlock[] | undefined,
  type: LiveDeltaKind,
  delta: string,
  blockId: string,
): ConversationMessageBlock[] | undefined {
  if (!blocks || !delta) {
    return blocks;
  }
  const current = [...blocks];
  const previous = current.at(-1);
  if (previous?.type === type) {
    current[current.length - 1] = {
      ...previous,
      content: `${previous.content}${delta}`,
    };
    return current;
  }
  current.push({ id: blockId, type, content: delta });
  return current;
}

/** Applies deltas in order, exactly like the former per-event updates. */
export function foldLiveDeltas(
  message: Message,
  deltas: readonly Pick<LiveDelta, "kind" | "delta" | "blockId">[],
): Message {
  if (!deltas.length) {
    return message;
  }
  let content = message.content;
  let reasoning = message.reasoning;
  let blocks = message.blocks;
  for (const { kind, delta, blockId } of deltas) {
    if (kind === "text") {
      content = `${content}${delta}`;
    } else {
      reasoning = `${reasoning ?? ""}${delta}`;
    }
    blocks = appendBlock(blocks, kind, delta, blockId);
  }
  const next: Message = { ...message, content, blocks, status: undefined };
  if (reasoning !== undefined) {
    next.reasoning = reasoning;
  }
  return next;
}

export function createLiveMessageStore(options: {
  createId?: () => string;
  onPending?: () => void;
} = {}) {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const entries = new Map<string, LiveMessageSnapshot>();
  const listeners = new Map<string, Set<Listener>>();
  /** Last delta sequence contained by message objects this store produced. */
  const absorbed = new WeakMap<Message, number>();
  const resolved = new WeakMap<Message, { snapshot: LiveMessageSnapshot; message: Message }>();
  let seq = 0;
  let version = 0;
  let resolvedConversations:
    | { input: Conversation[]; version: number; output: Conversation[] }
    | undefined;

  const notify = (messageId: string): void => {
    for (const listener of [...(listeners.get(messageId) ?? [])]) {
      listener();
    }
  };

  /** Number of leading deltas of `snapshot` that `message` already contains. */
  const containedCount = (message: Message, snapshot: LiveMessageSnapshot): number => {
    const { deltas } = snapshot;
    const tag = absorbed.get(message);
    if (tag !== undefined) {
      let count = 0;
      while (count < deltas.length && deltas[count]!.seq <= tag) count += 1;
      return count;
    }
    const textLength = message.content.length;
    const reasoningLength = message.reasoning?.length ?? 0;
    let count = 0;
    while (
      count < deltas.length &&
      deltas[count]!.textLength <= textLength &&
      deltas[count]!.reasoningLength <= reasoningLength
    ) {
      count += 1;
    }
    return count;
  };

  const findMessage = (
    conversations: readonly Conversation[],
    snapshot: LiveMessageSnapshot,
  ): Message | undefined =>
    conversations
      .find((item) => item.id === snapshot.conversationId)
      ?.messages.find((item) => item.id === snapshot.messageId);

  /**
   * Folds `snapshots` into `conversations`. Snapshots are immutable, so React
   * may replay an updater against an older base state and get the same result.
   */
  const fold = (
    conversations: Conversation[],
    snapshots: readonly LiveMessageSnapshot[],
  ): Conversation[] => {
    let next = conversations;
    for (const snapshot of snapshots) {
      const conversationIndex = next.findIndex((item) => item.id === snapshot.conversationId);
      const conversation = next[conversationIndex];
      if (!conversation) continue;
      const messageIndex = conversation.messages.findIndex((item) => item.id === snapshot.messageId);
      const message = conversation.messages[messageIndex];
      if (!message) continue;
      const count = containedCount(message, snapshot);
      if (count >= snapshot.deltas.length) continue;
      const updated = foldLiveDeltas(message, snapshot.deltas.slice(count));
      absorbed.set(updated, snapshot.lastSeq);
      const messages = [...conversation.messages];
      messages[messageIndex] = updated;
      if (next === conversations) next = [...conversations];
      next[conversationIndex] = { ...conversation, updatedAt: Date.now(), messages };
    }
    return next;
  };

  return {
    /**
     * Records a delta. `base` is the committed message, used to measure the
     * first delta of a message; omit it when the message is not committed yet.
     */
    append(
      conversationId: string,
      messageId: string,
      kind: LiveDeltaKind,
      delta: string,
      base?: Pick<Message, "content" | "reasoning">,
    ): void {
      if (!delta) return;
      seq += 1;
      version += 1;
      const previous = entries.get(messageId);
      const last = previous?.deltas.at(-1);
      // Without a committed base, lengths are unknown; only tags then decide
      // what a message contains, so text is never hidden by a wrong guess.
      const textLength = last?.textLength ?? base?.content.length ?? Number.POSITIVE_INFINITY;
      const reasoningLength = last?.reasoningLength ??
        (base ? base.reasoning?.length ?? 0 : Number.POSITIVE_INFINITY);
      const entry: LiveDelta = {
        seq,
        kind,
        delta,
        blockId: createId(),
        textLength: kind === "text" ? textLength + delta.length : textLength,
        reasoningLength: kind === "reasoning" ? reasoningLength + delta.length : reasoningLength,
      };
      entries.set(messageId, {
        conversationId,
        messageId,
        lastSeq: seq,
        deltas: previous ? [...previous.deltas, entry] : [entry],
      });
      notify(messageId);
      options.onPending?.();
    },
    /** Pending deltas at dispatch time; pass to `applyUpdate`. */
    capture(): readonly LiveMessageSnapshot[] {
      return entries.size ? [...entries.values()] : noSnapshots;
    },
    hasEntries(): boolean {
      return entries.size > 0;
    },
    subscribe(messageId: string, listener: Listener): () => void {
      let set = listeners.get(messageId);
      if (!set) {
        set = new Set();
        listeners.set(messageId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size && listeners.get(messageId) === set) listeners.delete(messageId);
      };
    },
    getSnapshot(messageId: string): LiveMessageSnapshot | undefined {
      return entries.get(messageId);
    },
    /** The message as it should be displayed now; stable identity per input. */
    resolve(message: Message, snapshot = entries.get(message.id)): Message {
      if (!snapshot) return message;
      const cached = resolved.get(message);
      if (cached?.snapshot === snapshot) return cached.message;
      const count = containedCount(message, snapshot);
      const display = count < snapshot.deltas.length
        ? foldLiveDeltas(message, snapshot.deltas.slice(count))
        : message;
      resolved.set(message, { snapshot, message: display });
      return display;
    },
    /** Conversations with every pending delta applied, without changing state. */
    resolveConversations(conversations: Conversation[]): Conversation[] {
      if (!entries.size) return conversations;
      if (resolvedConversations?.input === conversations && resolvedConversations.version === version) {
        return resolvedConversations.output;
      }
      const output = fold(conversations, [...entries.values()]);
      resolvedConversations = { input: conversations, version, output };
      return output;
    },
    /**
     * Runs a conversations update after absorbing the deltas captured when it
     * was dispatched. New message objects a functional update derives from
     * absorbed messages contain the same deltas, so they inherit the tag.
     */
    applyUpdate(
      current: Conversation[],
      update: ConversationsUpdate,
      captured: readonly LiveMessageSnapshot[],
    ): Conversation[] {
      if (typeof update !== "function") return update;
      if (!captured.length) return update(current);
      const flushed = fold(current, captured);
      const next = update(flushed);
      if (next === flushed) return next;
      for (const snapshot of captured) {
        const before = findMessage(flushed, snapshot);
        const after = findMessage(next, snapshot);
        if (!before || !after || after === before || absorbed.has(after)) continue;
        const tag = absorbed.get(before);
        if (tag !== undefined) absorbed.set(after, tag);
      }
      return next;
    },
    /** Drops deltas fully contained in committed state, and orphaned entries. */
    prune(conversations: readonly Conversation[]): void {
      for (const snapshot of [...entries.values()]) {
        const message = findMessage(conversations, snapshot);
        if (message && containedCount(message, snapshot) < snapshot.deltas.length) continue;
        entries.delete(snapshot.messageId);
        version += 1;
        notify(snapshot.messageId);
      }
    },
  };
}

export const LiveMessageStoreContext = createContext<LiveMessageStore | null>(null);

const noSubscription = (): (() => void) => () => undefined;

/** The committed message plus any streaming deltas not yet in App state. */
export function useLiveMessage(message: Message): Message {
  const store = useContext(LiveMessageStoreContext);
  const messageId = message.id;
  const subscribe = useCallback(
    (listener: Listener) => (store ? store.subscribe(messageId, listener) : noSubscription()),
    [messageId, store],
  );
  const getSnapshot = useCallback(
    () => store?.getSnapshot(messageId),
    [messageId, store],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  return store && snapshot ? store.resolve(message, snapshot) : message;
}
