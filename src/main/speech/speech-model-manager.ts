import { createHash, randomUUID } from 'node:crypto'
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
import { z } from 'zod'
import {
  installedSpeechModelSchema,
  speechModelCatalogEntrySchema,
  speechModelCatalogViewEntrySchema,
  speechModelIdSchema,
  speechModelSnapshotSchema,
  type InstalledSpeechModel,
  type SpeechModelCatalogEntry,
  type SpeechModelCatalogViewEntry,
  type SpeechModelFileSpec,
  type SpeechModelOperation,
  type SpeechModelSnapshot
} from '../../shared/speech-model-contracts'
import {
  MODEL_DOWNLOAD_SOURCES,
  getMaximumModelPackageBytes,
  getModelDownloadAvailability,
  getModelPackageFingerprints,
  modelPackageFingerprintMatches,
  resolveModelDownloadPackage,
  type ModelDownloadSource,
  type ResolvedModelArtifactFile
} from '../../shared/model-download-contracts'
import { SPEECH_MODEL_CATALOG } from './speech-model-catalog'
import {
  exportModelArchive,
  extractModelArchive
} from '../model-archive'
import { fetchModelDownloadResponse } from '../model-download-transport'
import {
  MODEL_PARTIAL_SUFFIX,
  attachModelAbortSignal,
  cleanupStaleModelInstallArtifacts,
  createModelStagingDirectory,
  ensureModelOperationNotAborted,
  fingerprintModelFile,
  hashModelFile,
  managedModelChild,
  modelFileFingerprintMatches,
  type ModelFileFingerprint,
  writeModelBuffer
} from '../model-package-utils'
import { isMissingFileError } from '../settings-file-utils'

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const MANIFEST_FILE_NAME = 'manifest.json'
const SELECTION_FILE_NAME = '.selection.json'
const MAXIMUM_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024 - 1
const ARCHIVE_OVERHEAD_BYTES = 1024 * 1024

const selectionSchema = z
  .object({
    selectedModelId: speechModelIdSchema.nullable()
  })
  .strict()

const executableExtensionPattern =
  /\.(?:app|bat|bin|cmd|com|cpl|dll|dmg|exe|gadget|hta|inf|ins|ipa|iso|jar|js|jse|lnk|msi|msp|mst|pif|ps1|reg|scr|sh|sys|vb|vbe|vbs|ws|wsc|wsf|wsh)$/iu

type ActiveOperation = {
  controller: AbortController
  progress: SpeechModelOperation
}

type SpeechSelectionFileOperations = {
  writeFile: typeof writeFile
  rename: typeof rename
}

type CachedSelectedSpeechRuntimeModel = {
  model: SelectedSpeechRuntimeModel
  manifestFingerprint: ModelFileFingerprint
  fileFingerprints: Map<string, ModelFileFingerprint>
}

export type SpeechModelManagerOptions = {
  userDataDirectory: string
  fetch: typeof fetch
  catalog?: readonly SpeechModelCatalogEntry[]
  getDownloadSource?: () =>
    | ModelDownloadSource
    | Promise<ModelDownloadSource>
  maxFileBytes?: number
  selectionFileOperations?: Partial<SpeechSelectionFileOperations>
}

export type SelectedSpeechRuntimeModel = {
  id: string
  family: SpeechModelCatalogEntry['family']
  directory: string
  files: InstalledSpeechModel['files']
}

function cloneCatalogEntry(
  entry: SpeechModelCatalogEntry
): SpeechModelCatalogEntry {
  return speechModelCatalogEntrySchema.parse(entry)
}

function toCatalogView(entry: SpeechModelCatalogEntry) {
  const { repositoryUrls, files, ...metadata } = entry
  void repositoryUrls
  return speechModelCatalogViewEntrySchema.parse({
    ...metadata,
    files: files.map((file) => ({
      name: file.name,
      role: file.role,
      size: file.size,
      sha256: file.sha256
    })),
    downloadAvailability: MODEL_DOWNLOAD_SOURCES.map((source) =>
      getModelDownloadAvailability(files, source)
    )
  })
}

function speechModelPackageMatches(
  entry: SpeechModelCatalogEntry,
  files: readonly {
    name: string
    role: string
    size: number
    sha256: string
  }[]
): boolean {
  return getModelPackageFingerprints(entry.files).some(
    (fingerprint) =>
      modelPackageFingerprintMatches(fingerprint, files)
  )
}

