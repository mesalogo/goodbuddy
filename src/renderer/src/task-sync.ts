import { useEffect } from "react";
import type { AssistantTask } from "../../shared/assistant-contracts";
import { useArtifactById } from "./task-selectors";
import type { TaskStore } from "./task-store";

/**
 * Task and artifact IPC with Main: the first load, refreshes after runs and
 * on-demand loading of artifact content. Moved out of App so the store, not
 * App state, receives the results.
 */

/** Refreshes the artifact list; unchanged artifacts keep their identity. */
export async function refreshArtifacts(store: TaskStore): Promise<void> {
  store.mergeArtifacts(await window.goodbuddy.artifacts.list());
}

/** Loads one artifact with its content. */
export async function loadArtifact(store: TaskStore, artifactId: string): Promise<void> {
  if (store.getArtifactById().get(artifactId)?.content) return;
  store.mergeArtifacts([await window.goodbuddy.artifacts.get(artifactId)]);
}

/** Reloads the task list from Main. */
export async function refreshTasks(store: TaskStore): Promise<AssistantTask[]> {
  const tasks = await window.goodbuddy.tasks.list();
  store.setTasks(tasks);
  return tasks;
}

/**
 * Loads the next older task page and merges it; refreshes keep it. The first
 * call starts from the newest page (the same window `tasks.list` returns) to
 * find the cursor, and continues once if that page added nothing new.
 * Returns whether more history remains.
 */
export async function loadOlderTasks(store: TaskStore): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { cursor, exhausted, generation } = store.getTaskHistory();
    if (exhausted) return false;
    const before = store.getTasks().length;
    const page = await window.goodbuddy.tasks.listPage(cursor ? { before: cursor } : {});
    store.mergeOlderTasks(page.tasks, page.nextCursor, generation);
    if (store.getTasks().length > before || cursor) break;
  }
  return !store.getTaskHistory().exhausted;
}

/** Loads the next older artifact page and merges it; returns whether more remain. */
export async function loadOlderArtifacts(store: TaskStore): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { cursor, exhausted, generation } = store.getArtifactHistory();
    if (exhausted) return false;
    const before = store.getArtifacts().length;
    const page = await window.goodbuddy.artifacts.listPage(cursor ? { before: cursor } : {});
    if (generation !== store.getArtifactHistory().generation) return false;
    store.mergeArtifacts(page.artifacts);
    store.setArtifactCursor(page.nextCursor, generation);
    if (store.getArtifacts().length > before || cursor) break;
  }
  return !store.getArtifactHistory().exhausted;
}

/**
 * Loads the content of the most recent artifacts a conversation references
 * (at most 32), skipping ones already loaded or loading.
 */
export function useArtifactHydration(
  store: TaskStore,
  artifactIds: readonly string[] | undefined,
  hydrating: { current: Set<string> },
): void {
  const artifactById = useArtifactById(store);
  useEffect(() => {
    const missingIds = [...(artifactIds ?? [])]
      .filter((artifactId) =>
        !artifactById.get(artifactId)?.content && !hydrating.current.has(artifactId))
      .slice(-32);
    if (missingIds.length === 0) {
      return;
    }
    for (const artifactId of missingIds) {
      hydrating.current.add(artifactId);
    }
    void Promise.allSettled(
      missingIds.map((artifactId) => window.goodbuddy.artifacts.get(artifactId)),
    ).then((results) => {
      const artifacts = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []);
      if (artifacts.length > 0) {
        store.mergeArtifacts(artifacts);
      }
      for (const artifactId of missingIds) {
        hydrating.current.delete(artifactId);
      }
    });
  }, [artifactIds, artifactById, hydrating, store]);
}

/** Loads the artifact list once on mount. */
export function useInitialArtifactSync(store: TaskStore, onFailed: () => void): void {
  useEffect(() => {
    void refreshArtifacts(store).catch(onFailed);
    // Runs once, like the former App effect; a later callback is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);
}
