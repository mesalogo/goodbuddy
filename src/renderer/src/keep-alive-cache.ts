export type KeepAliveCacheEntry<Key extends string> = {
  key: Key
  lastVisitedAt: number
}

export function touchKeepAliveEntry<Key extends string>(
  entries: readonly KeepAliveCacheEntry<Key>[],
  key: Key,
  visitedAt: number
): KeepAliveCacheEntry<Key>[] {
  const existing = entries.find((entry) => entry.key === key)
  if (existing?.lastVisitedAt === visitedAt) {
    return [...entries]
  }
  return [
    ...entries.filter((entry) => entry.key !== key),
    { key, lastVisitedAt: visitedAt }
  ]
}

export function pruneKeepAliveEntries<Key extends string>(
  entries: readonly KeepAliveCacheEntry<Key>[],
  {
    currentKey,
    expiresAfterMs,
    maximumEntries,
    now,
    protectedKeys,
    recentEntries
  }: {
    currentKey?: Key
    expiresAfterMs: number
    maximumEntries: number
    now: number
    protectedKeys?: ReadonlySet<Key>
    recentEntries: number
  }
): KeepAliveCacheEntry<Key>[] {
  const newestFirst = [...entries].sort(
    (left, right) => right.lastVisitedAt - left.lastVisitedAt
  )
  const alwaysKeep = new Set(
    newestFirst.slice(0, recentEntries).map((entry) => entry.key)
  )
  if (currentKey) {
    alwaysKeep.add(currentKey)
  }
  protectedKeys?.forEach((key) => alwaysKeep.add(key))

  const retained = newestFirst.filter(
    (entry) =>
      alwaysKeep.has(entry.key) ||
      now - entry.lastVisitedAt < expiresAfterMs
  )
  if (retained.length <= maximumEntries) {
    return retained
  }

  const removableOldestFirst = retained
    .filter((entry) => !alwaysKeep.has(entry.key))
    .sort((left, right) => left.lastVisitedAt - right.lastVisitedAt)
  const removeCount = retained.length - maximumEntries
  const removedKeys = new Set(
    removableOldestFirst
      .slice(0, removeCount)
      .map((entry) => entry.key)
  )
  return retained.filter((entry) => !removedKeys.has(entry.key))
}
