import type {
  FileEntryWithStats,
  SFTPWrapper
} from 'ssh2'
import type {
  SshHostDirectoryBrowseResult
} from '../../shared/ssh-host-contracts'

const MAXIMUM_RETURNED_DIRECTORIES = 500
const MAXIMUM_SCANNED_ENTRIES = 2_000
const MAXIMUM_READDIR_CALLBACKS = 64
const OPERATION_TIMEOUT_MS = 30_000
const MAXIMUM_REMOTE_PATH_BYTES = 4_096
const MAXIMUM_NAME_BYTES = 255

export type DirectorySftp = Pick<
  SFTPWrapper,
  | 'realpath'
  | 'opendir'
  | 'readdir'
  | 'close'
  | 'end'
  | 'on'
  | 'removeListener'
>

export type DirectorySftpOpener = (
  callback: (
    error: Error | undefined,
    sftp?: DirectorySftp
  ) => void
) => void

function abortError(signal?: AbortSignal): unknown {
  return (
    signal?.reason ??
    new DOMException('The operation was aborted', 'AbortError')
  )
}

function isCanonicalAbsolutePosixPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') <= MAXIMUM_REMOTE_PATH_BYTES &&
    value.startsWith('/') &&
    (value === '/' || !value.endsWith('/')) &&
    !value.includes('//') &&
    !value.includes('\\') &&
    !value
      .split('/')
      .some((part) => part === '.' || part === '..') &&
    !/[\p{Cc}\p{Cs}\u2028\u2029\ufffd]/u.test(value)
  )
}

function validateRequestedPath(path: string | undefined): void {
  if (path !== undefined && !isCanonicalAbsolutePosixPath(path)) {
    throw new Error('SSH 目录路径无效')
  }
}

function parentPath(path: string): string | null {
  if (path === '/') {
    return null
  }
  const separator = path.lastIndexOf('/')
  return separator === 0 ? '/' : path.slice(0, separator)
}

function validDirectoryName(entry: FileEntryWithStats): boolean {
  const name = entry?.filename
  if (
    typeof name !== 'string' ||
    name === '.' ||
    name === '..' ||
    name.length === 0 ||
    Buffer.byteLength(name, 'utf8') > MAXIMUM_NAME_BYTES ||
    name.includes('/') ||
    name.includes('\\') ||
    /[\p{Cc}\p{Cs}\u2028\u2029\ufffd]/u.test(name)
  ) {
    return false
  }
  try {
    return (
      typeof entry.attrs?.isDirectory === 'function' &&
      entry.attrs.isDirectory() === true &&
      typeof entry.attrs.isSymbolicLink === 'function' &&
      entry.attrs.isSymbolicLink() === false
    )
  } catch {
    return false
  }
}

function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, 'utf8'),
    Buffer.from(right, 'utf8')
  )
}

function isSftpEndOfDirectory(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 1
  )
}