function validateMaximumBytes(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAX_FILE_BYTES
  if (
    !Number.isSafeInteger(maximum) ||
    maximum <= 0 ||
    maximum > 8 * 1024 * 1024 * 1024
  ) {
    throw new RangeError('maxFileBytes must be a positive safe integer')
  }
  return maximum
}

function safeChild(parent: string, name: string): string {
  return managedModelChild(parent, name, '模型路径超出受管目录')
}

export class SpeechModelManager {
  readonly rootDirectory: string

  private readonly transport: typeof fetch
  private readonly catalog: SpeechModelCatalogEntry[]
  private readonly catalogViews: SpeechModelCatalogViewEntry[]
  private readonly getDownloadSource: () =>
    | ModelDownloadSource
    | Promise<ModelDownloadSource>
  private readonly maxFileBytes: number
  private readonly selectionFileOperations: SpeechSelectionFileOperations
  private readonly operations = new Map<string, ActiveOperation>()
  private readonly activeSelectionPartialNames = new Set<string>()
  private selectedRuntimeModel?: Promise<
    CachedSelectedSpeechRuntimeModel | undefined
  >
  private selectedRuntimeGeneration = 0

  constructor(options: SpeechModelManagerOptions) {
    if (!options.userDataDirectory.trim()) {
      throw new Error('userDataDirectory is required')
    }
    this.rootDirectory = resolve(
      options.userDataDirectory,
      'models',
      'speech'
    )
    this.transport = options.fetch
    this.getDownloadSource =
      options.getDownloadSource ?? (() => 'modelscope')
    this.catalog = (options.catalog ?? SPEECH_MODEL_CATALOG).map(
      cloneCatalogEntry
    )
    if (new Set(this.catalog.map((entry) => entry.id)).size !== this.catalog.length) {
      throw new Error('语音模型目录包含重复 ID')
    }
    this.catalogViews = this.catalog.map(toCatalogView)
    this.maxFileBytes = validateMaximumBytes(options.maxFileBytes)
    this.selectionFileOperations = {
      writeFile,
      rename,
      ...options.selectionFileOperations
    }
  }

  async snapshot(): Promise<SpeechModelSnapshot> {
    await this.ensureRoot()
    await this.cleanupStaleArtifacts()
    const [installed, selected, selectedDownloadSource] =
      await Promise.all([
        this.readInstalled(),
        this.readSelection(),
        this.getDownloadSource()
      ])
    const installedIds = new Set(installed.map((model) => model.id))
    return speechModelSnapshotSchema.parse({
      rootDirectory: this.rootDirectory,
      selectedDownloadSource,
      catalog: this.catalogViews,
      installed,
      operations: [...this.operations.values()].map((operation) => ({
        ...operation.progress
      })),
      selectedModelId:
        selected && installedIds.has(selected) ? selected : null
    })
  }

  async getSnapshot(): Promise<SpeechModelSnapshot> {
    return this.snapshot()
  }

  getRepositoryUrl(
    modelId: string,
    source: ModelDownloadSource
  ): string {
    const entry = this.requireCatalogEntry(modelId)
    resolveModelDownloadPackage(entry.files, source)
    const repositoryUrl = entry.repositoryUrls[source]
    if (!repositoryUrl) {
      throw new Error('当前下载源暂不提供此模型的仓库')
    }
    return repositoryUrl
  }

  async getSelectedRuntimeModel(): Promise<
    SelectedSpeechRuntimeModel | undefined
  > {
    const selectedModelId = await this.readSelection()
    if (!selectedModelId) {
      this.invalidateSelectedRuntimeModel()
      return undefined
    }
    const cachedPromise = this.selectedRuntimeModel
    if (cachedPromise) {
      const cached = await cachedPromise
      if (
        cached?.model.id === selectedModelId &&
        (await this.selectedRuntimeFingerprintsMatch(cached))
      ) {
        return this.cloneSelectedRuntimeModel(cached.model)
      }
      if (this.selectedRuntimeModel === cachedPromise) {
        this.invalidateSelectedRuntimeModel()
      }
    }
    const selected = await this.getOrCreateSelectedRuntimeModel(
      selectedModelId
    )
    return selected
      ? this.cloneSelectedRuntimeModel(selected.model)
      : undefined
  }

