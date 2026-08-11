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
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import {
  installedSpeechModelSchema,
  speechModelCatalogEntrySchema,
  speechModelIdSchema,
  speechModelSnapshotSchema,
  type InstalledSpeechModel,
  type SpeechModelCatalogEntry,
  type SpeechModelFileSpec,
  type SpeechModelOperation,
  type SpeechModelSnapshot
} from '../../shared/speech-model-contracts'
import { SPEECH_MODEL_CATALOG } from './speech-model-catalog'
import {
  exportModelArchive,
  extractModelArchive
} from '../model-archive'

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_REDIRECTS = 3
const MANIFEST_FILE_NAME = 'manifest.json'
const SELECTION_FILE_NAME = '.selection.json'
const PARTIAL_SUFFIX = '.partial'
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

export type SpeechModelManagerOptions = {
  userDataDirectory: string
  fetch: typeof fetch
  catalog?: readonly SpeechModelCatalogEntry[]
  maxFileBytes?: number
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

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError()
  }
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
  const child = resolve(parent, name)
  if (dirname(child) !== resolve(parent)) {
    throw new Error('模型路径超出受管目录')
  }
  return child
}

function validateDownloadUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:'
  ) {
    throw new Error('模型下载地址必须使用 HTTP 或 HTTPS')
  }
  return url
}

async function hashFile(
  path: string,
  signal?: AbortSignal
): Promise<{
  size: number
  sha256: string
}> {
  const handle = await open(path, 'r')
  const hash = createHash('sha256')
  let size = 0
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    while (true) {
      if (signal) {
        ensureNotAborted(signal)
      }
      const { bytesRead } = await handle.read(buffer, 0, buffer.length)
      if (bytesRead === 0) {
        break
      }
      hash.update(buffer.subarray(0, bytesRead))
      size += bytesRead
    }
  } finally {
    await handle.close()
  }
  return { size, sha256: hash.digest('hex') }
}

export class SpeechModelManager {
  readonly rootDirectory: string

