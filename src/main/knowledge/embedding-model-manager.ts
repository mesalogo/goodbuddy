import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  MODEL_DOWNLOAD_SOURCES,
  getMaximumModelPackageBytes,
  getModelDownloadAvailability,
  resolveModelDownloadPackage,
  type ModelDownloadAvailability,
  type ModelDownloadSource,
  type ResolvedModelArtifactFile
} from '../../shared/model-download-contracts'
import { extractModelArchive } from '../model-archive'
import { fetchModelDownloadResponse } from '../model-download-transport'
import {
  MODEL_PARTIAL_SUFFIX,
  attachModelAbortSignal,
  cleanupStaleModelInstallArtifacts,
  createModelStagingDirectory,
  ensureModelOperationNotAborted,
  hashModelFile,
  managedModelChild,
  writeModelBuffer
} from '../model-package-utils'
import { isMissingFileError } from '../settings-file-utils'
import { EMBEDDING_MODEL_CATALOG } from './embedding-model-catalog'
import {
  embeddingModelCatalogEntrySchema,
  embeddingModelCatalogViewEntrySchema,
  embeddingModelIdSchema,
  embeddingModelProgressSnapshotSchema,
  embeddingModelSnapshotSchema,
  embeddingModelStatusSchema,
  installedEmbeddingModelSchema,
  type EmbeddingModelCatalogEntry,
  type EmbeddingModelCatalogViewEntry,
  type EmbeddingModelOperation,
  type EmbeddingModelProgressSnapshot,
  type EmbeddingModelSnapshot,
  type EmbeddingModelStatus,
  type InstalledEmbeddingModel
} from './embedding-model-contracts'

const MANIFEST_FILE_NAME = 'manifest.json'
const ARCHIVE_MANIFEST_FILE_NAME = 'goodbuddy-model.json'
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const MAXIMUM_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024 - 1
const ARCHIVE_OVERHEAD_BYTES = 1024 * 1024
const executableExtensionPattern =
  /\.(?:app|bat|bin|cmd|com|cpl|dll|dmg|exe|hta|iso|jar|js|jse|lnk|msi|ps1|reg|scr|sh|sys|vb|vbe|vbs|wsf)$/iu

type ActiveOperation = {
  controller: AbortController
  progress: EmbeddingModelOperation
}

export type EmbeddingModelManagerOptions = {
  userDataDirectory: string
  catalog?: readonly EmbeddingModelCatalogEntry[]
  fetch?: typeof fetch
  getDownloadSource?: () =>
    | ModelDownloadSource
    | Promise<ModelDownloadSource>
  maxFileBytes?: number
}

function safeChild(parent: string, name: string): string {
  return managedModelChild(
    parent,
    name,
    '向量模型路径超出受管目录'
  )
}

function unavailableDownloadAvailability(
  source: ModelDownloadSource,
  reason: string
): ModelDownloadAvailability {
  return { source, available: false, unavailableReason: reason }
}

function toCatalogView(
  entry: EmbeddingModelCatalogEntry
): EmbeddingModelCatalogViewEntry {
  const { repositoryUrls, files, ...metadata } = entry
  void repositoryUrls
  return embeddingModelCatalogViewEntrySchema.parse({
    ...metadata,
    files: files.map(({ targets, ...file }) => {
      void targets
      return file
    }),
    downloadAvailability: MODEL_DOWNLOAD_SOURCES.map((source) =>
      entry.available
        ? getModelDownloadAvailability(files, source)
        : unavailableDownloadAvailability(
            source,
            entry.unavailableReason ??
              '当前内置向量模型尚不可安装'
          )
    )
  })
}

function packageMatches(
  entry: EmbeddingModelCatalogEntry,
  files: readonly {
    name: string
    role: string
    size: number
    sha256: string
  }[]
): boolean {
  return (
    files.length === entry.files.length &&
    entry.files.every((expected) =>
      files.some(
        (actual) =>
          actual.name === expected.name &&
          actual.role === expected.role &&
          actual.size === expected.size &&
          actual.sha256 === expected.sha256
      )
    )
  )
}

