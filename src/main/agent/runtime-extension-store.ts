import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  runtimeExtensionActionSchema,
  runtimeExtensionCatalogEntrySchema,
  runtimeExtensionIdSchema,
  runtimeExtensionInstalledStateSchema,
  runtimeExtensionStartupFailureCode,
  type RuntimeExtensionAction,
  type RuntimeExtensionCatalogEntry,
  type RuntimeExtensionConfiguration,
  type RuntimeExtensionExactPackage,
  type RuntimeExtensionInstalledState,
  type RuntimeExtensionMarketplaceInstalledState,
  type RuntimeExtensionMarketplaceSnapshot
} from '../../shared/runtime-extension-contracts'
import {
  isMissingFileError,
  writeJsonFileAtomically
} from '../settings-file-utils'

const managedDirectoryName = 'runtime-extensions'
const stateFileName = 'store.json'

const version1StoredStateSchema = z
  .object({
    version: z.literal(1),
    installed: z.array(runtimeExtensionInstalledStateSchema)
  })
  .strict()

const storedStateSchema = z
  .object({
    version: z.literal(2),
    marketplaceEnabled: z.boolean(),
    installed: z.array(runtimeExtensionInstalledStateSchema)
  })
  .strict()

const storedStateFileSchema = z.union([
  storedStateSchema,
  version1StoredStateSchema
])

type StoredState = z.infer<typeof storedStateSchema>

export interface RuntimeExtensionCatalog {
  list(): Promise<readonly RuntimeExtensionCatalogEntry[]>
}

export interface RuntimeExtensionStoreDependencies {
  catalog: RuntimeExtensionCatalog
  install(input: {
    entry: RuntimeExtensionCatalogEntry
    destinationDirectory: string
  }): Promise<{
    entrypoint: string
    integrity?: string
  }>
  now?: () => Date
  temporaryId?: () => string
}

export interface EnabledRuntimeExtension {
  id: string
  entrypoint: string
  configuration: RuntimeExtensionConfiguration
}

export type RuntimeExtensionApplyResult = {
  snapshot: RuntimeExtensionMarketplaceSnapshot
  changed: boolean
}

function emptyState(): StoredState {
  return {
    version: 2,
    marketplaceEnabled: false,
    installed: []
  }
}

function compareIds(
  left: { id: string },
  right: { id: string }
): number {
  return left.id.localeCompare(right.id, 'en')
}

function packagesEqual(
  left: RuntimeExtensionExactPackage,
  right: RuntimeExtensionExactPackage
): boolean {
  return left.name === right.name && left.version === right.version
}

function marketplaceInstalledState(
  extension: RuntimeExtensionInstalledState
): RuntimeExtensionMarketplaceInstalledState {
  return {
    id: extension.id,
    package: extension.package,
    installedAt: extension.installedAt,
    enabled: extension.enabled,
    configuration: extension.configuration,
    ...(extension.integrity
      ? { integrity: extension.integrity }
      : {}),
    ...(extension.lastError
      ? { lastError: extension.lastError }
      : {})
  }
}

export class RuntimeExtensionStore {
  readonly managedRoot: string

  private readonly statePath: string
  private state?: StoredState
  private stateLoad?: Promise<StoredState>
  private canonicalRoot?: string
  private mutationQueue: Promise<void> = Promise.resolve()
  private catalog: RuntimeExtensionCatalogEntry[] = []
  private catalogError?: string

  constructor(
    userDataPath: string,
    private readonly dependencies: RuntimeExtensionStoreDependencies
  ) {
    if (!isAbsolute(userDataPath)) {
      throw new Error('GoodBuddy userData path must be absolute')
    }
    this.managedRoot = resolve(userDataPath, managedDirectoryName)
    this.statePath = join(this.managedRoot, stateFileName)
  }

  async getSnapshot(): Promise<RuntimeExtensionMarketplaceSnapshot> {
    const state = await this.load()
    if (!state.marketplaceEnabled) {
      this.catalog = []
      this.catalogError = undefined
      return this.marketplaceSnapshot(state)
    }
    try {
      await this.loadCatalog()
    } catch (error) {
      this.catalog = []
      this.catalogError =
        error instanceof Error && error.message.trim()
          ? error.message.trim().slice(0, 1_000)
          : 'Extension catalog is unavailable.'
    }
    return this.marketplaceSnapshot(state)
  }

  async apply(
    action: RuntimeExtensionAction
  ): Promise<RuntimeExtensionMarketplaceSnapshot> {
    return (await this.applyWithResult(action)).snapshot
  }

