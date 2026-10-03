import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssistantArtifact, AssistantTask } from "../../shared/assistant-contracts";
import {
  useArtifactById,
  useConversationHasBusyTask,
  useProductTasks,
  useSidebarArtifacts,
  useTaskActivityRows,
  useTaskStatsRevision,
  useTaskStatusRows,
} from "./task-selectors";
import { createTaskStore, mergeArtifacts } from "./task-store";

function task(overrides: Partial<AssistantTask> = {}): AssistantTask {
  return {
    id: "t1",
    conversationId: "c1",
    title: "Task",
    instructions: "",
    origin: "user",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as AssistantTask;
}

function artifact(overrides: Partial<AssistantArtifact> = {}): AssistantArtifact {
  return {
    id: "a1",
    projectId: "p1",
    kind: "markdown",
    title: "Result",
    mimeType: "text/markdown",
    byteSize: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("task store", () => {
  it("applies task updates synchronously and in order, notifying only on change", () => {
    const store = createTaskStore();
    const listener = vi.fn();
    store.subscribeTasks(listener);
    store.setTasks([task()]);
    store.setTasks((current) => current.map((item) => ({ ...item, status: "completed" })));
    expect(store.getTasks()[0]!.status).toBe("completed");
    expect(listener).toHaveBeenCalledTimes(2);
    store.setTasks((current) => current);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps artifact identity when a refresh returns equal artifacts", () => {
    const store = createTaskStore();
    const listener = vi.fn();
    store.subscribeArtifacts(listener);
    store.mergeArtifacts([artifact({ content: "body" })]);
    const before = store.getArtifacts();
    const map = store.getArtifactById();
    // artifacts.list() returns metadata without content; the merge keeps it.
    store.mergeArtifacts([artifact()]);
    expect(store.getArtifacts()).toBe(before);
    expect(store.getArtifactById()).toBe(map);
    expect(listener).toHaveBeenCalledTimes(1);
    store.mergeArtifacts([artifact({ id: "a2", createdAt: "2026-02-01T00:00:00.000Z" })]);
    expect(store.getArtifacts().map((item) => item.id)).toEqual(["a2", "a1"]);
    expect(store.getArtifacts()[1]).toBe(before[0]);
    expect(store.getArtifactById()).not.toBe(map);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("merges artifacts newest first and keeps loaded content", () => {
    const merged = mergeArtifacts(
      [artifact({ content: "kept" })],
      [artifact({ title: "Renamed" }), artifact({ id: "a0", createdAt: "2025-01-01T00:00:00.000Z" })],
    );
    expect(merged.map((item) => [item.id, item.title, item.content])).toEqual([
      ["a1", "Renamed", "kept"],
      ["a0", "Result", undefined],
    ]);
  });

  it("clears tasks and artifacts", () => {
    const store = createTaskStore({ tasks: [task()], artifacts: [artifact()] });
    store.clear();
    expect(store.getTasks()).toEqual([]);
    expect(store.getArtifacts()).toEqual([]);
  });
});

describe("task selectors", () => {
  it("do not re-render on subagent progress", () => {
    const store = createTaskStore({
      tasks: [task(), task({ id: "s1", origin: "schedule", conversationId: "c2", status: "completed" })],
    });
    const renders = vi.fn();
    const { result } = renderHook(() => {
      renders();
      return {
        product: useProductTasks(store),
        status: useTaskStatusRows(store),
        activity: useTaskActivityRows(store),
        busy: useConversationHasBusyTask(store, "c1"),
        revision: useTaskStatsRevision(store, false),
      };
    });
    const first = result.current;
    expect(first.product.map((item) => item.id)).toEqual(["s1"]);
    expect(first.busy).toBe(true);
    // A subagent of t1 starts, then reports progress without a status change.
    act(() => store.setTasks((current) => [...current, task({ id: "child", parentTaskId: "t1", status: "running" })]));
    renders.mockClear();
    act(() => store.setTasks((current) => current.map((item) =>
      item.id === "child" ? { ...item, startedAt: "2026-01-01T00:00:01.000Z" } : item)));
    expect(renders).not.toHaveBeenCalled();
    expect(result.current.product).toBe(first.product);
    expect(result.current.status).toBe(first.status);
  });

  it("re-render when a conversation task finishes", () => {
    const store = createTaskStore({ tasks: [task()] });
    const { result } = renderHook(() => ({
      busy: useConversationHasBusyTask(store, "c1"),
      status: useTaskStatusRows(store),
      revision: useTaskStatsRevision(store, true),
    }));
    const revision = result.current.revision;
    act(() => store.setTasks((current) => current.map((item) => ({ ...item, status: "completed" }))));
    expect(result.current.busy).toBe(false);
    expect(result.current.status[0]!.status).toBe("completed");
    expect(result.current.revision).not.toBe(revision);
  });

  it("keep the artifact map and sidebar entries while artifacts are unchanged", () => {
    const store = createTaskStore({ artifacts: [artifact({ content: "x" }), artifact({ id: "b", projectId: "p2" })] });
    const { result } = renderHook(() => ({
      byId: useArtifactById(store),
      sidebar: useSidebarArtifacts(store, "p1"),
    }));
    const first = result.current;
    expect(first.sidebar.map((item) => item.id)).toEqual(["a1"]);
    act(() => store.mergeArtifacts([artifact()]));
    expect(result.current.byId).toBe(first.byId);
    act(() => store.mergeArtifacts([artifact({ id: "b", projectId: "p2", title: "Other project" })]));
    expect(result.current.byId).not.toBe(first.byId);
    expect(result.current.sidebar).toBe(first.sidebar);
  });
});