export class EmbeddingModelManager {
  readonly rootDirectory: string

  private readonly catalog: EmbeddingModelCatalogEntry[]
  private readonly catalogViews: EmbeddingModelCatalogViewEntry[]
  private readonly transport: typeof fetch
  private readonly getDownloadSource: () =>
    | ModelDownloadSource
    | Promise<ModelDownloadSource>
  private readonly maxFileBytes: number
  private readonly operations = new Map<string, ActiveOperation>()

  constructor(options: EmbeddingModelManagerOptions) {
    if (!options.userDataDirectory.trim()) {
      throw new Error('userDataDirectory is required')
    }
    this.rootDirectory = resolve(
      options.userDataDirectory,
      'models',
      'embedding'
    )
    this.catalog = (options.catalog ?? EMBEDDING_MODEL_CATALOG).map(
      (entry) => embeddingModelCatalogEntrySchema.parse(entry)
    )
    if (
      new Set(this.catalog.map((entry) => entry.id)).size !==
      this.catalog.length
    ) {
      throw new Error('向量模型目录包含重复 ID')
    }
    this.catalogViews = this.catalog.map(toCatalogView)
    this.transport = options.fetch ?? globalThis.fetch
    this.getDownloadSource =
      options.getDownloadSource ?? (() => 'modelscope')
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    if (
      !Number.isSafeInteger(this.maxFileBytes) ||
      this.maxFileBytes <= 0 ||
      this.maxFileBytes > 8 * 1024 * 1024 * 1024
    ) {
      throw new RangeError('maxFileBytes must be a positive safe integer')
    }
  }

  async getSnapshot(): Promise<EmbeddingModelSnapshot> {
    await this.ensureRoot()
    await this.cleanupStaleArtifacts()
    const [selectedDownloadSource, installed] = await Promise.all([
      this.getDownloadSource(),
      this.readInstalled()
    ])
    return embeddingModelSnapshotSchema.parse({
      selectedDownloadSource,
      catalog: this.catalogViews,
      installed,
      operations: [...this.operations.values()].map(({ progress }) => ({
        ...progress
      }))
    })
  }

  async snapshot(): Promise<EmbeddingModelSnapshot> {
    return this.getSnapshot()
  }

  getProgressSnapshot(): EmbeddingModelProgressSnapshot {
    return embeddingModelProgressSnapshotSchema.parse({
      operations: [...this.operations.values()].map(({ progress }) => ({
        ...progress
      }))
    })
  }

  async getStatus(modelId: string): Promise<EmbeddingModelStatus> {
    const id = embeddingModelIdSchema.parse(modelId)
    const entry = this.catalog.find((candidate) => candidate.id === id)
    if (!entry) {
      return embeddingModelStatusSchema.parse({
        id,
        displayName: id,
        catalogAvailable: false,
        installed: false,
        verified: false,
        detail: '当前版本不提供此内置向量模型'
      })
    }
    try {
      await this.verifyInstalledModel(entry)
      return embeddingModelStatusSchema.parse({
        id,
        displayName: entry.displayName,
        catalogAvailable: entry.available,
        installed: true,
        verified: true,
        detail: '模型已安装并通过 SHA-256 校验，可供本地推理使用'
      })
    } catch {
      const installed = await this.hasInstalledDirectory(id)
      return embeddingModelStatusSchema.parse({
        id,
        displayName: entry.displayName,
        catalogAvailable: entry.available,
        installed,
        verified: false,
        detail: installed
          ? '模型文件校验失败'
          : entry.available
            ? '模型尚未安装'
            : entry.unavailableReason!
      })
    }
  }

  /**
   * Returns a Main-owned absolute path only after re-verifying every package
   * file. This path must not be sent to the renderer.
   */
  async getVerifiedModelDirectory(modelId: string): Promise<string> {
    const entry = this.requireAvailableEntry(modelId)
    await this.verifyInstalledModel(entry)
    return this.modelDirectory(entry.id)
  }

