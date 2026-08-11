import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { releaseNotesFileSchema } from '../shared/release-notes-contracts'

describe('packaged release notes', () => {
  it('contains matching bounded Chinese and English content', async () => {
    const source = JSON.parse(
      await readFile(
        join(process.cwd(), 'resources', 'release-notes.json'),
        'utf8'
      )
    ) as unknown
    const parsed = releaseNotesFileSchema.parse(source)

    expect(parsed.releases).toContainEqual(
      expect.objectContaining({ version: '0.8.18' })
    )
    for (const release of parsed.releases) {
      expect(release.notes['zh-CN'].features).toHaveLength(
        release.notes['en-US'].features.length
      )
      expect(release.notes['zh-CN'].fixes).toHaveLength(
        release.notes['en-US'].fixes.length
      )
    }
  })
})
