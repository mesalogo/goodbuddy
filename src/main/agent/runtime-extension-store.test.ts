import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeExtensionCatalogEntry } from '../../shared/runtime-extension-contracts'
import {
  RuntimeExtensionStore,
  type RuntimeExtensionStoreDependencies
} from './runtime-extension-store'

const temporaryDirectories: string[] = []

function catalogEntry(version = '1.0.0'): RuntimeExtensionCatalogEntry {
  return {
    id: 'test-extension',
    package: {
      name: '@goodbuddy/test-extension',
      version
    },
    displayName: 'Test extension',
    description: 'A deterministic extension store fixture.'
  }
}

async function defaultInstall(input: {
  destinationDirectory: string
}): Promise<{ entrypoint: string; integrity: string }> {
  const distribution = join(input.destinationDirectory, 'dist')
  await mkdir(distribution, { recursive: true })
  await writeFile(join(distribution, 'index.js'), 'export default {}')
  return {
    entrypoint: 'dist/index.js',
    integrity: `sha512-${Buffer.from('verified').toString('base64')}`
  }
}

async function fixture(input: {
  entries?: RuntimeExtensionCatalogEntry[]
  install?: RuntimeExtensionStoreDependencies['install']
  temporaryIds?: string[]
  marketplaceEnabled?: boolean
} = {}): Promise<{
  userDataPath: string
  store: RuntimeExtensionStore
  dependencies: RuntimeExtensionStoreDependencies
}> {
  const userDataPath = await mkdtemp(
    join(tmpdir(), 'goodbuddy-extension-store-')
  )
  temporaryDirectories.push(userDataPath)
  const entries = input.entries ?? [catalogEntry()]
  const temporaryIds = input.temporaryIds ?? ['install-one']
  const dependencies: RuntimeExtensionStoreDependencies = {
    catalog: {
      list: vi.fn(async () => entries)
    },
    install: vi.fn(input.install ?? defaultInstall),
    now: () => new Date('2026-08-16T00:00:00.000Z'),
    temporaryId: () => {
      const id = temporaryIds.shift()
      if (!id) {
        throw new Error('No fixture temporary ID remains')
      }
      return id
    }
  }
  const store = new RuntimeExtensionStore(userDataPath, dependencies)
  if (input.marketplaceEnabled ?? true) {
    await store.apply({
      type: 'set-marketplace-enabled',
      enabled: true
    })
  }
  return {
    userDataPath,
    dependencies,
    store
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('RuntimeExtensionStore', () => {
  it('keeps a fresh marketplace disabled without loading the catalog', async () => {
    const { store, dependencies } = await fixture({
      marketplaceEnabled: false
    })
    const entry = catalogEntry()

    await expect(store.getSnapshot()).resolves.toEqual({
      marketplaceEnabled: false,
      catalog: [],
      installed: []
    })
    expect(dependencies.catalog.list).not.toHaveBeenCalled()
    await expect(
      store.apply({
        type: 'install',
        extensionId: entry.id,
        package: entry.package
      })
    ).rejects.toThrow('marketplace is disabled')

    await expect(
      store.applyWithResult({
        type: 'set-marketplace-enabled',
        enabled: true
      })
    ).resolves.toMatchObject({
      changed: true,
      snapshot: { marketplaceEnabled: true }
    })
    await expect(store.getSnapshot()).resolves.toMatchObject({
      marketplaceEnabled: true,
      catalog: [entry]
    })
  })

  it('keeps the marketplace enabled when migrating installed version 1 state', async () => {
    const { userDataPath, dependencies } = await fixture({
      marketplaceEnabled: false
    })
    const entry = catalogEntry()
    const extensionDirectory = join(
      userDataPath,
      'runtime-extensions',
      'extensions',
      entry.id
    )
    await mkdir(join(extensionDirectory, 'dist'), { recursive: true })
    const entrypoint = join(extensionDirectory, 'dist', 'index.js')
    await writeFile(entrypoint, 'export default {}')
    await writeFile(
      join(userDataPath, 'runtime-extensions', 'store.json'),
      JSON.stringify({
        version: 1,
        installed: [
          {
            id: entry.id,
            package: entry.package,
            entrypoint,
            installedAt: '2026-08-16T00:00:00.000Z',
            enabled: true,
            configuration: {}
          }
        ]
      }),
      'utf8'
    )

    const migrated = new RuntimeExtensionStore(
      userDataPath,
      dependencies
    )
    await expect(migrated.getSnapshot()).resolves.toMatchObject({
      marketplaceEnabled: true,
      installed: [
        expect.objectContaining({
          id: entry.id,
          enabled: true
        })
      ]
    })
    await expect(
      readFile(
        join(userDataPath, 'runtime-extensions', 'store.json'),
        'utf8'
      ).then((value) => JSON.parse(value) as unknown)
    ).resolves.toMatchObject({
      version: 2,
      marketplaceEnabled: true
    })
  })

  it('installs one exact, integrity-verified package directory', async () => {
    const { userDataPath, store, dependencies } = await fixture()
    const entry = catalogEntry()

    const snapshot = await store.apply({
      type: 'install',
      extensionId: entry.id,
      package: entry.package
    })

    const extensionDirectory = join(
      userDataPath,
      'runtime-extensions',
      'extensions',
      entry.id
    )
    expect(snapshot.installed).toEqual([
      {
        id: entry.id,
        package: entry.package,
        installedAt: '2026-08-16T00:00:00.000Z',
        enabled: true,
        configuration: {},
        integrity: `sha512-${Buffer.from('verified').toString('base64')}`
      }
    ])
    await expect(store.getEnabledExtensions()).resolves.toEqual([
      expect.objectContaining({
        id: entry.id,
        entrypoint: join(extensionDirectory, 'dist', 'index.js')
      })
    ])
    await expect(
      readFile(join(extensionDirectory, 'dist', 'index.js'), 'utf8')
    ).resolves.toBe('export default {}')
    expect(dependencies.install).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationDirectory: expect.stringMatching(
          /\.staging[\\/]install-one$/u
        )
      })
    )
  })

  it('hides the marketplace without disabling installed plugins', async () => {
    const { store, dependencies } = await fixture()
    const entry = catalogEntry()
    await store.apply({
      type: 'install',
      extensionId: entry.id,
      package: entry.package
    })
    vi.mocked(dependencies.catalog.list).mockClear()

    await expect(
      store.apply({
        type: 'set-marketplace-enabled',
        enabled: false
      })
    ).resolves.toMatchObject({
      marketplaceEnabled: false,
      catalog: [],
      installed: [
        expect.objectContaining({
          id: entry.id,
          enabled: true
        })
      ]
    })
    expect(dependencies.catalog.list).not.toHaveBeenCalled()
    await expect(store.getEnabledExtensions()).resolves.toEqual([
      expect.objectContaining({ id: entry.id })
    ])
  })

  it('leaves an existing installation untouched when an upgrade fails', async () => {
    const first = catalogEntry('1.0.0')
    const second = catalogEntry('2.0.0')
    const { store, dependencies } = await fixture({
      entries: [first],
      temporaryIds: ['install-one', 'install-two']
    })
    await store.apply({
      type: 'install',
      extensionId: first.id,
      package: first.package
    })
    await store.apply({
      type: 'configure',
      extensionId: first.id,
      configuration: { nested: { value: 1 } }
    })
    await store.apply({
      type: 'set-enabled',
      extensionId: first.id,
      enabled: true
    })
    vi.mocked(dependencies.catalog.list).mockResolvedValue([second])
    vi.mocked(dependencies.install).mockRejectedValueOnce(
      new Error('Entrypoint contract mismatch')
    )

    await expect(
      store.apply({
        type: 'install',
        extensionId: second.id,
        package: second.package
      })
    ).rejects.toThrow('Entrypoint contract mismatch')

    expect((await store.getSnapshot()).installed[0]).toMatchObject({
      package: first.package,
      enabled: true,
      configuration: { nested: { value: 1 } }
    })
  })

  it('rejects installer entrypoints outside the managed package', async () => {
    const entry = catalogEntry()
    const fixtureValue = await fixture({
      entries: [entry],
      install: async () => ({ entrypoint: '../outside.js' })
    })
    await expect(
      fixtureValue.store.apply({
        type: 'install',
        extensionId: entry.id,
        package: entry.package
      })
    ).rejects.toThrow('invalid entrypoint')
    expect(
      (await fixtureValue.store.getSnapshot()).installed
    ).toEqual([])
  })

  it('configures, launches, and disables startup failures', async () => {
    const { store } = await fixture()
    const entry = catalogEntry()
    await store.apply({
      type: 'install',
      extensionId: entry.id,
      package: entry.package
    })
    await store.apply({
      type: 'configure',
      extensionId: entry.id,
      configuration: {
        endpoint: 'https://example.com',
        options: { retries: 2, tags: ['one', 'two'] }
      }
    })
    await expect(store.getEnabledExtensions()).resolves.toEqual([
      expect.objectContaining({
        id: entry.id,
        configuration: {
          endpoint: 'https://example.com',
          options: { retries: 2, tags: ['one', 'two'] }
        }
      })
    ])

    await store.markStartupFailed([entry.id, 'not-installed'])
    expect((await store.getSnapshot()).installed[0]).toMatchObject({
      enabled: false,
      lastError: 'startup-failed'
    })
    await expect(store.getEnabledExtensions()).resolves.toEqual([])
  })

  it('reports semantic no-op mutations without refreshing the catalog', async () => {
    const { store, dependencies } = await fixture()
    const entry = catalogEntry()
    await store.apply({
      type: 'install',
      extensionId: entry.id,
      package: entry.package
    })
    await store.apply({
      type: 'configure',
      extensionId: entry.id,
      configuration: { first: 1, second: 2 }
    })
    vi.mocked(dependencies.catalog.list).mockClear()

    await expect(
      store.applyWithResult({
        type: 'configure',
        extensionId: entry.id,
        configuration: { second: 2, first: 1 }
      })
    ).resolves.toMatchObject({ changed: false })
    await expect(
      store.applyWithResult({
        type: 'set-enabled',
        extensionId: entry.id,
        enabled: true
      })
    ).resolves.toMatchObject({ changed: false })
    expect(dependencies.catalog.list).not.toHaveBeenCalled()
  })

  it('keeps installed extensions manageable while the catalog is offline', async () => {
    const { store, dependencies } = await fixture()
    const entry = catalogEntry()
    await store.apply({
      type: 'install',
      extensionId: entry.id,
      package: entry.package
    })
    vi.mocked(dependencies.catalog.list).mockRejectedValue(
      new Error('npm registry unavailable')
    )

    await expect(store.getSnapshot()).resolves.toMatchObject({
      catalog: [],
      catalogError: 'npm registry unavailable',
      installed: [
        expect.objectContaining({
          id: entry.id,
          enabled: true
        })
      ]
    })
    vi.mocked(dependencies.catalog.list).mockClear()
    await expect(
      store.apply({
        type: 'set-enabled',
        extensionId: entry.id,
        enabled: false
      })
    ).resolves.toMatchObject({
      catalog: [],
      catalogError: 'npm registry unavailable',
      installed: [
        expect.objectContaining({
          id: entry.id,
          enabled: false
        })
      ]
    })
    expect(dependencies.catalog.list).not.toHaveBeenCalled()
  })

  it('serializes mutations and removes only its managed extension directory', async () => {
    const { userDataPath, store } = await fixture()
    const entry = catalogEntry()
    const outsidePath = join(userDataPath, 'outside.txt')
    await writeFile(outsidePath, 'preserve me')
    await store.apply({
      type: 'install',
      extensionId: entry.id,
      package: entry.package
    })

    const configured = store.apply({
      type: 'configure',
      extensionId: entry.id,
      configuration: { order: 1 }
    })
    const enabled = store.apply({
      type: 'set-enabled',
      extensionId: entry.id,
      enabled: true
    })
    await Promise.all([configured, enabled])
    expect((await store.getSnapshot()).installed[0]).toMatchObject({
      enabled: true,
      configuration: { order: 1 }
    })

    await store.apply({ type: 'remove', extensionId: entry.id })
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe('preserve me')
    expect((await store.getSnapshot()).installed).toEqual([])
    await expect(
      readdir(join(userDataPath, 'runtime-extensions', 'extensions'))
    ).resolves.toEqual([])
  })
})
