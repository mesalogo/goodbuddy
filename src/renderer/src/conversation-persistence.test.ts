import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationListSnapshot, LocalConversationSaveBatch } from "../../shared/assistant-contracts";
import type { Message } from "./ChatTimeline";
import type { Conversation } from "./chat-conversation";
import { createConversationPersistence, createLocalConversationSaveBatch, LOCAL_CONVERSATION_SAVE_BYTES } from "./conversation-persistence";
import { storageDataBytes } from "../../shared/storage-data-size";
import { startConversationRefresh, type ConversationRefreshApi } from "./conversation-refresh";
import { createConversationStore } from "./conversation-store";
import { createLiveMessageStore } from "./live-message-store";

function message(id: string, overrides: Partial<Message> = {}): Message {
  return { id, role: "assistant", content: id, createdAt: 1, state: "complete", ...overrides } as Message;
}

function conversation(id: string, messages: Message[] = [message(`${id}-m`)], overrides: Partial<Conversation> = {}): Conversation {
  return { id, title: id, updatedAt: 1, messages, ...overrides } as Conversation;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const remoteSource = { channel: "wecom", accountDisplay: "bot", conversationType: "direct" } as const;

type SaveLocal = (batch: LocalConversationSaveBatch) => Promise<unknown>;

function setup(initial: Conversation[], saveLocal = vi.fn<SaveLocal>(async () => undefined)) {
  const store = createConversationStore(initial, createLiveMessageStore());
  const get = vi.fn(async (id: string) => ({ ...conversation(id), updatedAt: 2 }) as ConversationListSnapshot);
  const persistence = createConversationPersistence({ store, api: { saveLocal, get }, intervalMs: 500 });
  return { store, persistence, saveLocal, get };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("conversation persistence", () => {
  it("batches by bytes, keeps a single large history complete, and drains every batch on quit", async () => {
    const histories = Array.from({ length: 5 }, (_, index) => conversation(`large-${index}`, [
      message(`message-${index}`, { content: "x".repeat(2 * 1024 * 1024) }),
    ]));
    const first = createLocalConversationSaveBatch(histories, new Map(), new Set());
    expect(first.batch).toHaveLength(1);
    expect(storageDataBytes(first.batch, Infinity)).toBeLessThan(LOCAL_CONVERSATION_SAVE_BYTES);
    const huge = conversation("huge", [message("huge-message", { content: "y".repeat(20 * 1024 * 1024) })]);
    const oversized = createLocalConversationSaveBatch([huge], new Map(), new Set());
    expect(oversized.batch[0]!.messages[0]!.content).toBe(huge.messages[0]!.content);
    expect(oversized.acknowledgements).toEqual([huge]);
    const { persistence, saveLocal } = setup([...histories, huge]);
    const stop = persistence.start();
    await persistence.flushForQuit();
    expect(saveLocal.mock.calls.flatMap(([batch]) => batch.map(row => row.header.id))).toEqual([...histories, huge].map(row => row.id));
    expect(saveLocal).toHaveBeenCalledTimes(6);
    stop();
  });

  it("does not turn a failed final byte-bounded batch into a successful quit flush", async () => {
    const { persistence } = setup([conversation("failure")], vi.fn(async () => { throw new Error("disk full"); }));
    const stop = persistence.start();
    await expect(persistence.flushForQuit()).rejects.toThrow("disk full");
    expect(persistence.acknowledged().size).toBe(0);
    stop();
  });

  it("saves only changed local conversations and only their changed messages", async () => {
    const remote = conversation("r", undefined, { remote: remoteSource });
    const { store, persistence, saveLocal } = setup([conversation("a"), conversation("b"), remote]);
    persistence.persist();
    await persistence.idle();
    expect(saveLocal).toHaveBeenCalledTimes(1);
    expect(saveLocal.mock.calls[0]![0].map((entry) => entry.header.id)).toEqual(["a", "b"]);

    store.set((current) => current.map((item) => item.id === "a"
      ? { ...item, updatedAt: 2, messages: [...item.messages, message("a-new")] }
      : item));
    persistence.persist();
    await persistence.idle();
    expect(saveLocal).toHaveBeenCalledTimes(2);
    const [entry] = saveLocal.mock.calls[1]![0];
    expect(entry!.header.id).toBe("a");
    expect(entry!.messages.map((item) => item.id)).toEqual(["a-new"]);

    persistence.persist();
    await persistence.idle();
    expect(saveLocal).toHaveBeenCalledTimes(2);
  });

  it("serializes saves with queued tasks and skips paused or deleting conversations", async () => {
    const gate = deferred();
    const order: string[] = [];
    const saveLocal = vi.fn<SaveLocal>(async (batch) => {
      order.push(`save:${batch.map((entry) => entry.header.id).join(",")}`);
      await gate.promise;
    });
    const { store, persistence } = setup([conversation("a"), conversation("b")], saveLocal);
    persistence.markDeleting("b", true);
    persistence.persist();
    const queued = persistence.enqueue(async () => { order.push("task"); });
    await vi.waitFor(() => expect(order).toEqual(["save:a"]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The task waits for the pending save.
    expect(order).toEqual(["save:a"]);
    gate.resolve();
    await queued;
    expect(order).toEqual(["save:a", "task"]);

    persistence.setPaused(true);
    store.set((current) => current.map((item) => ({ ...item, updatedAt: 3 })));
    persistence.persist();
    await persistence.idle();
    expect(saveLocal).toHaveBeenCalledTimes(1);
  });

  it("saves on the interval, after a requested commit flush and once more on quit", async () => {
    vi.useFakeTimers();
    const { store, persistence, saveLocal } = setup([conversation("a")]);
    persistence.flushAfterCommit();
    persistence.requestFlushAfterCommit();
    persistence.flushAfterCommit();
    await vi.advanceTimersByTimeAsync(0);
    // Not started yet: a commit flush waits for the store to be ready.
    expect(saveLocal).not.toHaveBeenCalled();

    const stop = persistence.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveLocal).toHaveBeenCalledTimes(1);

    store.set((current) => current.map((item) => ({ ...item, updatedAt: 2 })));
    await vi.advanceTimersByTimeAsync(500);
    expect(saveLocal).toHaveBeenCalledTimes(2);

    store.set((current) => current.map((item) => ({ ...item, updatedAt: 3 })));
    persistence.requestFlushAfterCommit();
    persistence.flushAfterCommit();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveLocal).toHaveBeenCalledTimes(3);

    store.set((current) => current.map((item) => ({ ...item, updatedAt: 4 })));
    await persistence.flushForQuit();
    expect(saveLocal).toHaveBeenCalledTimes(4);
    expect(saveLocal.mock.calls[3]![0][0]!.header.updatedAt).toBe(4);
    stop();
  });

  it("releases acknowledged idle history that is not retained", async () => {
    const { store, persistence } = setup([conversation("a"), conversation("b"), conversation("c", [message("c-m", { state: "streaming" })])]);
    persistence.connect({
      retainedConversationIds: () => new Set(["a"]),
      hasBusyTask: () => false,
      pinState: () => ({ revision: 0, pending: false }),
      historyUnavailableError: () => new Error("unavailable"),
      onSaveFailed: () => undefined,
    });
    persistence.persist();
    await persistence.idle();
    const byId = new Map(store.getState().map((item) => [item.id, item]));
    expect(byId.get("a")!.messageSummary).toBeUndefined();
    expect(byId.get("b")!.messageSummary).toEqual({ count: 1, firstRole: "assistant" });
    expect(byId.get("b")!.messages).toEqual([]);
    expect(byId.get("c")!.messageSummary).toBeUndefined();
  });

  it("loads summarized history once and merges it into the store", async () => {
    const summary = { ...conversation("a", []), messageSummary: { count: 1 } } as Conversation;
    const { store, persistence, get } = setup([summary]);
    const [first, second] = await Promise.all([persistence.ensureHistory("a"), persistence.ensureHistory("a")]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(store.getConversation("a")!.messageSummary).toBeUndefined();
    expect(store.getConversation("a")!.messages.map((item) => item.id)).toEqual(["a-m"]);
    expect(await persistence.ensureHistory("a")).toBe(store.getConversation("a"));
  });

  it("reports a failed save", async () => {
    const onSaveFailed = vi.fn();
    const { persistence } = setup([conversation("a")], vi.fn(async () => { throw new Error("disk"); }));
    persistence.connect({
      retainedConversationIds: () => new Set(),
      hasBusyTask: () => false,
      pinState: () => ({ revision: 0, pending: false }),
      historyUnavailableError: () => new Error("unavailable"),
      onSaveFailed,
    });
    persistence.persist();
    await persistence.idle();
    await Promise.resolve();
    expect(onSaveFailed).toHaveBeenCalledTimes(1);
  });
});

describe("conversation refresh", () => {
  function refreshApi(summaries: () => ConversationListSnapshot[]) {
    let changed: (() => void) | undefined;
    const api: ConversationRefreshApi = {
      listTasks: vi.fn(async () => []),
      listSchedules: vi.fn(async () => []),
      listSummaries: vi.fn(async () => summaries()),
      onConversationsChanged: vi.fn((listener) => { changed = listener; return () => { changed = undefined; }; }),
      onQueueChanged: vi.fn(() => () => undefined),
    };
    return { api, emit: () => changed?.() };
  }

  it("merges summaries on change notifications, marks remote updates unread and settles finished runs", async () => {
    const { store, persistence } = setup([
      conversation("local", [message("l1", { state: "streaming" })], { updatedAt: 1 }),
      conversation("remote", undefined, { updatedAt: 1, remote: remoteSource }),
    ]);
    let persisted: ConversationListSnapshot[] = [];
    const { api, emit } = refreshApi(() => persisted);
    const activeRuns = new Map([["req", { conversationId: "local", messageId: "l1" }]]);
    const onUnread = vi.fn();
    const onRunSettled = vi.fn();
    const onTasks = vi.fn();
    const stop = startConversationRefresh({
      store, persistence, api, activeRuns,
      activeConversationId: () => "local",
      retainedConversationIds: () => new Set(["local"]),
      pinState: () => ({ revision: 0, pending: false }),
      onTasks, onSchedules: vi.fn(), onUnread, onRunSettled, onError: vi.fn(), delayMs: 0,
    });
    persisted = [
      { id: "local", title: "Local", updatedAt: 1, messages: [message("l1", { content: "done", state: "complete" })] },
      { id: "remote", title: "Remote", updatedAt: 5, remote: remoteSource, messages: [message("r1")] },
      { id: "new", title: "New", updatedAt: 3, messages: [message("n1")] },
    ] as ConversationListSnapshot[];
    emit();
    emit();
    await vi.waitFor(() => expect(onRunSettled).toHaveBeenCalled());
    expect(api.listSummaries).toHaveBeenCalledTimes(1);
    expect(api.listSummaries).toHaveBeenCalledWith(["local"]);
    expect(onTasks).toHaveBeenCalledWith([]);
    expect(onUnread.mock.calls[0]![0].map((item: ConversationListSnapshot) => item.id)).toEqual(["remote"]);
    expect(onRunSettled).toHaveBeenCalledWith("req", { conversationId: "local", messageId: "l1" }, "complete");
    expect(activeRuns.size).toBe(0);
    const byId = new Map(store.getState().map((item) => [item.id, item]));
    expect(byId.get("local")!.messages[0]!.content).toBe("done");
    expect(byId.get("remote")!.title).toBe("Remote");
    expect(byId.get("new")!.title).toBe("New");
    // The persisted copy is acknowledged, so it is not saved back.
    expect(persistence.acknowledged().get("local")).toBe(persisted[0]);
    stop();
    expect(api.onConversationsChanged).toHaveBeenCalledTimes(1);
  });

  it("drops a reply when a pin edit changed meanwhile and refreshes again", async () => {
    const { store, persistence } = setup([conversation("a")]);
    const reply = deferred<ConversationListSnapshot[]>();
    const { api, emit } = refreshApi(() => []);
    vi.mocked(api.listSummaries).mockReturnValueOnce(reply.promise);
    let revision = 0;
    const stop = startConversationRefresh({
      store, persistence, api, activeRuns: new Map(),
      activeConversationId: () => "a",
      retainedConversationIds: () => new Set(),
      pinState: () => ({ revision, pending: false }),
      onTasks: vi.fn(), onSchedules: vi.fn(), onUnread: vi.fn(), onRunSettled: vi.fn(), onError: vi.fn(), delayMs: 0,
    });
    emit();
    await vi.waitFor(() => expect(api.listSummaries).toHaveBeenCalledTimes(1));
    revision = 1;
    reply.resolve([{ id: "a", title: "Stale", updatedAt: 9, messages: [] } as ConversationListSnapshot]);
    await vi.waitFor(() => expect(api.listSummaries).toHaveBeenCalledTimes(2));
    expect(store.getConversation("a")!.title).toBe("a");
    stop();
  });
});