  async applyWithResult(
    action: RuntimeExtensionAction
  ): Promise<RuntimeExtensionApplyResult> {
    const parsed = runtimeExtensionActionSchema.parse(action)
    const changed = await this.serialize(async () => {
      switch (parsed.type) {
        case 'set-marketplace-enabled':
          return this.setMarketplaceEnabled(parsed.enabled)
        case 'install':
          await this.install(parsed.extensionId, parsed.package)
          return true
        case 'set-enabled':
          return this.setEnabled(parsed.extensionId, parsed.enabled)
        case 'remove':
          await this.remove(parsed.extensionId)
          return true
        case 'configure':
          return this.configure(
            parsed.extensionId,
            parsed.configuration
          )
      }
    })
    return {
      snapshot: this.marketplaceSnapshot(await this.load()),
      changed
    }
  }

  async getEnabledExtensions(): Promise<EnabledRuntimeExtension[]> {
    const state = await this.load()
    return state.installed
      .filter((extension) => extension.enabled)
      .sort(compareIds)
      .map(({ id, entrypoint, configuration }) => ({
        id,
        entrypoint,
        configuration
      }))
  }

  markStartupFailed(ids: readonly string[]): Promise<void> {
    const parsedIds = z.array(runtimeExtensionIdSchema).parse(ids)
    return this.serialize(async () => {
      const failed = new Set(parsedIds)
      const state = await this.load()
      const installed = state.installed.map((extension) =>
        failed.has(extension.id)
          ? {
              ...extension,
              enabled: false,
              lastError: runtimeExtensionStartupFailureCode
            }
          : extension
      )
      if (
        installed.some(
          (extension, index) => extension !== state.installed[index]
        )
      ) {
        await this.persistAndSet({ ...state, installed })
      }
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private load(): Promise<StoredState> {
    if (this.state) {
      return Promise.resolve(this.state)
    }
    if (!this.stateLoad) {
      this.stateLoad = this.readState().finally(() => {
        this.stateLoad = undefined
      })
    }
    return this.stateLoad
  }

  private async readState(): Promise<StoredState> {
    await this.initialize()
    try {
      const status = await lstat(this.statePath)
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink > 1
      ) {
        throw new Error('Extension store state must be a regular file')
      }
      await this.assertExistingPathContained(this.statePath)
      const stored = storedStateFileSchema.parse(
        JSON.parse(await readFile(this.statePath, 'utf8')) as unknown
      )
      const parsed: StoredState =
        stored.version === 1
          ? {
              version: 2,
              marketplaceEnabled: stored.installed.length > 0,
              installed: stored.installed
            }
          : stored
      for (const extension of parsed.installed) {
        this.assertExtensionEntrypoint(extension)
      }
      if (stored.version === 1) {
        await this.persist(parsed)
      }
      this.state = parsed
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error
      }
      this.state = emptyState()
      await this.persist(this.state)
    }
    return this.state
  }

  private async initialize(): Promise<void> {
    await mkdir(this.managedRoot, { recursive: true, mode: 0o700 })
    const status = await lstat(this.managedRoot)
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error('Extension managed root must be a real directory')
    }
    this.canonicalRoot = await realpath(this.managedRoot)
    await this.createManagedDirectory('extensions')
    await this.createManagedDirectory('.staging')
  }

  private async loadCatalog(): Promise<RuntimeExtensionCatalogEntry[]> {
    const catalog = (await this.dependencies.catalog.list()).map((entry) =>
      runtimeExtensionCatalogEntrySchema.parse(entry)
    )
    const ids = new Set<string>()
    for (const entry of catalog) {
      if (ids.has(entry.id)) {
        throw new Error(`Duplicate extension catalog ID: ${entry.id}`)
      }
      ids.add(entry.id)
    }
    this.catalog = catalog.sort(compareIds)
    this.catalogError = undefined
    return this.catalog
  }

