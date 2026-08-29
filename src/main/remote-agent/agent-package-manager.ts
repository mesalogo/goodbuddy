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
  type AgentArchitecture,
  type AgentReleaseKeyRegistry
} from '../../shared/agent-installation-contracts'
import {
  fetchModelDownloadResponse,
  isDownloadRedirectStatus,
  validateSecureDownloadUrl
} from '../model-download-transport'
import {
  compareSemanticVersions,
  extractAndVerifyAgentPackage,
  verifyExtractedAgentPackage,
  type VerifiedAgentPackage
} from './agent-package-verifier'
import {
  readAgentReleaseKeyRegistry
} from './agent-bundle-verifier'
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
const REMOTE_CANDIDATE_TIMEOUT_MS = 30_000
const MAXIMUM_REMOTE_REDIRECTS = 3
const MAXIMUM_REMOTE_URL_BYTES = 4_096
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

type CatalogState =
  | {
      state: 'available'
      checkedAt: string
      catalog: AgentPackageCatalog
    }
  | {
      state: 'unavailable'
      checkedAt: string
      error: string
    }

export type AgentPackageManagerOptions = {
  userDataPath: string
  desktopVersion: string
  keyRegistryPath: string
  getUpdateSource: () => Promise<UpdateSource>
  fetch?: typeof fetch
  now?: () => Date
}

export type VerifiedRemoteAgentInstallCandidate = {
  source: UpdateSource
  platform: 'linux'
  architecture: AgentArchitecture
  version: string
  minimumDesktopVersion: string
  agentProtocol: {
    major: number
    minor: number
  }
  remoteRuntime: {
    runtimeId: 'opencode'
    provider: 'opencode'
    version: string
    bundleDigest: string
    protocol: {
      major: number
      minor: number
    }
  }
  archive: string
  size: number
  sha256: string
  /**
   * The canonical signed URL followed by each manually verified redirect.
   * The remote bootstrap must require this exact sequence.
   */
  urls: readonly string[]
}

export type VerifiedRemoteAgentEnvironmentCatalog = {
  expected: {
    agent: { version: string }
    runtimes: Array<{
      runtimeId: 'opencode'
      provider: 'opencode'
      version: string
    }>
  }
  candidate: VerifiedRemoteAgentInstallCandidate | null
  candidateFailure?: {
    reason: 'package-unavailable' | 'probe-failed'
    source: UpdateSource | null
    packageSize: number | null
  }
}

export type AgentPackageArchiveLease = {
  candidate: VerifiedRemoteAgentInstallCandidate
  path: string
  size: number
  sha256: string
  nodePath: string
  nodeSize: number
  nodeSha256: string
  release: () => void
}

export type AcquireInstallArchiveOptions = {
  signal?: AbortSignal
  onProgress?: (progress: AgentPackageDownloadProgress) => void
}

function expectedCatalog(
  agentVersion: string,
  runtimeVersion: string
): VerifiedRemoteAgentEnvironmentCatalog['expected'] {
  return {
    agent: { version: agentVersion },
    runtimes: [{
      runtimeId: 'opencode',
      provider: 'opencode',
      version: runtimeVersion
    }]
  }
}

function candidateFromCatalogEntry(
  entry: AgentPackageCatalogEntry,
  source: UpdateSource
): VerifiedRemoteAgentInstallCandidate {
  return {
    source,
    platform: 'linux',
    architecture: entry.architecture,
    version: entry.version,
    minimumDesktopVersion: entry.minimumDesktopVersion,
    agentProtocol: { ...entry.agentProtocol },
    remoteRuntime: {
      ...entry.remoteRuntime,
      protocol: { ...entry.remoteRuntime.protocol }
    },
    archive: entry.archive,
    size: entry.size,
    sha256: entry.sha256,
    urls: []
  }
}

