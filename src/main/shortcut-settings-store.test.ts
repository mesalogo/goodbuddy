import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultGlobalShortcutSettings
} from '../shared/shortcut'
import { ShortcutSettingsStore } from './shortcut-settings-store'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createStore(): Promise<{
  filePath: string
  store: ShortcutSettingsStore
}> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-shortcut-'))
  directories.push(directory)
  const filePath = join(directory, 'shortcut-settings.json')
  return { filePath, store: new ShortcutSettingsStore(filePath) }
}

describe('ShortcutSettingsStore', () => {
  it('preserves the legacy shortcut as the non-persisted default', async () => {
    const { filePath, store } = await createStore()

    await expect(store.get()).resolves.toEqual(
      defaultGlobalShortcutSettings
    )
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('persists a validated versioned shortcut and reloads it', async () => {
    const { filePath, store } = await createStore()
    await expect(
      store.update({
        enabled: false,
        accelerator: 'ctrl+alt+k'
      })
    ).resolves.toEqual({
      enabled: false,
      accelerator: 'Control+Alt+K'
    })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      enabled: false,
      accelerator: 'Control+Alt+K'
    })
    await expect(
      new ShortcutSettingsStore(filePath).get()
    ).resolves.toEqual({
      enabled: false,
      accelerator: 'Control+Alt+K'
    })
  })

  it('rejects invalid accelerators without replacing saved state', async () => {
    const { filePath, store } = await createStore()
    await store.update({
      enabled: true,
      accelerator: 'Control+Alt+K'
    })
    const saved = await readFile(filePath, 'utf8')

    await expect(
      store.update({ enabled: true, accelerator: 'K' })
    ).rejects.toThrow()
    expect(await readFile(filePath, 'utf8')).toBe(saved)
  })
})
