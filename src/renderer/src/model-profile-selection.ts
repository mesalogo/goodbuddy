export function findPreferredCompatibleModelProfile<
  Profile extends { id: string }
>(
  profiles: readonly Profile[],
  preferredProfileId: string | undefined,
  isCompatible: (profile: Profile) => boolean
): Profile | undefined {
  return (
    profiles.find(
      (profile) =>
        profile.id === preferredProfileId && isCompatible(profile)
    ) ?? profiles.find(isCompatible)
  )
}