function candidateFromVerifiedRecord(
  record: InstalledRecord,
  source: UpdateSource,
  size: number
): VerifiedRemoteAgentInstallCandidate {
  const descriptor = record.verified.descriptor
  return {
    source,
    platform: 'linux',
    architecture: descriptor.architecture,
    version: descriptor.version,
    minimumDesktopVersion: descriptor.minimumDesktopVersion,
    agentProtocol: { ...descriptor.agentProtocol },
    remoteRuntime: {
      ...descriptor.remoteRuntime,
      protocol: { ...descriptor.remoteRuntime.protocol }
    },
    archive: agentPackageArchiveName(
      descriptor.version,
      descriptor.architecture
    ),
    size,
    sha256: record.archiveSha256,
    urls: []
  }
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
    Promise<unknown>
  >()
  readonly #leaseCounts = new Map<string, number>()
  readonly #pendingRemovals = new Set<string>()
  readonly #startupCleanup: Promise<void>
  #catalogState?: CatalogState

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
    this.#startupCleanup = this.#cleanupInterruptedArtifacts()
  }

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
        const latestVersion = this.#latestVersion(architecture)
        return {
          platform: 'linux' as const,
          architecture,
          state,
          version: record?.verified.descriptor.version ?? null,
          latestVersion,
          updateAvailable: this.#updateAvailable(
            latestVersion,
            record?.verified.descriptor.version ?? null
          ),
          remoteRuntimeVersion:
            record?.verified.descriptor.remoteRuntime.version ?? null,
          agentProtocol:
            record?.verified.descriptor.agentProtocol ?? null
        }
      })
    )
    return agentPackageInventorySchema.parse({
      checkedAt: this.#now().toISOString(),
      catalog: this.#publicCatalogState(),
      entries
    })
  }

  async getSnapshot(
    options: { refresh?: boolean } = {}
  ): Promise<AgentPackageInventory> {
    const catalogCheck = this.#checkCatalog()
    const inventory = await this.getInventory(options)
    await catalogCheck
    return agentPackageInventorySchema.parse({
      ...inventory,
      checkedAt: this.#now().toISOString(),
      catalog: this.#publicCatalogState(),
      entries: inventory.entries.map((entry) => {
        const latestVersion = this.#latestVersion(
          entry.architecture
        )
        return {
          ...entry,
          latestVersion,
          updateAvailable: this.#updateAvailable(
            latestVersion,
            entry.version
          )
        }
      })
    })
  }

  async getRemoteEnvironmentCatalog(
    architecture: AgentArchitecture,
    options: { signal?: AbortSignal } = {}
  ): Promise<VerifiedRemoteAgentEnvironmentCatalog> {
    options.signal?.throwIfAborted()
    let entry: AgentPackageCatalogEntry
    let source: UpdateSource | undefined
    try {
      source = await this.#getUpdateSource()
      options.signal?.throwIfAborted()
      const catalog = await this.#loadCatalogAndRemember(
        source,
        options.signal
      )
      entry = selectLatestCompatibleEntry(
        catalog,
        architecture,
        this.#desktopVersion
      )
    } catch (onlineError) {
      options.signal?.throwIfAborted()
      const installed = await this.#loadInstalled(architecture)
      if (!installed) {
        throw onlineError
      }
      return {
        expected: expectedCatalog(
          installed.verified.descriptor.version,
          installed.verified.descriptor.remoteRuntime.version
        ),
        candidate: null,
        candidateFailure: {
          reason:
            onlineError instanceof NoCompatibleAgentPackageError
              ? 'package-unavailable'
              : 'probe-failed',
          source: source ?? null,
          packageSize: null
        }
      }
    }
    const expected = expectedCatalog(
      entry.version,
      entry.remoteRuntime.version
    )
    try {
      return {
        expected,
        candidate: await this.#remoteInstallCandidate(
          entry,
          source,
          options.signal
        )
      }
    } catch {
      options.signal?.throwIfAborted()
      return {
        expected,
        candidate: null,
        candidateFailure: {
          reason: 'probe-failed',
          source,
          packageSize: entry.size
        }
      }
    }
  }

  /**
   * Returns a Main-only, signed and compatibility-checked remote installation
   * candidate. No local .gbagent cache is required.
   */
  async getRemoteInstallCandidate(
    architecture: AgentArchitecture,
    options: { signal?: AbortSignal } = {}
  ): Promise<VerifiedRemoteAgentInstallCandidate> {
    options.signal?.throwIfAborted()
    const source = await this.#getUpdateSource()
    options.signal?.throwIfAborted()
    const catalog = await this.#loadCatalogAndRemember(
      source,
      options.signal
    )
    const entry = selectLatestCompatibleEntry(
      catalog,
      architecture,
      this.#desktopVersion
    )
    return this.#remoteInstallCandidate(
      entry,
      source,
      options.signal
    )
  }

  async #remoteInstallCandidate(
    entry: AgentPackageCatalogEntry,
    source: UpdateSource,
    signal?: AbortSignal
  ): Promise<VerifiedRemoteAgentInstallCandidate> {
    assertCanonicalDownload(entry, source)
    const urls = await this.#resolveRemoteDownloadUrls(
      entry,
      source,
      signal
    )
    return {
      ...candidateFromCatalogEntry(entry, source),
      urls
    }
  }

  download(
    architecture: AgentArchitecture,
    onProgress?: (progress: AgentPackageDownloadProgress) => void,
    signal?: AbortSignal
  ): Promise<AgentPackageInventory> {
    return this.#runExclusive(architecture, async () => {
      signal?.throwIfAborted()
      this.#emit(onProgress, {
        architecture,
        phase: 'catalog',
        completedBytes: 0,
        totalBytes: null
      })
      const source = await this.#getUpdateSource()
      signal?.throwIfAborted()
      const catalog = await this.#loadCatalogAndRemember(
        source,
        signal
      )
      const entry = selectLatestCompatibleEntry(
        catalog,
        architecture,
        this.#desktopVersion
      )
      await this.#ensureInstalledCandidate(
        architecture,
        entry,
        source,
        onProgress,
        signal
      )
      return this.getInventory()
    })
  }

  async acquireInstallArchive(
    architecture: AgentArchitecture,
    expectedCandidate: VerifiedRemoteAgentInstallCandidate,
    options: AcquireInstallArchiveOptions = {}
  ): Promise<AgentPackageArchiveLease> {
    return this.#runExclusive(
      architecture,
      async () => {
        options.signal?.throwIfAborted()
        const current = await this.#loadInstalled(architecture)
        if (
          current &&
          await this.#recordMatchesRemoteCandidate(
            current,
            expectedCandidate
          )
        ) {
          return this.#archiveLease(
            current,
            expectedCandidate
          )
        }
        const source = await this.#getUpdateSource()
        options.signal?.throwIfAborted()
        const catalog = await this.#loadCatalogAndRemember(
          source,
          options.signal
        )
        const entry = selectLatestCompatibleEntry(
          catalog,
          architecture,
          this.#desktopVersion
        )
        assertCandidateMatchesCatalogEntry(
          expectedCandidate,
          entry,
          source
        )
        const record = await this.#ensureInstalledCandidate(
          architecture,
          entry,
          source,
          options.onProgress,
          options.signal
        )
        options.signal?.throwIfAborted()
        return this.#archiveLease(record, expectedCandidate)
      }
    )
  }

  async acquireGoodBuddyInstallArchive(
    architecture: AgentArchitecture,
    options: AcquireInstallArchiveOptions = {}
  ): Promise<AgentPackageArchiveLease> {
    return this.#runExclusive(
      architecture,
      async () => {
        options.signal?.throwIfAborted()
        const source = await this.#getUpdateSource()
        options.signal?.throwIfAborted()
        const record = await this.#loadInstalled(architecture)
        const leaseRecord = async (
          installed: InstalledRecord
        ): Promise<AgentPackageArchiveLease> => {
          const status = await lstat(installed.archivePath)
          return this.#archiveLease(
            installed,
            candidateFromVerifiedRecord(
              installed,
              source,
              status.size
            )
          )
        }
        if (
          record &&
          this.#catalogState?.state !== 'available'
        ) {
          return leaseRecord(record)
        }
        let entry: AgentPackageCatalogEntry
        if (this.#catalogState?.state === 'available') {
          entry = selectLatestCompatibleEntry(
            this.#catalogState.catalog,
            architecture,
            this.#desktopVersion
          )
          if (
            record &&
            compareSemanticVersions(
              record.verified.descriptor.version,
              entry.version
            ) >= 0
          ) {
            return leaseRecord(record)
          }
        } else {
          if (this.#catalogState?.state === 'unavailable') {
            throw new Error(this.#catalogState.error)
          }
          const catalog = await this.#loadCatalogAndRemember(
            source,
            options.signal
          )
          entry = selectLatestCompatibleEntry(
            catalog,
            architecture,
            this.#desktopVersion
          )
        }
        const candidate = candidateFromCatalogEntry(
          entry,
          source
        )
        const installed = await this.#ensureInstalledCandidate(
          architecture,
          entry,
          source,
          options.onProgress,
          options.signal
        )
        return this.#archiveLease(installed, candidate)
      }
    )
  }

  async #archiveLease(
    record: InstalledRecord,
    candidate: VerifiedRemoteAgentInstallCandidate
  ): Promise<AgentPackageArchiveLease> {
    const archiveStatus = await lstat(record.archivePath)
    if (
      !archiveStatus.isFile() ||
      archiveStatus.isSymbolicLink() ||
      archiveStatus.size !== candidate.size ||
      record.archiveSha256 !== candidate.sha256
    ) {
      throw new Error(
        'Cached Agent archive does not match the signed installation candidate'
      )
    }
    const node = record.verified.descriptor.files.find(
      (file) => file.path === 'agent/node'
    )
    if (!node) {
      throw new Error(
        'Verified Agent package does not contain agent/node'
      )
    }
    const release = this.#lease(record)
    return {
      candidate,
      path: record.archivePath,
      size: archiveStatus.size,
      sha256: record.archiveSha256,
      nodePath: join(
        record.verified.rootDirectory,
        ...node.path.split('/')
      ),
      nodeSize: node.size,
      nodeSha256: node.sha256,
      release
    }
  }

  async #recordMatchesRemoteCandidate(
    record: InstalledRecord,
    candidate: VerifiedRemoteAgentInstallCandidate
  ): Promise<boolean> {
    const descriptor = record.verified.descriptor
    if (
      descriptor.architecture === candidate.architecture &&
      descriptor.version === candidate.version &&
      descriptor.minimumDesktopVersion ===
        candidate.minimumDesktopVersion &&
      descriptor.agentProtocol.major ===
        candidate.agentProtocol.major &&
      descriptor.agentProtocol.minor ===
        candidate.agentProtocol.minor &&
      descriptor.remoteRuntime.runtimeId ===
        candidate.remoteRuntime.runtimeId &&
      descriptor.remoteRuntime.provider ===
        candidate.remoteRuntime.provider &&
      descriptor.remoteRuntime.version ===
        candidate.remoteRuntime.version &&
      descriptor.remoteRuntime.bundleDigest ===
        candidate.remoteRuntime.bundleDigest &&
      descriptor.remoteRuntime.protocol.major ===
        candidate.remoteRuntime.protocol.major &&
      descriptor.remoteRuntime.protocol.minor ===
        candidate.remoteRuntime.protocol.minor &&
      record.archiveSha256 === candidate.sha256
    ) {
      try {
        const status = await lstat(record.archivePath)
        return (
          status.isFile() &&
          !status.isSymbolicLink() &&
          status.size === candidate.size
        )
      } catch {
        return false
      }
    }
    return false
  }

  async #ensureInstalledCandidate(
    architecture: AgentArchitecture,
    entry: AgentPackageCatalogEntry,
    source: UpdateSource,
    onProgress?: (progress: AgentPackageDownloadProgress) => void,
    signal?: AbortSignal
  ): Promise<InstalledRecord> {
    signal?.throwIfAborted()
    const current = await this.#loadInstalled(architecture)
    const comparison = current
      ? compareSemanticVersions(
          entry.version,
          current.verified.descriptor.version
        )
      : 1
    if (current && comparison < 0) {
      throw new Error(
        'Agent 发布目录不能降级已安装的兼容版本'
      )
    }
    if (
      current &&
      comparison === 0 &&
      await this.#recordMatchesCatalogEntry(current, entry)
    ) {
      return current
    }

    const staging = await this.#createStaging(architecture)
    const archivePath = join(staging, entry.archive)
    try {
      await this.#downloadArchive(
        entry,
        source,
        archivePath,
        onProgress,
        signal
      )
      signal?.throwIfAborted()
      this.#emit(onProgress, {
        architecture,
        phase: 'verifying',
        completedBytes: entry.size,
        totalBytes: entry.size
      })
      const installed = await this.#installArchive(
        archivePath,
        architecture,
        staging,
        entry.sha256
      )
      if (!await this.#recordMatchesCatalogEntry(
        installed,
        entry
      )) {
        throw new Error(
          'Downloaded Agent package does not match its catalog entry'
        )
      }
      signal?.throwIfAborted()
      this.#emit(onProgress, {
        architecture,
        phase: 'installing',
        completedBytes: entry.size,
        totalBytes: entry.size
      })
      const published = await this.#publishInstalled(
        installed,
        architecture,
        entry
      )
      if (!await this.#recordMatchesCatalogEntry(published, entry)) {
        throw new Error(
          'Published Agent package does not match its catalog entry'
        )
      }
      return published
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  async #recordMatchesCatalogEntry(
    record: InstalledRecord,
    entry: AgentPackageCatalogEntry
  ): Promise<boolean> {
    const descriptor = record.verified.descriptor
    if (
      descriptor.version !== entry.version ||
      descriptor.minimumDesktopVersion !==
        entry.minimumDesktopVersion ||
      descriptor.platform !== entry.platform ||
      descriptor.architecture !== entry.architecture ||
      descriptor.agentProtocol.major !==
        entry.agentProtocol.major ||
      descriptor.agentProtocol.minor !==
        entry.agentProtocol.minor ||
      descriptor.remoteRuntime.runtimeId !==
        entry.remoteRuntime.runtimeId ||
      descriptor.remoteRuntime.provider !==
        entry.remoteRuntime.provider ||
      descriptor.remoteRuntime.version !==
        entry.remoteRuntime.version ||
      descriptor.remoteRuntime.bundleDigest !==
        entry.remoteRuntime.bundleDigest ||
      descriptor.remoteRuntime.protocol.major !==
        entry.remoteRuntime.protocol.major ||
      descriptor.remoteRuntime.protocol.minor !==
        entry.remoteRuntime.protocol.minor ||
      record.archiveSha256 !== entry.sha256
    ) {
      return false
    }
    try {
      const status = await lstat(record.archivePath)
      return (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.size === entry.size
      )
    } catch {
      return false
    }
  }

  async importArchive(
    archivePath: string
  ): Promise<AgentPackageInventory> {
    const staging = await this.#createStaging('import')
    try {
      const copiedArchive = join(staging, basename(archivePath))
      const archiveSha256 = await copyAndHashBoundedRegularFile(
        resolve(archivePath),
        copiedArchive,
        MAXIMUM_PACKAGE_BYTES
      )
      const installed = await this.#installArchive(
        copiedArchive,
        undefined,
        staging,
        archiveSha256
      )
      const architecture =
        installed.verified.descriptor.architecture
      return await this.#runExclusive(
        architecture,
        async () => {
          await this.#publishInstalled(installed, architecture)
          return this.getInventory()
        }
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

  async #loadInstalled(
    architecture: AgentArchitecture
  ): Promise<InstalledRecord | undefined> {
    await this.#startupCleanup
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
    staging: string,
    verifiedArchiveSha256?: string
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
    const archiveSha256 =
      verifiedArchiveSha256 ?? await sha256File(canonicalArchive)
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
    architecture: AgentArchitecture,
    catalogEntry?: AgentPackageCatalogEntry
  ): Promise<InstalledRecord> {
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
        if (
          !catalogEntry ||
          !await this.#recordMatchesCatalogEntry(
            installed,
            catalogEntry
          )
        ) {
          throw new Error(
            'Agent package version identity is immutable'
          )
        }
      } else {
        return current
      }
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
    const published: InstalledRecord = {
      ...installed,
      directory: destination,
      archivePath: join(destination, 'package.gbagent'),
      verified: {
        ...installed.verified,
        rootDirectory: join(destination, 'content')
      }
    }
    this.#installed.set(
      architecture,
      Promise.resolve(published)
    )
    if (replacedExisting) {
      await rm(backup, { recursive: true, force: true }).catch(
        () => undefined
      )
    }
    await this.#removeOtherVersions(
      architecture,
      installed.verified.descriptor.version
    )
    return published
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
    onProgress?: (progress: AgentPackageDownloadProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    assertCanonicalDownload(entry, source)
    const controller = new AbortController()
    const abortFromCaller = (): void => {
      controller.abort(signal?.reason)
    }
    signal?.addEventListener('abort', abortFromCaller, {
      once: true
    })
    if (signal?.aborted) {
      abortFromCaller()
    }
    const timeout = setTimeout(
      () => controller.abort(
        new DOMException(
          'Agent package download timed out',
          'TimeoutError'
        )
      ),
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
            controller.signal.throwIfAborted()
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
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  async #loadCatalog(
    source: UpdateSource,
    signal?: AbortSignal
  ): Promise<AgentPackageCatalog> {
    signal?.throwIfAborted()
    const registry = await this.#loadTrustedRegistry()
    signal?.throwIfAborted()
    const [catalogBytes, signatureBytes] =
      source === 'mirror'
        ? await this.#fetchMirrorCatalog(signal)
        : await this.#fetchGithubCatalog(signal)
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

  async #loadCatalogAndRemember(
    source: UpdateSource,
    signal?: AbortSignal
  ): Promise<AgentPackageCatalog> {
    const checkedAt = this.#now().toISOString()
    try {
      const catalog = await this.#loadCatalog(source, signal)
      this.#catalogState = {
        state: 'available',
        checkedAt,
        catalog
      }
      return catalog
    } catch (error) {
      this.#catalogState = {
        state: 'unavailable',
        checkedAt,
        error: boundedErrorMessage(error)
      }
      throw error
    }
  }

  async #checkCatalog(): Promise<void> {
    try {
      await this.#loadCatalogAndRemember(
        await this.#getUpdateSource()
      )
    } catch {
      // The failed catalog state is already recorded. Local packages remain usable.
    }
  }

  #latestVersion(
    architecture: AgentArchitecture
  ): string | null {
    if (this.#catalogState?.state !== 'available') {
      return null
    }
    try {
      return selectLatestCompatibleEntry(
        this.#catalogState.catalog,
        architecture,
        this.#desktopVersion
      ).version
    } catch {
      return null
    }
  }

  #updateAvailable(
    latestVersion: string | null,
    installedVersion: string | null
  ): boolean {
    return installedVersion !== null &&
      latestVersion !== null &&
      compareSemanticVersions(
        latestVersion,
        installedVersion
      ) > 0
  }

  #publicCatalogState():
  AgentPackageInventory['catalog'] {
    if (this.#catalogState === undefined) {
      return {
        state: 'not-checked',
        checkedAt: null,
        error: null
      }
    }
    if (this.#catalogState.state === 'available') {
      return {
        state: 'available',
        checkedAt: this.#catalogState.checkedAt,
        error: null
      }
    }
    return {
      state: 'unavailable',
      checkedAt: this.#catalogState.checkedAt,
      error: this.#catalogState.error
    }
  }

  async #fetchMirrorCatalog(
    signal?: AbortSignal
  ): Promise<[Buffer, Buffer]> {
    const pointerBytes = await this.#fetchBounded(
      `${MIRROR_ROOT}latest.json`,
      [],
      signal,
      true
    )
    const pointer = parseCanonicalMirrorPointer(pointerBytes)
    return Promise.all([
      this.#fetchBounded(
        new URL(pointer.catalog, MIRROR_ROOT).href,
        [],
        signal,
        true
      ),
      this.#fetchBounded(
        new URL(pointer.signature, MIRROR_ROOT).href,
        [],
        signal,
        true
      )
    ])
  }

  async #fetchGithubCatalog(
    signal?: AbortSignal
  ): Promise<[Buffer, Buffer]> {
    const releases = await this.#fetchJson(
      GITHUB_RELEASES_API,
      signal
    )
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
          this.#fetchBounded(
            catalogUrl,
            GITHUB_REDIRECT_HOSTS,
            signal
          ),
          this.#fetchBounded(
            signatureUrl,
            GITHUB_REDIRECT_HOSTS,
            signal
          )
        ])
      }
    }
    throw new Error('GitHub 中没有可用的 Agent 发布目录')
  }

  async #fetchJson(
    url: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    const bytes = await this.#fetchBounded(
      url,
      [],
      signal,
      true
    )
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    ) as unknown
  }

  async #fetchBounded(
    url: string,
    redirectHosts: readonly string[] = [],
    signal?: AbortSignal,
    rejectRedirects = false
  ): Promise<Buffer> {
    const controller = new AbortController()
    const abortFromCaller = (): void => {
      controller.abort(signal?.reason)
    }
    signal?.addEventListener('abort', abortFromCaller, {
      once: true
    })
    if (signal?.aborted) {
      abortFromCaller()
    }
    const timeout = setTimeout(
      () => controller.abort(
        new DOMException(
          'Agent catalog request timed out',
          'TimeoutError'
        )
      ),
      30_000
    )
    timeout.unref?.()
    try {
      const response = rejectRedirects
        ? await this.#fetchExactResponse(url, controller.signal)
        : await fetchModelDownloadResponse({
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
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  async #fetchExactResponse(
    url: string,
    signal: AbortSignal
  ): Promise<Response> {
    validateSecureDownloadUrl(url, 'Agent 发布目录')
    const response = await this.#fetch(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal
    })
    if (isDownloadRedirectStatus(response.status)) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('Agent 发布目录不允许重定向')
    }
    return response
  }

  async #resolveRemoteDownloadUrls(
    entry: AgentPackageCatalogEntry,
    source: UpdateSource,
    signal?: AbortSignal
  ): Promise<readonly string[]> {
    const controller = new AbortController()
    const abortFromCaller = (): void => {
      controller.abort(signal?.reason)
    }
    signal?.addEventListener('abort', abortFromCaller, {
      once: true
    })
    if (signal?.aborted) {
      abortFromCaller()
    }
    const timeout = setTimeout(
      () => controller.abort(
        new DOMException(
          'Agent remote candidate resolution timed out',
          'TimeoutError'
        )
      ),
      REMOTE_CANDIDATE_TIMEOUT_MS
    )
    timeout.unref?.()
    const urls: string[] = []
    let current = validateSecureDownloadUrl(
      entry.downloads[source].url,
      'Agent 包'
    )
    try {
      for (
        let redirectCount = 0;
        redirectCount <= MAXIMUM_REMOTE_REDIRECTS;
        redirectCount += 1
      ) {
        controller.signal.throwIfAborted()
        const currentUrl = current.href
        if (
          Buffer.byteLength(currentUrl, 'utf8') >
          MAXIMUM_REMOTE_URL_BYTES
        ) {
          throw new Error('Agent 包下载地址超出长度限制')
        }
        urls.push(currentUrl)
        let response = await this.#fetch(current, {
          method: 'HEAD',
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal
        })
        if (response.status === 405 || response.status === 501) {
          await response.body?.cancel().catch(() => undefined)
          response = await this.#fetch(current, {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal
          })
        }
        if (!isDownloadRedirectStatus(response.status)) {
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined)
            throw new Error(
              `Agent 包下载地址检查失败：HTTP ${response.status}`
            )
          }
          const declared = response.headers.get('content-length')
          await response.body?.cancel().catch(() => undefined)
          if (
            declared !== null &&
            (!/^(?:0|[1-9]\d*)$/u.test(declared) ||
              Number(declared) !== entry.size)
          ) {
            throw new Error('Agent 包下载大小与目录不一致')
          }
          return Object.freeze([...urls])
        }
        if (
          source === 'mirror' ||
          redirectCount === MAXIMUM_REMOTE_REDIRECTS
        ) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error(
            source === 'mirror'
              ? 'Agent 镜像下载地址不允许重定向'
              : 'Agent 包下载重定向次数过多'
          )
        }
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (!location) {
          throw new Error('Agent 包下载重定向缺少地址')
        }
        const next = validateSecureDownloadUrl(
          new URL(location, current).href,
          'Agent 包'
        )
        if (
          !GITHUB_REDIRECT_HOSTS.includes(
            next.hostname as (typeof GITHUB_REDIRECT_HOSTS)[number]
          )
        ) {
          throw new Error('Agent 包下载重定向到不受信任的主机')
        }
        current = next
      }
      throw new Error('Agent 包下载重定向次数过多')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
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
    await this.#startupCleanup
    await mkdir(this.#rootDirectory, { recursive: true })
    const path = join(
      this.#rootDirectory,
      `.stage-linux-${architecture}-${randomUUID()}`
    )
    await mkdir(path)
    return path
  }

  async #cleanupInterruptedArtifacts(): Promise<void> {
    await this.#removeOwnedTemporaryDirectories(
      this.#rootDirectory,
      /^\.stage-linux-(?:x64|arm64|import)-[0-9a-f-]{36}$/u
    )
    await Promise.all(
      agentArchitectureSchema.options.map((architecture) =>
        this.#removeOwnedTemporaryDirectories(
          this.#architectureRoot(architecture),
          /^\.backup-[0-9a-f-]{36}$/u
        )
      )
    )
  }

  async #removeOwnedTemporaryDirectories(
    root: string,
    pattern: RegExp
  ): Promise<void> {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            pattern.test(entry.name)
        )
        .slice(0, 512)
        .map((entry) =>
          rm(join(root, entry.name), {
            recursive: true,
            force: true
          }).catch(() => undefined)
        )
    )
  }

  #architectureRoot(
    architecture: AgentArchitecture
  ): string {
    return join(this.#rootDirectory, `linux-${architecture}`)
  }

  #loadTrustedRegistry(): Promise<AgentReleaseKeyRegistry> {
    this.#trustedRegistry ??= readAgentReleaseKeyRegistry(
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

  #runExclusive<T>(
    architecture: AgentArchitecture,
    operation: () => Promise<T>
  ): Promise<T> {
    const existing = this.#operations.get(architecture)
    if (existing) {
      return existing.then(
        () => this.#runExclusive(architecture, operation),
        () => this.#runExclusive(architecture, operation)
      )
    }
    const promise: Promise<T> = operation().finally(() => {
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
    throw new NoCompatibleAgentPackageError(
      `没有与当前 GoodBuddy 兼容的 Linux ${architecture} Agent 包`
    )
  }
  return entry
}

class NoCompatibleAgentPackageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoCompatibleAgentPackageError'
  }
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

