import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantArtifact,
  AssistantTask,
  ListCursor,
} from "../../shared/assistant-contracts";
import { createTaskStore } from "./task-store";
import { loadOlderArtifacts, loadOlderTasks, refreshTasks } from "./task-sync";

function task(index: number): AssistantTask {
  return {
    id: `t${String(index).padStart(3, "0")}`,
    title: `Task ${index}`,
    instructions: "",
    origin: "user",
    status: "completed",
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
  };
}

function artifact(index: number): AssistantArtifact {
  return {
    id: `a${String(index).padStart(3, "0")}`,
    kind: "markdown",
    title: `Artifact ${index}`,
    mimeType: "text/markdown",
    byteSize: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
  };
}

/** Newest-first keyset pages over `rows`, like Main's listTaskPage. */
function pager<T extends { id: string; createdAt: string }>(rows: T[], size: number) {
  const sorted = [...rows].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return (before?: ListCursor): { items: T[]; nextCursor?: ListCursor } => {
    const start = before
      ? sorted.findIndex((row) =>
        row.createdAt < before.createdAt || (row.createdAt === before.createdAt && row.id < before.id))
      : 0;
    const items = start < 0 ? [] : sorted.slice(start, start + size);
    const last = items.at(-1);
    return start >= 0 && start + size < sorted.length && last
      ? { items, nextCursor: { createdAt: last.createdAt, id: last.id } }
      : { items };
  };
}

function installApi(tasks: AssistantTask[], artifacts: AssistantArtifact[], size = 100) {
  const taskPages = pager(tasks, size);
  const artifactPages = pager(artifacts, size);
  const api = {
    tasks: {
      list: vi.fn(async () => taskPages().items),
      listPage: vi.fn(async (input: { before?: ListCursor } = {}) => {
        const page = taskPages(input.before);
        return { tasks: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      }),
    },
    artifacts: {
      list: vi.fn(async () => artifactPages().items),
      listPage: vi.fn(async (input: { before?: ListCursor } = {}) => {
        const page = artifactPages(input.before);
        return { artifacts: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      }),
    },
  };
  vi.stubGlobal("window", { goodbuddy: api });
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("task history paging", () => {
  it("loads older task pages until every task is reachable and keeps them across refreshes", async () => {
    const all = Array.from({ length: 250 }, (_, index) => task(index));
    const api = installApi(all, []);
    const store = createTaskStore();
    await refreshTasks(store);
    expect(store.getTasks()).toHaveLength(100);

    // The first call re-reads the newest page for its cursor, then continues.
    await expect(loadOlderTasks(store)).resolves.toBe(true);
    expect(store.getTasks()).toHaveLength(200);
    await expect(loadOlderTasks(store)).resolves.toBe(false);
    expect(new Set(store.getTasks().map((item) => item.id))).toEqual(new Set(all.map((item) => item.id)));
    await expect(loadOlderTasks(store)).resolves.toBe(false);
    expect(api.tasks.listPage).toHaveBeenCalledTimes(3);

    // A poll returns only the recent window; older pages stay loaded and
    // updated rows from the poll win.
    const updated = { ...all[249]!, status: "failed" as const };
    api.tasks.list.mockResolvedValueOnce([updated, ...all.slice(150, 249).reverse()]);
    await refreshTasks(store);
    expect(store.getTasks()).toHaveLength(250);
    expect(store.getTasks().find((item) => item.id === updated.id)?.status).toBe("failed");
    expect(store.getTasks().filter((item) => item.id === updated.id)).toHaveLength(1);

    // Functional removal forgets the task; an empty refresh resets history.
    store.setTasks((current) => current.filter((item) => item.id !== all[0]!.id));
    await refreshTasks(store);
    expect(store.getTasks().some((item) => item.id === all[0]!.id)).toBe(false);
    expect(store.getTasks()).toHaveLength(249);
    store.setTasks([]);
    expect(store.getTaskHistory().exhausted).toBe(false);
    expect(store.getTaskHistory().cursor).toBeUndefined();
  });

  it("keeps tasks pushed out of the recent window after history was exhausted", async () => {
    const all = Array.from({ length: 50 }, (_, index) => task(index));
    const api = installApi(all, []);
    const store = createTaskStore();
    await refreshTasks(store);
    await expect(loadOlderTasks(store)).resolves.toBe(false);
    // 100 newer tasks arrive; the poll's window no longer includes the old 50.
    const newer = Array.from({ length: 100 }, (_, index) => task(500 + index)).reverse();
    api.tasks.list.mockResolvedValueOnce(newer);
    await refreshTasks(store);
    expect(store.getTasks()).toHaveLength(150);
  });

  it("ignores an older page that arrives after the list was cleared", async () => {
    installApi(Array.from({ length: 150 }, (_, index) => task(index)), []);
    const store = createTaskStore();
    await refreshTasks(store);
    const { generation } = store.getTaskHistory();
    store.clear();
    store.mergeOlderTasks([task(999)], undefined, generation);
    expect(store.getTasks()).toEqual([]);
  });

  it("loads older artifact pages and merges them", async () => {
    const all = Array.from({ length: 230 }, (_, index) => artifact(index));
    installApi([], all);
    const store = createTaskStore();
    store.mergeArtifacts(await window.goodbuddy.artifacts.list());
    expect(store.getArtifacts()).toHaveLength(100);
    await expect(loadOlderArtifacts(store)).resolves.toBe(true);
    await expect(loadOlderArtifacts(store)).resolves.toBe(false);
    expect(store.getArtifacts()).toHaveLength(230);
    // A refresh merges and keeps the older artifacts.
    store.mergeArtifacts(await window.goodbuddy.artifacts.list());
    expect(store.getArtifacts()).toHaveLength(230);
  });
});
