import { z } from 'zod'

export const releaseVersionSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
    'Release version must be a stable semantic version'
  )

const releaseNoteItemSchema = z.string().trim().min(1)

const localizedReleaseNotesSchema = z.preprocess(
  (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return value
    }
    const notes = value as Record<string, unknown>
    if ('highlights' in notes || 'notices' in notes) {
      return value
    }
    return {
      highlights: [],
      ...notes,
      notices: []
    }
  },
  z
    .object({
      highlights: z.array(releaseNoteItemSchema).max(3),
      features: z.array(releaseNoteItemSchema).max(20),
      fixes: z.array(releaseNoteItemSchema).max(20),
      notices: z.array(releaseNoteItemSchema).max(20)
    })
    .strict()
    .refine(
      (notes) =>
        notes.highlights.length > 0 ||
        notes.features.length > 0 ||
        notes.fixes.length > 0 ||
        notes.notices.length > 0,
      'Release notes must contain at least one item'
    )
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
      for (const section of [
        'highlights',
        'features',
        'fixes',
        'notices'
      ] as const) {
        if (
          release.notes['zh-CN'][section].length !==
          release.notes['en-US'][section].length
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'Localized release-note sections must have matching counts',
            path: ['releases', index, 'notes', section]
          })
        }
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