  async registerLocalDirectory(
    modelId: string,
    sourceDirectory: string,
    externalSignal?: AbortSignal
  ): Promise<InstalledEmbeddingModel> {
    const entry = this.requireAvailableEntry(modelId)
    const source = resolve(sourceDirectory)
    const operation = this.beginOperation(entry.id, 'import', null)
    const detachAbort = attachModelAbortSignal(
      externalSignal,
      operation.controller
    )
    let stagingDirectory: string | undefined
    try {
      await this.ensureRoot()
      await this.assertNotInstalled(entry.id)
      await this.validateLocalDirectory(
        source,
        entry,
        operation.controller.signal
      )
      stagingDirectory = await createModelStagingDirectory(
        this.rootDirectory,
        entry.id,
        '向量模型路径超出受管目录'
      )
      operation.progress.phase = 'transferring'
      for (const file of entry.files) {
        ensureModelOperationNotAborted(operation.controller.signal)
        operation.progress.currentFile = file.name
        const destination = safeChild(stagingDirectory, file.name)
        await copyFile(safeChild(source, file.name), destination)
        ensureModelOperationNotAborted(operation.controller.signal)
        operation.progress.completedBytes += (await stat(destination)).size
      }
      operation.progress.totalBytes = operation.progress.completedBytes
      operation.progress.phase = 'installing'
      operation.progress.currentFile = null
      const installed = await this.writeVerifiedManifest(
        entry,
        'local',
        stagingDirectory,
        operation.controller.signal
      )
      ensureModelOperationNotAborted(operation.controller.signal)
      await rename(stagingDirectory, this.modelDirectory(entry.id))
      stagingDirectory = undefined
      return installed
    } finally {
      detachAbort()
      this.operations.delete(entry.id)
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
    }
  }

  async install(
    modelId: string,
    downloadSource?: ModelDownloadSource,
    externalSignal?: AbortSignal
  ): Promise<InstalledEmbeddingModel> {
    const entry = this.requireAvailableEntry(modelId)
    const selectedDownloadSource =
      downloadSource ?? (await this.getDownloadSource())
    const resolvedPackage = resolveModelDownloadPackage(
      entry.files,
      selectedDownloadSource
    )
    const operation = this.beginOperation(
      entry.id,
      'download',
      resolvedPackage.totalBytes,
      resolvedPackage.source
    )
    const detachAbort = attachModelAbortSignal(
      externalSignal,
      operation.controller
    )
    let stagingDirectory: string | undefined
    try {
      await this.ensureRoot()
      await this.assertNotInstalled(entry.id)
      stagingDirectory = await createModelStagingDirectory(
        this.rootDirectory,
        entry.id,
        '向量模型路径超出受管目录'
      )
      for (const file of resolvedPackage.files) {
        ensureModelOperationNotAborted(operation.controller.signal)
        operation.progress.phase = 'transferring'
        operation.progress.currentFile = file.name
        await this.downloadFile(
          file,
          safeChild(stagingDirectory, file.name),
          operation,
          operation.controller.signal
        )
      }
      operation.progress.phase = 'installing'
      operation.progress.currentFile = null
      const installed = await this.writeVerifiedManifest(
        entry,
        'download',
        stagingDirectory,
        operation.controller.signal
      )
      ensureModelOperationNotAborted(operation.controller.signal)
      await rename(stagingDirectory, this.modelDirectory(entry.id))
      stagingDirectory = undefined
      return installed
    } finally {
      detachAbort()
      this.operations.delete(entry.id)
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
    }
  }

