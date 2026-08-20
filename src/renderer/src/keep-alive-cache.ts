export type KeepAliveCacheEntry<Key extends string> = {
  key: Key
  lastVisitedAt: number
}

export type KeepAlivePruneOptions<Key extends string> = {
  currentKey?: Key
  expiresAfterMs: number
  maximumEntries: number
  now: number
  protectedKeys?: ReadonlySet<Key>
  recentEntries: number
}

export function filterKeepAliveEntries<Key extends string>(
  entries: KeepAliveCacheEntry<Key>[],
  predicate: (entry: KeepAliveCacheEntry<Key>) => boolean
): KeepAliveCacheEntry<Key>[]
export function filterKeepAliveEntries<Key extends string>(
  entries: readonly KeepAliveCacheEntry<Key>[],
  predicate: (entry: KeepAliveCacheEntry<Key>) => boolean
): readonly KeepAliveCacheEntry<Key>[]
export function filterKeepAliveEntries<Key extends string>(
  entries: readonly KeepAliveCacheEntry<Key>[],
  predicate: (entry: KeepAliveCacheEntry<Key>) => boolean
): readonly KeepAliveCacheEntry<Key>[] {
  const filtered = entries.filter(predicate)
  return filtered.length === entries.length ? entries : filtered
}

export function touchKeepAliveEntry<Key extends string>(
  entries: KeepAliveCacheEntry<Key>[],
  key: Key,
  visitedAt: number
): KeepAliveCacheEntry<Key>[]
export function touchKeepAliveEntry<Key extends string>(
  entries: readonly KeepAliveCacheEntry<Key>[],
  key: Key,
  visitedAt: number
): readonly KeepAliveCacheEntry<Key>[]
export function touchKeepAliveEntry<Key extends string>(
  entries: readonly KeepAliveCacheEntry<Key>[],
  key: Key,
  visitedAt: number
): readonly KeepAliveCacheEntry<Key>[] {
  const existingIndex = entries.findIndex((entry) => entry.key === key)
  if (
    existingIndex >= 0 &&
    entries[existingIndex]?.lastVisitedAt === visitedAt &&
    entries.findIndex(
      (entry, index) => index !== existingIndex && entry.key === key
    ) < 0
  ) {
    return entries
  }
  return [
    ...entries.filter((entry) => entry.key !== key),
    { key, lastVisitedAt: visitedAt }
  ]
}

export function touchAndPruneKeepAliveEntries<Key extends string>(
  entries: KeepAliveCacheEntry<Key>[],
  key: Key,
  visitedAt: number,
  options: Omit<KeepAlivePruneOptions<Key>, 'currentKey' | 'now'>
): KeepAliveCacheEntry<Key>[]
export function touchAndPruneKeepAliveEntries<Key extends string>(
  entries: readonly KeepAliveCacheEntry<Key>[],
  key: Key,
  visitedAt: number,
  options: Omit<KeepAlivePruneOptions<Key>, 'currentKey' | 'now'>
): readonly KeepAliveCacheEntry<Key>[]
export function touchAndPruneKeepAliveEntries<Key extends string>(
  entries: readonly KeepAliveCacheEntry<Key>[],
  key: Key,
  visitedAt: number,
  options: Omit<KeepAlivePruneOptions<Key>, 'currentKey' | 'now'>
): readonly KeepAliveCacheEntry<Key>[] {
  return pruneKeepAliveEntries(
    touchKeepAliveEntry(entries, key, visitedAt),
    {
      ...options,
      currentKey: key,
      now: visitedAt
    }
  )
}

export function pruneKeepAliveEntries<Key extends string>(
  entries: KeepAliveCacheEntry<Key>[],
  options: KeepAlivePruneOptions<Key>
): KeepAliveCacheEntry<Key>[]
export function pruneKeepAliveEntries<Key extends string>(
  entries: readonly KeepAliveCacheEntry<Key>[],
  options: KeepAlivePruneOptions<Key>
): readonly KeepAliveCacheEntry<Key>[]
/**
 * Prunes pane cache membership without modifying the pane data itself.
 *
 * Capacity is absolute. Candidates are selected in this exact order:
 * the current pane, the globally newest `recentEntries`, the newest
 * protected panes, then all other unexpired panes by recency. Overlapping
 * categories do not consume capacity twice. Equal timestamps retain their
 * input order.
 */
export function pruneKeepAliveEntries<Key extends string>(
  entries: readonly KeepAliveCacheEntry<Key>[],
  {
    currentKey,
    expiresAfterMs,
    maximumEntries,
    now,
    protectedKeys,
    recentEntries
  }: KeepAlivePruneOptions<Key>
): readonly KeepAliveCacheEntry<Key>[] {
  const newestFirst = entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        right.entry.lastVisitedAt - left.entry.lastVisitedAt ||
        left.index - right.index
    )
    .map(({ entry }) => entry)
  const selected: KeepAliveCacheEntry<Key>[] = []
  const selectedKeys = new Set<Key>()
  const capacity = Math.max(0, maximumEntries)
  const add = (entry: KeepAliveCacheEntry<Key> | undefined): void => {
    if (
      entry &&
      selected.length < capacity &&
      !selectedKeys.has(entry.key)
    ) {
      selected.push(entry)
      selectedKeys.add(entry.key)
    }
  }

  if (currentKey) {
    add(newestFirst.find((entry) => entry.key === currentKey))
  }
  newestFirst
    .slice(0, Math.max(0, recentEntries))
    .forEach(add)
  newestFirst
    .filter((entry) => protectedKeys?.has(entry.key))
    .forEach(add)
  newestFirst
    .filter(
      (entry) => now - entry.lastVisitedAt < expiresAfterMs
    )
    .forEach(add)

  const unchanged =
    selected.length === entries.length &&
    selectedKeys.size === entries.length &&
    entries.every((entry) => selectedKeys.has(entry.key))
  return unchanged ? entries : selected
}
