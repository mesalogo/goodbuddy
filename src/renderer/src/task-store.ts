import type { SetStateAction } from "react";
import type { AssistantArtifact, AssistantTask } from "../../shared/assistant-contracts";

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
 */
type Listener = () => void;

export type TaskStore = ReturnType<typeof createTaskStore>;

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
      const next = typeof update === "function" ? update(tasks) : update;
      if (next === tasks) return;
      tasks = next;
      notify(taskListeners);
    },
    subscribeTasks: subscribe(taskListeners),

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
    },
  };
  return store;
}