  private getOrCreateSelectedRuntimeModel(
    selectedModelId: string
  ): Promise<CachedSelectedSpeechRuntimeModel | undefined> {
    const current = this.selectedRuntimeModel
    if (current) {
      return current
    }
    const generation = this.selectedRuntimeGeneration
    const resolution = this.resolveSelectedRuntimeModel(
      selectedModelId,
      generation
    )
    const tracked = resolution.catch((error) => {
      if (this.selectedRuntimeModel === tracked) {
        this.selectedRuntimeModel = undefined
      }
      throw error
    })
    this.selectedRuntimeModel = tracked
    return tracked
  }

  async install(
    modelId: string,
    downloadSource?: ModelDownloadSource,
    externalSignal?: AbortSignal
  ): Promise<InstalledSpeechModel> {
    const entry = this.requireCatalogEntry(modelId)
    if (entry.manualOnly) {
      throw new Error(
        entry.manualReason ?? '该模型只能从本地目录导入'
      )
    }
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
    const detachExternalAbort = this.attachExternalSignal(
      externalSignal,
      operation.controller
    )
    let stagingDirectory: string | undefined
    try {
      await this.ensureRoot()
      await this.assertNotInstalled(entry.id)
      stagingDirectory = await this.createStagingDirectory(entry.id)
      for (const file of resolvedPackage.files) {
        ensureModelOperationNotAborted(operation.controller.signal)
        operation.progress.phase = 'transferring'
        operation.progress.currentFile = file.name
        const destination = safeChild(stagingDirectory, file.name)
        await this.downloadFile(
          file,
          destination,
          operation,
          operation.controller.signal
        )
      }
      operation.progress.phase = 'installing'
      operation.progress.currentFile = null
      const installed = await this.createInstalledManifest(
        entry,
        'download',
        stagingDirectory,
        operation.controller.signal
      )
      ensureModelOperationNotAborted(operation.controller.signal)
      await rename(
        stagingDirectory,
        this.modelDirectory(entry.id)
      )
      stagingDirectory = undefined
      this.invalidateSelectedRuntimeModel()
      return installed
    } finally {
      detachExternalAbort()
      this.operations.delete(entry.id)
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
    }
  }

  cancel(modelId: string): boolean {
    speechModelIdSchema.parse(modelId)
    const operation = this.operations.get(modelId)
    if (!operation) {
      return false
    }
    operation.controller.abort()
    return true
  }

  async remove(modelId: string): Promise<void> {
    speechModelIdSchema.parse(modelId)
    this.cancel(modelId)
    this.invalidateSelectedRuntimeModel()
    await this.ensureRoot()
    const target = this.modelDirectory(modelId)
    await rm(target, { recursive: true, force: true })
    const selected = await this.readSelection()
    if (selected === modelId) {
      await this.writeSelection(null)
    }
  }

  async select(modelId: string | null): Promise<void> {
    if (modelId !== null) {
      speechModelIdSchema.parse(modelId)
      const installed = await this.readInstalled()
      if (!installed.some((model) => model.id === modelId)) {
        throw new Error('只能选择已安装的语音模型')
      }
    }
    await this.writeSelection(modelId)
    this.invalidateSelectedRuntimeModel()
  }

  async registerLocalDirectory(
    modelId: string,
    sourceDirectory: string,
    externalSignal?: AbortSignal
  ): Promise<InstalledSpeechModel> {
    const entry = this.requireCatalogEntry(modelId)
    const source = resolve(sourceDirectory)
    const operation = this.beginOperation(entry.id, 'import', null)
    const detachExternalAbort = this.attachExternalSignal(
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
      stagingDirectory = await this.createStagingDirectory(entry.id)
      operation.progress.phase = 'transferring'
      for (const file of entry.files) {
        ensureModelOperationNotAborted(operation.controller.signal)
        operation.progress.currentFile = file.name
        const sourceFile = safeChild(source, file.name)
        const destination = safeChild(stagingDirectory, file.name)
        await copyFile(sourceFile, destination)
        ensureModelOperationNotAborted(operation.controller.signal)
        const copied = await stat(destination)
        if (copied.size > this.maxFileBytes) {
          throw new RangeError(`模型文件过大：${file.name}`)
        }
        operation.progress.completedBytes += copied.size
      }
      operation.progress.totalBytes =
        operation.progress.completedBytes
      operation.progress.phase = 'installing'
      operation.progress.currentFile = null
      const installed = await this.createInstalledManifest(
        entry,
        'local',
        stagingDirectory,
        operation.controller.signal
      )
      ensureModelOperationNotAborted(operation.controller.signal)
      await rename(
        stagingDirectory,
        this.modelDirectory(entry.id)
      )
      stagingDirectory = undefined
      this.invalidateSelectedRuntimeModel()
      return installed
    } finally {
      detachExternalAbort()
      this.operations.delete(entry.id)
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
    }
  }

