import {
  createHash,
  createPublicKey,
  randomUUID,
  verify
} from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  agentPackageArchiveName,
  agentPackageCatalogSchema,
  agentPackageDownloadProgressSchema,
  agentPackageInventorySchema,
  type AgentPackageCatalog,
  type AgentPackageCatalogEntry,
  type AgentPackageDownloadProgress,
  type AgentPackageInventory
} from '../../shared/agent-package-contracts'
import type { UpdateSource } from '../../shared/application-settings-contracts'
import {
  AGENT_PROTOCOL_VERSION
} from '../../shared/agent-protocol/contracts'
import {
  agentArchitectureSchema,
  agentReleaseKeyRegistrySchema,
  type AgentArchitecture,
  type AgentReleaseKeyRegistry
} from '../../shared/agent-installation-contracts'
import {
  fetchModelDownloadResponse
} from '../model-download-transport'
import {
  compareSemanticVersions,
  extractAndVerifyAgentPackage,
  verifyExtractedAgentPackage,
  type VerifiedAgentPackage
} from './agent-package-verifier'
import type {
  AgentInstallationBundleLoader
} from './agent-installation-manager'
import {
  canonicalAgentReleaseKeyRegistryBytes
} from './agent-bundle-verifier'
import type {
  RemoteRuntimeInstallationBundleLoader,
  RemoteRuntimeInstallationVerificationMetadataLoader
} from './remote-runtime-installation-manager'
import { isMissingPathError } from './path-errors'

const CATALOG_NAME = 'agent-catalog.json'
const CATALOG_SIGNATURE_NAME = 'agent-catalog.sig'
const CATALOG_SIGNATURE_DOMAIN = Buffer.from(
  'GoodBuddy Agent Package Catalog Signature v1\0',
  'utf8'
)
const MIRROR_ROOT =
  'https://goodbuddy.oss-cn-beijing.aliyuncs.com/agent-releases/'
const GITHUB_RELEASES_API =
  'https://api.github.com/repos/mesalogo/goodbuddy/releases?per_page=100'
const GITHUB_RELEASE_ROOT =
  'https://github.com/mesalogo/goodbuddy/releases/download/'
const MAXIMUM_CATALOG_BYTES = 1024 * 1024
const MAXIMUM_PACKAGE_BYTES = 512 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
const GITHUB_REDIRECT_HOSTS = [
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
] as const

type InstalledRecord = {
  directory: string
  archivePath: string
  archiveSha256: string
  verified: VerifiedAgentPackage
}

export type AgentPackageManagerOptions = {
  userDataPath: string
  desktopVersion: string
  keyRegistryPath: string
  getUpdateSource: () => Promise<UpdateSource>
  fetch?: typeof fetch
  now?: () => Date
}

export class AgentPackageManager {
  readonly #rootDirectory: string
  readonly #desktopVersion: string
  readonly #keyRegistryPath: string
  readonly #getUpdateSource: () => Promise<UpdateSource>
  readonly #fetch: typeof fetch
  readonly #now: () => Date
  #trustedRegistry?: Promise<AgentReleaseKeyRegistry>
  readonly #installed = new Map<
    AgentArchitecture,
    Promise<InstalledRecord | undefined>
  >()
  readonly #operations = new Map<
    AgentArchitecture,
    Promise<AgentPackageInventory>
  >()
  readonly #leaseCounts = new Map<string, number>()
  readonly #pendingRemovals = new Set<string>()

