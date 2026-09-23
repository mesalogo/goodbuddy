import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApplicationSettingsStore,
  applicationSettingsSchema,
  applicationSettingsUpdateSchema,
  defaultApplicationSettings
} from './application-settings-store'

const temporaryDirectories: string[] = []
const managedMigrationResolver = async () => ({})

function createApplicationSettingsStore(
  filePath: string
): ApplicationSettingsStore {
  return new ApplicationSettingsStore(filePath, managedMigrationResolver)
}

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
    store: createApplicationSettingsStore(filePath)
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('ApplicationSettingsStore', () => {
  it.each([11, 12])('defaults missing supervisor preference to off in version %s through unrelated updates and reload', async (version) => {
    const { filePath, store } = await createStore()
    const legacy = { ...defaultApplicationSettings, version, lastSeenReleaseNotesVersion: null }
    delete legacy.heartbeatEnabled
    await writeFile(filePath, JSON.stringify(legacy), 'utf8')

    expect(await store.get()).toEqual({ ...defaultApplicationSettings, heartbeatEnabled: false })
    const changed = vi.fn()
    store.onChanged(changed)
    const updated = await store.update({ checkUpdatesOnStartup: false })
    expect(updated).toMatchObject({ heartbeatEnabled: false, checkUpdatesOnStartup: false })
    expect(changed).toHaveBeenCalledExactlyOnceWith(updated)
    expect(await createApplicationSettingsStore(filePath).get()).toEqual(updated)
  })

  it.each([
    { version: 11, heartbeatEnabled: true },
    { version: 11, heartbeatEnabled: false },
    { version: 12, heartbeatEnabled: true },
    { version: 12, heartbeatEnabled: false },
  ])('preserves supervisor preference $heartbeatEnabled in version $version through unrelated updates and reload', async ({ version, heartbeatEnabled }) => {
    const { filePath, store } = await createStore()
    await writeFile(filePath, JSON.stringify({
      ...defaultApplicationSettings, version, lastSeenReleaseNotesVersion: null, heartbeatEnabled,
    }), 'utf8')

    expect((await store.get()).heartbeatEnabled).toBe(heartbeatEnabled)
    expect((await store.update({ checkUpdatesOnStartup: false })).heartbeatEnabled).toBe(heartbeatEnabled)
    expect(JSON.parse(await readFile(filePath, 'utf8')).heartbeatEnabled).toBe(heartbeatEnabled)
    expect((await createApplicationSettingsStore(filePath).get()).heartbeatEnabled).toBe(heartbeatEnabled)
  })

  it('persists explicit supervisor enable and disable choices', async () => {
    const { filePath, store } = await createStore()
    for (const heartbeatEnabled of [true, false]) {
      expect((await store.update({ heartbeatEnabled })).heartbeatEnabled).toBe(heartbeatEnabled)
      await store.update({ checkUpdatesOnStartup: false })
      expect((await createApplicationSettingsStore(filePath).get()).heartbeatEnabled).toBe(heartbeatEnabled)
    }
  })

  it('defaults missing historical canvas page counts and persists updates without resetting other preferences', async () => {
    const { filePath, store } = await createStore()
    const legacy: Record<string, unknown> = { ...defaultApplicationSettings, version: 12,
      lastSeenReleaseNotesVersion: null, magicNoteCommentMode: 'after-save-manual' }
    delete legacy.magicNoteCanvasPageCount
    await writeFile(filePath, JSON.stringify(legacy))
    expect(await store.get()).toMatchObject({ magicNoteCanvasPageCount: 1, magicNoteCommentMode: 'after-save-manual' })
    const changed = vi.fn()
    store.onChanged(changed)
    expect(await store.update({ magicNoteCanvasPageCount: 8 })).toMatchObject({ magicNoteCanvasPageCount: 8 })
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ magicNoteCanvasPageCount: 8 }))
    await store.update({ magicNotesEnabled: false })
    expect(await createApplicationSettingsStore(filePath).get()).toMatchObject({ magicNoteCanvasPageCount: 8, magicNotesEnabled: false, magicNoteCommentMode: 'after-save-manual' })
    for (const count of [0, 9, -1, 1.5, '2', null]) {
      await expect(store.update({ magicNoteCanvasPageCount: count })).rejects.toThrow()
    }
    expect((await createApplicationSettingsStore(filePath).get()).magicNoteCanvasPageCount).toBe(8)
    expect((await store.update({ magicNoteCanvasPageCount: 1 })).magicNoteCanvasPageCount).toBe(1)
  })

  it.each([
    { order: ['local-inference', 'magic-notes'], expected: ['knowledge', 'heartbeat', 'local-inference', 'magic-notes'] },
    { order: ['local-inference'], expected: ['knowledge', 'heartbeat', 'local-inference', 'magic-notes'] },
    { order: ['magic-notes', 'knowledge'], expected: ['heartbeat', 'magic-notes', 'knowledge', 'local-inference'] },
    { order: [], expected: ['knowledge', 'heartbeat', 'magic-notes', 'local-inference'] },
    { order: undefined, expected: ['knowledge', 'heartbeat', 'magic-notes', 'local-inference'] },
    { order: ['local-inference', 'heartbeat', 'magic-notes', 'knowledge'], expected: ['local-inference', 'heartbeat', 'magic-notes', 'knowledge'] },
  ])('normalizes stored order $order without changing existing relative order', async ({ order, expected }) => {
    const { filePath, store } = await createStore()
    await writeFile(filePath, JSON.stringify({
      ...defaultApplicationSettings, version: 12, lastSeenReleaseNotesVersion: null,
      magicNotesEnabled: false, applicationNavigation: { order, pinned: { 'magic-notes': false } },
    }))
    const settings = await store.get()
    expect(settings.warnings).toBeUndefined()
    expect(settings.magicNotesEnabled).toBe(false)
    expect(settings.applicationNavigation).toEqual({ order: expected, pinned: { 'magic-notes': false, heartbeat: true, 'local-inference': false } })
    expect(applicationSettingsSchema.parse(settings)).toEqual(settings)
    await store.update({ checkUpdatesOnStartup: false })
    expect(JSON.parse(await readFile(filePath, 'utf8')).applicationNavigation).toEqual(settings.applicationNavigation)
    expect((await createApplicationSettingsStore(filePath).get()).applicationNavigation).toEqual(settings.applicationNavigation)
  })

  it('validates full-order writes, persists and publishes them, and rejects partial writes without mutation', async () => {
    const { store, filePath } = await createStore()
    const applicationNavigation = {
      order: ['local-inference', 'heartbeat', 'magic-notes', 'knowledge'],
      pinned: { 'magic-notes': false, heartbeat: true, 'local-inference': false },
    }
    const changed = vi.fn()
    store.onChanged(changed)
    const saved = await store.update({ applicationNavigation })
    expect(applicationSettingsSchema.parse(saved).applicationNavigation).toEqual(applicationNavigation)
    expect(changed).toHaveBeenCalledExactlyOnceWith(saved)
    const contents = await readFile(filePath, 'utf8')
    for (const order of [[], ['local-inference', 'magic-notes'], ['knowledge', 'knowledge', 'magic-notes', 'local-inference'], ['knowledge', 'heartbeat', 'magic-notes', 'invalid']]) {
      expect(applicationSettingsSchema.safeParse({ ...saved, applicationNavigation: { ...applicationNavigation, order } }).success).toBe(false)
      await expect(store.update({ applicationNavigation: { ...applicationNavigation, order } })).rejects.toThrow()
    }
    expect(await readFile(filePath, 'utf8')).toBe(contents)
    expect(changed).toHaveBeenCalledTimes(1)
    expect((await createApplicationSettingsStore(filePath).get()).applicationNavigation).toEqual(applicationNavigation)
  })

  it('keeps the confirmed snapshot when an atomic save fails', async () => {
    const { filePath, store } = await createStore()
    const confirmed = await store.get()
    const changed = vi.fn()
    store.onChanged(changed)
    await mkdir(filePath)
    await expect(store.update({ localInferenceEnabled: false })).rejects.toThrow()
    expect(await store.get()).toEqual(confirmed)
    expect(changed).not.toHaveBeenCalled()
  })

  it.each([11, 12])('defaults missing navigation and Notes fields in version %s without resetting unrelated values', async (version) => {
    const { filePath, store } = await createStore()
    const legacy: Record<string, unknown> = { ...defaultApplicationSettings, version, lastSeenReleaseNotesVersion: null, checkUpdatesOnStartup: false }
    for (const key of ['applicationNavigation', 'localInferenceEnabled', 'magicNotesEnabled', 'magicNotesShowIncompleteTodoCount']) delete legacy[key]
    await writeFile(filePath, JSON.stringify(legacy), 'utf8')
    expect(await store.get()).toEqual({ ...defaultApplicationSettings, checkUpdatesOnStartup: false })
    expect(await store.get()).toMatchObject({ localInferenceEnabled: true, applicationNavigation: defaultApplicationSettings.applicationNavigation })
    expect(await createApplicationSettingsStore(filePath).get()).toEqual(await store.get())
  })
  it.each([true, false])('preserves a saved local inference pin of %s through migration, updates and reload', async (pinned) => {
    const { filePath, store } = await createStore()
    const applicationNavigation = {
      order: ['local-inference', 'magic-notes'],
      pinned: { 'magic-notes': false, 'local-inference': pinned }
    }
    await writeFile(filePath, JSON.stringify({ ...defaultApplicationSettings, applicationNavigation, version: 11, lastSeenReleaseNotesVersion: null }), 'utf8')
    const normalized = { ...applicationNavigation, pinned: { ...applicationNavigation.pinned, heartbeat: true }, order: ['knowledge', 'heartbeat', 'local-inference', 'magic-notes'] }
    expect((await store.get()).applicationNavigation).toEqual(normalized)
    await store.update({ checkUpdatesOnStartup: false })
    expect((await createApplicationSettingsStore(filePath).get()).applicationNavigation).toEqual(normalized)
  })
  it('migrates released settings without replacing explicit false values or comment choices', async () => {
    const { filePath, store } = await createStore()
    const legacy: Record<string, unknown> = { ...defaultApplicationSettings, version: 11, lastSeenReleaseNotesVersion: null, magicNotesEnabled: false, magicNotesShowIncompleteTodoCount: false, magicNoteCommentMode: 'after-save-manual', magicNoteCommentFormat: 'structured' }
    for (const key of ['applicationNavigation', 'localInferenceEnabled']) delete legacy[key]
    await writeFile(filePath, JSON.stringify(legacy), 'utf8')
    const migrated = await store.get()
    expect(migrated).toMatchObject({ magicNotesEnabled: false, magicNotesShowIncompleteTodoCount: false, localInferenceEnabled: true, magicNoteCommentMode: 'after-save-manual', magicNoteCommentFormat: 'structured' })
    await store.update({ localInferenceEnabled: false })
    await store.update({ applicationNavigation: { ...migrated.applicationNavigation, order: [...migrated.applicationNavigation.order].reverse(), pinned: { ...migrated.applicationNavigation.pinned, 'local-inference': false } } })
    const reloaded = await createApplicationSettingsStore(filePath).get()
    expect(reloaded).toMatchObject({ magicNotesEnabled: false, magicNotesShowIncompleteTodoCount: false, localInferenceEnabled: false, magicNoteCommentMode: 'after-save-manual', magicNoteCommentFormat: 'structured' })
    expect(reloaded.applicationNavigation.order).toEqual([...migrated.applicationNavigation.order].reverse())
    expect(reloaded.applicationNavigation.pinned['local-inference']).toBe(false)
  })

  it('rejects incomplete, duplicate, unknown order and pin values without applying defaults to patches', () => {
    const navigation = defaultApplicationSettings.applicationNavigation
    for (const invalid of [
      { ...navigation, order: navigation.order.slice(1) },
      { ...navigation, order: ['knowledge', 'heartbeat', 'magic-notes', 'magic-notes'] },
      { ...navigation, order: ['knowledge', 'heartbeat', 'unknown', 'local-inference'] },
      { ...navigation, order: ['magic-notes', 'local-inference'] },
      { ...navigation, order: ['knowledge', 'local-inference'] },
      { ...navigation, order: ['heartbeat', 'local-inference'] },
      { ...navigation, pinned: { ...navigation.pinned, extra: true } },
      { ...navigation, pinned: { knowledge: true } }
    ]) expect(applicationSettingsUpdateSchema.safeParse({ applicationNavigation: invalid }).success).toBe(false)
    expect(applicationSettingsUpdateSchema.parse({ checkUpdatesOnStartup: false })).toEqual({ checkUpdatesOnStartup: false })
  })
  it('returns defaults without creating a settings file', async () => {
    const { directory, store } = await createStore()

    await expect(store.get()).resolves.toEqual(defaultApplicationSettings)
    expect(defaultApplicationSettings.heartbeatEnabled).toBe(false)
    expect(await store.get()).toMatchObject({ localInferenceEnabled: true, applicationNavigation: defaultApplicationSettings.applicationNavigation })
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('persists versioned application preferences', async () => {
    const { directory, filePath, store } = await createStore()

    await expect(
      store.update({
        checkUpdatesOnStartup: false,
        magicNotesEnabled: false,
        magicNotesShowIncompleteTodoCount: false
      })
    ).resolves.toEqual({
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: false,
      magicNotesShowIncompleteTodoCount: false,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    })
    await expect(store.get()).resolves.toEqual({
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: false,
      magicNotesShowIncompleteTodoCount: false,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      ...defaultApplicationSettings,
      version: 12,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: false,
      magicNotesShowIncompleteTodoCount: false,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined',
      lastSeenReleaseNotesVersion: null
    })
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp'))
    ).toEqual([])
  })

  it('persists the Remote Projects preference', async () => {
    const { filePath, store } = await createStore()

    await expect(
      store.update({ remoteProjectsEnabled: true })
    ).resolves.toEqual({
      ...defaultApplicationSettings,
      remoteProjectsEnabled: true
    })
    await expect(
      createApplicationSettingsStore(filePath).get()
    ).resolves.toEqual({
      ...defaultApplicationSettings,
      remoteProjectsEnabled: true
    })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 12,
      lastSeenReleaseNotesVersion: null,
      ...defaultApplicationSettings,
      remoteProjectsEnabled: true
    })
  })

  it('creates the parent directory and can reload persisted settings', async () => {
    const { directory } = await createStore()
    const filePath = join(directory, 'nested', 'application-settings.json')
    const store = createApplicationSettingsStore(filePath)
    await store.update({
      checkUpdatesOnStartup: false,
      magicNotesEnabled: false
    })

    await expect(
      createApplicationSettingsStore(filePath).get()
    ).resolves.toEqual({
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: false,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    })
  })

  it.each([1, 2])(
    'loads version %s settings missing the field with Magic Notes enabled',
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
        ...defaultApplicationSettings,
        checkUpdatesOnStartup: false,
        updateSource: 'github',
        modelDownloadSource: 'modelscope',
        localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
        conversationHtmlRenderingEnabled: true,
        remoteProjectsEnabled: false,
        magicNotesEnabled: true,
        magicNotesShowIncompleteTodoCount: true,
        magicNoteCommentMode: 'immediate',
        magicNoteCommentFormat: 'combined'
      })
    }
  )

  it('migrates version 2 Magic Notes settings with the immediate comment mode', async () => {
    const { filePath, store } = await createStore()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        checkUpdatesOnStartup: false,
        magicNotesEnabled: true
      }),
      'utf8'
    )

    await expect(store.get()).resolves.toEqual({
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    })
  })

  it('migrates version 3 settings with the combined comment format', async () => {
    const { filePath, store } = await createStore()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 3,
        checkUpdatesOnStartup: false,
        magicNotesEnabled: true,
        magicNoteCommentMode: 'after-save-manual'
      }),
      'utf8'
    )

    await expect(store.get()).resolves.toEqual({
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'after-save-manual',
      magicNoteCommentFormat: 'combined'
    })
  })

  it('migrates version 4 settings with no release notes acknowledged', async () => {
    const { filePath, store } = await createStore()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 4,
        checkUpdatesOnStartup: false,
        magicNotesEnabled: true,
        magicNoteCommentMode: 'after-save-manual',
        magicNoteCommentFormat: 'narrative'
      }),
      'utf8'
    )

    await expect(store.getLastSeenReleaseNotesVersion()).resolves.toBeNull()
    await store.setLastSeenReleaseNotesVersion('0.8.18')
    await expect(
      createApplicationSettingsStore(filePath).getLastSeenReleaseNotesVersion()
    ).resolves.toBe('0.8.18')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      ...defaultApplicationSettings,
      version: 12,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'after-save-manual',
      magicNoteCommentFormat: 'narrative',
      lastSeenReleaseNotesVersion: '0.8.18'
    })
  })

  it('migrates version 5 settings to the default GitHub update source', async () => {
    const { filePath, store } = await createStore()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 5,
        checkUpdatesOnStartup: false,
        magicNotesEnabled: true,
        magicNoteCommentMode: 'after-save-auto',
        magicNoteCommentFormat: 'structured',
        lastSeenReleaseNotesVersion: '0.8.18'
      }),
      'utf8'
    )

    await expect(store.get()).resolves.toEqual({
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'after-save-auto',
      magicNoteCommentFormat: 'structured'
    })
    await expect(store.getLastSeenReleaseNotesVersion()).resolves.toBe('0.8.18')
  })

  it('migrates version 6 to the default ModelScope source', async () => {
    const { filePath, store } = await createStore()
    const versionSix = {
      version: 6,
      checkUpdatesOnStartup: false,
      updateSource: 'mirror',
      magicNotesEnabled: true,
      magicNoteCommentMode: 'after-save-auto',
      magicNoteCommentFormat: 'structured',
      lastSeenReleaseNotesVersion: '0.8.18'
    }
    await writeFile(filePath, JSON.stringify(versionSix), 'utf8')

    await expect(store.get()).resolves.toEqual({
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'mirror',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'after-save-auto',
      magicNoteCommentFormat: 'structured'
    })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      ...defaultApplicationSettings,
      ...versionSix,
      version: 12,
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesShowIncompleteTodoCount: true
    })

    await store.update({ modelDownloadSource: 'hugging-face' })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      ...defaultApplicationSettings,
      ...versionSix,
      version: 12,
      modelDownloadSource: 'hugging-face',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesShowIncompleteTodoCount: true
    })
  })

  it('migrates version 7 to show incomplete todo counts', async () => {
    const { filePath, store } = await createStore()
    const versionSeven = {
      version: 7,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      magicNotesEnabled: true,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined',
      lastSeenReleaseNotesVersion: null
    }
    await writeFile(filePath, JSON.stringify(versionSeven), 'utf8')

    await expect(store.get()).resolves.toEqual({
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      ...defaultApplicationSettings,
      ...versionSeven,
      version: 12,
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesShowIncompleteTodoCount: true
    })
  })

  it('migrates version 8 with Remote Projects disabled', async () => {
    const { filePath, store } = await createStore()
    const versionEight = {
      version: 8,
      checkUpdatesOnStartup: false,
      updateSource: 'mirror',
      modelDownloadSource: 'hugging-face',
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: false,
      magicNoteCommentMode: 'after-save-manual',
      magicNoteCommentFormat: 'narrative',
      warnings: [{ code: 'application-settings-recovered' }],
      lastSeenReleaseNotesVersion: '0.8.18'
    }
    await writeFile(filePath, JSON.stringify(versionEight), 'utf8')

    const migratedSettings = await store.get()
    expect(migratedSettings).toEqual({
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'mirror',
      modelDownloadSource: 'hugging-face',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: false,
      magicNoteCommentMode: 'after-save-manual',
      magicNoteCommentFormat: 'narrative'
    })
    await expect(store.getLastSeenReleaseNotesVersion()).resolves.toBe('0.8.18')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      ...defaultApplicationSettings,
      ...versionEight,
      version: 12,
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false
    })

    await store.update({ checkUpdatesOnStartup: true })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      ...defaultApplicationSettings,
      ...versionEight,
      version: 12,
      checkUpdatesOnStartup: true,
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false
    })
  })

  it('persists independently resolved version 9 runtime selections exactly once', async () => {
    const { filePath } = await createStore()
    const versionNine = {
      version: 9,
      checkUpdatesOnStartup: false,
      updateSource: 'mirror',
      modelDownloadSource: 'hugging-face',
      remoteProjectsEnabled: true,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: false,
      magicNoteCommentMode: 'after-save-manual',
      magicNoteCommentFormat: 'narrative',
      lastSeenReleaseNotesVersion: '0.8.18'
    }
    await writeFile(filePath, JSON.stringify(versionNine), 'utf8')
    let resolverCalls = 0
    const store = new ApplicationSettingsStore(filePath, async () => {
      resolverCalls += 1
      return {
        nodeExecutablePath: 'C:\\Tools\\node.exe',
        pythonExecutablePath: 'relative/python'
      }
    })

    await expect(store.get()).resolves.toEqual({
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'mirror',
      modelDownloadSource: 'hugging-face',
      remoteProjectsEnabled: true,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: false,
      magicNoteCommentMode: 'after-save-manual',
      magicNoteCommentFormat: 'narrative',
      conversationHtmlRenderingEnabled: true,
      localToolEnvironment: {
        node: {
          source: 'custom',
          executablePath: 'C:\\Tools\\node.exe'
        },
        python: { source: 'managed' },
        artifactDownloadSource: 'native'
      }
    })
    expect(resolverCalls).toBe(1)

    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    expect(persisted).toEqual({
      ...defaultApplicationSettings,
      ...versionNine,
      version: 12,
      conversationHtmlRenderingEnabled: true,
      localToolEnvironment: {
        node: {
          source: 'custom',
          executablePath: 'C:\\Tools\\node.exe'
        },
        python: { source: 'managed' },
        artifactDownloadSource: 'native'
      }
    })
    const reloaded = new ApplicationSettingsStore(filePath, async () => {
      throw new Error('A persisted migration must not resolve PATH again')
    })
    await expect(reloaded.get()).resolves.toEqual(await store.get())
  })

  it('strictly rejects incomplete full settings', () => {
    expect(
      applicationSettingsSchema.safeParse(defaultApplicationSettings).success
    ).toBe(true)
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
      expect(applicationSettingsSchema.safeParse(input).success).toBe(false)
    }
  })

  it('strictly rejects empty, unknown, and mistyped updates', async () => {
    const { directory, store } = await createStore()
    for (const input of [
      {},
      { checkUpdatesOnStartup: 'true' },
      { modelDownloadSource: 'automatic' },
      { remoteProjectsEnabled: 'false' },
      { anotherSetting: true },
      null
    ]) {
      expect(applicationSettingsUpdateSchema.safeParse(input).success).toBe(
        false
      )
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
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    })
  })

  it('persists the selected mirror update source', async () => {
    const { filePath, store } = await createStore()

    await expect(store.update({ updateSource: 'mirror' })).resolves.toEqual({
      ...defaultApplicationSettings,
      updateSource: 'mirror'
    })
    await expect(
      createApplicationSettingsStore(filePath).get()
    ).resolves.toEqual({
      ...defaultApplicationSettings,
      updateSource: 'mirror'
    })
  })

  it('persists disabling conversation HTML rendering', async () => {
    const { filePath, store } = await createStore()

    await expect(
      store.update({ conversationHtmlRenderingEnabled: false })
    ).resolves.toEqual({
      ...defaultApplicationSettings,
      conversationHtmlRenderingEnabled: false
    })
    await expect(
      createApplicationSettingsStore(filePath).get()
    ).resolves.toEqual({
      ...defaultApplicationSettings,
      conversationHtmlRenderingEnabled: false
    })
  })

  it('enables conversation HTML rendering when migrating version 10 settings', async () => {
    const { filePath, store } = await createStore()
    const versionTenSettings: Record<string, unknown> = {
      ...defaultApplicationSettings,
      version: 10,
      lastSeenReleaseNotesVersion: '0.8.18'
    }
    delete versionTenSettings.conversationHtmlRenderingEnabled
    await writeFile(filePath, JSON.stringify(versionTenSettings), 'utf8')

    await expect(store.get()).resolves.toEqual(defaultApplicationSettings)
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      ...versionTenSettings,
      version: 12,
      conversationHtmlRenderingEnabled: true
    })
  })

  it.each([
    '{not-json',
    JSON.stringify({
      version: 3,
      checkUpdatesOnStartup: false,
      magicNotesEnabled: 'false'
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

    await expect(store.get()).resolves.toEqual({
      ...defaultApplicationSettings,
      warnings: [{ code: 'application-settings-recovered' }]
    })
    const entries = await readdir(directory)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(
      /^application-settings\.json\.corrupt-\d+-[a-f0-9]{12}$/u
    )
    expect(await readFile(join(directory, entries[0] ?? ''), 'utf8')).toBe(data)
  })

  it('preserves settings created by a newer unsupported version', async () => {
    const { directory, filePath, store } = await createStore()
    const futureSettings = JSON.stringify({
      version: 99,
      futureField: 'keep-me'
    })
    await writeFile(filePath, futureSettings, 'utf8')

    await expect(store.get()).rejects.toThrow('不支持应用设置版本 99')
    expect(await readFile(filePath, 'utf8')).toBe(futureSettings)
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith('application-settings.json.corrupt-')
      )
    ).toBe(false)
  })

  it('does not classify an I/O failure as corrupt settings', async () => {
    const { directory } = await createStore()
    const filePath = join(directory, 'settings-directory')
    const store = createApplicationSettingsStore(filePath)
    await writeFile(join(directory, 'sentinel'), 'unchanged', 'utf8')
    const directoryStore = createApplicationSettingsStore(directory)

    await expect(directoryStore.get()).rejects.toThrow(
      'Application settings could not be read'
    )
    expect(await readdir(directory)).toEqual(['sentinel'])
    await expect(store.get()).resolves.toEqual(defaultApplicationSettings)
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
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: false,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      ...defaultApplicationSettings,
      version: 12,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: false,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined',
      lastSeenReleaseNotesVersion: null
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
      ...defaultApplicationSettings,
      checkUpdatesOnStartup: false,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      localToolEnvironment: defaultApplicationSettings.localToolEnvironment,
      conversationHtmlRenderingEnabled: true,
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'immediate',
      magicNoteCommentFormat: 'combined'
    })
  })
})
