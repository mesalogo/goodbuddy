import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { releaseNotesFileSchema } from '../shared/release-notes-contracts'

describe('packaged release notes', () => {
  it('contains matching Chinese and English content', async () => {
    const source = JSON.parse(
      await readFile(
        join(process.cwd(), 'resources', 'release-notes.json'),
        'utf8'
      )
    ) as unknown
    const packageSource = JSON.parse(
      await readFile(join(process.cwd(), 'package.json'), 'utf8')
    ) as { version?: unknown }
    const parsed = releaseNotesFileSchema.parse(source)

    expect(typeof packageSource.version).toBe('string')
    expect(parsed.releases).toContainEqual(
      expect.objectContaining({ version: packageSource.version })
    )
    expect(parsed.releases).toContainEqual(
      expect.objectContaining({ version: '0.8.19' })
    )
    for (const release of parsed.releases) {
      for (const section of [
        'highlights',
        'features',
        'fixes',
        'notices'
      ] as const) {
        expect(release.notes['zh-CN'][section]).toHaveLength(
          release.notes['en-US'][section].length
        )
      }
    }
    const releaseWithLongScenario = parsed.releases.find(
      (release) => release.version === '0.12.0'
    )
    expect(
      releaseWithLongScenario?.notes['en-US'].features.some(
        (item) => item.length > 500
      )
    ).toBe(true)

    const currentRelease = parsed.releases.find(
      (release) => release.version === '0.10.1'
    )
    expect(currentRelease).toBeDefined()
    expect(currentRelease?.releasedAt).toBe('2026-08-17')
    expect(currentRelease?.notes['zh-CN'].highlights).toHaveLength(1)
    expect(currentRelease?.notes['zh-CN'].features).toHaveLength(7)
    expect(currentRelease?.notes['zh-CN'].fixes).toHaveLength(6)
    expect(currentRelease?.notes['zh-CN'].notices).toHaveLength(4)
    expect(
      currentRelease?.notes['zh-CN'].features.every((item) =>
        item.startsWith('**')
      )
    ).toBe(true)
    expect(
      currentRelease?.notes['zh-CN'].fixes.every((item) =>
        item.startsWith('**')
      )
    ).toBe(true)
    expect(
      currentRelease?.notes['zh-CN'].notices.every((item) =>
        item.startsWith('**')
      )
    ).toBe(true)
    expect(JSON.stringify(currentRelease)).not.toContain('官网')
    expect(JSON.stringify(currentRelease)).not.toContain(
      'Website and product preview'
    )

    const legacyRelease = parsed.releases.find(
      (release) => release.version === '0.9.3'
    )
    expect(legacyRelease?.notes['zh-CN'].highlights).toEqual([])
    expect(legacyRelease?.notes['zh-CN'].notices).toEqual([])
  })
})
