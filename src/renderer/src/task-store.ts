import type { SetStateAction } from "react";
import type { AssistantArtifact, AssistantTask, ListCursor } from "../../shared/assistant-contracts";

/**
 * Assistant tasks and result artifacts, kept outside App state.
 *
 * Agent events update task status and artifacts many times per run. As App
 * state every update re-rendered the whole window; here components select
 * the part they show (see task-selectors.ts) and re-render only when it
 * changes. `getTasks()` / `getArtifacts()` are always the latest values,
 * synchronously after an update, replacing the former `assistantTasksRef`.
 *
 * Artifact updates keep the previous objects (and the previous array) when
 * the merged result is equal, so refreshing the list after every run does
 * not invalidate the artifact map the chat timelines render from.
 *
 * Main returns only the most recent task window on refresh. Once the user
 * paged in older history (see `mergeOlderTasks`), a refresh that replaces the
 * list with a plain array keeps every loaded task it does not cover, so
 * polling never drops them; functional updates that remove a task forget it.
 * An empty refresh means no task exists and resets the paging state.
 */
type Listener = () => void;

export type TaskStore = ReturnType<typeof createTaskStore>;

/**
 * Where the next older page starts. No cursor and not exhausted means no
 * older page was loaded yet; `generation` changes when the list is cleared.
 */
export type TaskHistoryState = { cursor?: ListCursor; exhausted: boolean; generation: number };
export type ArtifactHistoryState = TaskHistoryState;

export function mergeArtifacts(
  current: readonly AssistantArtifact[],
  incoming: readonly AssistantArtifact[],
): AssistantArtifact[] {
  const merged = new Map(current.map((artifact) => [artifact.id, artifact]));
  for (const artifact of incoming) {
    const existing = merged.get(artifact.id);
    merged.set(artifact.id, {
      ...existing,
      ...artifact,
      content: artifact.content ?? existing?.content,
    });
  }
  return [...merged.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

const artifactKeys: readonly (keyof AssistantArtifact)[] = [
  "id", "projectId", "taskId", "kind", "title", "mimeType", "content", "byteSize", "createdAt", "updatedAt",
];

function sameArtifact(left: AssistantArtifact, right: AssistantArtifact): boolean {
  return artifactKeys.every((key) => left[key] === right[key]);
}

/** `next`, reusing equal objects from `previous`; `previous` itself when nothing changed. */
function reuseArtifacts(
  previous: AssistantArtifact[],
  next: AssistantArtifact[],
): AssistantArtifact[] {
  if (next === previous) return previous;
  const byId = new Map(previous.map((artifact) => [artifact.id, artifact]));
  let changed = next.length !== previous.length;
  const result = next.map((artifact, index) => {
    const existing = byId.get(artifact.id);
    const reused = existing && sameArtifact(existing, artifact) ? existing : artifact;
    if (reused !== previous[index]) changed = true;
    return reused;
  });
  return changed ? result : previous;
}

export function createTaskStore(
  initial: { tasks?: AssistantTask[]; artifacts?: AssistantArtifact[] } = {},
) {
  let tasks = initial.tasks ?? [];
  let artifacts = initial.artifacts ?? [];
  let artifactById: ReadonlyMap<string, AssistantArtifact> | undefined;
  // Older task pages loaded on request, beyond Main's recent window.
  let olderTaskIds = new Set<string>();
  let taskHistory: TaskHistoryState = { exhausted: false, generation: 0 };
  let artifactHistory: ArtifactHistoryState = { exhausted: false, generation: 0 };
  const historyListeners = new Set<Listener>();
  const resetTaskHistory = (): void => {
    olderTaskIds = new Set();
    taskHistory = { exhausted: false, generation: taskHistory.generation + 1 };
    notify(historyListeners);
  };
  const taskListeners = new Set<Listener>();
  const artifactListeners = new Set<Listener>();
  const notify = (listeners: Set<Listener>): void => {
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listeners: Set<Listener>) => (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const store = {
    getTasks(): AssistantTask[] {
      return tasks;
    },
    setTasks(update: SetStateAction<AssistantTask[]>): void {
      let next = typeof update === "function" ? update(tasks) : update;
      if (next === tasks) return;
      const historyLoaded = olderTaskIds.size > 0 || taskHistory.cursor !== undefined || taskHistory.exhausted;
      if (typeof update !== "function" && next.length === 0) {
        if (historyLoaded) resetTaskHistory();
      } else if (typeof update !== "function" && historyLoaded) {
        // A refresh from Main covers only the recent window. Once history was
        // paged in, tasks it no longer returns (older pages, or tasks newer
        // ones pushed out of the window) stay loaded, so none becomes
        // unreachable behind an exhausted cursor.
        const present = new Set(next.map((task) => task.id));
        const kept = tasks.filter((task) => !present.has(task.id));
        for (const task of kept) olderTaskIds.add(task.id);
        if (kept.length > 0) next = [...next, ...kept];
      }
      if (olderTaskIds.size > 0) {
        const ids = new Set(next.map((task) => task.id));
        olderTaskIds = new Set([...olderTaskIds].filter((id) => ids.has(id)));
      }
      tasks = next;
      notify(taskListeners);
    },
    subscribeTasks: subscribe(taskListeners),

    /** Paging state of the task history beyond Main's recent window. */
    getTaskHistory(): TaskHistoryState {
      return taskHistory;
    },
    getArtifactHistory(): ArtifactHistoryState {
      return artifactHistory;
    },
    subscribeHistory: subscribe(historyListeners),
    /**
     * Appends an older task page and records where the next page starts.
     * Ignored when the list was cleared after the page was requested.
     */
    mergeOlderTasks(
      page: readonly AssistantTask[],
      nextCursor: ListCursor | undefined,
      generation: number,
    ): void {
      if (generation !== taskHistory.generation) return;
      const present = new Set(tasks.map((task) => task.id));
      const added = page.filter((task) => !present.has(task.id));
      for (const task of added) olderTaskIds.add(task.id);
      taskHistory = { cursor: nextCursor, exhausted: nextCursor === undefined, generation };
      notify(historyListeners);
      if (added.length > 0) {
        tasks = [...tasks, ...added];
        notify(taskListeners);
      }
    },
    /** Records the artifact paging cursor after an older page was merged. */
    setArtifactCursor(nextCursor: ListCursor | undefined, generation: number): void {
      if (generation !== artifactHistory.generation) return;
      artifactHistory = { cursor: nextCursor, exhausted: nextCursor === undefined, generation };
      notify(historyListeners);
    },

    getArtifacts(): AssistantArtifact[] {
      return artifacts;
    },
    /** The artifacts by ID; the same map while the artifacts are unchanged. */
    getArtifactById(): ReadonlyMap<string, AssistantArtifact> {
      artifactById ??= new Map(artifacts.map((artifact) => [artifact.id, artifact]));
      return artifactById;
    },
    setArtifacts(update: SetStateAction<AssistantArtifact[]>): void {
      const next = reuseArtifacts(
        artifacts,
        typeof update === "function" ? update(artifacts) : update,
      );
      if (next === artifacts) return;
      artifacts = next;
      artifactById = undefined;
      notify(artifactListeners);
    },
    mergeArtifacts(incoming: readonly AssistantArtifact[]): void {
      store.setArtifacts((current) => mergeArtifacts(current, incoming));
    },
    subscribeArtifacts: subscribe(artifactListeners),

    clear(): void {
      store.setTasks([]);
      store.setArtifacts([]);
      resetTaskHistory();
      artifactHistory = { exhausted: false, generation: artifactHistory.generation + 1 };
      notify(historyListeners);
    },
  };
  return store;
}
