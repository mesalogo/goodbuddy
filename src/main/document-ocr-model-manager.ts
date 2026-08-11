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
import {
  documentOcrAssetsSchema,
  documentOcrModelCatalogEntrySchema,
  documentOcrModelSnapshotSchema,
  documentParsingModelStatusSchema,
  installedDocumentOcrModelSchema,
  localOcrModelIdSchema,
  type DocumentOcrAssets,
  type DocumentOcrModelCatalogEntry,
  type DocumentOcrModelFile,
  type DocumentOcrModelOperation,
  type DocumentOcrModelSnapshot,
  type InstalledDocumentOcrModel
} from '../shared/document-parsing-contracts'
import { DOCUMENT_OCR_MODEL_CATALOG } from './document-ocr-model-catalog'
import {
  exportModelArchive,
  extractModelArchive
} from './model-archive'

const DEFAULT_MAX_FILE_BYTES = 96 * 1024 * 1024
const MANIFEST_FILE_NAME = 'manifest.json'
const MAX_REDIRECTS = 3
const PARTIAL_SUFFIX = '.partial'
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024
const ARCHIVE_OVERHEAD_BYTES = 1024 * 1024
const executableExtensionPattern =
  /\.(?:app|bat|bin|cmd|com|cpl|dll|dmg|exe|hta|inf|ins|iso|jar|js|jse|lnk|msi|msp|mst|pif|ps1|reg|scr|sh|sys|vb|vbe|vbs|ws|wsc|wsf|wsh)$/iu

type ActiveOperation = {
  controller: AbortController
  progress: DocumentOcrModelOperation
}

export type DocumentOcrModelManagerOptions = {
  userDataDirectory: string
  fetch: typeof fetch
  catalog?: readonly DocumentOcrModelCatalogEntry[]
  maxFileBytes?: number
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError()
  }
}

function cloneCatalogEntry(
  entry: DocumentOcrModelCatalogEntry
): DocumentOcrModelCatalogEntry {
  return documentOcrModelCatalogEntrySchema.parse(entry)
}

function safeChild(parent: string, name: string): string {
  const child = resolve(parent, name)
  if (dirname(child) !== resolve(parent)) {
    throw new Error('OCR 模型路径超出受管目录')
  }
  return child
}

function validateDownloadUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OCR 模型下载地址必须使用 HTTP 或 HTTPS')
  }
  return url
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer
}

