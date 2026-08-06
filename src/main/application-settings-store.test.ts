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

  it('persists only the versioned startup update preference', async () => {
    const { directory, filePath, store } = await createStore()

    await expect(
      store.update({ checkUpdatesOnStartup: false })
    ).resolves.toEqual({ checkUpdatesOnStartup: false })
    await expect(store.get()).resolves.toEqual({
      checkUpdatesOnStartup: false
    })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      checkUpdatesOnStartup: false
    })
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp'))
    ).toEqual([])
  })

  it('creates the parent directory and can reload persisted settings', async () => {
    const { directory } = await createStore()
    const filePath = join(directory, 'nested', 'application-settings.json')
    const store = new ApplicationSettingsStore(filePath)
    await store.update({ checkUpdatesOnStartup: false })

    await expect(
      new ApplicationSettingsStore(filePath).get()
    ).resolves.toEqual({ checkUpdatesOnStartup: false })
  })

  it('strictly rejects unknown, missing, and mistyped input', async () => {
    const { directory, store } = await createStore()
    for (const input of [
      {},
      { checkUpdatesOnStartup: 'true' },
      { checkUpdatesOnStartup: true, anotherSetting: true },
      null
    ]) {
      expect(applicationSettingsSchema.safeParse(input).success).toBe(
        false
      )
      await expect(store.update(input)).rejects.toThrow()
    }
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it.each([
    '{not-json',
    JSON.stringify({ version: 2, checkUpdatesOnStartup: false }),
    JSON.stringify({
      version: 1,
      checkUpdatesOnStartup: false,
      injected: true
    }),
    JSON.stringify({ version: 1, checkUpdatesOnStartup: 'false' })
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
      store.update({ checkUpdatesOnStartup: false }),
      store.update({ checkUpdatesOnStartup: true }),
      store.update({ checkUpdatesOnStartup: false })
    ])

    await expect(store.get()).resolves.toEqual({
      checkUpdatesOnStartup: false
    })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      checkUpdatesOnStartup: false
    })
  })

  it('continues accepting updates after a validation failure', async () => {
    const { store } = await createStore()
    await expect(
      store.update({ checkUpdatesOnStartup: 'invalid' })
    ).rejects.toThrow()

    await expect(
      store.update({ checkUpdatesOnStartup: false })
    ).resolves.toEqual({ checkUpdatesOnStartup: false })
  })
})
