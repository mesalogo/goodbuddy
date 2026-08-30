import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApplicationSettingsStore } from './application-settings-store'
import { ReleaseNotesService } from './release-notes-service'

const temporaryDirectories: string[] = []

const localizedNotes = (label: string) => ({
  'zh-CN': {
    features: [`${label} 功能`],
    fixes: [`${label} 修复`]
  },
  'en-US': {
    features: [`${label} feature`],
    fixes: [`${label} fix`]
  }
})

async function createService(
  currentVersion: string
): Promise<{
  filePath: string
  service: ReleaseNotesService
  settingsStore: ApplicationSettingsStore
}> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-release-notes-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'release-notes.json')
  await writeFile(
    filePath,
    JSON.stringify({
      formatVersion: 1,
      releases: [
        {
          version: '0.8.12',
          releasedAt: '2026-08-04',
          notes: localizedNotes('0.8.12')
        },
        {
          version: '0.8.18',
          releasedAt: '2026-08-11',
          notes: localizedNotes('0.8.18')
        }
      ]
    }),
    'utf8'
  )
  const settingsStore = new ApplicationSettingsStore(
    join(directory, 'application-settings.json')
  )
  return {
    filePath,
    settingsStore,
    service: new ReleaseNotesService({
      currentVersion,
      filePath,
      settingsStore
    })
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('ReleaseNotesService', () => {
  it('shows only the current release on a fresh installation', async () => {
    const { service } = await createService('0.8.18')

    await expect(service.getPending()).resolves.toMatchObject({
      currentVersion: '0.8.18',
      releases: [{ version: '0.8.18' }]
    })
  })

  it('shows every unseen release newest first', async () => {
    const { service, settingsStore } = await createService('0.8.18')
    await settingsStore.setLastSeenReleaseNotesVersion('0.8.11')

    await expect(service.getPending()).resolves.toMatchObject({
      releases: [{ version: '0.8.18' }, { version: '0.8.12' }]
    })
  })

  it('does not present older notes as a missing current release', async () => {
    const { service, settingsStore } = await createService('0.8.19')
    await settingsStore.setLastSeenReleaseNotesVersion('0.8.11')

    await expect(service.getPending()).resolves.toEqual({
      currentVersion: '0.8.19',
      releases: []
    })
  })

  it('persists acknowledgement and does not show the release again', async () => {
    const { service, settingsStore } = await createService('0.8.18')

    await service.acknowledge({ version: '0.8.18' })

    await expect(service.getPending()).resolves.toEqual({
      currentVersion: '0.8.18',
      releases: []
    })
    await expect(
      settingsStore.getLastSeenReleaseNotesVersion()
    ).resolves.toBe('0.8.18')
  })

  it('rejects acknowledgement for another or unknown version', async () => {
    const { service } = await createService('0.8.18')

    await expect(
      service.acknowledge({ version: '0.8.12' })
    ).rejects.toThrow('Only the current release notes can be acknowledged')
    await expect(
      service.acknowledge({ version: '0.8.19' })
    ).rejects.toThrow('Only the current release notes can be acknowledged')
  })

  it('does not reopen release notes after an application downgrade', async () => {
    const { service, settingsStore } = await createService('0.8.12')
    await settingsStore.setLastSeenReleaseNotesVersion('0.8.18')

    await expect(service.getPending()).resolves.toEqual({
      currentVersion: '0.8.12',
      releases: []
    })
  })

  it('rejects an oversized release-notes resource with a bounded read', async () => {
    const { filePath, service } = await createService('0.8.18')
    await writeFile(filePath, ' '.repeat(128 * 1024 + 1), 'utf8')

    await expect(service.getPending()).rejects.toThrow(
      'Release notes exceed the size limit'
    )
  })
})
