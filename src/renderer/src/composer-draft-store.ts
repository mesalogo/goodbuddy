import {
  useCallback,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
  type SetStateAction,
} from "react";

/**
 * Per-conversation composer text, kept outside App state so a keystroke only
 * re-renders the textarea and the send button, not the whole window.
 */
export type ComposerDraftStore = ReturnType<typeof createComposerDraftStore>;

export function createComposerDraftStore() {
  const drafts = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get(conversationId: string): string {
      return drafts.get(conversationId) ?? "";
    },
    set(conversationId: string, update: SetStateAction<string>): void {
      const current = drafts.get(conversationId) ?? "";
      const next = typeof update === "function" ? update(current) : update;
      if (next === current) return;
      if (next) drafts.set(conversationId, next);
      else drafts.delete(conversationId);
      notify();
    },
    delete(conversationId: string): void {
      if (drafts.delete(conversationId)) notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useComposerDraft<T>(
  store: ComposerDraftStore,
  conversationId: string,
  select: (draft: string) => T,
): T {
  const getSnapshot = useCallback(
    () => select(store.get(conversationId)),
    [conversationId, select, store],
  );
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

const identity = (draft: string): string => draft;
const hasText = (draft: string): boolean => draft.trim().length > 0;

/** Renders `children` with the current draft text of a conversation. */
export function ComposerDraftText({
  children,
  conversationId,
  store,
}: {
  children: (draft: string) => ReactNode;
  conversationId: string;
  store: ComposerDraftStore;
}): ReactNode {
  return children(useComposerDraft(store, conversationId, identity));
}

/** Renders `children` with whether the draft has non-whitespace text. */
export function ComposerDraftHasText({
  children,
  conversationId,
  store,
}: {
  children: (hasText: boolean) => ReactNode;
  conversationId: string;
  store: ComposerDraftStore;
}): ReactNode {
  return children(useComposerDraft(store, conversationId, hasText));
}

/** Runs `resize` after each committed draft change. */
export function ComposerDraftEffect({
  draft,
  onCommit,
}: {
  draft: string;
  onCommit: () => void;
}): null {
  useLayoutEffect(() => {
    onCommit();
    // Only draft changes resize; the callback identity is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  return null;
}
