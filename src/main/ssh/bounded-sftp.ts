import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat as localLstat, open as localOpen } from 'node:fs/promises'
import type { SFTPWrapper, Stats } from 'ssh2'

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const MAX_OPERATION_TIMEOUT_MS = 60_000
const MINIMUM_TRANSFER_BYTES_PER_SECOND = 64 * 1024
const MAX_TRANSFER_TIMEOUT_MS = 60 * 60_000
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_MAXIMUM_FILE_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
const DEFAULT_MAX_OPERATIONS = 2_048
const MAX_REMOTE_PATH_BYTES = 4_096
const MAX_REMOTE_PATH_SEGMENTS = 128
const READ_CHUNK_BYTES = 64 * 1024
const MAXIMUM_CONCURRENT_READS = 32
const ALLOWED_MODES = [0o600, 0o644, 0o700, 0o755] as const

export type BoundedSftpLimits = {
  maximumFileBytes?: number
  maximumTotalBytes?: number
  maximumOperations?: number
  operationTimeoutMs?: number
}

export type SftpEntryType =
  | 'file'
  | 'directory'
  | 'symbolic-link'

export type SftpEntryMetadata = {
  type: SftpEntryType
  size: number
  mode: number
  uid: number
  gid: number
  atime: number
  mtime: number
}

export type AllowedSftpMode = (typeof ALLOWED_MODES)[number]

export type SftpUploadIdentity = {
  size: number
  sha256: string
}