  async importArchive(
    modelId: string,
    archivePath: string,
    externalSignal?: AbortSignal
  ): Promise<InstalledEmbeddingModel> {
    const entry = this.requireAvailableEntry(modelId)
    if (
      entry.files.some((file) =>
        executableExtensionPattern.test(file.name)
      )
    ) {
      throw new Error('向量模型目录包含不安全文件')
    }
    const expectedTotal = getMaximumModelPackageBytes(entry.files)
    const maximumTotalBytes = Math.min(
      MAXIMUM_ARCHIVE_BYTES,
      expectedTotal + ARCHIVE_OVERHEAD_BYTES
    )
    const operation = this.beginOperation(
      entry.id,
      'import',
      expectedTotal
    )
    const detachAbort = attachModelAbortSignal(
      externalSignal,
      operation.controller
    )
    let stagingDirectory: string | undefined
    try {
      await this.ensureRoot()
      await this.assertNotInstalled(entry.id)
      stagingDirectory = await createModelStagingDirectory(
        this.rootDirectory,
        entry.id,
        '向量模型路径超出受管目录'
      )
      operation.progress.phase = 'transferring'
      const descriptor = await extractModelArchive({
        archivePath,
        destinationDirectory: stagingDirectory,
        expectedKind: 'embedding',
        expectedModelId: entry.id,
        expectedFiles: entry.files.map((file) => ({
          name: file.name,
          role: file.role
        })),
        maximumArchiveBytes: Math.min(
          MAXIMUM_ARCHIVE_BYTES,
          maximumTotalBytes + ARCHIVE_OVERHEAD_BYTES
        ),
        maximumFileBytes: this.maxFileBytes,
        maximumTotalBytes,
        signal: operation.controller.signal,
        onProgress: (completedBytes) => {
          operation.progress.completedBytes = completedBytes
        }
      })
      if (
        descriptor.files.some(
          (file) => file.size > this.maxFileBytes
        ) ||
        !packageMatches(entry, descriptor.files)
      ) {
        throw new Error('向量模型 ZIP 与当前模型目录不匹配')
      }
      operation.progress.totalBytes = descriptor.files.reduce(
        (total, file) => total + file.size,
        0
      )
      operation.progress.phase = 'installing'
      operation.progress.currentFile = null
      await rm(
        safeChild(stagingDirectory, ARCHIVE_MANIFEST_FILE_NAME),
        { force: true }
      )
      const installed = await this.writeVerifiedManifest(
        entry,
        'local',
        stagingDirectory,
        operation.controller.signal
      )
      ensureModelOperationNotAborted(operation.controller.signal)
      await rename(stagingDirectory, this.modelDirectory(entry.id))
      stagingDirectory = undefined
      return installed
    } finally {
      detachAbort()
      this.operations.delete(entry.id)
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
    }
  }

  cancel(modelId: string): boolean {
    const id = embeddingModelIdSchema.parse(modelId)
    const operation = this.operations.get(id)
    if (!operation) {
      return false
    }
    operation.controller.abort()
    return true
  }

  async remove(modelId: string): Promise<void> {
    const id = embeddingModelIdSchema.parse(modelId)
    this.cancel(id)
    await rm(this.modelDirectory(id), { recursive: true, force: true })
  }

