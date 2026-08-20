import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isMissingFileError } from './settings-file-utils'

export const MODEL_PARTIAL_SUFFIX = '.partial'

export type ModelFileFingerprint = {
  dev: bigint
  ino: bigint
  size: bigint
  mode: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  isFile: boolean
  isSymbolicLink: boolean
}

const uuidPattern =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const stagingNamePattern = new RegExp(
  `^\\.install-(.+)-(${uuidPattern})$`,
  'iu'
)
const selectionPartialPattern = new RegExp(
  `^\\.selection\\.json\\.(${uuidPattern})\\.partial$`,
  'iu'
)

export function ensureModelOperationNotAborted(
  signal?: AbortSignal
): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError')
  }
}

export function managedModelChild(
  parent: string,
  name: string,
  escapeMessage: string
): string {
  const child = resolve(parent, name)
  if (dirname(child) !== resolve(parent)) {
    throw new Error(escapeMessage)
  }
  return child
}

export async function fingerprintModelFile(
  path: string
): Promise<ModelFileFingerprint> {
  const status = await lstat(path, { bigint: true })
  return {
    dev: status.dev,
    ino: status.ino,
    size: status.size,
    mode: status.mode,
    mtimeNs: status.mtimeNs,
    ctimeNs: status.ctimeNs,
    isFile: status.isFile(),
    isSymbolicLink: status.isSymbolicLink()
  }
}

export function modelFileFingerprintMatches(
  left: ModelFileFingerprint,
  right: ModelFileFingerprint
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.isFile === right.isFile &&
    left.isSymbolicLink === right.isSymbolicLink
  )
}

export async function writeModelBuffer(
  handle: Pick<FileHandle, 'write'>,
  buffer: Uint8Array,
  onPersisted?: (buffer: Uint8Array) => void
): Promise<number> {
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset
    )
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > buffer.byteLength - offset
    ) {
      throw new Error('模型文件写入不完整')
    }
    offset += bytesWritten
  }
  onPersisted?.(buffer)
  return offset
}

export async function hashModelFile(
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
        ensureModelOperationNotAborted(signal)
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

export function attachModelAbortSignal(
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

export async function createModelStagingDirectory(
  rootDirectory: string,
  modelId: string,
  escapeMessage: string
): Promise<string> {
  const directory = managedModelChild(
    rootDirectory,
    `.install-${modelId}-${randomUUID()}`,
    escapeMessage
  )
  await mkdir(directory, { recursive: false })
  return directory
}

export async function cleanupStaleModelInstallArtifacts(input: {
  rootDirectory: string
  isModelId: (value: string) => boolean
  activeModelIds: ReadonlySet<string>
  partialFileNames: ReadonlySet<string>
  cleanSelectionPartials?: boolean
  activeSelectionPartialNames?: ReadonlySet<string>
  escapeMessage: string
  operations?: {
    unlinkFile?: (path: string) => Promise<void>
  }
}): Promise<void> {
  const unlinkFile = input.operations?.unlinkFile ?? unlink
  const entries = await readdir(input.rootDirectory, {
    withFileTypes: true
  })
  for (const entry of entries) {
    const stagingMatch = stagingNamePattern.exec(entry.name)
    if (stagingMatch) {
      const modelId = stagingMatch[1]!
      if (
        input.isModelId(modelId) &&
        !input.activeModelIds.has(modelId) &&
        entry.isDirectory() &&
        !entry.isSymbolicLink()
      ) {
        await rm(
          managedModelChild(
            input.rootDirectory,
            entry.name,
            input.escapeMessage
          ),
          { recursive: true, force: true }
        )
      }
      continue
    }
    if (
      input.cleanSelectionPartials &&
      selectionPartialPattern.test(entry.name) &&
      !input.activeSelectionPartialNames?.has(entry.name) &&
      entry.isFile() &&
      !entry.isSymbolicLink()
    ) {
      try {
        await unlinkFile(
          managedModelChild(
            input.rootDirectory,
            entry.name,
            input.escapeMessage
          )
        )
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error
        }
      }
      continue
    }
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !input.isModelId(entry.name)
    ) {
      continue
    }
    const modelDirectory = managedModelChild(
      input.rootDirectory,
      entry.name,
      input.escapeMessage
    )
    for (const partialName of input.partialFileNames) {
      const partialPath = managedModelChild(
        modelDirectory,
        `${partialName}${MODEL_PARTIAL_SUFFIX}`,
        input.escapeMessage
      )
      try {
        const status = await lstat(partialPath)
        if (status.isFile() && !status.isSymbolicLink()) {
          await unlinkFile(partialPath)
        }
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error
        }
      }
    }
  }
}