export type StagedSftp = {
  readonly stagingDirectory: string
  mkdir(relativePath: string, signal?: AbortSignal): Promise<void>
  writeFile(
    relativePath: string,
    contents: Buffer,
    signal?: AbortSignal
  ): Promise<void>
  uploadFile(
    relativePath: string,
    sourcePath: string,
    identity: SftpUploadIdentity,
    signal?: AbortSignal
  ): Promise<void>
  readFile(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<Buffer>
  lstat(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<SftpEntryMetadata>
  stat(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<SftpEntryMetadata>
  chmod(
    relativePath: string,
    mode: AllowedSftpMode,
    signal?: AbortSignal
  ): Promise<void>
  setExecutable(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<void>
  rename(
    sourceRelativePath: string,
    destinationRelativePath: string,
    signal?: AbortSignal
  ): Promise<void>
  replaceFile(
    sourceRelativePath: string,
    destinationRelativePath: string,
    signal?: AbortSignal
  ): Promise<void>
  hardLink?(
    sourceRelativePath: string,
    destinationRelativePath: string,
    signal?: AbortSignal
  ): Promise<void>
  unlink(relativePath: string, signal?: AbortSignal): Promise<void>
  rmdir(relativePath: string, signal?: AbortSignal): Promise<void>
  close(): void
}

type SftpLike = Pick<
  SFTPWrapper,
  | 'mkdir'
  | 'writeFile'
  | 'chmod'
  | 'rename'
  | 'ext_openssh_rename'
  | 'ext_openssh_hardlink'
  | 'unlink'
  | 'rmdir'
  | 'lstat'
  | 'stat'
  | 'open'
  | 'read'
  | 'write'
  | 'close'
  | 'fstat'
  | 'end'
  | 'on'
>

function validatePositiveLimit(
  value: number | undefined,
  fallback: number,
  maximum: number
): number {
  const resolved = value ?? fallback
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > maximum
  ) {
    throw new Error('SFTP 安全限制无效')
  }
  return resolved
}

function validateStagingDirectory(value: string): string {
  if (
    Buffer.byteLength(value, 'utf8') > MAX_REMOTE_PATH_BYTES ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes('//') ||
    !(value.startsWith('/') || /^[A-Za-z]:\//u.test(value))
  ) {
    throw new Error('SFTP 暂存目录无效')
  }
  const normalized = value.replace(/\/+$/u, '')
  const pathWithoutRoot = normalized.replace(
    /^(?:\/|[A-Za-z]:\/)/u,
    ''
  )
  const parts = pathWithoutRoot.split('/')
  if (
    !pathWithoutRoot ||
    parts.length > MAX_REMOTE_PATH_SEGMENTS ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('SFTP 暂存目录无效')
  }
  return normalized
}

function validateRelativePath(value: string): string {
  if (
    !value ||
    Buffer.byteLength(value, 'utf8') > MAX_REMOTE_PATH_BYTES ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error('SFTP 相对路径无效')
  }
  const parts = value.split('/')
  if (
    parts.length > MAX_REMOTE_PATH_SEGMENTS ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('SFTP 相对路径无效')
  }
  return value
}

function abortError(signal?: AbortSignal): unknown {
  return (
    signal?.reason ??
    new DOMException('The operation was aborted', 'AbortError')
  )
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ('code' in error &&
      ((error as { code?: unknown }).code === 2 ||
        (error as { code?: unknown }).code === 'ENOENT'))
  )
}

function metadataFromStats(stats: Stats): SftpEntryMetadata {
  if (
    !Number.isSafeInteger(stats.size) ||
    stats.size < 0 ||
    !Number.isSafeInteger(stats.mode) ||
    !Number.isSafeInteger(stats.uid) ||
    !Number.isSafeInteger(stats.gid) ||
    !Number.isFinite(stats.atime) ||
    !Number.isFinite(stats.mtime)
  ) {
    throw new Error('SFTP 文件元数据无效')
  }
  const predicates = [
    ['file', stats.isFile],
    ['directory', stats.isDirectory],
    ['symbolic-link', stats.isSymbolicLink]
  ] as const
  const types = predicates
    .filter(([, predicate]) => {
      if (typeof predicate !== 'function') {
        throw new Error('SFTP 文件类型元数据无效')
      }
      return predicate.call(stats)
    })
    .map(([type]) => type)
  if (types.length !== 1) {
    throw new Error('SFTP 文件类型不受支持')
  }
  return {
    type: types[0]!,
    size: stats.size,
    mode: stats.mode & 0o7777,
    uid: stats.uid,
    gid: stats.gid,
    atime: stats.atime,
    mtime: stats.mtime
  }
}

export class BoundedStagedSftp implements StagedSftp {
  readonly stagingDirectory: string
  private readonly maximumFileBytes: number
  private readonly maximumTotalBytes: number
  private readonly maximumOperations: number
  private readonly operationTimeoutMs: number
  private totalBytes = 0
  private operations = 0
  private closed = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly sftp: SftpLike,
    stagingDirectory: string,
    limits: BoundedSftpLimits = {}
  ) {
    this.stagingDirectory =
      validateStagingDirectory(stagingDirectory)
    this.maximumFileBytes = validatePositiveLimit(
      limits.maximumFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      MAX_MAXIMUM_FILE_BYTES
    )
    this.maximumTotalBytes = validatePositiveLimit(
      limits.maximumTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      DEFAULT_MAX_TOTAL_BYTES
    )
    this.maximumOperations = validatePositiveLimit(
      limits.maximumOperations,
      DEFAULT_MAX_OPERATIONS,
      DEFAULT_MAX_OPERATIONS
    )
    this.operationTimeoutMs = validatePositiveLimit(
      limits.operationTimeoutMs,
      DEFAULT_OPERATION_TIMEOUT_MS,
      MAX_OPERATION_TIMEOUT_MS
    )
    this.sftp.on('error', () => {
      this.closed = true
    })
  }

  async mkdir(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const validated = validateRelativePath(relativePath)
    const remotePath = this.resolveValidated(validated)
    return this.enqueue(signal, async () => {
      await this.assertSafeAncestors(validated)
      await this.call<void>((done) => {
        this.sftp.mkdir(remotePath, { mode: 0o700 }, done)
      })
    })
  }

  async writeFile(
    relativePath: string,
    contents: Buffer,
    signal?: AbortSignal
  ): Promise<void> {
    const validated = validateRelativePath(relativePath)
    const remotePath = this.resolveValidated(validated)
    if (contents.byteLength > this.maximumFileBytes) {
      throw new Error('SFTP 文件大小超过安全限制')
    }
    return this.enqueue(
      signal,
      async () => {
        if (
          this.totalBytes + contents.byteLength >
          this.maximumTotalBytes
        ) {
          throw new Error('SFTP 传输总量超过安全限制')
        }
        await this.assertSafeAncestors(validated)
        await this.call<void>((done) => {
          this.sftp.writeFile(
            remotePath,
            contents,
            { mode: 0o600, flag: 'wx' },
            done
          )
        })
        this.totalBytes += contents.byteLength
      },
      this.transferTimeoutMs(contents.byteLength)
    )
  }

  async uploadFile(
    relativePath: string,
    sourcePath: string,
    identity: SftpUploadIdentity,
    signal?: AbortSignal
  ): Promise<void> {
    const validated = validateRelativePath(relativePath)
    const remotePath = this.resolveValidated(validated)
    if (
      !Number.isSafeInteger(identity.size) ||
      identity.size < 0 ||
      identity.size > this.maximumFileBytes
    ) {
      throw new Error('SFTP 文件大小超过安全限制')
    }
    if (!/^[a-f0-9]{64}$/u.test(identity.sha256)) {
      throw new Error('SFTP 文件 SHA-256 无效')
    }
    return this.enqueue(
      signal,
      async () => {
        if (
          this.totalBytes + identity.size >
          this.maximumTotalBytes
        ) {
          throw new Error('SFTP 传输总量超过安全限制')
        }
        await this.assertSafeAncestors(validated)
        const pathMetadata = await localLstat(sourcePath)
        if (
          !pathMetadata.isFile() ||
          pathMetadata.isSymbolicLink() ||
          pathMetadata.size !== identity.size
        ) {
          throw new Error('SFTP 本地上传源不是预期的普通文件')
        }
        const source = await localOpen(
          sourcePath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        )
        let remoteHandle: Buffer | undefined
        const closeSourceOnAbort = (): void => {
          void source.close().catch(() => undefined)
        }
        signal?.addEventListener('abort', closeSourceOnAbort, {
          once: true
        })
        try {
          const openedMetadata = await source.stat()
          if (
            !openedMetadata.isFile() ||
            openedMetadata.size !== identity.size ||
            openedMetadata.dev !== pathMetadata.dev ||
            openedMetadata.ino !== pathMetadata.ino
          ) {
            throw new Error(
              'SFTP 本地上传源在打开期间发生变化'
            )
          }
          remoteHandle = await this.call<Buffer>((done) => {
            this.sftp.open(
              remotePath,
              'wx',
              { mode: 0o600 },
              done
            )
          })
          const initialRemoteMetadata = metadataFromStats(
            await this.call<Stats>((done) => {
              this.sftp.fstat(remoteHandle!, done)
            })
          )
          this.assertType(initialRemoteMetadata, 'file')
          if (initialRemoteMetadata.size !== 0) {
            throw new Error('SFTP 上传目标初始大小无效')
          }

          const hash = createHash('sha256')
          const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
          let position = 0
          while (true) {
            signal?.throwIfAborted()
            const { bytesRead } = await source.read(
              buffer,
              0,
              buffer.byteLength,
              position
            )
            if (bytesRead === 0) {
              break
            }
            position += bytesRead
            if (
              position > identity.size ||
              this.totalBytes + bytesRead >
                this.maximumTotalBytes
            ) {
              throw new Error('SFTP 文件大小超过安全限制')
            }
            const chunk = buffer.subarray(0, bytesRead)
            hash.update(chunk)
            await this.writeHandle(
              remoteHandle,
              chunk,
              position - bytesRead
            )
            this.totalBytes += bytesRead
          }
          if (position !== identity.size) {
            throw new Error('SFTP 本地上传源大小与预期不一致')
          }
          if (hash.digest('hex') !== identity.sha256) {
            throw new Error('SFTP 本地上传源 SHA-256 校验失败')
          }
          const remoteMetadata = metadataFromStats(
            await this.call<Stats>((done) => {
              this.sftp.fstat(remoteHandle!, done)
            })
          )
          this.assertType(remoteMetadata, 'file')
          if (remoteMetadata.size !== identity.size) {
            throw new Error('SFTP 上传目标大小与预期不一致')
          }
        } finally {
          signal?.removeEventListener(
            'abort',
            closeSourceOnAbort
          )
          await Promise.allSettled([
            source.close(),
            remoteHandle
              ? this.closeHandle(remoteHandle)
              : Promise.resolve()
          ])
        }
      },
      this.transferTimeoutMs(identity.size)
    )
  }

  async readFile(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<Buffer> {
    const validated = validateRelativePath(relativePath)
    const remotePath = this.resolveValidated(validated)
    return this.enqueue(
      signal,
      async (resetTimeout) => {
        const metadata = await this.safeStat(validated)
        this.assertType(metadata, 'file')
        const remainingTotal =
          this.maximumTotalBytes - this.totalBytes
        const maximumReadBytes = Math.min(
          this.maximumFileBytes,
          remainingTotal
        )
        if (
          maximumReadBytes <= 0 ||
          metadata.size > maximumReadBytes
        ) {
          throw new Error('SFTP 读取大小超过安全限制')
        }
        const handle = await this.call<Buffer>((done) => {
          this.sftp.open(remotePath, 'r', done)
        })
        try {
          const openedMetadata = metadataFromStats(
            await this.call<Stats>((done) => {
              this.sftp.fstat(handle, done)
            })
          )
          this.assertType(openedMetadata, 'file')
          if (openedMetadata.size > maximumReadBytes) {
            throw new Error('SFTP 读取大小超过安全限制')
          }
          resetTimeout(
            this.transferTimeoutMs(openedMetadata.size)
          )
          const contents = await this.readHandle(
            handle,
            openedMetadata.size,
            maximumReadBytes
          )
          this.totalBytes += contents.byteLength
          return contents
        } finally {
          await this.closeHandle(handle)
        }
      }
    )
  }

  async lstat(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<SftpEntryMetadata> {
    const validated = validateRelativePath(relativePath)
    return this.enqueue(signal, async () => {
      await this.assertSafeAncestors(validated)
      return this.getLstat(this.resolveValidated(validated))
    })
  }

  async stat(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<SftpEntryMetadata> {
    const validated = validateRelativePath(relativePath)
    return this.enqueue(signal, () => this.safeStat(validated))
  }

  async chmod(
    relativePath: string,
    mode: AllowedSftpMode,
    signal?: AbortSignal
  ): Promise<void> {
    const validated = validateRelativePath(relativePath)
    const remotePath = this.resolveValidated(validated)
    if (!(ALLOWED_MODES as readonly number[]).includes(mode)) {
      throw new Error('SFTP 文件权限不在安全允许列表中')
    }
    return this.enqueue(signal, async () => {
      const metadata = await this.safeStat(validated)
      if (
        metadata.type === 'directory' &&
        mode !== 0o700 &&
        mode !== 0o755
      ) {
        throw new Error('SFTP 目录权限必须保留执行权限')
      }
      await this.call<void>((done) => {
        this.sftp.chmod(remotePath, mode, done)
      })
    })
  }

  setExecutable(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<void> {
    return this.chmod(relativePath, 0o700, signal)
  }

  async rename(
    sourceRelativePath: string,
    destinationRelativePath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const sourceValidated = validateRelativePath(sourceRelativePath)
    const destinationValidated = validateRelativePath(
      destinationRelativePath
    )
    const source = this.resolveValidated(sourceValidated)
    const destination = this.resolveValidated(destinationValidated)
    return this.enqueue(signal, async () => {
      await this.assertSafeAncestors(sourceValidated)
      const sourceMetadata = await this.getLstat(source)
      this.assertNotLink(sourceMetadata)
      await this.assertSafeAncestors(destinationValidated)
      try {
        await this.getLstat(destination)
        throw new Error('SFTP 重命名目标已存在')
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error
        }
      }
      await this.call<void>((done) => {
        this.sftp.rename(source, destination, done)
      })
    })
  }

  async replaceFile(
    sourceRelativePath: string,
    destinationRelativePath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const sourceValidated = validateRelativePath(sourceRelativePath)
    const destinationValidated = validateRelativePath(
      destinationRelativePath
    )
    const source = this.resolveValidated(sourceValidated)
    const destination = this.resolveValidated(destinationValidated)
    return this.enqueue(signal, async () => {
      await this.assertSafeAncestors(sourceValidated)
      this.assertType(await this.getLstat(source), 'file')
      await this.assertSafeAncestors(destinationValidated)
      try {
        this.assertType(await this.getLstat(destination), 'file')
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error
        }
      }
      try {
        await this.call<void>((done) => {
          this.sftp.ext_openssh_rename(
            source,
            destination,
            done
          )
        })
      } catch (error) {
        throw new Error('SFTP 原子文件替换失败', {
          cause: error
        })
      }
    })
  }

  async hardLink(
    sourceRelativePath: string,
    destinationRelativePath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const sourceValidated = validateRelativePath(sourceRelativePath)
    const destinationValidated = validateRelativePath(
      destinationRelativePath
    )
    const source = this.resolveValidated(sourceValidated)
    const destination = this.resolveValidated(destinationValidated)
    return this.enqueue(signal, async () => {
      await this.assertSafeAncestors(sourceValidated)
      this.assertType(await this.getLstat(source), 'file')
      await this.assertSafeAncestors(destinationValidated)
      try {
        await this.getLstat(destination)
        throw new Error('SFTP 硬链接目标已存在')
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error
        }
      }
      await this.call<void>((done) => {
        this.sftp.ext_openssh_hardlink(
          source,
          destination,
          done
        )
      })
      this.assertType(await this.getLstat(destination), 'file')
    })
  }

  async unlink(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const validated = validateRelativePath(relativePath)
    const remotePath = this.resolveValidated(validated)
    return this.enqueue(signal, async () => {
      await this.assertSafeAncestors(validated)
      this.assertType(await this.getLstat(remotePath), 'file')
      await this.call<void>((done) => {
        this.sftp.unlink(remotePath, done)
      })
    })
  }

  async rmdir(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const validated = validateRelativePath(relativePath)
    const remotePath = this.resolveValidated(validated)
    return this.enqueue(signal, async () => {
      await this.assertSafeAncestors(validated)
      this.assertType(
        await this.getLstat(remotePath),
        'directory'
      )
      await this.call<void>((done) => {
        this.sftp.rmdir(remotePath, done)
      })
    })
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.sftp.end()
  }

  private resolveValidated(relativePath: string): string {
    return `${this.stagingDirectory}/${relativePath}`
  }

  private async assertSafeAncestors(
    relativePath: string
  ): Promise<void> {
    const parts = relativePath.split('/')
    const paths = [this.stagingDirectory]
    let current = this.stagingDirectory
    for (const part of parts.slice(0, -1)) {
      current = `${current}/${part}`
      paths.push(current)
    }
    for (const path of paths) {
      this.assertType(await this.getLstat(path), 'directory')
    }
  }

  private async safeStat(
    relativePath: string
  ): Promise<SftpEntryMetadata> {
    await this.assertSafeAncestors(relativePath)
    const remotePath = this.resolveValidated(relativePath)
    const linkMetadata = await this.getLstat(remotePath)
    this.assertNotLink(linkMetadata)
    const metadata = metadataFromStats(
      await this.call<Stats>((done) => {
        this.sftp.stat(remotePath, done)
      })
    )
    this.assertNotLink(metadata)
    if (metadata.type !== linkMetadata.type) {
      throw new Error('SFTP 文件类型在操作期间发生变化')
    }
    return metadata
  }

  private getLstat(remotePath: string): Promise<SftpEntryMetadata> {
    return this.call<Stats>((done) => {
      this.sftp.lstat(remotePath, done)
    }).then(metadataFromStats)
  }

  private assertNotLink(metadata: SftpEntryMetadata): void {
    if (metadata.type === 'symbolic-link') {
      throw new Error('SFTP 不允许操作符号链接')
    }
  }

  private assertType(
    metadata: SftpEntryMetadata,
    expected: Exclude<SftpEntryType, 'symbolic-link'>
  ): void {
    this.assertNotLink(metadata)
    if (metadata.type !== expected) {
      throw new Error(
        expected === 'file'
          ? 'SFTP 目标不是普通文件'
          : 'SFTP 目标不是目录'
      )
    }
  }

  private async readHandle(
    handle: Buffer,
    expectedSize: number,
    maximumReadBytes: number
  ): Promise<Buffer> {
    const contents = Buffer.allocUnsafe(expectedSize)
    let nextPosition = 0
    let discoveredSize = expectedSize
    const readSegment = async (): Promise<void> => {
      while (true) {
        const position = nextPosition
        nextPosition += READ_CHUNK_BYTES
        if (
          position >= expectedSize ||
          position >= discoveredSize
        ) {
          return
        }
        const segmentLength = Math.min(
          READ_CHUNK_BYTES,
          expectedSize - position
        )
        let segmentOffset = 0
        while (
          segmentOffset < segmentLength &&
          position + segmentOffset < discoveredSize
        ) {
          const length = segmentLength - segmentOffset
          const bytesRead = await this.call<number>((done) => {
            this.sftp.read(
              handle,
              contents,
              position + segmentOffset,
              length,
              position + segmentOffset,
              (error, count) => done(error, count)
            )
          })
          if (
            !Number.isSafeInteger(bytesRead) ||
            bytesRead < 0 ||
            bytesRead > length
          ) {
            throw new Error('SFTP 读取结果无效')
          }
          if (bytesRead === 0) {
            discoveredSize = Math.min(
              discoveredSize,
              position + segmentOffset
            )
            return
          }
          segmentOffset += bytesRead
        }
      }
    }
    const workerCount = Math.min(
      MAXIMUM_CONCURRENT_READS,
      Math.ceil(expectedSize / READ_CHUNK_BYTES)
    )
    await Promise.all(
      Array.from({ length: workerCount }, readSegment)
    )
    const extra = Buffer.allocUnsafe(1)
    const extraBytes = await this.call<number>((done) => {
      this.sftp.read(
        handle,
        extra,
        0,
        1,
        expectedSize,
        (error, count) => done(error, count)
      )
    })
    if (extraBytes !== 0) {
      throw new Error('SFTP 读取大小超过安全限制')
    }
    const actualSize = Math.min(expectedSize, discoveredSize)
    if (actualSize > maximumReadBytes) {
      throw new Error('SFTP 读取大小超过安全限制')
    }
    return actualSize === contents.byteLength
      ? contents
      : contents.subarray(0, actualSize)
  }

  private async writeHandle(
    handle: Buffer,
    contents: Buffer,
    position: number
  ): Promise<void> {
    await this.call<void>((done) => {
      this.sftp.write(
        handle,
        contents,
        0,
        contents.byteLength,
        position,
        done
      )
    })
  }

  private async closeHandle(handle: Buffer): Promise<void> {
    try {
      await this.call<void>((done) => {
        this.sftp.close(handle, done)
      })
    } catch {
      this.close()
    }
  }

  private call<T>(
    begin: (
      callback: (error?: Error | null, value?: T) => void
    ) => void
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('SFTP 通道已关闭'))
    }
    return new Promise((resolve, reject) => {
      try {
        begin((error, value) => {
          if (error) {
            reject(error)
          } else {
            resolve(value as T)
          }
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  private transferTimeoutMs(byteLength: number): number {
    const scaled = Math.ceil(
      (byteLength / MINIMUM_TRANSFER_BYTES_PER_SECOND) * 1_000
    )
    return Math.min(
      MAX_TRANSFER_TIMEOUT_MS,
      Math.max(this.operationTimeoutMs, scaled)
    )
  }

  private enqueue<T>(
    signal: AbortSignal | undefined,
    operation: (
      resetTimeout: (timeoutMs: number) => void
    ) => Promise<T>,
    timeoutMs = this.operationTimeoutMs
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('SFTP 通道已关闭'))
    }
    if (signal?.aborted) {
      return Promise.reject(abortError(signal))
    }
    this.operations += 1
    if (this.operations > this.maximumOperations) {
      return Promise.reject(
        new Error('SFTP 操作数量超过安全限制')
      )
    }
    const previous = this.queue
    let releaseQueue!: () => void
    this.queue = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      const finish = (value?: T, error?: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
        signal?.removeEventListener('abort', abort)
        releaseQueue()
        if (error) {
          reject(error)
        } else {
          resolve(value as T)
        }
      }
      const abort = (): void => {
        this.close()
        finish(undefined, abortError(signal))
      }
      const resetTimeout = (nextTimeoutMs: number): void => {
        if (settled) {
          return
        }
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
        timeout = setTimeout(() => {
          this.close()
          finish(undefined, new Error('SFTP 操作超时'))
        }, nextTimeoutMs)
      }
      const start = (): void => {
        if (settled) {
          return
        }
        if (this.closed) {
          finish(undefined, new Error('SFTP 通道已关闭'))
          return
        }
        if (signal?.aborted) {
          abort()
          return
        }
        resetTimeout(timeoutMs)
        Promise.resolve()
          .then(() => operation(resetTimeout))
          .then(
            (value) => finish(value),
            (error: unknown) => finish(undefined, error)
          )
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }
      previous.then(start, start)
    })
  }
}