  private readonly transport: typeof fetch
  private readonly catalog: SpeechModelCatalogEntry[]
  private readonly maxFileBytes: number
  private readonly operations = new Map<string, ActiveOperation>()

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
    this.catalog = (options.catalog ?? SPEECH_MODEL_CATALOG).map(
      cloneCatalogEntry
    )
    if (new Set(this.catalog.map((entry) => entry.id)).size !== this.catalog.length) {
      throw new Error('语音模型目录包含重复 ID')
    }
    this.maxFileBytes = validateMaximumBytes(options.maxFileBytes)
  }

  async snapshot(): Promise<SpeechModelSnapshot> {
    await this.ensureRoot()
    const installed = await this.readInstalled()
    const selected = await this.readSelection()
    const installedIds = new Set(installed.map((model) => model.id))
    return speechModelSnapshotSchema.parse({
      rootDirectory: this.rootDirectory,
      catalog: this.catalog.map(cloneCatalogEntry),
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

  async getSelectedRuntimeModel(): Promise<
    SelectedSpeechRuntimeModel | undefined
  > {
    const snapshot = await this.snapshot()
    if (!snapshot.selectedModelId) {
      return undefined
    }
    const catalogEntry = this.catalog.find(
      (entry) => entry.id === snapshot.selectedModelId
    )
    const installed = snapshot.installed.find(
      (entry) => entry.id === snapshot.selectedModelId
    )
    if (!catalogEntry || !installed) {
      return undefined
    }
    return {
      id: installed.id,
      family: catalogEntry.family,
      directory: this.modelDirectory(installed.id),
      files: installed.files.map((file) => ({ ...file }))
    }
  }

  async install(
    modelId: string,
    externalSignal?: AbortSignal
  ): Promise<InstalledSpeechModel> {
    const entry = this.requireCatalogEntry(modelId)
    if (entry.manualOnly) {
      throw new Error(
        entry.manualReason ?? '该模型只能从本地目录导入'
      )
    }
    const downloadableFiles = entry.files.filter(
      (
        file
      ): file is SpeechModelFileSpec & {
        download: NonNullable<SpeechModelFileSpec['download']>
      } => file.download !== undefined
    )
    if (downloadableFiles.length !== entry.files.length) {
      throw new Error('模型下载元数据不完整')
    }
    const totalBytes = downloadableFiles.reduce(
      (total, file) => total + file.download.size,
      0
    )
    if (!Number.isSafeInteger(totalBytes)) {
      throw new RangeError('模型总大小超出安全范围')
    }
    const operation = this.beginOperation(
      entry.id,
      'download',
      totalBytes
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
      for (const file of downloadableFiles) {
        ensureNotAborted(operation.controller.signal)
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
      ensureNotAborted(operation.controller.signal)
      await rename(
        stagingDirectory,
        this.modelDirectory(entry.id)
      )
      stagingDirectory = undefined
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
        ensureNotAborted(operation.controller.signal)
        operation.progress.currentFile = file.name
        const sourceFile = safeChild(source, file.name)
        const destination = safeChild(stagingDirectory, file.name)
        await copyFile(sourceFile, destination)
        ensureNotAborted(operation.controller.signal)
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
      ensureNotAborted(operation.controller.signal)
      await rename(
        stagingDirectory,
        this.modelDirectory(entry.id)
      )
      stagingDirectory = undefined
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
        recorded.size > this.maxFileBytes ||
        (expected.download &&
          (recorded.size !== expected.download.size ||
            recorded.sha256 !== expected.download.sha256))
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
    const expectedTotal = entry.files.reduce(
      (total, file) =>
        total + (file.download?.size ?? this.maxFileBytes),
      0
    )
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
      for (const expected of entry.files) {
        const archived = descriptor.files.find(
          (file) =>
            file.name === expected.name &&
            file.role === expected.role
        )
        if (
          !archived ||
          archived.size > this.maxFileBytes ||
          (expected.download &&
            (archived.size !== expected.download.size ||
              archived.sha256 !== expected.download.sha256))
        ) {
          throw new Error(
            `语音模型 ZIP 与当前模型目录不匹配：${expected.name}`
          )
        }
      }
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
      ensureNotAborted(operation.controller.signal)
      await rename(stagingDirectory, this.modelDirectory(entry.id))
      stagingDirectory = undefined
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
    totalBytes: number | null
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
        totalBytes
      }
    }
    this.operations.set(modelId, operation)
    return operation
  }

  private attachExternalSignal(
    signal: AbortSignal | undefined,
    controller: AbortController
  ): () => void {
    if (!signal) {
      return () => undefined
    }
    const abort = (): void => controller.abort()
    if (signal.aborted) {
      controller.abort()
    } else {
      signal.addEventListener('abort', abort, { once: true })
    }
    return () => signal.removeEventListener('abort', abort)
  }

  private async assertNotInstalled(modelId: string): Promise<void> {
    try {
      await lstat(this.modelDirectory(modelId))
      throw new Error('语音模型已安装')
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return
      }
      throw error
    }
  }

  private async createStagingDirectory(modelId: string): Promise<string> {
    const directory = safeChild(
      this.rootDirectory,
      `.install-${modelId}-${randomUUID()}`
    )
    await mkdir(directory, { recursive: false })
    return directory
  }

  private async fetchFollowingRedirects(
    initialUrl: string,
    signal: AbortSignal
  ): Promise<Response> {
    let url = validateDownloadUrl(initialUrl)
    for (let redirectCount = 0; ; redirectCount += 1) {
      ensureNotAborted(signal)
      const response = await this.transport(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectCount >= MAX_REDIRECTS) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error('模型下载重定向次数过多')
        }
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (!location) {
          throw new Error('模型下载重定向缺少地址')
        }
        url = validateDownloadUrl(new URL(location, url).toString())
        continue
      }
      return response
    }
  }

  private async downloadFile(
    file: SpeechModelFileSpec & {
      download: NonNullable<SpeechModelFileSpec['download']>
    },
    destination: string,
    operation: ActiveOperation,
    signal: AbortSignal
  ): Promise<void> {
    if (
      file.download.size > this.maxFileBytes ||
      file.download.size <= 0
    ) {
      throw new RangeError(`模型文件大小超出限制：${file.name}`)
    }
    const response = await this.fetchFollowingRedirects(
      file.download.url,
      signal
    )
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
        parsedLength !== file.download.size
      ) {
        await response.body.cancel().catch(() => undefined)
        throw new Error(`模型文件大小不匹配：${file.name}`)
      }
    }

    const partialPath = `${destination}${PARTIAL_SUFFIX}`
    const handle = await open(partialPath, 'wx')
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    let written = 0
    try {
      while (true) {
        ensureNotAborted(signal)
        const result = await reader.read()
        if (result.done) {
          break
        }
        written += result.value.byteLength
        if (
          written > file.download.size ||
          written > this.maxFileBytes
        ) {
          await reader.cancel()
          throw new RangeError(`模型文件过大：${file.name}`)
        }
        await handle.write(result.value)
        hash.update(result.value)
        operation.progress.completedBytes += result.value.byteLength
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      await handle.close()
    }
    if (written !== file.download.size) {
      throw new Error(`模型文件大小不匹配：${file.name}`)
    }
    if (hash.digest('hex') !== file.download.sha256) {
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
    for (const expectedFile of entry.files) {
      ensureNotAborted(signal)
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
      if (
        expectedFile.download &&
        (sourceFileInfo.size !== expectedFile.download.size ||
          (await hashFile(sourceFile, signal)).sha256 !==
            expectedFile.download.sha256)
      ) {
        throw new Error(`本地模型文件校验失败：${expectedFile.name}`)
      }
    }
  }

  private async rejectUnsafeLocalEntries(
    directory: string,
    signal: AbortSignal,
    counter: { visited: number }
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      ensureNotAborted(signal)
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
      ensureNotAborted(signal)
      const metadata = await hashFile(
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
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null
      }
      return null
    }
  }

  private async writeSelection(modelId: string | null): Promise<void> {
    await this.ensureRoot()
    const target = safeChild(this.rootDirectory, SELECTION_FILE_NAME)
    const partial = safeChild(
      this.rootDirectory,
      `${SELECTION_FILE_NAME}.${randomUUID()}${PARTIAL_SUFFIX}`
    )
    await writeFile(
      partial,
      `${JSON.stringify(
        selectionSchema.parse({ selectedModelId: modelId })
      )}\n`,
      { encoding: 'utf8', flag: 'wx' }
    )
    try {
      await rename(partial, target)
    } catch (error) {
      await rm(partial, { force: true })
      throw error
    }
  }
}

export function createSpeechModelManager(
  options: SpeechModelManagerOptions
): SpeechModelManager {
  return new SpeechModelManager(options)
}