  async exportArchive(
    modelId: string,
    destinationPath: string
  ): Promise<void> {
    const entry = this.requireCatalogEntry(modelId)
    await this.ensureRoot()
    const installed = (await this.readInstalled()).find(
      (model) => model.id === entry.id
    )
    if (!installed) {
      throw new Error('只能导出已安装的语音模型')
    }
    if (!speechModelPackageMatches(entry, installed.files)) {
      throw new Error('语音模型文件与当前模型目录不匹配')
    }
    const directory = this.modelDirectory(entry.id)
    const files = []
    for (const expected of entry.files) {
      const recorded = installed.files.find(
        (file) =>
          file.name === expected.name && file.role === expected.role
      )
      if (
        !recorded ||
        recorded.size <= 0 ||
        recorded.size > this.maxFileBytes
      ) {
        throw new Error(`语音模型文件不可导出：${expected.name}`)
      }
      files.push({
        name: expected.name,
        role: expected.role,
        size: recorded.size,
        sha256: recorded.sha256
      })
    }
    await exportModelArchive({
      destinationPath,
      sourceDirectory: directory,
      descriptor: {
        kind: 'speech',
        modelId: entry.id,
        displayName: entry.displayName,
        files
      }
    })
  }

  async importArchive(
    modelId: string,
    archivePath: string
  ): Promise<InstalledSpeechModel> {
    const entry = this.requireCatalogEntry(modelId)
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
    let stagingDirectory: string | undefined
    try {
      await this.ensureRoot()
      await this.assertNotInstalled(entry.id)
      stagingDirectory = await this.createStagingDirectory(entry.id)
      operation.progress.phase = 'transferring'
      const descriptor = await extractModelArchive({
        archivePath,
        destinationDirectory: stagingDirectory,
        expectedKind: 'speech',
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
        !speechModelPackageMatches(entry, descriptor.files)
      ) {
        throw new Error('语音模型 ZIP 与当前模型目录不匹配')
      }
      operation.progress.totalBytes = descriptor.files.reduce(
        (total, file) => total + file.size,
        0
      )
      operation.progress.phase = 'installing'
      operation.progress.currentFile = null
      const installed = installedSpeechModelSchema.parse({
        id: entry.id,
        displayName: entry.displayName,
        source: 'local',
        installedAt: new Date().toISOString(),
        files: descriptor.files
      })
      await writeFile(
        safeChild(stagingDirectory, MANIFEST_FILE_NAME),
        `${JSON.stringify(installed, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' }
      )
      ensureModelOperationNotAborted(operation.controller.signal)
      await rename(stagingDirectory, this.modelDirectory(entry.id))
      stagingDirectory = undefined
      this.invalidateSelectedRuntimeModel()
      return installed
    } finally {
      this.operations.delete(entry.id)
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true })
  }

  private invalidateSelectedRuntimeModel(): void {
    this.selectedRuntimeGeneration += 1
    this.selectedRuntimeModel = undefined
  }

  private async resolveSelectedRuntimeModel(
    selectedModelId: string,
    generation: number
  ): Promise<CachedSelectedSpeechRuntimeModel | undefined> {
    await this.ensureRoot()
    const catalogEntry = this.catalog.find(
      (entry) => entry.id === selectedModelId
    )
    if (!catalogEntry) {
      return undefined
    }
    try {
      const directory = this.modelDirectory(selectedModelId)
      const manifestPath = safeChild(directory, MANIFEST_FILE_NAME)
      const manifestFingerprintBefore = await fingerprintModelFile(
        manifestPath
      )
      if (
        !manifestFingerprintBefore.isFile ||
        manifestFingerprintBefore.isSymbolicLink
      ) {
        return undefined
      }
      const installed = installedSpeechModelSchema.parse(
        JSON.parse(
          await readFile(manifestPath, 'utf8')
        ) as unknown
      )
      const manifestFingerprint = await fingerprintModelFile(manifestPath)
      if (
        !modelFileFingerprintMatches(
          manifestFingerprintBefore,
          manifestFingerprint
        )
      ) {
        return undefined
      }
      if (installed.id !== selectedModelId) {
        return undefined
      }
      if (
        installed.files.length !== catalogEntry.files.length ||
        !speechModelPackageMatches(catalogEntry, installed.files)
      ) {
        return undefined
      }
      const fileFingerprints = new Map<string, ModelFileFingerprint>()
      for (const file of installed.files) {
        const path = safeChild(directory, file.name)
        const fingerprintBefore = await fingerprintModelFile(path)
        if (
          !fingerprintBefore.isFile ||
          fingerprintBefore.isSymbolicLink ||
          fingerprintBefore.size !== BigInt(file.size)
        ) {
          return undefined
        }
        const actual = await hashModelFile(path)
        const fingerprint = await fingerprintModelFile(path)
        if (
          actual.size !== file.size ||
          actual.sha256 !== file.sha256 ||
          !modelFileFingerprintMatches(
            fingerprintBefore,
            fingerprint
          )
        ) {
          return undefined
        }
        fileFingerprints.set(file.name, fingerprint)
      }
      if (
        generation !== this.selectedRuntimeGeneration ||
        (await this.readSelection()) !== selectedModelId
      ) {
        return undefined
      }
      return {
        model: {
          id: installed.id,
          family: catalogEntry.family,
          directory,
          files: installed.files.map((file) => ({ ...file }))
        },
        manifestFingerprint,
        fileFingerprints
      }
    } catch {
      return undefined
    }
  }

  private cloneSelectedRuntimeModel(
    model: SelectedSpeechRuntimeModel
  ): SelectedSpeechRuntimeModel {
    return {
      ...model,
      files: model.files.map((file) => ({ ...file }))
    }
  }

  private async selectedRuntimeFingerprintsMatch(
    cached: CachedSelectedSpeechRuntimeModel
  ): Promise<boolean> {
    try {
      const manifestFingerprint = await fingerprintModelFile(
        safeChild(cached.model.directory, MANIFEST_FILE_NAME)
      )
      if (
        !manifestFingerprint.isFile ||
        manifestFingerprint.isSymbolicLink ||
        !modelFileFingerprintMatches(
          manifestFingerprint,
          cached.manifestFingerprint
        )
      ) {
        return false
      }
      for (const file of cached.model.files) {
        const expected = cached.fileFingerprints.get(file.name)
        if (!expected) {
          return false
        }
        const actual = await fingerprintModelFile(
          safeChild(cached.model.directory, file.name)
        )
        if (
          !actual.isFile ||
          actual.isSymbolicLink ||
          actual.size !== BigInt(file.size) ||
          !modelFileFingerprintMatches(actual, expected)
        ) {
          return false
        }
      }
      return true
    } catch {
      return false
    }
  }

  private modelDirectory(modelId: string): string {
    const parsedId = speechModelIdSchema.parse(modelId)
    return safeChild(this.rootDirectory, parsedId)
  }

  private requireCatalogEntry(modelId: string): SpeechModelCatalogEntry {
    const parsedId = speechModelIdSchema.parse(modelId)
    const entry = this.catalog.find((candidate) => candidate.id === parsedId)
    if (!entry) {
      throw new Error('未知的语音模型')
    }
    return entry
  }

  private beginOperation(
    modelId: string,
    kind: SpeechModelOperation['kind'],
    totalBytes: number | null,
    downloadSource?: ModelDownloadSource
  ): ActiveOperation {
    if (this.operations.has(modelId)) {
      throw new Error('该模型已有进行中的操作')
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

  private attachExternalSignal(
    signal: AbortSignal | undefined,
    controller: AbortController
  ): () => void {
    return attachModelAbortSignal(signal, controller)
  }

  private async assertNotInstalled(modelId: string): Promise<void> {
    try {
      await lstat(this.modelDirectory(modelId))
      throw new Error('语音模型已安装')
    } catch (error) {
      if (isMissingFileError(error)) {
        return
      }
      throw error
    }
  }

  private async createStagingDirectory(modelId: string): Promise<string> {
    return createModelStagingDirectory(
      this.rootDirectory,
      modelId,
      '模型路径超出受管目录'
    )
  }

  private async downloadFile(
    file: ResolvedModelArtifactFile<SpeechModelFileSpec['role']>,
    destination: string,
    operation: ActiveOperation,
    signal: AbortSignal
  ): Promise<void> {
    if (
      file.size > this.maxFileBytes ||
      file.size <= 0
    ) {
      throw new RangeError(`模型文件大小超出限制：${file.name}`)
    }
    const response = await fetchModelDownloadResponse({
      transport: this.transport,
      initialUrl: file.target.url,
      redirectHosts: file.target.redirectHosts,
      signal,
      modelLabel: '模型'
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`模型下载失败：HTTP ${response.status}`)
    }
    if (!response.body) {
      throw new Error('模型下载响应没有内容')
    }
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength)
      if (
        !Number.isSafeInteger(parsedLength) ||
        parsedLength !== file.size
      ) {
        await response.body.cancel().catch(() => undefined)
        throw new Error(`模型文件大小不匹配：${file.name}`)
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
          throw new RangeError(`模型文件过大：${file.name}`)
        }
        const persistedBytes = await writeModelBuffer(
          handle,
          result.value,
          (persisted) => {
            hash.update(persisted)
            operation.progress.completedBytes += persisted.byteLength
          }
        )
        written += persistedBytes
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      await handle.close()
    }
    if (written !== file.size) {
      throw new Error(`模型文件大小不匹配：${file.name}`)
    }
    if (hash.digest('hex') !== file.sha256) {
      throw new Error(`模型文件校验失败：${file.name}`)
    }
    await rename(partialPath, destination)
  }

  private async validateLocalDirectory(
    sourceDirectory: string,
    entry: SpeechModelCatalogEntry,
    signal: AbortSignal
  ): Promise<void> {
    const sourceInfo = await lstat(sourceDirectory)
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw new Error('本地模型来源必须是普通目录')
    }
    await this.rejectUnsafeLocalEntries(sourceDirectory, signal, {
      visited: 0
    })
    const actualFiles: InstalledSpeechModel['files'] = []
    for (const expectedFile of entry.files) {
      ensureModelOperationNotAborted(signal)
      const sourceFile = safeChild(sourceDirectory, expectedFile.name)
      const sourceFileInfo = await lstat(sourceFile)
      if (
        !sourceFileInfo.isFile() ||
        sourceFileInfo.isSymbolicLink()
      ) {
        throw new Error(`模型文件必须是普通文件：${expectedFile.name}`)
      }
      if (
        sourceFileInfo.size <= 0 ||
        sourceFileInfo.size > this.maxFileBytes
      ) {
        throw new RangeError(`模型文件大小无效：${expectedFile.name}`)
      }
      actualFiles.push({
        name: expectedFile.name,
        role: expectedFile.role,
        ...(await hashModelFile(sourceFile, signal))
      })
    }
    if (!speechModelPackageMatches(entry, actualFiles)) {
      throw new Error('本地模型文件与当前模型目录不匹配')
    }
  }

  private async rejectUnsafeLocalEntries(
    directory: string,
    signal: AbortSignal,
    counter: { visited: number }
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      ensureModelOperationNotAborted(signal)
      counter.visited += 1
      if (counter.visited > 4_096) {
        throw new Error('本地模型目录包含过多条目')
      }
      if (executableExtensionPattern.test(entry.name)) {
        throw new Error(`本地模型目录包含可执行文件：${entry.name}`)
      }
      const path = safeChild(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        throw new Error(`本地模型目录不能包含符号链接：${entry.name}`)
      }
      if (metadata.isDirectory()) {
        await this.rejectUnsafeLocalEntries(path, signal, counter)
      } else if (
        metadata.isFile() &&
        (((metadata.mode & 0o111) !== 0 &&
          process.platform !== 'win32') ||
          (await this.hasExecutableSignature(path)))
      ) {
        throw new Error(`本地模型目录包含可执行文件：${entry.name}`)
      }
    }
  }

  private async hasExecutableSignature(path: string): Promise<boolean> {
    const handle = await open(path, 'r')
    const header = Buffer.alloc(4)
    try {
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      if (bytesRead < 2) {
        return false
      }
      if (
        (header[0] === 0x4d && header[1] === 0x5a) ||
        (header[0] === 0x23 && header[1] === 0x21)
      ) {
        return true
      }
      if (
        bytesRead === 4 &&
        ((header[0] === 0x7f &&
          header[1] === 0x45 &&
          header[2] === 0x4c &&
          header[3] === 0x46) ||
          [
            'cafebabe',
            'cefaedfe',
            'cffaedfe',
            'feedface',
            'feedfacf'
          ].includes(header.toString('hex')))
      ) {
        return true
      }
      return false
    } finally {
      await handle.close()
    }
  }

  private async createInstalledManifest(
    entry: SpeechModelCatalogEntry,
    source: InstalledSpeechModel['source'],
    stagingDirectory: string,
    signal: AbortSignal
  ): Promise<InstalledSpeechModel> {
    const files = []
    for (const file of entry.files) {
      ensureModelOperationNotAborted(signal)
      const metadata = await hashModelFile(
        safeChild(stagingDirectory, file.name),
        signal
      )
      files.push({
        name: file.name,
        role: file.role,
        ...metadata
      })
    }
    const manifest = installedSpeechModelSchema.parse({
      id: entry.id,
      displayName: entry.displayName,
      source,
      installedAt: new Date().toISOString(),
      files
    })
    if (!speechModelPackageMatches(entry, manifest.files)) {
      throw new Error('语音模型文件与当前模型目录不匹配')
    }
    await writeFile(
      safeChild(stagingDirectory, MANIFEST_FILE_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    )
    return manifest
  }

  private async readInstalled(): Promise<InstalledSpeechModel[]> {
    const entries = await readdir(this.rootDirectory, {
      withFileTypes: true
    })
    const installed: InstalledSpeechModel[] = []
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.install-') ||
        !speechModelIdSchema.safeParse(entry.name).success
      ) {
        continue
      }
      try {
        const manifestPath = safeChild(
          this.modelDirectory(entry.name),
          MANIFEST_FILE_NAME
        )
        const manifest = installedSpeechModelSchema.parse(
          JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
        )
        if (manifest.id === entry.name) {
          installed.push(manifest)
        }
      } catch {
        // Incomplete or externally modified directories are not installed.
      }
    }
    return installed.sort((left, right) => left.id.localeCompare(right.id))
  }

  private async readSelection(): Promise<string | null> {
    try {
      const value = selectionSchema.parse(
        JSON.parse(
          await readFile(
            safeChild(this.rootDirectory, SELECTION_FILE_NAME),
            'utf8'
          )
        ) as unknown
      )
      return value.selectedModelId
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }
      return null
    }
  }

  private async writeSelection(modelId: string | null): Promise<void> {
    await this.ensureRoot()
    const target = safeChild(this.rootDirectory, SELECTION_FILE_NAME)
    const partialName =
      `${SELECTION_FILE_NAME}.${randomUUID()}${MODEL_PARTIAL_SUFFIX}`
    const partial = safeChild(
      this.rootDirectory,
      partialName
    )
    this.activeSelectionPartialNames.add(partialName)
    try {
      await this.selectionFileOperations.writeFile(
        partial,
        `${JSON.stringify(
          selectionSchema.parse({ selectedModelId: modelId })
        )}\n`,
        { encoding: 'utf8', flag: 'wx' }
      )
      await this.selectionFileOperations.rename(partial, target)
    } catch (error) {
      await rm(partial, { force: true })
      throw error
    } finally {
      this.activeSelectionPartialNames.delete(partialName)
    }
  }

  private cleanupStaleArtifacts(): Promise<void> {
    return cleanupStaleModelInstallArtifacts({
      rootDirectory: this.rootDirectory,
      isModelId: (value) => speechModelIdSchema.safeParse(value).success,
      activeModelIds: new Set(this.operations.keys()),
      partialFileNames: new Set(
        this.catalog.flatMap((entry) =>
          entry.files.map((file) => file.name)
        )
      ),
      cleanSelectionPartials: true,
      activeSelectionPartialNames: this.activeSelectionPartialNames,
      escapeMessage: '模型路径超出受管目录'
    })
  }
}

export function createSpeechModelManager(
  options: SpeechModelManagerOptions
): SpeechModelManager {
  return new SpeechModelManager(options)
}
