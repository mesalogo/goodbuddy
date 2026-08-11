import { z } from 'zod'

export const releaseVersionSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
    'Release version must be a stable semantic version'
  )

const localizedReleaseNotesSchema = z
  .object({
    features: z.array(z.string().trim().min(1).max(240)).max(20),
    fixes: z.array(z.string().trim().min(1).max(240)).max(20)
  })
  .strict()
  .refine(
    (notes) => notes.features.length > 0 || notes.fixes.length > 0,
    'Release notes must contain at least one item'
  )

export const releaseNoteSchema = z
  .object({
    version: releaseVersionSchema,
    releasedAt: z.iso.date(),
    notes: z
      .object({
        'zh-CN': localizedReleaseNotesSchema,
        'en-US': localizedReleaseNotesSchema
      })
      .strict()
  })
  .strict()

export const releaseNotesFileSchema = z
  .object({
    formatVersion: z.literal(1),
    releases: z.array(releaseNoteSchema).min(1).max(100)
  })
  .strict()
  .superRefine((value, context) => {
    const versions = new Set<string>()
    for (const [index, release] of value.releases.entries()) {
      if (versions.has(release.version)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate release version: ${release.version}`,
          path: ['releases', index, 'version']
        })
      }
      versions.add(release.version)
      if (
        release.notes['zh-CN'].features.length !==
          release.notes['en-US'].features.length ||
        release.notes['zh-CN'].fixes.length !==
          release.notes['en-US'].fixes.length
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Localized release-note sections must have matching counts',
          path: ['releases', index, 'notes']
        })
      }
    }
  })

export const releaseNotesAcknowledgeSchema = z
  .object({
    version: releaseVersionSchema
  })
  .strict()

export type ReleaseNote = z.infer<typeof releaseNoteSchema>

export type ReleaseNotesSnapshot = {
  currentVersion: string
  releases: ReleaseNote[]
}
