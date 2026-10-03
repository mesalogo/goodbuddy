import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Open/closed state of the composer's popups (options dialog, knowledge
 * scope, the pickers and the runtime menu). It lives outside App so opening a
 * menu re-renders only the composer.
 *
 * The state belongs to one composer context (conversation, running state and
 * view). Switching context closes every popup, as the earlier
 * reset-during-render in App did, without an extra App render.
 */
export type ComposerMenuId =
  | "expert"
  | "mode"
  | "runtime-agent"
  | "runtime-action"
  | "runtime-preset";

export type ComposerMenuState = {
  readonly optionsOpen: boolean;
  readonly knowledgeScopeOpen: boolean;
  readonly menu: ComposerMenuId | undefined;
  readonly runtimeMenuOpen: boolean;
};

export const closedComposerMenus: ComposerMenuState = Object.freeze({
  optionsOpen: false,
  knowledgeScopeOpen: false,
  menu: undefined,
  runtimeMenuOpen: false,
});

export type ComposerMenuUpdate =
  | Partial<ComposerMenuState>
  | ((current: ComposerMenuState) => Partial<ComposerMenuState>);

export type ComposerMenuStore = ReturnType<typeof createComposerMenuStore>;

function sameMenus(left: ComposerMenuState, right: ComposerMenuState): boolean {
  return (
    left.optionsOpen === right.optionsOpen &&
    left.knowledgeScopeOpen === right.knowledgeScopeOpen &&
    left.menu === right.menu &&
    left.runtimeMenuOpen === right.runtimeMenuOpen
  );
}

export function createComposerMenuStore() {
  let key = "";
  let menus = closedComposerMenus;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const store = {
    /** The popups of `contextKey`; closed for any other context. */
    get(contextKey: string): ComposerMenuState {
      return contextKey === key ? menus : closedComposerMenus;
    },
    /** Makes `contextKey` current; popups of an earlier context stay closed. */
    retain(contextKey: string): void {
      if (contextKey === key) return;
      const wasOpen = menus !== closedComposerMenus;
      key = contextKey;
      menus = closedComposerMenus;
      if (wasOpen) notify();
    },
    update(contextKey: string, update: ComposerMenuUpdate): void {
      const current = store.get(contextKey);
      const patch = typeof update === "function" ? update(current) : update;
      const next = { ...current, ...patch };
      key = contextKey;
      if (sameMenus(current, next)) {
        menus = current;
        return;
      }
      menus = sameMenus(next, closedComposerMenus) ? closedComposerMenus : next;
      notify();
    },
    /** Closes the pickers and the runtime menu of whatever context is current. */
    closeMenus(): void {
      store.update(key, { menu: undefined, runtimeMenuOpen: false });
    },
    closeRuntimeMenu(): void {
      store.update(key, { runtimeMenuOpen: false });
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return store;
}

export function useComposerMenus(
  store: ComposerMenuStore,
  contextKey: string,
): [ComposerMenuState, (update: ComposerMenuUpdate) => void] {
  useLayoutEffect(() => {
    store.retain(contextKey);
  }, [contextKey, store]);
  const getSnapshot = useCallback(() => store.get(contextKey), [contextKey, store]);
  const menus = useSyncExternalStore(store.subscribe, getSnapshot);
  const update = useCallback(
    (next: ComposerMenuUpdate): void => store.update(contextKey, next),
    [contextKey, store],
  );
  return [menus, update];
}