function assertCandidateMatchesCatalogEntry(
  candidate: VerifiedRemoteAgentInstallCandidate,
  entry: AgentPackageCatalogEntry,
  source: UpdateSource
): void {
  const canonicalUrl = entry.downloads[source].url
  if (
    candidate.source !== source ||
    candidate.platform !== entry.platform ||
    candidate.architecture !== entry.architecture ||
    candidate.version !== entry.version ||
    candidate.minimumDesktopVersion !==
      entry.minimumDesktopVersion ||
    candidate.agentProtocol.major !==
      entry.agentProtocol.major ||
    candidate.agentProtocol.minor !==
      entry.agentProtocol.minor ||
    candidate.remoteRuntime.runtimeId !==
      entry.remoteRuntime.runtimeId ||
    candidate.remoteRuntime.provider !==
      entry.remoteRuntime.provider ||
    candidate.remoteRuntime.version !==
      entry.remoteRuntime.version ||
    candidate.remoteRuntime.bundleDigest !==
      entry.remoteRuntime.bundleDigest ||
    candidate.remoteRuntime.protocol.major !==
      entry.remoteRuntime.protocol.major ||
    candidate.remoteRuntime.protocol.minor !==
      entry.remoteRuntime.protocol.minor ||
    candidate.archive !== entry.archive ||
    candidate.size !== entry.size ||
    candidate.sha256 !== entry.sha256 ||
    candidate.urls.length < 1 ||
    candidate.urls[0] !== canonicalUrl
  ) {
    throw new Error(
      'Agent install candidate does not match the current signed catalog'
    )
  }
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

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : String(error)
  return (
    message.trim().slice(0, 2_000) ||
    'Agent 发布目录检查失败'
  )
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