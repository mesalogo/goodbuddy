import { describe, expect, it, vi } from "vitest";
import type { Message } from "./ChatTimeline";
import type { Conversation } from "./chat-conversation";
import { createLiveMessageStore, foldLiveDeltas, type ConversationsUpdate } from "./live-message-store";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    createdAt: 1,
    state: "streaming",
    blocks: [],
    ...overrides,
  } as Message;
}

function conversation(messages: Message[]): Conversation {
  return { id: "c1", title: "t", updatedAt: 1, messages } as unknown as Conversation;
}

function harness() {
  let id = 0;
  const store = createLiveMessageStore({ createId: () => `b${++id}` });
  let state = [conversation([message()])];
  const setConversations = (update: ConversationsUpdate): void => {
    const captured = store.capture();
    state = store.applyUpdate(state, update, captured);
    store.prune(state);
  };
  const committed = (): Message => state[0]!.messages[0]!;
  const displayed = (): Message => store.resolve(committed());
  const append = (kind: "text" | "reasoning", delta: string): void =>
    store.append("c1", "m1", kind, delta, committed());
  return { store, setConversations, committed, displayed, append, get state() { return state; } };
}

describe("live message store", () => {
  it("folds deltas exactly like the former per-event updates", () => {
    let id = 0;
    const createId = () => `b${++id}`;
    const deltas = [
      { kind: "reasoning" as const, delta: "think ", blockId: createId() },
      { kind: "reasoning" as const, delta: "more", blockId: createId() },
      { kind: "text" as const, delta: "Hello", blockId: createId() },
      { kind: "text" as const, delta: " world", blockId: createId() },
    ];
    const folded = foldLiveDeltas(message({ status: "thinking" } as Partial<Message>), deltas);
    expect(folded.content).toBe("Hello world");
    expect(folded.reasoning).toBe("think more");
    expect(folded.status).toBeUndefined();
    expect(folded.blocks).toEqual([
      { id: "b1", type: "reasoning", content: "think more" },
      { id: "b3", type: "text", content: "Hello world" },
    ]);
  });

  it("shows deltas before App state absorbs them, then drops the buffer", () => {
    const h = harness();
    const listener = vi.fn();
    h.store.subscribe("m1", listener);
    h.append("text", "Hel");
    h.append("text", "lo");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(h.committed().content).toBe("");
    expect(h.displayed().content).toBe("Hello");
    expect(h.displayed()).toBe(h.displayed());

    h.setConversations((current) => current);
    expect(h.committed().content).toBe("Hello");
    expect(h.store.hasEntries()).toBe(false);
    expect(h.displayed()).toBe(h.committed());
  });

  it("keeps text and tool blocks in arrival order when another update intervenes", () => {
    const h = harness();
    h.append("text", "Before tool. ");
    h.setConversations((current) => current.map((item) => ({
      ...item,
      messages: item.messages.map((entry) => ({
        ...entry,
        blocks: [...(entry.blocks ?? []), { id: "tool", type: "tool", tool: { name: "x" } }],
      } as Message)),
    })));
    h.append("text", "After tool.");
    expect(h.displayed().content).toBe("Before tool. After tool.");
    expect(h.displayed().blocks?.map((block) => block.type)).toEqual(["text", "tool", "text"]);
    h.setConversations((current) => current);
    expect(h.committed().blocks?.map((block) => block.type)).toEqual(["text", "tool", "text"]);
    expect(h.committed().content).toBe("Before tool. After tool.");
  });

  it("absorbs only deltas captured when an update was dispatched", () => {
    const store = createLiveMessageStore({ createId: () => "b" });
    const base = [conversation([message()])];
    store.append("c1", "m1", "text", "one ", base[0]!.messages[0]);
    const captured = store.capture();
    store.append("c1", "m1", "text", "two", base[0]!.messages[0]);
    const next = store.applyUpdate(base, (current) => current, captured);
    expect(next[0]!.messages[0]!.content).toBe("one ");
    store.prune(next);
    expect(store.resolve(next[0]!.messages[0]!).content).toBe("one two");
  });

  it("does not repeat deltas already contained in a replacement snapshot", () => {
    const h = harness();
    h.append("text", "Persisted ");
    h.append("text", "and live");
    // Main persisted the first delta; the refetched snapshot replaces state.
    h.setConversations([conversation([message({ content: "Persisted ", blocks: [] })])]);
    expect(h.displayed().content).toBe("Persisted and live");
    h.setConversations([conversation([message({ content: "Persisted and live", blocks: [] })])]);
    expect(h.displayed().content).toBe("Persisted and live");
    expect(h.store.hasEntries()).toBe(false);
  });

  it("treats replaced content as containing every absorbed delta", () => {
    const h = harness();
    h.append("text", "partial");
    h.setConversations((current) => current.map((item) => ({
      ...item,
      messages: item.messages.map((entry) => ({ ...entry, content: "failed", state: "error" } as Message)),
    })));
    expect(h.committed().content).toBe("failed");
    expect(h.displayed().content).toBe("failed");
    expect(h.store.hasEntries()).toBe(false);
  });

  it("is idempotent when React replays an updater", () => {
    const store = createLiveMessageStore({ createId: () => "b" });
    const base = [conversation([message()])];
    store.append("c1", "m1", "text", "abc", base[0]!.messages[0]);
    const captured = store.capture();
    const update = (current: Conversation[]) => current;
    const first = store.applyUpdate(base, update, captured);
    const replay = store.applyUpdate(base, update, captured);
    expect(first[0]!.messages[0]!.content).toBe("abc");
    expect(replay[0]!.messages[0]!.content).toBe("abc");
  });

  it("never hides text when the first delta had no committed base", () => {
    const store = createLiveMessageStore({ createId: () => "b" });
    store.append("c1", "m1", "text", "hello");
    const committed = message({ content: "prefix that is long" });
    expect(store.resolve(committed).content).toBe("prefix that is longhello");
  });

  it("trims absorbed deltas while a reply keeps streaming", () => {
    const h = harness();
    for (let index = 0; index < 50; index += 1) {
      h.append("text", `${index},`);
      const captured = h.store.capture();
      h.append("text", "x");
      // An update dispatched before the newest delta absorbs only older ones.
      const next = h.store.applyUpdate(h.state, (current) => current, captured);
      h.setConversations(next);
      expect(h.store.getSnapshot("m1")?.deltas.length ?? 0).toBeLessThanOrEqual(1);
    }
    const expected = Array.from({ length: 50 }, (_, index) => `${index},x`).join("");
    expect(h.displayed().content).toBe(expected);
    h.setConversations((current) => current);
    expect(h.committed().content).toBe(expected);
    expect(h.store.hasEntries()).toBe(false);
  });

  it("drops entries for messages that no longer exist", () => {
    const h = harness();
    h.append("text", "gone");
    h.setConversations([]);
    expect(h.store.hasEntries()).toBe(false);
  });
});