  dispose(): void {
    for (const operation of this.operations.values()) {
      operation.controller.abort()
    }
    this.operations.clear()
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true })
  }

  private modelDirectory(modelId: string): string {
    return safeChild(
      this.rootDirectory,
      embeddingModelIdSchema.parse(modelId)
    )
  }

  private requireAvailableEntry(
    modelId: string
  ): EmbeddingModelCatalogEntry {
    const id = embeddingModelIdSchema.parse(modelId)
    const entry = this.catalog.find((candidate) => candidate.id === id)
    if (!entry) {
      throw new Error('未知的向量模型')
    }
    if (!entry.available) {
      throw new Error(
        entry.unavailableReason ?? '当前向量模型尚不可安装'
      )
    }
    return entry
  }

  private beginOperation(
    modelId: string,
    kind: EmbeddingModelOperation['kind'],
    totalBytes: number | null,
    downloadSource?: ModelDownloadSource
  ): ActiveOperation {
    if (this.operations.has(modelId)) {
      throw new Error('该向量模型已有进行中的操作')
    }
    const operation: ActiveOperation = {
      controller: new AbortController(),
      progress: {
        modelId,
        kind,
        phase: 'preparing',
        currentFile: null,
        completedBytes: 0,
        totalBytes,
        ...(downloadSource ? { downloadSource } : {})
      }
    }
    this.operations.set(modelId, operation)
    return operation
  }

  private async downloadFile(
    file: ResolvedModelArtifactFile<
      EmbeddingModelCatalogEntry['files'][number]['role']
    >,
    destination: string,
    operation: ActiveOperation,
    signal: AbortSignal
  ): Promise<void> {
    if (file.size <= 0 || file.size > this.maxFileBytes) {
      throw new RangeError(`向量模型文件过大：${file.name}`)
    }
    const response = await fetchModelDownloadResponse({
      transport: this.transport,
      initialUrl: file.target.url,
      redirectHosts: file.target.redirectHosts,
      signal,
      modelLabel: '向量模型'
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`向量模型下载失败：HTTP ${response.status}`)
    }
    if (!response.body) {
      throw new Error('向量模型下载响应没有内容')
    }
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength)
      if (
        !Number.isSafeInteger(parsedLength) ||
        parsedLength !== file.size
      ) {
        await response.body.cancel().catch(() => undefined)
        throw new Error(`向量模型文件大小不匹配：${file.name}`)
      }
    }

    const partialPath = `${destination}${MODEL_PARTIAL_SUFFIX}`
    const handle = await open(partialPath, 'wx')
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    let written = 0
    try {
      while (true) {
        ensureModelOperationNotAborted(signal)
        const result = await reader.read()
        if (result.done) {
          break
        }
        if (
          written + result.value.byteLength > file.size ||
          written + result.value.byteLength > this.maxFileBytes
        ) {
          await reader.cancel()
          throw new RangeError(`向量模型文件过大：${file.name}`)
        }
        written += await writeModelBuffer(
          handle,
          result.value,
          (persisted) => {
            hash.update(persisted)
            operation.progress.completedBytes += persisted.byteLength
          }
        )
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      await handle.close()
    }
    if (written !== file.size) {
      throw new Error(`向量模型文件大小不匹配：${file.name}`)
    }
    if (hash.digest('hex') !== file.sha256) {
      throw new Error(`向量模型文件校验失败：${file.name}`)
    }
    await rename(partialPath, destination)
  }

  private async assertNotInstalled(modelId: string): Promise<void> {
    try {
      await lstat(this.modelDirectory(modelId))
      throw new Error('向量模型已安装')
    } catch (error) {
      if (isMissingFileError(error)) {
        return
      }
      throw error
    }
  }

  private async hasInstalledDirectory(modelId: string): Promise<boolean> {
    try {
      const info = await lstat(this.modelDirectory(modelId))
      return info.isDirectory() && !info.isSymbolicLink()
    } catch (error) {
      if (isMissingFileError(error)) {
        return false
      }
      throw error
    }
  }

  private async validateLocalDirectory(
    source: string,
    entry: EmbeddingModelCatalogEntry,
    signal: AbortSignal
  ): Promise<void> {
    const sourceInfo = await lstat(source)
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw new Error('本地向量模型来源必须是普通目录')
    }
    const directoryEntries = await readdir(source, {
      withFileTypes: true
    })
    if (directoryEntries.length !== entry.files.length) {
      throw new Error('本地向量模型目录包含未声明或缺失的文件')
    }
    for (const localEntry of directoryEntries) {
      ensureModelOperationNotAborted(signal)
      if (
        localEntry.isSymbolicLink() ||
        !localEntry.isFile() ||
        executableExtensionPattern.test(localEntry.name)
      ) {
        throw new Error('本地向量模型目录包含不安全文件')
      }
    }
    for (const file of entry.files) {
      ensureModelOperationNotAborted(signal)
      const path = safeChild(source, file.name)
      const info = await lstat(path)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size <= 0 ||
        info.size > this.maxFileBytes
      ) {
        throw new Error(`向量模型文件无效：${file.name}`)
      }
      const actual = await hashModelFile(path, signal)
      if (
        actual.size !== file.size ||
        actual.sha256 !== file.sha256
      ) {
        throw new Error(`向量模型文件校验失败：${file.name}`)
      }
    }
  }

  private async writeVerifiedManifest(
    entry: EmbeddingModelCatalogEntry,
    source: InstalledEmbeddingModel['source'],
    directory: string,
    signal: AbortSignal
  ): Promise<InstalledEmbeddingModel> {
    const files: InstalledEmbeddingModel['files'] = []
    for (const file of entry.files) {
      ensureModelOperationNotAborted(signal)
      const actual = await hashModelFile(
        safeChild(directory, file.name),
        signal
      )
      files.push({ name: file.name, role: file.role, ...actual })
    }
    if (!packageMatches(entry, files)) {
      throw new Error('向量模型文件与当前目录不匹配')
    }
    const installed = installedEmbeddingModelSchema.parse({
      id: entry.id,
      displayName: entry.displayName,
      source,
      installedAt: new Date().toISOString(),
      files
    })
    await writeFile(
      safeChild(directory, MANIFEST_FILE_NAME),
      `${JSON.stringify(installed, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    )
    return installed
  }

  private async readInstalled(): Promise<InstalledEmbeddingModel[]> {
    const entries = await readdir(this.rootDirectory, {
      withFileTypes: true
    })
    const installed: InstalledEmbeddingModel[] = []
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name.startsWith('.install-') ||
        !embeddingModelIdSchema.safeParse(entry.name).success
      ) {
        continue
      }
      try {
        const manifest = installedEmbeddingModelSchema.parse(
          JSON.parse(
            await readFile(
              safeChild(
                this.modelDirectory(entry.name),
                MANIFEST_FILE_NAME
              ),
              'utf8'
            )
          ) as unknown
        )
        if (manifest.id === entry.name) {
          installed.push(manifest)
        }
      } catch {
        // Ignore incomplete or externally modified directories.
      }
    }
    return installed
  }

  private async verifyInstalledModel(
    entry: EmbeddingModelCatalogEntry
  ): Promise<void> {
    const directory = this.modelDirectory(entry.id)
    const directoryInfo = await lstat(directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error('向量模型目录无效')
    }
    const manifestPath = safeChild(directory, MANIFEST_FILE_NAME)
    const manifestInfo = await lstat(manifestPath)
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw new Error('向量模型清单无效')
    }
    const manifest = installedEmbeddingModelSchema.parse(
      JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
    )
    if (manifest.id !== entry.id || !packageMatches(entry, manifest.files)) {
      throw new Error('向量模型清单与目录不匹配')
    }
    const actualEntries = await readdir(directory, { withFileTypes: true })
    if (actualEntries.length !== entry.files.length + 1) {
      throw new Error('向量模型目录包含未声明文件')
    }
    for (const file of entry.files) {
      const path = safeChild(directory, file.name)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`向量模型文件无效：${file.name}`)
      }
      const actual = await hashModelFile(path)
      if (
        actual.size !== file.size ||
        actual.sha256 !== file.sha256
      ) {
        throw new Error(`向量模型文件校验失败：${file.name}`)
      }
    }
  }

  private cleanupStaleArtifacts(): Promise<void> {
    return cleanupStaleModelInstallArtifacts({
      rootDirectory: this.rootDirectory,
      isModelId: (value) =>
        embeddingModelIdSchema.safeParse(value).success,
      activeModelIds: new Set(this.operations.keys()),
      partialFileNames: new Set(
        this.catalog.flatMap((entry) =>
          entry.files.map((file) => file.name)
        )
      ),
      escapeMessage: '向量模型路径超出受管目录'
    })
  }
}
