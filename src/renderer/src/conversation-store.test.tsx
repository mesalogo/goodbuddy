import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, useCallback, useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "./ChatTimeline";
import type { Conversation } from "./chat-conversation";
import {
  ConversationStoreEffects,
  createConversationStore,
  createConversationStores,
  useConversation,
  useConversationStoreSelector,
  type ConversationStore,
} from "./conversation-store";
import {
  sameActiveConversationView,
  selectPendingSidebarApprovals,
  useActiveConversationView,
  usePendingSidebarApprovals,
  useConversationsById,
} from "./conversation-selectors";
import { createLiveMessageStore } from "./live-message-store";

function message(overrides: Partial<Message> = {}): Message {
  return { id: "m1", role: "assistant", content: "", createdAt: 1, state: "streaming", blocks: [], ...overrides } as Message;
}

function conversation(id: string, messages: Message[] = [], overrides: Partial<Conversation> = {}): Conversation {
  return { id, title: id, updatedAt: 1, messages, ...overrides } as Conversation;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("conversation store", () => {
  it("tracks visits and status transitions in session memory without changing persisted snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const initial = [conversation("old", [], { projectId: "project", updatedAt: 10 })];
    const store = createConversationStore(initial, createLiveMessageStore());
    const persisted = vi.fn();
    const activity = vi.fn();
    store.subscribe(persisted);
    store.subscribeActivityTimes(activity);
    store.recordActivityStatuses([{ conversationId: "old", status: "running" }]);
    expect(store.getActivityTimes().size).toBe(0);
    store.rememberOpened("old");
    expect(store.getActivityTimes().get("old")).toBe(1000);
    const visited = store.getActivityTimes();
    store.recordActivityStatuses([{ conversationId: "old", status: "running" }]);
    expect(store.getActivityTimes()).toBe(visited);
    store.recordActivityStatuses([{ conversationId: "old", status: "completed" }]);
    expect(store.getActivityTimes().get("old")).toBe(1001);
    const completed = store.getActivityTimes();
    store.recordActivityStatuses([]);
    expect(store.getActivityTimes()).toBe(completed);
    expect(store.getState()).toBe(initial);
    expect(store.getConversation("old")?.updatedAt).toBe(10);
    expect(persisted).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(2);
    store.recordActivityStatuses([{ conversationId: "old", status: "running" }]);
    store.recordActivityStatuses([]);
    expect(store.getActivityTimes().get("old")).toBe(1003);
    expect(createConversationStore(initial, createLiveMessageStore()).getActivityTimes().size).toBe(0);
  });

  it("restores the last opened conversation per project and falls back after deletion", () => {
    const older = conversation("older", [], { projectId: "project", updatedAt: 10 });
    const recent = conversation("recent", [], { projectId: "project", updatedAt: 20 });
    const other = conversation("other", [], { projectId: "other", updatedAt: 30 });
    const store = createConversationStore([older, other, recent], createLiveMessageStore());
    expect(store.projectConversation("project", false)?.id).toBe("recent");
    store.rememberOpened("older");
    store.rememberOpened("other");
    expect(store.projectConversation("project", false)?.id).toBe("older");
    expect(store.projectConversation("other", false)?.id).toBe("other");
    expect(store.projectConversation("project", true)).toBeUndefined();
    store.set([recent, other]);
    expect(store.projectConversation("project", false)?.id).toBe("recent");
  });

  it("applies updates synchronously, in dispatch order", () => {
    const store = createConversationStore([conversation("a")], createLiveMessageStore());
    store.set((current) => [...current, conversation("b")]);
    expect(store.getState().map((item) => item.id)).toEqual(["a", "b"]);
    store.set((current) => current.map((item) => item.id === "a" ? { ...item, title: "A" } : item));
    expect(store.getConversation("a")?.title).toBe("A");
    store.set([conversation("c")]);
    expect(store.getState().map((item) => item.id)).toEqual(["c"]);
  });

  it("notifies list listeners on change and per-conversation listeners only for changed IDs", () => {
    const store = createConversationStore([conversation("a"), conversation("b")], createLiveMessageStore());
    const list = vi.fn();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(list);
    store.subscribeConversation("a", a);
    const unsubscribeB = store.subscribeConversation("b", b);
    store.set((current) => current);
    expect(list).not.toHaveBeenCalled();
    store.set((current) => current.map((item) => item.id === "a" ? { ...item, title: "A" } : item));
    expect(list).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    store.set((current) => current.filter((item) => item.id !== "b"));
    expect(b).toHaveBeenCalledTimes(1);
    unsubscribeB();
    store.set((current) => [...current, conversation("b")]);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("absorbs live deltas captured at dispatch in order with other blocks", () => {
    let id = 0;
    const live = createLiveMessageStore({ createId: () => `b${++id}` });
    const store = createConversationStore([conversation("c1", [message()])], live);
    const committed = (): Message => store.getState()[0]!.messages[0]!;
    live.append("c1", "m1", "text", "Before. ", committed());
    store.set((current) => current.map((item) => ({
      ...item,
      messages: item.messages.map((entry) => ({
        ...entry,
        blocks: [...(entry.blocks ?? []), { id: "tool", type: "tool", tool: { name: "x" } }],
      } as Message)),
    })));
    live.prune(store.getState());
    live.append("c1", "m1", "text", "After.", committed());
    expect(live.resolve(committed()).content).toBe("Before. After.");
    store.set((current) => current);
    expect(committed().content).toBe("Before. After.");
    expect(committed().blocks?.map((block) => block.type)).toEqual(["text", "tool", "text"]);
    live.prune(store.getState());
    expect(live.hasEntries()).toBe(false);
  });

  it("flushes pending deltas on the slow cadence and cancels the flush", () => {
    vi.useFakeTimers();
    const stores = createConversationStores([conversation("c1", [message()])], { flushIntervalMs: 250 });
    const committed = (): Message => stores.conversations.getState()[0]!.messages[0]!;
    stores.liveMessages.append("c1", "m1", "text", "Hi", committed());
    vi.advanceTimersByTime(249);
    expect(committed().content).toBe("");
    vi.advanceTimersByTime(1);
    expect(committed().content).toBe("Hi");
    stores.liveMessages.prune(stores.conversations.getState());
    stores.liveMessages.append("c1", "m1", "text", "!", committed());
    stores.cancelLiveMessageFlush();
    vi.advanceTimersByTime(1000);
    expect(committed().content).toBe("Hi");
  });
});

describe("conversation store hooks", () => {
  function setup(initial: Conversation[]) {
    return createConversationStore(initial, createLiveMessageStore());
  }

  it("re-renders a selector only when its selected value changes", () => {
    const store = setup([conversation("a"), conversation("b")]);
    const renders = vi.fn();
    function Count({ store }: { store: ConversationStore }) {
      const count = useConversationStoreSelector(store, useCallback((items: Conversation[]) => items.length, []));
      renders(count);
      return <span>{count}</span>;
    }
    const view = render(<Count store={store} />);
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => store.set((current) => current.map((item) => ({ ...item, title: "x" }))));
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => store.set((current) => [...current, conversation("c")]));
    expect(renders).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toBe("3");
  });

  it("keeps an equal selected value's identity", () => {
    const store = setup([conversation("a", [message({ approval: { id: "p1", title: "Run" } } as Partial<Message>)])]);
    const seen: unknown[] = [];
    function Approvals({ store }: { store: ConversationStore }) {
      seen.push(usePendingSidebarApprovals(store));
      return null;
    }
    const view = render(<Approvals store={store} />);
    act(() => store.set((current) => [...current, conversation("b")]));
    view.rerender(<Approvals store={store} />);
    expect(seen.length).toBe(2);
    expect(seen[1]).toBe(seen[0]);
    expect(selectPendingSidebarApprovals(store.getState())).toEqual(seen[0]);
  });

  it("re-renders useConversation only for its own conversation and follows ID changes", () => {
    const store = setup([conversation("a"), conversation("b")]);
    const renders = vi.fn();
    function Title({ id }: { id: string }) {
      const item = useConversation(store, id);
      renders(id);
      return <span>{item?.title ?? "none"}</span>;
    }
    const view = render(<Title id="a" />);
    act(() => store.set((current) => current.map((item) => item.id === "b" ? { ...item, title: "B" } : item)));
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => store.set((current) => current.map((item) => item.id === "a" ? { ...item, title: "A" } : item)));
    expect(view.container.textContent).toBe("A");
    view.rerender(<Title id="b" />);
    expect(view.container.textContent).toBe("B");
    act(() => store.set((current) => current.filter((item) => item.id !== "b")));
    expect(view.container.textContent).toBe("none");
  });

  it("catches updates made between render and subscription, also in Strict Mode", () => {
    const store = setup([conversation("a")]);
    function Ids() {
      const items = useConversationsById(store, ids);
      return <span>{items.map((item) => item.title).join(",")}</span>;
    }
    const ids = ["a", "b"];
    function UpdateOnMount() {
      // Earlier sibling: its layout effect runs before the selector subscribes.
      useLayoutEffect(() => {
        if (!store.getConversation("b")) store.set((current) => [...current, conversation("b")]);
      }, []);
      return null;
    }
    const view = render(<StrictMode><UpdateOnMount /><Ids /></StrictMode>);
    expect(view.container.textContent).toBe("a,b");
    act(() => store.set((current) => current.map((item) => ({ ...item, title: item.id.toUpperCase() }))));
    expect(view.container.textContent).toBe("A,B");
  });

  it("re-renders the active conversation view only for header or derived changes", () => {
    const store = setup([conversation("a", [message({ state: "complete", content: "x" })]), conversation("b")]);
    const seen: unknown[] = [];
    function Header() {
      const view = useActiveConversationView(store, "a");
      seen.push(view);
      return <span>{view?.title}:{String(view?.running)}</span>;
    }
    const view = render(<Header />);
    const editMessage = (content: string) => store.set((current) => current.map((item) => item.id === "a"
      ? { ...item, updatedAt: item.updatedAt + 1, messages: item.messages.map((entry) => ({ ...entry, content })) }
      : item));
    act(() => editMessage("streamed text"));
    act(() => store.set((current) => current.map((item) => item.id === "a"
      ? { ...item, runtimeSelection: item.runtimeSelection ? { ...item.runtimeSelection } : undefined }
      : item)));
    expect(seen).toHaveLength(1);
    act(() => store.set((current) => current.map((item) => item.id === "a" ? { ...item, title: "A" } : item)));
    expect(view.container.textContent).toBe("A:false");
    act(() => store.set((current) => current.map((item) => item.id === "a"
      ? { ...item, messages: [...item.messages, message({ id: "m2", state: "streaming" })] }
      : item)));
    expect(view.container.textContent).toBe("A:true");
    expect(seen).toHaveLength(3);
    expect(sameActiveConversationView(seen[1] as never, seen[2] as never)).toBe(false);
  });

  it("prunes absorbed deltas and runs the commit callback after list commits", () => {
    const live = createLiveMessageStore({ createId: () => "b" });
    const store = createConversationStore([conversation("c1", [message()])], live);
    const onCommit = vi.fn();
    render(<ConversationStoreEffects liveMessages={live} onCommit={onCommit} store={store} />);
    expect(onCommit).toHaveBeenCalledTimes(1);
    live.append("c1", "m1", "text", "abc", store.getState()[0]!.messages[0]);
    act(() => store.set((current) => current));
    expect(store.getState()[0]!.messages[0]!.content).toBe("abc");
    expect(live.hasEntries()).toBe(false);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});