  constructor(options: AgentPackageManagerOptions) {
    this.#rootDirectory = resolve(
      options.userDataPath,
      'remote-components',
      'agent-packages'
    )
    this.#desktopVersion = options.desktopVersion
    this.#keyRegistryPath = resolve(options.keyRegistryPath)
    this.#getUpdateSource = options.getUpdateSource
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? (() => new Date())
  }

  readonly loadAgentBundle: AgentInstallationBundleLoader =
    async (architecture) => {
      const record = await this.#requireInstalled(architecture)
      const release = this.#lease(record)
      return {
        bundle: record.verified.agentBundle,
        registry:
          record.verified.runtimeMetadata.releaseKeyRegistry,
        release
      }
    }

  readonly loadRuntimeBundle: RemoteRuntimeInstallationBundleLoader =
    async (architecture) => {
      const record = await this.#requireInstalled(architecture)
      return {
        ...record.verified.runtimeBundle,
        release: this.#lease(record)
      }
    }

  readonly loadRuntimeMetadata:
  RemoteRuntimeInstallationVerificationMetadataLoader =
    async (architecture) =>
      (await this.#requireInstalled(architecture))
        .verified.runtimeMetadata

  async getInventory(
    options: { refresh?: boolean } = {}
  ): Promise<AgentPackageInventory> {
    if (options.refresh) {
      this.#installed.clear()
    }
    const entries = await Promise.all(
      agentArchitectureSchema.options.map(async (architecture) => {
        let record: InstalledRecord | undefined
        let state: 'not-downloaded' | 'verified' | 'invalid'
        try {
          record = await this.#loadInstalled(architecture)
          state = record ? 'verified' : await this.#hasEntries(architecture)
            ? 'invalid'
            : 'not-downloaded'
        } catch {
          state = 'invalid'
        }
        return {
          platform: 'linux' as const,
          architecture,
          state,
          version: record?.verified.descriptor.version ?? null,
          remoteRuntimeVersion:
            record?.verified.descriptor.remoteRuntime.version ?? null,
          agentProtocol:
            record?.verified.descriptor.agentProtocol ?? null
        }
      })
    )
    return agentPackageInventorySchema.parse({
      checkedAt: this.#now().toISOString(),
      entries
    })
  }

  getSnapshot(
    options: { refresh?: boolean } = {}
  ): Promise<AgentPackageInventory> {
    return this.getInventory(options)
  }

  async getExpectedCatalog(
    architecture: AgentArchitecture
  ): Promise<{
    agent: { version: string }
    runtimes: Array<{
      runtimeId: 'opencode'
      provider: 'opencode'
      version: string
    }>
  }> {
    const descriptor =
      (await this.#requireInstalled(architecture))
        .verified.descriptor
    return {
      agent: { version: descriptor.version },
      runtimes: [{
        runtimeId: 'opencode',
        provider: 'opencode',
        version: descriptor.remoteRuntime.version
      }]
    }
  }

  download(
    architecture: AgentArchitecture,
    onProgress?: (progress: AgentPackageDownloadProgress) => void
  ): Promise<AgentPackageInventory> {
    return this.#runExclusive(architecture, async () => {
      this.#emit(onProgress, {
        architecture,
        phase: 'catalog',
        completedBytes: 0,
        totalBytes: null
      })
      const source = await this.#getUpdateSource()
      const catalog = await this.#loadCatalog(source)
      const entry = selectLatestCompatibleEntry(
        catalog,
        architecture,
        this.#desktopVersion
      )
      const current = await this.#loadInstalled(architecture)
      if (
        current &&
        compareSemanticVersions(
          entry.version,
          current.verified.descriptor.version
        ) < 0
      ) {
        throw new Error(
          'Agent 发布目录不能降级已安装的兼容版本'
        )
      }
      const staging = await this.#createStaging(architecture)
      const archivePath = join(staging, entry.archive)
      try {
        await this.#downloadArchive(
          entry,
          source,
          archivePath,
          onProgress
        )
        this.#emit(onProgress, {
          architecture,
          phase: 'verifying',
          completedBytes: entry.size,
          totalBytes: entry.size
        })
        const installed = await this.#installArchive(
          archivePath,
          architecture,
          staging
        )
        if (
          installed.verified.descriptor.version !== entry.version ||
          installed.verified.descriptor.remoteRuntime.version !==
            entry.remoteRuntime.version
        ) {
          throw new Error(
            'Downloaded Agent package does not match its catalog entry'
          )
        }
        this.#emit(onProgress, {
          architecture,
          phase: 'installing',
          completedBytes: entry.size,
          totalBytes: entry.size
        })
        await this.#publishInstalled(installed, architecture)
        return this.getInventory({ refresh: true })
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    })
  }

  async importArchive(
    archivePath: string
  ): Promise<AgentPackageInventory> {
    const staging = await this.#createStaging('import')
    try {
      const copiedArchive = join(staging, basename(archivePath))
      await copyAndHashBoundedRegularFile(
        resolve(archivePath),
        copiedArchive,
        MAXIMUM_PACKAGE_BYTES
      )
      const installed = await this.#installArchive(
        copiedArchive,
        undefined,
        staging
      )
      const architecture =
        installed.verified.descriptor.architecture
      return await this.#runExclusive(
        architecture,
        async () => {
          await this.#publishInstalled(installed, architecture)
          return this.getInventory({ refresh: true })
        },
        false
      )
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  async exportArchive(
    architecture: AgentArchitecture,
    destinationPath: string
  ): Promise<void> {
    const installed = await this.#requireInstalled(architecture)
    const release = this.#lease(installed)
    const destination = resolve(destinationPath)
    const partial = `${destination}.${randomUUID()}.partial`
    const backup = `${destination}.${randomUUID()}.backup`
    try {
      const copiedSha256 =
        await copyAndHashBoundedRegularFile(
          installed.archivePath,
          partial,
          MAXIMUM_PACKAGE_BYTES
        )
      if (copiedSha256 !== installed.archiveSha256) {
        throw new Error(
          'Cached Agent archive does not match its installed package'
        )
      }
    } catch (error) {
      await rm(partial, { force: true })
      release()
      throw error
    }
    let replacedExisting = false
    let backupRestorationFailed = false
    try {
      try {
        const existing = await lstat(destination)
        if (!existing.isFile() || existing.isSymbolicLink()) {
          throw new Error(
            'Agent 包导出目标必须是普通文件或不存在的路径'
          )
        }
        await rename(destination, backup)
        replacedExisting = true
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error
        }
      }
      await rename(partial, destination)
    } catch (error) {
      await rm(partial, { force: true })
      if (replacedExisting) {
        try {
          await rename(backup, destination)
          replacedExisting = false
        } catch (restoreError) {
          backupRestorationFailed = true
          throw new Error(
            `Agent 包导出失败，原文件保留在 ${backup}`,
            { cause: restoreError }
          )
        }
      }
      throw error
    } finally {
      if (replacedExisting && !backupRestorationFailed) {
        await rm(backup, { force: true }).catch(() => undefined)
      }
      release()
    }
  }

  async getExportArchiveName(
    architecture: AgentArchitecture
  ): Promise<string> {
    const descriptor =
      (await this.#requireInstalled(architecture))
        .verified.descriptor
    return agentPackageArchiveName(
      descriptor.version,
      descriptor.architecture
    )
  }

  async #requireInstalled(
    architecture: AgentArchitecture
  ): Promise<InstalledRecord> {
    const installed = await this.#loadInstalled(architecture)
    if (!installed) {
      throw new Error(
        `未下载 Linux ${architecture} Agent 包，请先在“设置 > 平台功能 > 远程项目”下载或导入`
      )
    }
    return installed
  }

  #loadInstalled(
    architecture: AgentArchitecture
  ): Promise<InstalledRecord | undefined> {
    let promise = this.#installed.get(architecture)
    if (!promise) {
      promise = this.#scanInstalled(architecture)
      this.#installed.set(architecture, promise)
    }
    return promise
  }

  async #scanInstalled(
    architecture: AgentArchitecture
  ): Promise<InstalledRecord | undefined> {
    const architectureRoot = this.#architectureRoot(architecture)
    let entries
    try {
      entries = await readdir(architectureRoot, {
        withFileTypes: true
      })
    } catch (error) {
      if (isMissingPathError(error)) {
        return undefined
      }
      throw error
    }
    const verified: InstalledRecord[] = []
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name.startsWith('.')
      ) {
        continue
      }
      const directory = join(architectureRoot, entry.name)
      try {
        const packageContent = await verifyExtractedAgentPackage({
          rootDirectory: join(directory, 'content'),
          architecture,
          desktopVersion: this.#desktopVersion,
          trustedRegistry: await this.#loadTrustedRegistry()
        })
        if (packageContent.descriptor.version !== entry.name) {
          continue
        }
        const archivePath = join(directory, 'package.gbagent')
        const archiveStat = await lstat(archivePath)
        if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
          continue
        }
        const archiveSha256 = (
          await readFile(join(directory, 'archive.sha256'), 'utf8')
        ).trim()
        if (
          !/^[a-f0-9]{64}$/u.test(archiveSha256) ||
          await sha256File(archivePath) !== archiveSha256
        ) {
          continue
        }
        verified.push({
          directory,
          archivePath,
          archiveSha256,
          verified: packageContent
        })
      } catch {
        // Invalid cache entries remain visible as an invalid inventory state.
      }
    }
    return verified.sort((left, right) =>
      compareSemanticVersions(
        right.verified.descriptor.version,
        left.verified.descriptor.version
      )
    )[0]
  }

  async #installArchive(
    archivePath: string,
    architecture: AgentArchitecture | undefined,
    staging: string
  ): Promise<InstalledRecord> {
    const content = join(staging, 'content')
    const verified = await extractAndVerifyAgentPackage({
      archivePath,
      destinationDirectory: content,
      architecture,
      desktopVersion: this.#desktopVersion,
      trustedRegistry: await this.#loadTrustedRegistry()
    })
    const canonicalArchive = join(staging, 'package.gbagent')
    if (resolve(archivePath) !== resolve(canonicalArchive)) {
      await rename(archivePath, canonicalArchive)
    }
    const archiveSha256 = await sha256File(canonicalArchive)
    await writeFile(
      join(staging, 'archive.sha256'),
      `${archiveSha256}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    )
    return {
      directory: staging,
      archivePath: canonicalArchive,
      archiveSha256,
      verified
    }
  }

  async #publishInstalled(
    installed: InstalledRecord,
    architecture: AgentArchitecture
  ): Promise<void> {
    const destination = join(
      this.#architectureRoot(architecture),
      installed.verified.descriptor.version
    )
    await mkdir(this.#architectureRoot(architecture), {
      recursive: true
    })
    const current = await this.#loadInstalled(architecture)
    if (
      current?.verified.descriptor.version ===
      installed.verified.descriptor.version
    ) {
      if (
        current.verified.descriptor.contentDigest !==
        installed.verified.descriptor.contentDigest ||
        current.archiveSha256 !== installed.archiveSha256
      ) {
        throw new Error(
          'Agent package version identity is immutable'
        )
      }
      return
    }
    const backup = join(
      this.#architectureRoot(architecture),
      `.backup-${randomUUID()}`
    )
    let replacedExisting = false
    try {
      try {
        await lstat(destination)
        if ((this.#leaseCounts.get(destination) ?? 0) > 0) {
          throw new Error(
            'Agent package version is currently in use'
          )
        }
        await rename(destination, backup)
        replacedExisting = true
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error
        }
      }
      await rename(installed.directory, destination)
    } catch (error) {
      if (replacedExisting) {
        await rename(backup, destination).catch(() => undefined)
      }
      throw error
    }
    this.#installed.delete(architecture)
    if (replacedExisting) {
      await rm(backup, { recursive: true, force: true }).catch(
        () => undefined
      )
    }
    await this.#removeOtherVersions(
      architecture,
      installed.verified.descriptor.version
    )
  }

  async #removeOtherVersions(
    architecture: AgentArchitecture,
    retainedVersion: string
  ): Promise<void> {
    const root = this.#architectureRoot(architecture)
    const entries = await readdir(root, { withFileTypes: true })
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            !entry.name.startsWith('.') &&
            entry.name !== retainedVersion
        )
        .map((entry) =>
          this.#removeWhenUnused(join(root, entry.name))
        )
    )
  }

  async #downloadArchive(
    entry: AgentPackageCatalogEntry,
    source: UpdateSource,
    destination: string,
    onProgress?: (progress: AgentPackageDownloadProgress) => void
  ): Promise<void> {
    assertCanonicalDownload(entry, source)
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      DOWNLOAD_TIMEOUT_MS
    )
    timeout.unref?.()
    try {
      const response = await fetchModelDownloadResponse({
        transport: this.#fetch,
        initialUrl: entry.downloads[source].url,
        redirectHosts:
          source === 'github' ? GITHUB_REDIRECT_HOSTS : [],
        signal: controller.signal,
        modelLabel: 'Agent 包'
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(
          `Agent 包下载失败：HTTP ${response.status}`
        )
      }
      if (!response.body) {
        throw new Error('Agent 包下载响应没有内容')
      }
      const reader = response.body.getReader()
      const hash = createHash('sha256')
      let written = 0
      try {
        const declared = response.headers.get('content-length')
        if (declared && Number(declared) !== entry.size) {
          throw new Error('Agent 包下载大小与目录不一致')
        }
        const handle = await open(destination, 'wx')
        try {
          while (true) {
            const result = await reader.read()
            if (result.done) {
              break
            }
            written += result.value.byteLength
            if (
              written > entry.size ||
              written > MAXIMUM_PACKAGE_BYTES
            ) {
              throw new Error('Agent 包下载超出大小限制')
            }
            hash.update(result.value)
            await writeAll(handle, result.value)
            this.#emit(onProgress, {
              architecture: entry.architecture,
              phase: 'downloading',
              completedBytes: written,
              totalBytes: entry.size
            })
          }
          await handle.sync()
        } finally {
          await handle.close()
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      if (
        written !== entry.size ||
        hash.digest('hex') !== entry.sha256
      ) {
        throw new Error('Agent 包下载完整性校验失败')
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async #loadCatalog(
    source: UpdateSource
  ): Promise<AgentPackageCatalog> {
    const registry = await this.#loadTrustedRegistry()
    const [catalogBytes, signatureBytes] =
      source === 'mirror'
        ? await this.#fetchMirrorCatalog()
        : await this.#fetchGithubCatalog()
    const catalog = parseCanonicalCatalog(catalogBytes)
    verifyCatalogSignature(
      catalog,
      catalogBytes,
      signatureBytes,
      registry
    )
    for (const entry of catalog.entries) {
      assertCanonicalDownload(entry, 'github')
      assertCanonicalDownload(entry, 'mirror')
    }
    return catalog
  }

  async #fetchMirrorCatalog(): Promise<[Buffer, Buffer]> {
    const pointerBytes = await this.#fetchBounded(
      `${MIRROR_ROOT}latest.json`
    )
    const pointer = parseCanonicalMirrorPointer(pointerBytes)
    return Promise.all([
      this.#fetchBounded(
        new URL(pointer.catalog, MIRROR_ROOT).href
      ),
      this.#fetchBounded(
        new URL(pointer.signature, MIRROR_ROOT).href
      )
    ])
  }

  async #fetchGithubCatalog(): Promise<[Buffer, Buffer]> {
    const releases = await this.#fetchJson(GITHUB_RELEASES_API)
    if (!Array.isArray(releases)) {
      throw new Error('GitHub Agent 发布目录无效')
    }
    for (const untrusted of releases.slice(0, 100)) {
      if (
        typeof untrusted !== 'object' ||
        untrusted === null ||
        !('tag_name' in untrusted) ||
        typeof untrusted.tag_name !== 'string' ||
        !/^agent-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(
          untrusted.tag_name
        ) ||
        !('draft' in untrusted) ||
        untrusted.draft !== false ||
        !('prerelease' in untrusted) ||
        untrusted.prerelease !== false ||
        !('assets' in untrusted) ||
        !Array.isArray(untrusted.assets)
      ) {
        continue
      }
      const assets = new Map<string, string>()
      for (const asset of untrusted.assets) {
        if (
          typeof asset === 'object' &&
          asset !== null &&
          'name' in asset &&
          typeof asset.name === 'string' &&
          'browser_download_url' in asset &&
          typeof asset.browser_download_url === 'string'
        ) {
          assets.set(asset.name, asset.browser_download_url)
        }
      }
      const catalogUrl = assets.get(CATALOG_NAME)
      const signatureUrl = assets.get(CATALOG_SIGNATURE_NAME)
      if (catalogUrl && signatureUrl) {
        const releaseRoot =
          `${GITHUB_RELEASE_ROOT}${untrusted.tag_name}/`
        if (
          catalogUrl !== `${releaseRoot}${CATALOG_NAME}` ||
          signatureUrl !==
            `${releaseRoot}${CATALOG_SIGNATURE_NAME}`
        ) {
          continue
        }
        return Promise.all([
          this.#fetchBounded(catalogUrl, GITHUB_REDIRECT_HOSTS),
          this.#fetchBounded(signatureUrl, GITHUB_REDIRECT_HOSTS)
        ])
      }
    }
    throw new Error('GitHub 中没有可用的 Agent 发布目录')
  }

  async #fetchJson(url: string): Promise<unknown> {
    const bytes = await this.#fetchBounded(url)
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    ) as unknown
  }

  async #fetchBounded(
    url: string,
    redirectHosts: readonly string[] = []
  ): Promise<Buffer> {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      30_000
    )
    timeout.unref?.()
    try {
      const response = await fetchModelDownloadResponse({
        transport: this.#fetch,
        initialUrl: url,
        redirectHosts,
        signal: controller.signal,
        modelLabel: 'Agent 发布目录'
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(
          `Agent 发布目录请求失败：HTTP ${response.status}`
        )
      }
      if (!response.body) {
        throw new Error('Agent 发布目录响应没有内容')
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        while (true) {
          const result = await reader.read()
          if (result.done) {
            break
          }
          total += result.value.byteLength
          if (total > MAXIMUM_CATALOG_BYTES) {
            throw new Error('Agent 发布目录超出大小限制')
          }
          chunks.push(result.value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      return Buffer.concat(chunks, total)
    } finally {
      clearTimeout(timeout)
    }
  }

  async #hasEntries(
    architecture: AgentArchitecture
  ): Promise<boolean> {
    try {
      return (
        await readdir(this.#architectureRoot(architecture))
      ).some((name) => !name.startsWith('.'))
    } catch (error) {
      if (isMissingPathError(error)) {
        return false
      }
      throw error
    }
  }

  async #createStaging(
    architecture: AgentArchitecture | 'import'
  ): Promise<string> {
    await mkdir(this.#rootDirectory, { recursive: true })
    const path = join(
      this.#rootDirectory,
      `.stage-linux-${architecture}-${randomUUID()}`
    )
    await mkdir(path)
    return path
  }

  #architectureRoot(
    architecture: AgentArchitecture
  ): string {
    return join(this.#rootDirectory, `linux-${architecture}`)
  }

  #loadTrustedRegistry(): Promise<AgentReleaseKeyRegistry> {
    this.#trustedRegistry ??= readCanonicalRegistry(
      this.#keyRegistryPath
    )
    return this.#trustedRegistry
  }

  #lease(record: InstalledRecord): () => void {
    const key = record.directory
    this.#leaseCounts.set(
      key,
      (this.#leaseCounts.get(key) ?? 0) + 1
    )
    let active = true
    return () => {
      if (!active) {
        return
      }
      active = false
      const remaining = (this.#leaseCounts.get(key) ?? 1) - 1
      if (remaining > 0) {
        this.#leaseCounts.set(key, remaining)
        return
      }
      this.#leaseCounts.delete(key)
      if (this.#pendingRemovals.delete(key)) {
        void rm(key, {
          recursive: true,
          force: true
        }).catch(() => undefined)
      }
    }
  }

  async #removeWhenUnused(directory: string): Promise<void> {
    if ((this.#leaseCounts.get(directory) ?? 0) > 0) {
      this.#pendingRemovals.add(directory)
      return
    }
    await rm(directory, { recursive: true, force: true })
  }

  #runExclusive(
    architecture: AgentArchitecture,
    operation: () => Promise<AgentPackageInventory>,
    joinExisting = true
  ): Promise<AgentPackageInventory> {
    const existing = this.#operations.get(architecture)
    if (existing) {
      return joinExisting
        ? existing
        : existing.then(
            () =>
              this.#runExclusive(
                architecture,
                operation,
                false
              ),
            () =>
              this.#runExclusive(
                architecture,
                operation,
                false
              )
          )
    }
    const promise = operation().finally(() => {
      if (this.#operations.get(architecture) === promise) {
        this.#operations.delete(architecture)
      }
    })
    this.#operations.set(architecture, promise)
    return promise
  }

  #emit(
    observer:
      | ((progress: AgentPackageDownloadProgress) => void)
      | undefined,
    progress: AgentPackageDownloadProgress
  ): void {
    try {
      observer?.(agentPackageDownloadProgressSchema.parse(progress))
    } catch {
      // Progress observers cannot alter the package operation.
    }
  }
}

export function selectLatestCompatibleEntry(
  catalog: AgentPackageCatalog,
  architecture: AgentArchitecture,
  desktopVersion: string
): AgentPackageCatalogEntry {
  const entry = catalog.entries
    .filter(
      (candidate) =>
        candidate.architecture === architecture &&
        compareSemanticVersions(
          desktopVersion,
          candidate.minimumDesktopVersion
        ) >= 0 &&
        candidate.agentProtocol.major ===
          AGENT_PROTOCOL_VERSION.major &&
        candidate.agentProtocol.minor <=
          AGENT_PROTOCOL_VERSION.minor
    )
    .sort((left, right) =>
      compareSemanticVersions(right.version, left.version)
    )[0]
  if (!entry) {
    throw new Error(
      `没有与当前 GoodBuddy 兼容的 Linux ${architecture} Agent 包`
    )
  }
  return entry
}

function assertCanonicalDownload(
  entry: AgentPackageCatalogEntry,
  source: UpdateSource
): void {
  const expected =
    source === 'mirror'
      ? new URL(
          `v${entry.version}/${entry.archive}`,
          MIRROR_ROOT
        ).href
      : new URL(
          `agent-v${entry.version}/${entry.archive}`,
          GITHUB_RELEASE_ROOT
        ).href
  if (entry.downloads[source].url !== expected) {
    throw new Error('Agent 包下载地址不受信任')
  }
}

async function readCanonicalRegistry(
  filePath: string
): Promise<AgentReleaseKeyRegistry> {
  const bytes = await readFile(filePath)
  const registry = agentReleaseKeyRegistrySchema.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    )
  )
  if (
    !canonicalAgentReleaseKeyRegistryBytes(registry).equals(bytes)
  ) {
    throw new Error('Agent 签名公钥目录不是规范格式')
  }
  return registry
}

function parseCanonicalCatalog(bytes: Buffer): AgentPackageCatalog {
  const catalog = agentPackageCatalogSchema.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    )
  )
  if (
    !Buffer.from(
      `${JSON.stringify(catalog, null, 2)}\n`,
      'utf8'
    ).equals(bytes)
  ) {
    throw new Error('Agent 发布目录不是规范格式')
  }
  return catalog
}

function parseCanonicalMirrorPointer(bytes: Buffer): {
  catalog: string
  signature: string
} {
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  ) as unknown
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).sort().join(',') !==
      'catalog,formatVersion,signature,version' ||
    !('formatVersion' in value) ||
    value.formatVersion !== 1 ||
    !('version' in value) ||
    typeof value.version !== 'string' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(
      value.version
    ) ||
    !('catalog' in value) ||
    typeof value.catalog !== 'string' ||
    value.catalog !==
      `v${value.version}/${CATALOG_NAME}` ||
    !('signature' in value) ||
    typeof value.signature !== 'string' ||
    value.signature !==
      `v${value.version}/${CATALOG_SIGNATURE_NAME}` ||
    !Buffer.from(
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8'
    ).equals(bytes)
  ) {
    throw new Error('Agent 镜像目录指针无效')
  }
  return {
    catalog: value.catalog,
    signature: value.signature
  }
}

function verifyCatalogSignature(
  catalog: AgentPackageCatalog,
  bytes: Buffer,
  signatureText: Buffer,
  registry: AgentReleaseKeyRegistry
): void {
  const key = registry.keys.find(
    (candidate) =>
      candidate.keyId === catalog.signingKeyId &&
      candidate.environment === 'production'
  )
  if (
    !key ||
    registry.revocations.some(
      (revocation) => revocation.keyId === key.keyId
    )
  ) {
    throw new Error('Agent 发布目录签名密钥不受信任')
  }
  const signature = Buffer.from(
    signatureText.toString('utf8').trim(),
    'base64'
  )
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki'
  })
  if (
    signature.length !== 64 ||
    !verify(
      null,
      Buffer.concat([CATALOG_SIGNATURE_DOMAIN, bytes]),
      publicKey,
      signature
    )
  ) {
    throw new Error('Agent 发布目录签名校验失败')
  }
}

async function copyAndHashBoundedRegularFile(
  sourcePath: string,
  destinationPath: string,
  maximumBytes: number
): Promise<string> {
  const sourceStatus = await lstat(sourcePath)
  if (
    !sourceStatus.isFile() ||
    sourceStatus.isSymbolicLink() ||
    sourceStatus.size <= 0 ||
    sourceStatus.size > maximumBytes
  ) {
    throw new Error('Agent package must be a bounded regular file')
  }
  const source = await open(
    sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  let destination:
    | Awaited<ReturnType<typeof open>>
    | undefined
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let copied = 0
  try {
    const openedStatus = await source.stat()
    if (
      !openedStatus.isFile() ||
      openedStatus.dev !== sourceStatus.dev ||
      openedStatus.ino !== sourceStatus.ino ||
      openedStatus.size !== sourceStatus.size
    ) {
      throw new Error(
        'Agent package changed while it was being opened'
      )
    }
    destination = await open(destinationPath, 'wx', 0o600)
    while (true) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.length
      )
      if (bytesRead === 0) {
        break
      }
      copied += bytesRead
      if (copied > maximumBytes) {
        throw new Error('Agent package exceeds its size limit')
      }
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      await writeAll(destination, chunk)
    }
    if (copied !== sourceStatus.size) {
      throw new Error('Agent package changed while it was copied')
    }
    await destination.sync()
  } finally {
    await Promise.allSettled([
      source.close(),
      destination?.close() ?? Promise.resolve()
    ])
  }
  return hash.digest('hex')
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await open(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length
      )
      if (bytesRead === 0) {
        break
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset
    )
    if (bytesWritten <= 0) {
      throw new Error('Agent 包下载写入未取得进展')
    }
    offset += bytesWritten
  }
}