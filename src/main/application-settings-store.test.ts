import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ApplicationSettingsStore,
  applicationSettingsSchema,
  applicationSettingsUpdateSchema,
  defaultApplicationSettings
} from './application-settings-store'

const temporaryDirectories: string[] = []

async function createStore(): Promise<{
  directory: string
  filePath: string
  store: ApplicationSettingsStore
}> {
  const directory = await mkdtemp(
    join(tmpdir(), 'goodbuddy-application-settings-')
  )
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'application-settings.json')
  return {
    directory,
    filePath,
    store: new ApplicationSettingsStore(filePath)
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('ApplicationSettingsStore', () => {
  it('returns defaults without creating a settings file', async () => {
    const { directory, store } = await createStore()

    await expect(store.get()).resolves.toEqual(
      defaultApplicationSettings
    )
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('persists versioned application preferences', async () => {
    const { directory, filePath, store } = await createStore()

    await expect(
      store.update({
        checkUpdatesOnStartup: false,
        magicNotesEnabled: false
      })
    ).resolves.toEqual({
      checkUpdatesOnStartup: false,
      magicNotesEnabled: false
    })
    await expect(store.get()).resolves.toEqual({
      checkUpdatesOnStartup: false,
      magicNotesEnabled: false
    })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 2,
      checkUpdatesOnStartup: false,
      magicNotesEnabled: false
    })
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp'))
    ).toEqual([])
  })

  it('creates the parent directory and can reload persisted settings', async () => {
    const { directory } = await createStore()
    const filePath = join(directory, 'nested', 'application-settings.json')
    const store = new ApplicationSettingsStore(filePath)
    await store.update({
      checkUpdatesOnStartup: false,
      magicNotesEnabled: false
    })

    await expect(
      new ApplicationSettingsStore(filePath).get()
    ).resolves.toEqual({
      checkUpdatesOnStartup: false,
      magicNotesEnabled: false
    })
  })

  it.each([1, 2])(
    'loads version %s settings missing the field with Magic Notes disabled',
    async (version) => {
      const { filePath, store } = await createStore()
      await writeFile(
        filePath,
        JSON.stringify({
          version,
          checkUpdatesOnStartup: false
        }),
        'utf8'
      )

      await expect(store.get()).resolves.toEqual({
        checkUpdatesOnStartup: false,
        magicNotesEnabled: false
      })
    }
  )

  it('strictly rejects incomplete full settings', () => {
    for (const input of [
      {},
      { checkUpdatesOnStartup: 'true' },
      {
        checkUpdatesOnStartup: true,
        magicNotesEnabled: true,
        anotherSetting: true
      },
      { checkUpdatesOnStartup: true },
      null
    ]) {
      expect(applicationSettingsSchema.safeParse(input).success).toBe(
        false
      )
    }
  })

  it('strictly rejects empty, unknown, and mistyped updates', async () => {
    const { directory, store } = await createStore()
    for (const input of [
      {},
      { checkUpdatesOnStartup: 'true' },
      { anotherSetting: true },
      null
    ]) {
      expect(
        applicationSettingsUpdateSchema.safeParse(input).success
      ).toBe(false)
      await expect(store.update(input)).rejects.toThrow()
    }
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('merges partial updates without overwriting other settings', async () => {
    const { store } = await createStore()

    await store.update({ magicNotesEnabled: true })
    await expect(
      store.update({ checkUpdatesOnStartup: false })
    ).resolves.toEqual({
      checkUpdatesOnStartup: false,
      magicNotesEnabled: true
    })
  })

  it.each([
    '{not-json',
    JSON.stringify({
      version: 3,
      checkUpdatesOnStartup: false,
      magicNotesEnabled: false
    }),
    JSON.stringify({
      version: 2,
      checkUpdatesOnStartup: false,
      magicNotesEnabled: true,
      injected: true
    }),
    JSON.stringify({
      version: 2,
      checkUpdatesOnStartup: 'false',
      magicNotesEnabled: true
    })
  ])('isolates corrupt persisted data and restores defaults', async (data) => {
    const { directory, filePath, store } = await createStore()
    await writeFile(filePath, data, 'utf8')

    await expect(store.get()).resolves.toEqual(
      defaultApplicationSettings
    )
    const entries = await readdir(directory)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(
      /^application-settings\.json\.corrupt-\d+-[a-f0-9]{12}$/u
    )
    expect(await readFile(join(directory, entries[0] ?? ''), 'utf8')).toBe(
      data
    )
  })

  it('does not classify an I/O failure as corrupt settings', async () => {
    const { directory } = await createStore()
    const filePath = join(directory, 'settings-directory')
    const store = new ApplicationSettingsStore(filePath)
    await writeFile(join(directory, 'sentinel'), 'unchanged', 'utf8')
    const directoryStore = new ApplicationSettingsStore(directory)

    await expect(directoryStore.get()).rejects.toThrow(
      'Application settings could not be read'
    )
    expect(await readdir(directory)).toEqual(['sentinel'])
    await expect(store.get()).resolves.toEqual(
      defaultApplicationSettings
    )
  })

  it('serializes concurrent updates and leaves complete JSON', async () => {
    const { filePath, store } = await createStore()

    await Promise.all([
      store.update({
        checkUpdatesOnStartup: false,
        magicNotesEnabled: true
      }),
      store.update({
        checkUpdatesOnStartup: true,
        magicNotesEnabled: false
      }),
      store.update({
        checkUpdatesOnStartup: false,
        magicNotesEnabled: false
      })
    ])

    await expect(store.get()).resolves.toEqual({
      checkUpdatesOnStartup: false,
      magicNotesEnabled: false
    })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 2,
      checkUpdatesOnStartup: false,
      magicNotesEnabled: false
    })
  })

  it('continues accepting updates after a validation failure', async () => {
    const { store } = await createStore()
    await expect(
      store.update({
        checkUpdatesOnStartup: 'invalid',
        magicNotesEnabled: true
      })
    ).rejects.toThrow()

    await expect(
      store.update({
        checkUpdatesOnStartup: false,
        magicNotesEnabled: true
      })
    ).resolves.toEqual({
      checkUpdatesOnStartup: false,
      magicNotesEnabled: true
    })
  })
})