  private async install(
    extensionId: string,
    requestedPackage: RuntimeExtensionExactPackage
  ): Promise<void> {
    const state = await this.load()
    if (!state.marketplaceEnabled) {
      throw new Error('The DSH plugin marketplace is disabled')
    }
    const catalog = await this.loadCatalog()
    const entry = catalog.find(
      (candidate) =>
        candidate.id === extensionId &&
        packagesEqual(candidate.package, requestedPackage)
    )
    if (!entry) {
      throw new Error('The exact extension package is not in the catalog')
    }

    const temporaryId =
      this.dependencies.temporaryId?.() ?? randomUUID()
    runtimeExtensionIdSchema.parse(temporaryId)
    const stagedDirectory = await this.createFreshManagedDirectory(
      '.staging',
      temporaryId
    )
    const backupDirectory = this.managedPath(
      '.staging',
      `${temporaryId}-previous`
    )
    const finalDirectory = this.extensionDirectory(extensionId)
    let previousMoved = false
    let stagedMoved = false
    try {
      const installedPackage = await this.dependencies.install({
        entry,
        destinationDirectory: stagedDirectory
      })
      await this.resolveEntrypoint(
        stagedDirectory,
        installedPackage.entrypoint
      )

      if (await this.pathExists(finalDirectory)) {
        await rename(finalDirectory, backupDirectory)
        previousMoved = true
      }
      await rename(stagedDirectory, finalDirectory)
      stagedMoved = true
      const entrypoint = resolve(
        finalDirectory,
        installedPackage.entrypoint
      )
      const existing = state.installed.find(
        (extension) => extension.id === extensionId
      )
      const installed: RuntimeExtensionInstalledState = {
        id: extensionId,
        package: entry.package,
        entrypoint,
        installedAt: (
          this.dependencies.now?.() ?? new Date()
        ).toISOString(),
        enabled: existing?.enabled ?? true,
        configuration: existing?.configuration ?? {},
        ...(installedPackage.integrity
          ? { integrity: installedPackage.integrity }
          : {})
      }
      await this.persistAndSet(
        this.replaceInstalled(state, installed)
      )
      if (previousMoved) {
        await this.removeManagedTree(backupDirectory).catch(() => undefined)
      }
    } catch (error) {
      if (stagedMoved) {
        await this.removeManagedTree(finalDirectory)
      }
      if (previousMoved) {
        await rename(backupDirectory, finalDirectory)
      }
      throw error
    } finally {
      await this.removeManagedTree(stagedDirectory).catch(() => undefined)
    }
  }

  private async setEnabled(
    extensionId: string,
    enabled: boolean
  ): Promise<boolean> {
    const state = await this.load()
    const extension = this.requireInstalled(state, extensionId)
    if (
      extension.enabled === enabled &&
      (!enabled || !extension.lastError)
    ) {
      return false
    }
    const updated = {
      ...extension,
      enabled,
      ...(enabled ? { lastError: undefined } : {})
    }
    await this.persistAndSet(this.replaceInstalled(state, updated))
    return true
  }

  private async setMarketplaceEnabled(
    enabled: boolean
  ): Promise<boolean> {
    const state = await this.load()
    if (state.marketplaceEnabled === enabled) {
      return false
    }
    await this.persistAndSet({
      ...state,
      marketplaceEnabled: enabled
    })
    if (!enabled) {
      this.catalog = []
      this.catalogError = undefined
    }
    return true
  }

  private async configure(
    extensionId: string,
    configuration: RuntimeExtensionConfiguration
  ): Promise<boolean> {
    const state = await this.load()
    const extension = this.requireInstalled(state, extensionId)
    if (isDeepStrictEqual(extension.configuration, configuration)) {
      return false
    }
    await this.persistAndSet(
      this.replaceInstalled(state, { ...extension, configuration })
    )
    return true
  }

  private marketplaceSnapshot(
    state: StoredState
  ): RuntimeExtensionMarketplaceSnapshot {
    return {
      marketplaceEnabled: state.marketplaceEnabled,
      catalog: this.catalog,
      installed: [...state.installed]
        .sort(compareIds)
        .map(marketplaceInstalledState),
      ...(this.catalogError
        ? { catalogError: this.catalogError }
        : {})
    }
  }

  private async remove(extensionId: string): Promise<void> {
    const state = await this.load()
    this.requireInstalled(state, extensionId)
    const finalDirectory = this.extensionDirectory(extensionId)
    const trashDirectory = this.managedPath(
      '.staging',
      `${randomUUID()}-removed`
    )
    let moved = false
    if (await this.pathExists(finalDirectory)) {
      await rename(finalDirectory, trashDirectory)
      moved = true
    }
    try {
      await this.persistAndSet({
        ...state,
        installed: state.installed.filter(
          (extension) => extension.id !== extensionId
        )
      })
    } catch (error) {
      if (moved) {
        await rename(trashDirectory, finalDirectory)
      }
      throw error
    }
    if (moved) {
      await this.removeManagedTree(trashDirectory).catch(() => undefined)
    }
  }

  private requireInstalled(
    state: StoredState,
    extensionId: string
  ): RuntimeExtensionInstalledState {
    const extension = state.installed.find(
      (candidate) => candidate.id === extensionId
    )
    if (!extension) {
      throw new Error(`Extension is not installed: ${extensionId}`)
    }
    return extension
  }