export function listBoundedSftpDirectories(
  openSftp: DirectorySftpOpener,
  requestedPath?: string,
  signal?: AbortSignal
): Promise<SshHostDirectoryBrowseResult> {
  validateRequestedPath(requestedPath)
  if (signal?.aborted) {
    return Promise.reject(abortError(signal))
  }

  return new Promise((resolve, reject) => {
    let sftp: DirectorySftp | undefined
    let handle: Buffer | undefined
    let handleCloseRequested = false
    let channelEnded = false
    let settled = false
    let scannedEntries = 0
    let readdirCallbacks = 0
    let truncated = false
    let homeDirectory: string | undefined
    let listingPath: string | undefined
    const directories = new Set<string>()

    const endChannel = (): void => {
      if (channelEnded || !sftp) {
        return
      }
      channelEnded = true
      sftp.removeListener('error', onChannelError)
      sftp.end()
    }

    const closeHandleBestEffort = (
      candidate: Buffer | undefined = handle,
      afterClose?: (error?: Error | null) => void
    ): void => {
      if (!candidate || !sftp) {
        afterClose?.()
        return
      }
      if (candidate === handle) {
        if (handleCloseRequested) {
          afterClose?.()
          return
        }
        handleCloseRequested = true
      }
      try {
        sftp.close(candidate, (error) => {
          afterClose?.(error)
        })
      } catch (error) {
        afterClose?.(
          error instanceof Error
            ? error
            : new Error('SFTP 目录句柄关闭失败')
        )
      }
    }

    const finishError = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      closeHandleBestEffort()
      endChannel()
      reject(error)
    }

    const finishSuccess = (): void => {
      if (settled || !listingPath) {
        return
      }
      const sorted = [...directories].sort(compareUtf8)
      const result: SshHostDirectoryBrowseResult = {
        path: listingPath,
        homeDirectory: homeDirectory!,
        parentPath: parentPath(listingPath),
        entries: sorted
          .slice(0, MAXIMUM_RETURNED_DIRECTORIES)
          .map((name) => ({
            name,
            path: joinPath(listingPath!, name)
          })),
        truncated:
          truncated ||
          sorted.length > MAXIMUM_RETURNED_DIRECTORIES
      }
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      closeHandleBestEffort()
      endChannel()
      resolve(result)
    }

    const onAbort = (): void => {
      finishError(abortError(signal))
    }
    const onChannelError = (error: Error): void => {
      finishError(error)
    }
    const timeout = setTimeout(() => {
      finishError(new Error('SSH 目录浏览超时'))
    }, OPERATION_TIMEOUT_MS)

    const readNextBatch = (): void => {
      if (settled || !sftp || !handle) {
        return
      }
      if (
        scannedEntries >= MAXIMUM_SCANNED_ENTRIES ||
        readdirCallbacks >= MAXIMUM_READDIR_CALLBACKS
      ) {
        truncated = true
        finishSuccess()
        return
      }
      readdirCallbacks += 1
      try {
        sftp.readdir(handle, (error, rawList) => {
          if (settled) {
            return
          }
          if (isSftpEndOfDirectory(error)) {
            finishSuccess()
            return
          }
          if (error) {
            finishError(error)
            return
          }
          const list = rawList as
            | FileEntryWithStats[]
            | false
            | undefined
          if (list === false || list === undefined) {
            finishSuccess()
            return
          }
          if (!Array.isArray(list)) {
            finishError(new Error('SFTP 目录列表无效'))
            return
          }
          if (list.length === 0) {
            finishSuccess()
            return
          }
          const remaining =
            MAXIMUM_SCANNED_ENTRIES - scannedEntries
          const inspected = list.slice(0, remaining)
          scannedEntries += inspected.length
          for (const entry of inspected) {
            if (
              validDirectoryName(entry) &&
              isCanonicalAbsolutePosixPath(
                joinPath(listingPath!, entry.filename)
              )
            ) {
              directories.add(entry.filename)
            }
          }
          if (
            list.length > inspected.length ||
            scannedEntries >= MAXIMUM_SCANNED_ENTRIES ||
            readdirCallbacks >= MAXIMUM_READDIR_CALLBACKS
          ) {
            truncated = true
            finishSuccess()
          } else {
            readNextBatch()
          }
        })
      } catch (error) {
        finishError(error)
      }
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }

    try {
      openSftp((openError, openedSftp) => {
        if (settled) {
          openedSftp?.end()
          return
        }
        if (openError || !openedSftp) {
          finishError(openError ?? new Error('无法打开 SFTP 通道'))
          return
        }
        sftp = openedSftp
        sftp.on('error', onChannelError)
        try {
          sftp.realpath('.', (homeError, homePath) => {
            if (settled) {
              return
            }
            if (
              homeError ||
              !isCanonicalAbsolutePosixPath(homePath)
            ) {
              finishError(
                homeError ?? new Error('SSH 主目录路径无效')
              )
              return
            }
            homeDirectory = homePath
            try {
              sftp!.realpath(
                requestedPath ?? homePath,
                (pathError, canonicalPath) => {
                  if (settled) {
                    return
                  }
                  if (
                    pathError ||
                    !isCanonicalAbsolutePosixPath(canonicalPath)
                  ) {
                    finishError(
                      pathError ?? new Error('SSH 目录路径无效')
                    )
                    return
                  }
                  listingPath = canonicalPath
                  try {
                    sftp!.opendir(
                      canonicalPath,
                      (directoryError, openedHandle) => {
                        if (settled) {
                          closeHandleBestEffort(openedHandle)
                          endChannel()
                          return
                        }
                        if (directoryError || !openedHandle) {
                          finishError(
                            directoryError ??
                              new Error('无法打开 SSH 目录')
                          )
                          return
                        }
                        handle = openedHandle
                        readNextBatch()
                      }
                    )
                  } catch (error) {
                    finishError(error)
                  }
                }
              )
            } catch (error) {
              finishError(error)
            }
          })
        } catch (error) {
          finishError(error)
        }
      })
    } catch (error) {
      finishError(error)
    }
  })
}
