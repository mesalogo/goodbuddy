import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  open,
  readFile,
  rename,
  rm,
  type FileHandle
} from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  Zip,
  ZipPassThrough
} from 'fflate'
import { z } from 'zod'
import {
  ensureModelOperationNotAborted,
  hashModelFile,
  managedModelChild,
  writeModelBuffer
} from './model-package-utils'
import { isMissingFileError } from './settings-file-utils'

const ARCHIVE_MANIFEST_NAME = 'goodbuddy-model.json'
const ARCHIVE_FORMAT = 'goodbuddy-model-archive'
const ARCHIVE_VERSION = 1
const MAXIMUM_ARCHIVE_ENTRIES = 40
const MAXIMUM_MANIFEST_BYTES = 256 * 1024

const archiveFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\\:\0]+$/u)

const modelArchiveFileSchema = z
  .object({
    name: archiveFileNameSchema,
    role: z.string().trim().min(1).max(64),
    size: z.number().int().positive().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict()

const modelArchiveDescriptorSchema = z
  .object({
    kind: z.enum(['speech', 'document-ocr', 'embedding']),
    modelId: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    displayName: z.string().trim().min(1).max(120),
    files: z.array(modelArchiveFileSchema).min(1).max(32)
  })
  .strict()

const modelArchiveManifestSchema = modelArchiveDescriptorSchema
  .extend({
    format: z.literal(ARCHIVE_FORMAT),
    version: z.literal(ARCHIVE_VERSION),
    exportedAt: z.string().datetime()
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      new Set(manifest.files.map((file) => file.name.toLowerCase()))
        .size !== manifest.files.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: '模型 ZIP 清单包含重复文件'
      })
    }
  })

export type ModelArchiveKind = z.infer<
  typeof modelArchiveManifestSchema
>['kind']

export type ModelArchiveFile = z.infer<typeof modelArchiveFileSchema>

export type ModelArchiveDescriptor = {
  kind: ModelArchiveKind
  modelId: string
  displayName: string
  files: ModelArchiveFile[]
}

export type ModelArchiveExpectedFile = {
  name: string
  role: string
}

type ExportModelArchiveOptions = {
  destinationPath: string
  sourceDirectory: string
  descriptor: ModelArchiveDescriptor
}

type ExtractModelArchiveOptions = {
  archivePath: string
  destinationDirectory: string
  expectedKind: ModelArchiveKind
  expectedModelId: string
  expectedFiles: ModelArchiveExpectedFile[]
  maximumArchiveBytes: number
  maximumFileBytes: number
  maximumTotalBytes: number
  signal?: AbortSignal
  onProgress?: (completedBytes: number) => void
}

function ensureArchiveName(name: string): string {
  return archiveFileNameSchema.parse(name)
}

function ensureUniqueFiles(files: ModelArchiveExpectedFile[]): void {
  const names = files.map((file) => ensureArchiveName(file.name))
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new Error('模型目录包含重复文件名')
  }
}

function checkedLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label}无效`)
  }
  return value
}

async function pushFileIntoArchive(
  archive: Zip,
  file: ModelArchiveFile,
  sourcePath: string,
  waitForOutput: () => Promise<void>
): Promise<void> {
  const input = new ZipPassThrough(ensureArchiveName(file.name))
  archive.add(input)
  const sourceInfo = await lstat(sourcePath)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`模型文件不可导出：${file.name}`)
  }
  const handle = await open(sourcePath, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const hash = createHash('sha256')
  let size = 0
  try {
    const openedInfo = await handle.stat()
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== sourceInfo.dev ||
      openedInfo.ino !== sourceInfo.ino
    ) {
      throw new Error(`模型文件在打开前已发生变化：${file.name}`)
    }
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length)
      if (bytesRead === 0) {
        break
      }
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      size += bytesRead
      input.push(Uint8Array.from(chunk))
      await waitForOutput()
    }
    if (size !== file.size || hash.digest('hex') !== file.sha256) {
      throw new Error(`模型文件校验失败：${file.name}`)
    }
    input.push(new Uint8Array(), true)
    await waitForOutput()
  } finally {
    await handle.close()
  }
}

async function pushBytesIntoArchive(
  archive: Zip,
  name: string,
  value: Uint8Array,
  waitForOutput: () => Promise<void>
): Promise<void> {
  const input = new ZipPassThrough(ensureArchiveName(name))
  archive.add(input)
  input.push(value, true)
  await waitForOutput()
}

async function replaceArchiveFile(
  partialPath: string,
  destinationPath: string
): Promise<void> {
  const backupPath = `${destinationPath}.${randomUUID()}.backup`
  let movedExistingFile = false
  try {
    try {
      await rename(destinationPath, backupPath)
      movedExistingFile = true
      const existingInfo = await lstat(backupPath)
      if (!existingInfo.isFile() || existingInfo.isSymbolicLink()) {
        throw new Error('模型 ZIP 导出目标必须是普通文件')
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error
      }
    }
    await rename(partialPath, destinationPath)
    if (movedExistingFile) {
      await rm(backupPath, { force: true }).catch(() => undefined)
    }
  } catch (error) {
    if (movedExistingFile) {
      await rm(destinationPath, { force: true }).catch(() => undefined)
      await rename(backupPath, destinationPath).catch(() => undefined)
    }
    throw error
  }
}

export async function exportModelArchive(
  options: ExportModelArchiveOptions
): Promise<void> {
  const descriptor = modelArchiveDescriptorSchema.parse(
    options.descriptor
  )
  ensureUniqueFiles(descriptor.files)
  const sourceDirectory = resolve(options.sourceDirectory)
  const destinationPath = resolve(options.destinationPath)
  const partialPath = `${destinationPath}.${randomUUID()}.partial`
  const output = await open(partialPath, 'wx')
  let writeChain = Promise.resolve()
  let archiveError: Error | undefined
  let resolveFinished: (() => void) | undefined
  let rejectFinished: ((error: Error) => void) | undefined
  const finished = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveFinished = resolvePromise
    rejectFinished = rejectPromise
  })
  const archive = new Zip((error, data, final) => {
    if (error) {
      archiveError = error
      rejectFinished?.(error)
      return
    }
    writeChain = writeChain.then(async () => {
      if (data.byteLength > 0) {
        await writeModelBuffer(output, data)
      }
    })
    if (final) {
      void writeChain.then(resolveFinished, rejectFinished)
    }
  })
  const waitForOutput = async (): Promise<void> => {
    await writeChain
    if (archiveError) {
      throw archiveError
    }
  }
  try {
    const manifest = modelArchiveManifestSchema.parse({
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      kind: descriptor.kind,
      modelId: descriptor.modelId,
      displayName: descriptor.displayName,
      exportedAt: new Date().toISOString(),
      files: descriptor.files
    })
    await pushBytesIntoArchive(
      archive,
      ARCHIVE_MANIFEST_NAME,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      waitForOutput
    )
    for (const file of descriptor.files) {
      await pushFileIntoArchive(
        archive,
        file,
        managedModelChild(
          sourceDirectory,
          file.name,
          '模型 ZIP 路径超出临时目录'
        ),
        waitForOutput
      )
    }
    archive.end()
    await finished
    await output.sync()
    await output.close()
    await replaceArchiveFile(partialPath, destinationPath)
  } catch (error) {
    archive.terminate()
    await output.close().catch(() => undefined)
    await rm(partialPath, { force: true })
    throw error
  }
}

function closeHandle(handle: FileHandle): Promise<void> {
  return handle.close().catch(() => undefined)
}

export async function extractModelArchive(
  options: ExtractModelArchiveOptions
): Promise<ModelArchiveDescriptor> {
  ensureModelOperationNotAborted(options.signal)
  const maximumArchiveBytes = checkedLimit(
    options.maximumArchiveBytes,
    '模型 ZIP 大小限制'
  )
  const maximumFileBytes = checkedLimit(
    options.maximumFileBytes,
    '模型文件大小限制'
  )
  const maximumTotalBytes = checkedLimit(
    options.maximumTotalBytes,
    '模型展开大小限制'
  )
  const expectedFiles = options.expectedFiles.map((file) => ({
    name: ensureArchiveName(file.name),
    role: file.role
  }))
  ensureUniqueFiles(expectedFiles)
  const allowedNames = new Set([
    ARCHIVE_MANIFEST_NAME,
    ...expectedFiles.map((file) => file.name)
  ])
  const source = resolve(options.archivePath)
  let sourceInfo
  try {
    sourceInfo = await lstat(source)
  } catch (error) {
    throw new Error('无法读取模型 ZIP', { cause: error })
  }
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    sourceInfo.size <= 0 ||
    sourceInfo.size > maximumArchiveBytes
  ) {
    throw new Error('模型 ZIP 必须是大小合规的普通文件')
  }

  let input: FileHandle | undefined
  try {
    input = await open(source, 'r')
    const openedInfo = await input.stat()
    if (
      !openedInfo.isFile() ||
      openedInfo.size !== sourceInfo.size ||
      openedInfo.dev !== sourceInfo.dev ||
      openedInfo.ino !== sourceInfo.ino
    ) {
      await input.close()
      throw new Error('模型 ZIP 在打开前已发生变化')
    }
  } catch (error) {
    await input?.close().catch(() => undefined)
    if (error instanceof Error && error.message.startsWith('模型 ZIP')) {
      throw error
    }
    throw new Error('无法读取模型 ZIP', { cause: error })
  }
  if (!input) {
    throw new Error('无法读取模型 ZIP')
  }

  const destination = resolve(options.destinationDirectory)
  const seenNames = new Set<string>()
  const openHandles = new Set<FileHandle>()
  const completions: Promise<
    { ok: true } | { ok: false; error: Error }
  >[] = []
  const pendingWrites = new Set<Promise<void>>()
  let entryCount = 0
  let totalBytes = 0
  let completedModelBytes = 0
  let fatalError: Error | undefined
  const fail = (error: unknown): Error => {
    const resolvedError =
      error instanceof Error ? error : new Error('模型 ZIP 已损坏')
    fatalError ??= resolvedError
    return resolvedError
  }
  const unzip = new Unzip((file) => {
    try {
      entryCount += 1
      if (
        entryCount > MAXIMUM_ARCHIVE_ENTRIES ||
        entryCount > allowedNames.size
      ) {
        throw new Error('模型 ZIP 包含过多条目')
      }
      const name = ensureArchiveName(file.name)
      const key = name.toLowerCase()
      if (seenNames.has(key)) {
        throw new Error('模型 ZIP 包含重复条目')
      }
      seenNames.add(key)
      if (!allowedNames.has(name)) {
        throw new Error(`模型 ZIP 包含未声明文件：${name}`)
      }
      const entryMaximum =
        name === ARCHIVE_MANIFEST_NAME
          ? MAXIMUM_MANIFEST_BYTES
          : maximumFileBytes
      if (
        file.originalSize !== undefined &&
        (file.originalSize <= 0 ||
          file.originalSize > entryMaximum ||
          totalBytes + file.originalSize > maximumTotalBytes)
      ) {
        throw new Error(`模型 ZIP 条目大小超出限制：${name}`)
      }
      const handlePromise = open(
        managedModelChild(
          destination,
          name,
          '模型 ZIP 路径超出临时目录'
        ),
        'wx'
      ).then((handle) => {
        openHandles.add(handle)
        return handle
      })
      let written = 0
      let writeChain = Promise.resolve()
      let resolveEntry: (() => void) | undefined
      let rejectEntry: ((error: Error) => void) | undefined
      const completion = new Promise<void>((resolveEntryPromise, rejectEntryPromise) => {
        resolveEntry = resolveEntryPromise
        rejectEntry = rejectEntryPromise
      })
      completions.push(
        completion.then(
          () => ({ ok: true as const }),
          (error: Error) => ({ ok: false as const, error })
        )
      )
      file.ondata = (error, data, final) => {
        if (error) {
          rejectEntry?.(fail(error))
          return
        }
        if (fatalError) {
          file.terminate()
          rejectEntry?.(fatalError)
          return
        }
        if (options.signal?.aborted) {
          file.terminate()
          rejectEntry?.(
            fail(
              options.signal.reason instanceof Error
                ? options.signal.reason
                : new Error('模型 ZIP 导入已取消')
            )
          )
          return
        }
        written += data.byteLength
        totalBytes += data.byteLength
        if (
          written > entryMaximum ||
          totalBytes > maximumTotalBytes
        ) {
          file.terminate()
          rejectEntry?.(
            fail(new Error(`模型 ZIP 条目大小超出限制：${name}`))
          )
          return
        }
        writeChain = writeChain.then(async () => {
          const handle = await handlePromise
          if (data.byteLength > 0) {
            await writeModelBuffer(handle, data, (persisted) => {
              if (name !== ARCHIVE_MANIFEST_NAME) {
                completedModelBytes += persisted.byteLength
                options.onProgress?.(completedModelBytes)
              }
            })
          }
        })
        const pendingWrite = writeChain
        pendingWrites.add(pendingWrite)
        void pendingWrite.then(
          () => pendingWrites.delete(pendingWrite),
          () => pendingWrites.delete(pendingWrite)
        )
        if (final) {
          void writeChain.then(async () => {
            const handle = await handlePromise
            openHandles.delete(handle)
            await closeHandle(handle)
            resolveEntry?.()
          }, (writeError: unknown) => {
            rejectEntry?.(fail(writeError))
          })
        }
      }
      file.start()
    } catch (error) {
      file.terminate()
      fail(error)
    }
  })
  unzip.register(UnzipPassThrough)
  unzip.register(UnzipInflate)

  const buffer = Buffer.allocUnsafe(16 * 1024)
  try {
    while (true) {
      ensureModelOperationNotAborted(options.signal)
      if (fatalError) {
        throw fatalError
      }
      const { bytesRead } = await input.read(buffer, 0, buffer.length)
      if (bytesRead === 0) {
        unzip.push(new Uint8Array(), true)
        break
      }
      unzip.push(
        Uint8Array.from(buffer.subarray(0, bytesRead)),
        false
      )
      await Promise.all([...pendingWrites])
    }
    const completionResults = await Promise.all(completions)
    const failedCompletion = completionResults.find(
      (result) => !result.ok
    )
    if (failedCompletion && !failedCompletion.ok) {
      throw failedCompletion.error
    }
    if (fatalError) {
      throw fatalError
    }
  } catch (error) {
    throw fail(error)
  } finally {
    await input.close()
    await Promise.all(
      [...openHandles].map((handle) => closeHandle(handle))
    )
  }

  if (
    seenNames.size !== allowedNames.size ||
    [...allowedNames].some(
      (name) => !seenNames.has(name.toLowerCase())
    )
  ) {
    throw new Error('模型 ZIP 缺少必需文件')
  }

  let manifest
  try {
    manifest = modelArchiveManifestSchema.parse(
      JSON.parse(
        await readFile(
          managedModelChild(
            destination,
            ARCHIVE_MANIFEST_NAME,
            '模型 ZIP 路径超出临时目录'
          ),
          'utf8'
        )
      ) as unknown
    )
  } catch {
    throw new Error('模型 ZIP 清单无效')
  }
  if (
    manifest.kind !== options.expectedKind ||
    manifest.modelId !== options.expectedModelId
  ) {
    throw new Error('模型 ZIP 类型或模型 ID 不匹配')
  }
  if (
    manifest.files.length !== expectedFiles.length ||
    expectedFiles.some((expected) => {
      const archived = manifest.files.find(
        (file) => file.name === expected.name
      )
      return !archived || archived.role !== expected.role
    })
  ) {
    throw new Error('模型 ZIP 清单与当前模型目录不匹配')
  }
  for (const archived of manifest.files) {
    const path = managedModelChild(
      destination,
      archived.name,
      '模型 ZIP 路径超出临时目录'
    )
    const metadata = await lstat(path)
    const hash = await hashModelFile(path)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== archived.size ||
      hash.size !== archived.size ||
      hash.sha256 !== archived.sha256
    ) {
      throw new Error(`模型 ZIP 文件校验失败：${archived.name}`)
    }
  }
  return {
    kind: manifest.kind,
    modelId: manifest.modelId,
    displayName: manifest.displayName,
    files: manifest.files
  }
}
