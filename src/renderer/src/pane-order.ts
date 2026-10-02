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
