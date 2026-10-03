import { useCallback, useRef, useSyncExternalStore } from "react";
import type { AssistantArtifact, AssistantTask } from "../../shared/assistant-contracts";
import type { SidebarArtifact } from "./RightAssistantSidebar";
import type { TaskStore } from "./task-store";

/**
 * Narrow views of the task store. Each returns a value that keeps its
 * identity while what it selects is equal, so a subagent progress event or a
 * status change of an unrelated task does not re-render the component.
 */
function useSelection<S, T>(
  subscribe: (listener: () => void) => () => void,
  getSource: () => S,
  select: (source: S) => T,
  isEqual: (left: T, right: T) => boolean,
): T {
  const cache = useRef<{ source: S; select: (source: S) => T; value: T } | undefined>(undefined);
  const getSnapshot = useCallback((): T => {
    const source = getSource();
    const cached = cache.current;
    if (cached && cached.source === source && cached.select === select) return cached.value;
    const next = select(source);
    const value = cached && isEqual(cached.value, next) ? cached.value : next;
    cache.current = { source, select, value };
    return value;
  }, [getSource, isEqual, select]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameRows<T extends object>(keys: readonly (keyof T)[]) {
  return (left: readonly T[], right: readonly T[]): boolean =>
    left.length === right.length &&
    left.every((item, index) => keys.every((key) => item[key] === right[index]![key]));
}

export function useTaskSelector<T>(
  store: TaskStore,
  select: (tasks: AssistantTask[]) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  return useSelection(store.subscribeTasks, store.getTasks, select, isEqual);
}

/**
 * Every task. With `paused` it keeps returning the list it had, for views
 * kept alive while hidden; they catch up when shown again.
 */
export function useAllTasks(store: TaskStore, paused = false): AssistantTask[] {
  const last = useRef<AssistantTask[] | undefined>(undefined);
  const select = useCallback(
    (tasks: AssistantTask[]): AssistantTask[] =>
      paused && last.current ? last.current : (last.current = tasks),
    [paused],
  );
  return useTaskSelector(store, select);
}

const selectProductTasks = (tasks: AssistantTask[]): AssistantTask[] =>
  tasks.filter((task) => !task.parentTaskId && task.origin === "schedule");

/** Top-level scheduled tasks (sidebar, conversation task strips). */
export function useProductTasks(store: TaskStore): AssistantTask[] {
  return useTaskSelector(store, selectProductTasks, sameItems);
}

export type TaskStatusRow = Pick<AssistantTask, "id" | "conversationId" | "parentTaskId" | "status">;
// Unviewed completions ignore subagent tasks and tasks without a conversation.
const selectStatusRows = (tasks: AssistantTask[]): TaskStatusRow[] =>
  tasks.flatMap(({ id, conversationId, parentTaskId, status }) =>
    conversationId && !parentTaskId ? [{ id, conversationId, parentTaskId, status }] : []);

/** Top-level conversation tasks and their statuses; subagent progress leaves it unchanged. */
export function useTaskStatusRows(store: TaskStore): TaskStatusRow[] {
  return useTaskSelector(
    store,
    selectStatusRows,
    sameRows<TaskStatusRow>(["id", "conversationId", "parentTaskId", "status"]),
  );
}

export type TaskActivityRow = {
  conversationId: string;
  projectId?: string;
  title: string;
  /** The conversation activity summary only tells these apart. */
  status: "running" | "waiting_approval" | "other";
};
const selectActivityRows = (tasks: AssistantTask[]): TaskActivityRow[] =>
  tasks.flatMap(({ conversationId, projectId, title, status }) =>
    conversationId
      ? [{
          conversationId,
          projectId,
          title,
          status: status === "running" || status === "waiting_approval" ? status : "other",
        }]
      : []);

/** What the conversation activity summary reads from tasks. */
export function useTaskActivityRows(store: TaskStore): TaskActivityRow[] {
  return useTaskSelector(
    store,
    selectActivityRows,
    sameRows<TaskActivityRow>(["conversationId", "projectId", "title", "status"]),
  );
}

const selectStatsRevision = (tasks: AssistantTask[]): string =>
  tasks.map((task) => `${task.id}:${task.status}:${task.completedAt ?? ""}`).join("|");
const selectNoRevision = (): string => "";

/**
 * Changes whenever a task starts, finishes or changes status; constant while
 * `enabled` is false, so nothing re-renders for statistics nobody sees.
 */
export function useTaskStatsRevision(store: TaskStore, enabled: boolean): string {
  return useTaskSelector(store, enabled ? selectStatsRevision : selectNoRevision);
}
/** Whether a task of this conversation is running or waiting for approval. */
export function useConversationHasBusyTask(store: TaskStore, conversationId: string): boolean {
  const select = useCallback(
    (tasks: AssistantTask[]): boolean =>
      tasks.some((task) =>
        task.conversationId === conversationId &&
        (task.status === "running" || task.status === "waiting_approval")),
    [conversationId],
  );
  return useTaskSelector(store, select);
}

/** The artifacts by ID; the same map while artifacts are unchanged. */
export function useArtifactById(store: TaskStore): ReadonlyMap<string, AssistantArtifact> {
  return useSyncExternalStore(store.subscribeArtifacts, store.getArtifactById);
}

const sameSidebarArtifacts = sameRows<SidebarArtifact>(["id", "title", "content", "createdAt", "mimeType"]);

/** The results tab entries of a project (all projects without one). */
export function useSidebarArtifacts(store: TaskStore, projectId: string): SidebarArtifact[] {
  const select = useCallback(
    (artifacts: AssistantArtifact[]): SidebarArtifact[] =>
      artifacts
        .filter((artifact) => !projectId || artifact.projectId === projectId)
        .map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          content: artifact.content ?? "",
          createdAt: new Date(artifact.createdAt).getTime(),
          mimeType: artifact.mimeType,
        })),
    [projectId],
  );
  return useSelection(store.subscribeArtifacts, store.getArtifacts, select, sameSidebarArtifacts);
}
