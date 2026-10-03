import { useMemo, useState } from "react";

/**
 * Reconciles a stable order for kept-alive panes. Ids already in `previous`
 * keep their relative position, ids missing from `ids` are dropped and new ids
 * are appended in iteration order. Returns `previous` itself when nothing
 * changed, so it is safe to store the result in state during render.
 */
export function reconcilePaneOrder(
  previous: readonly string[],
  ids: Iterable<string>,
): readonly string[] {
  const wanted = new Set(ids);
  const next = previous.filter((id) => wanted.has(id));
  const kept = new Set(next);
  wanted.forEach((id) => {
    if (!kept.has(id)) next.push(id);
  });
  if (
    next.length === previous.length &&
    next.every((id, index) => id === previous[index])
  ) {
    return previous;
  }
  return next;
}
const previousOrders = new WeakMap<object, readonly string[]>();

/**
 * The reconciled pane order, derived during render. The previous order is
 * kept per hook slot (like useStableDerivedValue), so a conversation switch
 * renders App once instead of once more for a state update during render.
 */
export function usePaneOrder(ids: readonly string[]): readonly string[] {
  const [slot] = useState(() => ({}));
  const order = useMemo(
    () => reconcilePaneOrder(previousOrders.get(slot) ?? [], ids),
    [ids, slot],
  );
  previousOrders.set(slot, order);
  return order;
}