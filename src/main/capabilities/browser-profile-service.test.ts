import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserProfileService,
  FileBrowserProfileStore,
  MemoryBrowserProfileStore
} from './browser-profile-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('BrowserProfileService', () => {
  it('defaults new profiles to isolated managed mode and migrates version 1', async () => {
    const legacyId = 'af6774e4-39e0-4479-b81b-42ec0f85c353'
    const store = new MemoryBrowserProfileStore({
      version: 1,
      profiles: [{ id: legacyId, name: '旧配置' }]
    })
    const migrated = await new BrowserProfileService(store).getSnapshot()

    expect(migrated).toEqual({
      version: 2,
      profiles: [
        {
          id: legacyId,
          name: '旧配置',
          mode: 'managed-isolated',
          references: []
        }
      ],
      defaultProfileId: legacyId
    })

    const created = await new BrowserProfileService(
      new MemoryBrowserProfileStore()
    ).createProfile('隔离浏览器')
    expect(created.profiles[0]).toMatchObject({
      name: '隔离浏览器',
      mode: 'managed-isolated',
      references: []
    })
    expect(created.defaultProfileId).toBe(created.profiles[0]?.id)
  })

  it('persists loaded state only when migration changes it', async () => {
    const profileId = 'af6774e4-39e0-4479-b81b-42ec0f85c353'
    const currentStore = {
      load: vi.fn(async () => ({
        version: 2,
        profiles: [
          {
            id: profileId,
            name: '当前配置',
            mode: 'managed-isolated',
            references: []
          }
        ],
        defaultProfileId: profileId
      })),
      save: vi.fn(async () => undefined)
    }
    const current = new BrowserProfileService(currentStore)

    await current.getSnapshot()
    await current.getSnapshot()

    expect(currentStore.load).toHaveBeenCalledOnce()
    expect(currentStore.save).not.toHaveBeenCalled()

    const legacyStore = {
      load: vi.fn(async () => ({
        version: 1,
        profiles: [{ id: profileId, name: '旧配置' }]
      })),
      save: vi.fn(async () => undefined)
    }
    await new BrowserProfileService(legacyStore).getSnapshot()
    expect(legacyStore.save).toHaveBeenCalledOnce()
    expect(legacyStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2 })
    )
  })

  it('persists only strict browser metadata without arguments or environment', async () => {
    const service = new BrowserProfileService(new MemoryBrowserProfileStore())
    const state = await service.createProfile('浏览器')
    const id = state.profiles[0]?.id
    if (!id) {
      throw new Error('Expected browser profile')
    }

    await expect(
      service.selectBrowser(id, {
        executablePath: resolve(process.execPath),
        displayName: 'Selected browser',
        source: 'user-selected',
        args: ['--remote-debugging-port=1']
      } as never)
    ).rejects.toThrow()
    await expect(
      service.selectBrowser(id, {
        executablePath: resolve(process.execPath),
        displayName: 'Selected browser',
        source: 'user-selected',
        env: { TOKEN: 'secret' }
      } as never)
    ).rejects.toThrow()
  })

  it('blocks deletion while a profile is referenced', async () => {
    const service = new BrowserProfileService(new MemoryBrowserProfileStore())
    const created = await service.createProfile('自动化配置')
    const id = created.profiles[0]?.id
    if (!id) {
      throw new Error('Expected browser profile')
    }
    const reference = { kind: 'automation' as const, id: 'job:daily-check' }
    await service.addReference(id, reference)

    await expect(service.deleteProfile(id)).rejects.toThrow('Referenced')
    await service.removeReference(id, reference)
    await expect(service.deleteProfile(id)).resolves.toMatchObject({
      profiles: [],
      defaultProfileId: null
    })
  })

  it('uses atomic files under the owned root and rejects a symlink root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-browser-store-'))
    temporaryDirectories.push(directory)
    const root = join(directory, 'owned')
    const outsideRoot = join(directory, 'outside')
    const outside = join(outsideRoot, 'browser-profiles.json')
    await mkdir(outsideRoot)
    await writeFile(outside, '{"sentinel":true}', 'utf8')
    await symlink(outsideRoot, root, 'junction')
    const service = new BrowserProfileService(
      new FileBrowserProfileStore(root)
    )

    await expect(service.getSnapshot()).rejects.toThrow('real directory')
    await expect(readFile(outside, 'utf8')).resolves.toBe('{"sentinel":true}')
  })

  it('rejects invalid defaults and unknown persisted properties', async () => {
    const unknownId = 'b7f29e4c-1c4a-4aa0-ac58-5165451dde07'
    const service = new BrowserProfileService(
      new MemoryBrowserProfileStore({
        version: 2,
        profiles: [],
        defaultProfileId: unknownId,
        args: ['--unsafe']
      })
    )
    await expect(service.getSnapshot()).rejects.toThrow()
  })
})
