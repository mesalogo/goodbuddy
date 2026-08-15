import { describe, expect, it } from 'vitest'
import {
  pruneKeepAliveEntries,
  touchKeepAliveEntry
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
      'conversation-5',
      'conversation-4',
      'conversation-0'
    ])
  })

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