  private replaceInstalled(
    state: StoredState,
    extension: RuntimeExtensionInstalledState
  ): StoredState {
    return storedStateSchema.parse({
      ...state,
      installed: state.installed
        .filter((candidate) => candidate.id !== extension.id)
        .concat(extension)
        .sort(compareIds)
    })
  }

  private async persistAndSet(state: StoredState): Promise<void> {
    await this.persist(state)
    this.state = state
  }

  private persist(state: StoredState): Promise<void> {
    return writeJsonFileAtomically(
      this.statePath,
      storedStateSchema.parse(state)
    )
  }

  private assertExtensionEntrypoint(
    extension: RuntimeExtensionInstalledState
  ): void {
    if (!isAbsolute(extension.entrypoint)) {
      throw new Error('Installed extension entrypoint must be absolute')
    }
    const directory = this.extensionDirectory(extension.id)
    this.assertContained(directory, extension.entrypoint)
  }

  private extensionDirectory(extensionId: string): string {
    runtimeExtensionIdSchema.parse(extensionId)
    return this.managedPath('extensions', extensionId)
  }

  private managedPath(...segments: string[]): string {
    const path = resolve(this.managedRoot, ...segments)
    this.assertContained(this.managedRoot, path)
    return path
  }

  private assertContained(root: string, path: string): void {
    const relativePath = relative(root, path)
    if (
      relativePath === '' ||
      (!relativePath.startsWith(`..${sep}`) &&
        relativePath !== '..' &&
        !isAbsolute(relativePath))
    ) {
      return
    }
    throw new Error('Extension path escapes the managed root')
  }

  private async assertExistingPathContained(path: string): Promise<void> {
    this.assertContained(this.managedRoot, path)
    const root = this.canonicalRoot ?? (await realpath(this.managedRoot))
    this.assertContained(root, await realpath(path))
  }

  private async createManagedDirectory(
    ...segments: string[]
  ): Promise<string> {
    let directory = this.managedRoot
    await this.assertExistingPathContained(directory)
    for (const segment of segments) {
      directory = join(directory, segment)
      this.assertContained(this.managedRoot, directory)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const status = await lstat(directory)
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new Error('Extension managed path must be a real directory')
      }
      await this.assertExistingPathContained(directory)
    }
    return directory
  }

  private async createFreshManagedDirectory(
    ...segments: string[]
  ): Promise<string> {
    const leaf = segments.at(-1)
    if (!leaf) {
      throw new Error('A managed directory name is required')
    }
    const parent = await this.createManagedDirectory(...segments.slice(0, -1))
    const directory = join(parent, leaf)
    this.assertContained(this.managedRoot, directory)
    await mkdir(directory, { mode: 0o700 })
    await this.assertExistingPathContained(directory)
    return directory
  }

  private async pathExists(path: string): Promise<boolean> {
    this.assertContained(this.managedRoot, path)
    try {
      await lstat(path)
      return true
    } catch (error) {
      if (isMissingFileError(error)) {
        return false
      }
      throw error
    }
  }

  private async resolveEntrypoint(
    root: string,
    relativeEntrypoint: string
  ): Promise<string> {
    if (
      !relativeEntrypoint ||
      relativeEntrypoint.includes('\\') ||
      relativeEntrypoint.startsWith('/') ||
      /^[A-Za-z]:/u.test(relativeEntrypoint) ||
      relativeEntrypoint
        .split('/')
        .some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error(
        'Extension installer returned an invalid entrypoint'
      )
    }
    const entrypoint = resolve(root, relativeEntrypoint)
    this.assertContained(root, entrypoint)
    const [canonicalRoot, canonicalEntrypoint] = await Promise.all([
      realpath(root),
      realpath(entrypoint)
    ])
    this.assertContained(canonicalRoot, canonicalEntrypoint)
    const status = await lstat(canonicalEntrypoint)
    if (!status.isFile()) {
      throw new Error('Extension entrypoint is not a regular file')
    }
    return canonicalEntrypoint
  }

  private async removeManagedTree(path: string): Promise<void> {
    this.assertContained(this.managedRoot, path)
    let status
    try {
      status = await lstat(path)
    } catch (error) {
      if (isMissingFileError(error)) {
        return
      }
      throw error
    }
    if (status.isDirectory() && !status.isSymbolicLink()) {
      for (const entry of await readdir(path)) {
        await this.removeManagedTree(join(path, entry))
      }
      await rmdir(path)
    } else {
      await unlink(path)
    }
  }
}
