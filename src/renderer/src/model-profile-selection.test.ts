import { describe, expect, it } from 'vitest'
import { findPreferredCompatibleModelProfile } from './model-profile-selection'

const profiles = [
  { id: 'image', compatible: false },
  { id: 'first-text', compatible: true },
  { id: 'preferred-text', compatible: true }
]

describe('findPreferredCompatibleModelProfile', () => {
  it.each([
    ['preferred compatible profile', 'preferred-text', 'preferred-text'],
    [
      'first compatible fallback for an incompatible preference',
      'image',
      'first-text'
    ],
    [
      'first compatible fallback for a missing preference',
      'missing',
      'first-text'
    ],
    ['first compatible fallback without a preference', undefined, 'first-text']
  ] as const)(
    'selects the %s',
    (_case, preferredProfileId, expectedId) => {
      expect(
        findPreferredCompatibleModelProfile(
          profiles,
          preferredProfileId,
          (profile) => profile.compatible
        )?.id
      ).toBe(expectedId)
    }
  )

  it('returns undefined when no profile is compatible', () => {
    expect(
      findPreferredCompatibleModelProfile(
        profiles,
        'preferred-text',
        () => false
      )
    ).toBeUndefined()
  })
})