async function hashFile(
  path: string,
  signal?: AbortSignal
): Promise<{ size: number; sha256: string }> {
  const handle = await open(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let size = 0
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

function parseYamlScalar(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'")
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string
  }
  return value
}

export function extractPaddleCharacterDictionary(source: string): string {
  const characters: string[] = []
  let readingDictionary = false
  for (const line of source.replace(/\r/gu, '').split('\n')) {
    if (line === '  character_dict:') {
      readingDictionary = true
      continue
    }
    if (!readingDictionary) {
      continue
    }
    const match = /^ {2}- (.*)$/u.exec(line)
    if (!match) {
      break
    }
    const character = parseYamlScalar(match[1]!)
    if (!character) {
      throw new Error('OCR 字符字典包含空条目')
    }
    characters.push(character)
  }
  if (characters.length < 100) {
    throw new Error('OCR 字符字典格式无效')
  }
  return `${characters.join('\n')}\n`
}

export class DocumentOcrModelManager {
  readonly rootDirectory: string

  private readonly transport: typeof fetch
  private readonly catalog: DocumentOcrModelCatalogEntry[]
  private readonly maxFileBytes: number
  private readonly operations = new Map<string, ActiveOperation>()
  private readonly verifiedModels = new Map<string, Promise<void>>()

  constructor(options: DocumentOcrModelManagerOptions) {
    if (!options.userDataDirectory.trim()) {
      throw new Error('userDataDirectory is required')
    }
    this.rootDirectory = resolve(
      options.userDataDirectory,
      'models',
      'document-ocr'
    )
    this.transport = options.fetch
    this.catalog = (options.catalog ?? DOCUMENT_OCR_MODEL_CATALOG).map(
      cloneCatalogEntry
    )
    if (
      new Set(this.catalog.map((entry) => entry.id)).size !==
      this.catalog.length
    ) {
      throw new Error('OCR 模型目录包含重复 ID')
    }
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    if (
      !Number.isSafeInteger(this.maxFileBytes) ||
      this.maxFileBytes <= 0 ||
      this.maxFileBytes > 512 * 1024 * 1024
    ) {
      throw new RangeError('maxFileBytes must be a positive safe integer')
    }
  }

  async getSnapshot(): Promise<DocumentOcrModelSnapshot> {
    await this.ensureRoot()
    return documentOcrModelSnapshotSchema.parse({
      rootDirectory: this.rootDirectory,
      catalog: this.catalog.map(cloneCatalogEntry),
      installed: await this.readInstalled(),
      operations: [...this.operations.values()].map((operation) => ({
        ...operation.progress
      }))
    })
  }

  async getStatus(
    modelId: string
  ): Promise<ReturnType<typeof documentParsingModelStatusSchema.parse>> {
    const entry = this.requireCatalogEntry(modelId)
    try {
      await this.getVerifiedStatus(entry)
      return documentParsingModelStatusSchema.parse({
        id: entry.id,
        displayName: entry.displayName,
        available: true,
        verified: true,
        runtime: entry.runtime,
        detail: '模型已安装并通过 SHA-256 校验，可离线使用'
      })
    } catch {
      return documentParsingModelStatusSchema.parse({
        id: entry.id,
        displayName: entry.displayName,
        available: false,
        verified: false,
        runtime: entry.runtime,
        detail: '模型尚未安装或校验失败，请从 ModelScope 下载'
      })
    }
  }

  getAssets(modelId: string): Promise<DocumentOcrAssets> {
    return this.loadVerifiedAssets(this.requireCatalogEntry(modelId))
  }

  async install(
    modelId: string,
    externalSignal?: AbortSignal
  ): Promise<InstalledDocumentOcrModel> {
    const entry = this.requireCatalogEntry(modelId)
    const totalBytes = entry.files.reduce(
      (total, file) => total + file.download.size,
      0
    )
    if (!Number.isSafeInteger(totalBytes)) {
      throw new RangeError('OCR 模型总大小超出安全范围')
    }
    const operation = this.beginOperation(entry.id, 'download', totalBytes)
    const detachAbort = this.attachExternalSignal(
      externalSignal,
      operation.controller
    )
    let stagingDirectory: string | undefined
    try {
      await this.ensureRoot()
      await this.assertNotInstalled(entry.id)
      stagingDirectory = await this.createStagingDirectory(entry.id)
      for (const file of entry.files) {
        ensureNotAborted(operation.controller.signal)
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
      const installed = await this.createInstalledManifest(
        entry,
        'download',
        stagingDirectory,
        operation.controller.signal
      )
      ensureNotAborted(operation.controller.signal)
      await rename(stagingDirectory, this.modelDirectory(entry.id))
      stagingDirectory = undefined
      this.verifiedModels.delete(entry.id)
      return installed
    } finally {
      detachAbort()
      this.operations.delete(entry.id)
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
    }
  }

  async registerLocalDirectory(
    modelId: string,
    sourceDirectory: string,
    externalSignal?: AbortSignal
  ): Promise<InstalledDocumentOcrModel> {
    const entry = this.requireCatalogEntry(modelId)
    const source = resolve(sourceDirectory)
    const operation = this.beginOperation(entry.id, 'import', null)
    const detachAbort = this.attachExternalSignal(
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
        operation.progress.completedBytes +=
          (await stat(destination)).size
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
      await rename(stagingDirectory, this.modelDirectory(entry.id))
      stagingDirectory = undefined
      this.verifiedModels.delete(entry.id)
      return installed
    } finally {
      detachAbort()
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
      throw new Error('只能导出已安装的 OCR 模型')
    }
    const directory = this.modelDirectory(entry.id)
    const files = []
    for (const expected of entry.files) {
      const recorded = installed.files.find(
        (file) =>
          file.name === expected.name &&
          file.role === expected.role
      )
      if (
        !recorded ||
        recorded.size !== expected.download.size ||
        recorded.sha256 !== expected.download.sha256
      ) {
        throw new Error(`OCR 模型文件校验失败：${expected.name}`)
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
        kind: 'document-ocr',
        modelId: entry.id,
        displayName: entry.displayName,
        files
      }
    })
  }

  async importArchive(
    modelId: string,
    archivePath: string
  ): Promise<InstalledDocumentOcrModel> {
    const entry = this.requireCatalogEntry(modelId)
    const expectedTotal = entry.files.reduce(
      (total, file) => total + file.download.size,
      0
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
        expectedKind: 'document-ocr',
        expectedModelId: entry.id,
        expectedFiles: entry.files.map((file) => ({
          name: file.name,
          role: file.role
        })),
        maximumArchiveBytes: Math.min(
          MAXIMUM_ARCHIVE_BYTES,
          expectedTotal + ARCHIVE_OVERHEAD_BYTES
        ),
        maximumFileBytes: this.maxFileBytes,
        maximumTotalBytes: expectedTotal + ARCHIVE_OVERHEAD_BYTES,
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
          archived.size !== expected.download.size ||
          archived.sha256 !== expected.download.sha256
        ) {
          throw new Error(
            `OCR 模型 ZIP 与当前模型目录不匹配：${expected.name}`
          )
        }
      }
      operation.progress.phase = 'installing'
      operation.progress.currentFile = null
      const installed = installedDocumentOcrModelSchema.parse({
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
      this.verifiedModels.delete(entry.id)
      return installed
    } finally {
      this.operations.delete(entry.id)
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
    }
  }

  cancel(modelId: string): boolean {
    const id = localOcrModelIdSchema.parse(modelId)
    const operation = this.operations.get(id)
    if (!operation) {
      return false
    }
    operation.controller.abort()
    return true
  }

  async remove(modelId: string): Promise<void> {
    const id = localOcrModelIdSchema.parse(modelId)
    this.cancel(id)
    this.verifiedModels.delete(id)
    await rm(this.modelDirectory(id), {
      recursive: true,
      force: true
    })
  }

  dispose(): void {
    for (const operation of this.operations.values()) {
      operation.controller.abort()
    }
    this.operations.clear()
    this.verifiedModels.clear()
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true })
  }

  private modelDirectory(modelId: string): string {
    return safeChild(
      this.rootDirectory,
      localOcrModelIdSchema.parse(modelId)
    )
  }

  private requireCatalogEntry(
    modelId: string
  ): DocumentOcrModelCatalogEntry {
    const id = localOcrModelIdSchema.parse(modelId)
    const entry = this.catalog.find((candidate) => candidate.id === id)
    if (!entry) {
      throw new Error('未知的 OCR 模型')
    }
    return entry
  }

  private beginOperation(
    modelId: string,
    kind: DocumentOcrModelOperation['kind'],
    totalBytes: number | null
  ): ActiveOperation {
    if (this.operations.has(modelId)) {
      throw new Error('该 OCR 模型已有进行中的操作')
    }
    const operation: ActiveOperation = {
      controller: new AbortController(),
      progress: {
        modelId: localOcrModelIdSchema.parse(modelId),
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
      throw new Error('OCR 模型已安装')
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
          throw new Error('OCR 模型下载重定向次数过多')
        }
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (!location) {
          throw new Error('OCR 模型下载重定向缺少地址')
        }
        url = validateDownloadUrl(new URL(location, url).toString())
        continue
      }
      return response
    }
  }

  private async downloadFile(
    file: DocumentOcrModelFile,
    destination: string,
    operation: ActiveOperation,
    signal: AbortSignal
  ): Promise<void> {
    if (file.download.size > this.maxFileBytes) {
      throw new RangeError(`OCR 模型文件过大：${file.name}`)
    }
    const response = await this.fetchFollowingRedirects(
      file.download.url,
      signal
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`OCR 模型下载失败：HTTP ${response.status}`)
    }
    if (!response.body) {
      throw new Error('OCR 模型下载响应没有内容')
    }
    const declaredLength = response.headers.get('content-length')
    if (
      declaredLength !== null &&
      Number(declaredLength) !== file.download.size
    ) {
      await response.body.cancel().catch(() => undefined)
      throw new Error(`OCR 模型文件大小不匹配：${file.name}`)
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
          throw new RangeError(`OCR 模型文件过大：${file.name}`)
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
    if (
      written !== file.download.size ||
      hash.digest('hex') !== file.download.sha256
    ) {
      throw new Error(`OCR 模型文件校验失败：${file.name}`)
    }
    await rename(partialPath, destination)
  }

  private async validateLocalDirectory(
    sourceDirectory: string,
    entry: DocumentOcrModelCatalogEntry,
    signal: AbortSignal
  ): Promise<void> {
    const sourceInfo = await lstat(sourceDirectory)
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw new Error('本地 OCR 模型来源必须是普通目录')
    }
    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    for (const localEntry of entries) {
      ensureNotAborted(signal)
      if (
        localEntry.isSymbolicLink() ||
        executableExtensionPattern.test(localEntry.name)
      ) {
        throw new Error('本地 OCR 模型目录包含不安全文件')
      }
    }
    for (const file of entry.files) {
      ensureNotAborted(signal)
      const path = safeChild(sourceDirectory, file.name)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`OCR 模型文件必须是普通文件：${file.name}`)
      }
      const actual = await hashFile(path, signal)
      if (
        actual.size !== file.download.size ||
        actual.sha256 !== file.download.sha256
      ) {
        throw new Error(`本地 OCR 模型文件校验失败：${file.name}`)
      }
    }
  }

  private async createInstalledManifest(
    entry: DocumentOcrModelCatalogEntry,
    source: InstalledDocumentOcrModel['source'],
    stagingDirectory: string,
    signal: AbortSignal
  ): Promise<InstalledDocumentOcrModel> {
    const files = []
    for (const file of entry.files) {
      ensureNotAborted(signal)
      files.push({
        name: file.name,
        role: file.role,
        ...(await hashFile(
          safeChild(stagingDirectory, file.name),
          signal
        ))
      })
    }
    const manifest = installedDocumentOcrModelSchema.parse({
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

  private async readInstalled(): Promise<InstalledDocumentOcrModel[]> {
    const entries = await readdir(this.rootDirectory, {
      withFileTypes: true
    })
    const installed: InstalledDocumentOcrModel[] = []
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.install-') ||
        !localOcrModelIdSchema.safeParse(entry.name).success
      ) {
        continue
      }
      try {
        const manifest = installedDocumentOcrModelSchema.parse(
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
        // Ignore incomplete or externally modified model directories.
      }
    }
    return installed
  }

  private async readInstalledManifest(
    entry: DocumentOcrModelCatalogEntry
  ): Promise<InstalledDocumentOcrModel> {
    const directory = this.modelDirectory(entry.id)
    const manifest = installedDocumentOcrModelSchema.parse(
      JSON.parse(
        await readFile(
          safeChild(directory, MANIFEST_FILE_NAME),
          'utf8'
        )
      ) as unknown
    )
    if (manifest.id !== entry.id) {
      throw new Error('OCR 模型清单 ID 不匹配')
    }
    return manifest
  }

  private async verifyInstalledModel(
    entry: DocumentOcrModelCatalogEntry
  ): Promise<void> {
    const directory = this.modelDirectory(entry.id)
    const manifest = await this.readInstalledManifest(entry)
    for (const file of entry.files) {
      const installed = manifest.files.find(
        (candidate) =>
          candidate.name === file.name &&
          candidate.role === file.role
      )
      const actual = await hashFile(safeChild(directory, file.name))
      if (
        !installed ||
        actual.size !== file.download.size ||
        actual.sha256 !== file.download.sha256 ||
        actual.size !== installed.size ||
        actual.sha256 !== installed.sha256
      ) {
        throw new Error(`OCR 模型文件校验失败：${file.name}`)
      }
    }
  }

  private getVerifiedStatus(
    entry: DocumentOcrModelCatalogEntry
  ): Promise<void> {
    let verification = this.verifiedModels.get(entry.id)
    if (!verification) {
      verification = this.verifyInstalledModel(entry).catch((error) => {
        this.verifiedModels.delete(entry.id)
        throw error
      })
      this.verifiedModels.set(entry.id, verification)
    }
    return verification
  }

  private async loadVerifiedAssets(
    entry: DocumentOcrModelCatalogEntry
  ): Promise<DocumentOcrAssets> {
    const directory = this.modelDirectory(entry.id)
    const manifest = await this.readInstalledManifest(entry)
    const loaded = new Map<
      DocumentOcrModelFile['role'],
      ArrayBuffer
    >()
    for (const file of entry.files) {
      const installed = manifest.files.find(
        (candidate) =>
          candidate.name === file.name &&
          candidate.role === file.role
      )
      const path = safeChild(directory, file.name)
      const contents = await readFile(path)
      const actual = {
        size: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex')
      }
      if (
        !installed ||
        actual.size !== file.download.size ||
        actual.sha256 !== file.download.sha256 ||
        actual.size !== installed.size ||
        actual.sha256 !== installed.sha256
      ) {
        throw new Error(`OCR 模型文件校验失败：${file.name}`)
      }
      loaded.set(
        file.role,
        file.role === 'dictionary'
          ? toArrayBuffer(
              Buffer.from(
                extractPaddleCharacterDictionary(
                  contents.toString('utf8')
                ),
                'utf8'
              )
            )
          : toArrayBuffer(contents)
      )
    }
    return documentOcrAssetsSchema.parse({
      modelId: entry.id,
      detection: loaded.get('detection'),
      recognition: loaded.get('recognition'),
      dictionary: loaded.get('dictionary')
    })
  }
}
