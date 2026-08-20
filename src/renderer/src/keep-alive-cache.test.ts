import { describe, expect, it } from 'vitest'
import {
  filterKeepAliveEntries,
  pruneKeepAliveEntries,
  touchAndPruneKeepAliveEntries,
  touchKeepAliveEntry,
  type KeepAliveCacheEntry
} from './keep-alive-cache'

describe('keep-alive cache', () => {
  it('updates a visited entry without duplicating it', () => {
    expect(
      touchKeepAliveEntry(
        [
          { key: 'chat', lastVisitedAt: 10 },
          { key: 'knowledge', lastVisitedAt: 20 }
        ],
        'chat',
        30
      )
    ).toEqual([
      { key: 'knowledge', lastVisitedAt: 20 },
      { key: 'chat', lastVisitedAt: 30 }
    ])
  })

  it('preserves reference equality for no-op touches and filtering', () => {
    const entries = [
      { key: 'knowledge', lastVisitedAt: 20 },
      { key: 'chat', lastVisitedAt: 10 }
    ]

    expect(touchKeepAliveEntry(entries, 'chat', 10)).toBe(entries)
    expect(
      filterKeepAliveEntries(entries, () => true)
    ).toBe(entries)
    expect(
      touchAndPruneKeepAliveEntries(entries, 'knowledge', 20, {
        expiresAfterMs: 100,
        maximumEntries: 2,
        protectedKeys: new Set<string>(),
        recentEntries: 1
      })
    ).toBe(entries)
  })

  it('preserves reference equality for a no-op sweep', () => {
    const entries = [
      { key: 'knowledge', lastVisitedAt: 20 },
      { key: 'chat', lastVisitedAt: 30 }
    ]

    expect(
      pruneKeepAliveEntries(entries, {
        currentKey: 'chat',
        expiresAfterMs: 100,
        maximumEntries: 2,
        now: 40,
        protectedKeys: new Set(['knowledge']),
        recentEntries: 1
      })
    ).toBe(entries)
  })

  it('keeps recent and protected entries while expiring inactive ones', () => {
    expect(
      pruneKeepAliveEntries(
        [
          { key: 'one', lastVisitedAt: 10 },
          { key: 'two', lastVisitedAt: 20 },
          { key: 'three', lastVisitedAt: 30 },
          { key: 'four', lastVisitedAt: 40 }
        ],
        {
          currentKey: 'four',
          expiresAfterMs: 50,
          maximumEntries: 4,
          now: 100,
          protectedKeys: new Set(['one']),
          recentEntries: 2
        }
      )
    ).toEqual([
      { key: 'four', lastVisitedAt: 40 },
      { key: 'three', lastVisitedAt: 30 },
      { key: 'one', lastVisitedAt: 10 }
    ])
  })

  it('enforces the hard limit with least-recently-used eviction', () => {
    expect(
      pruneKeepAliveEntries(
        Array.from({ length: 8 }, (_, index) => ({
          key: `conversation-${index}`,
          lastVisitedAt: index
        })),
        {
          currentKey: 'conversation-7',
          expiresAfterMs: 1_000,
          maximumEntries: 5,
          now: 10,
          protectedKeys: new Set(['conversation-0']),
          recentEntries: 2
        }
      ).map((entry) => entry.key)
    ).toEqual([
      'conversation-7',
      'conversation-6',
      'conversation-0',
      'conversation-5',
      'conversation-4'
    ])
  })

  it('applies the documented priority when protected entries exceed capacity', () => {
    const entries = [
      { key: 'newest', lastVisitedAt: 60 },
      { key: 'recent', lastVisitedAt: 50 },
      { key: 'protected-newest', lastVisitedAt: 40 },
      { key: 'protected-older', lastVisitedAt: 30 },
      { key: 'current', lastVisitedAt: 10 }
    ]

    expect(
      pruneKeepAliveEntries(entries, {
        currentKey: 'current',
        expiresAfterMs: 1_000,
        maximumEntries: 4,
        now: 100,
        protectedKeys: new Set([
          'protected-newest',
          'protected-older',
          'current'
        ]),
        recentEntries: 2
      }).map((entry) => entry.key)
    ).toEqual([
      'current',
      'newest',
      'recent',
      'protected-newest'
    ])
  })

  it.each([
    ['conversation', 12, 5, 20],
    ['workspace', 4, 3, 8]
  ])(
    'enforces the %s cap on every rapid touch',
    (_kind, maximumEntries, recentEntries, visitCount) => {
      const entries = Array.from(
        { length: visitCount },
        (_, index) => `entry-${index}`
      ).reduce<KeepAliveCacheEntry<string>[]>(
        (current, key, index) =>
          touchAndPruneKeepAliveEntries(current, key, index + 1, {
            expiresAfterMs: 60 * 60 * 1_000,
            maximumEntries,
            protectedKeys: new Set<string>(),
            recentEntries
          }),
        []
      )

      expect(entries).toHaveLength(maximumEntries)
      expect(entries.map((entry) => entry.key)).toEqual(
        Array.from(
          { length: maximumEntries },
          (_, index) => `entry-${visitCount - index - 1}`
        )
      )
    }
  )

  it('expires an unprotected entry after one hour', () => {
    const entries = [{ key: 'knowledge', lastVisitedAt: 1_000 }]
    const options = {
      expiresAfterMs: 60 * 60 * 1_000,
      maximumEntries: 4,
      protectedKeys: new Set<string>(),
      recentEntries: 0
    }

    expect(
      pruneKeepAliveEntries(entries, {
        ...options,
        now: 1_000 + 60 * 60 * 1_000 - 1
      })
    ).toEqual(entries)
    expect(
      pruneKeepAliveEntries(entries, {
        ...options,
        now: 1_000 + 60 * 60 * 1_000
      })
    ).toEqual([])
  })
})
