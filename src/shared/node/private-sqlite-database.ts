import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  type BigIntStats
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function assertSameFile(
  descriptorStats: BigIntStats,
  pathStats: BigIntStats
): void {
  if (
    !pathStats.isFile() ||
    pathStats.isSymbolicLink() ||
    descriptorStats.dev !== pathStats.dev ||
    descriptorStats.ino !== pathStats.ino
  ) {
    throw new Error('SQLite database path identity changed during open')
  }
}

/**
 * Verifies a local same-UID security boundary. On POSIX the database and its
 * immediate parent must be owned by the current UID, the parent must be
 * private, and the database mode is forced to 0600. This does not defend
 * against a process already running as the same UID.
 */
export class PreparedPrivateSqliteDatabaseFile {
  private descriptor?: number
  readonly path: string

  constructor(databasePath: string) {
    if (
      databasePath.length === 0 ||
      databasePath === ':memory:' ||
      /^file:/iu.test(databasePath)
    ) {
      throw new Error('SQLite database must be a filesystem path')
    }

    this.path = resolve(databasePath)
    const parentStats = lstatSync(dirname(this.path), { bigint: true })
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new Error('SQLite database parent must be a real directory')
    }
    this.assertPrivatePosixParent(parentStats)

    try {
      const pathStats = lstatSync(this.path, { bigint: true })
      if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
        throw new Error(
          'SQLite database must be a regular, non-symbolic-link file'
        )
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error
      }
    }

    this.descriptor = openSync(
      this.path,
      constants.O_CREAT |
        constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    try {
      if (process.platform !== 'win32') {
        fchmodSync(this.descriptor, 0o600)
      }
      this.verifyPathIdentity()
    } catch (error) {
      this.close()
      throw error
    }
  }

  openDatabase(timeout = 5_000): DatabaseSync {
    this.verifyPathIdentity()
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(this.path, { timeout })
      this.verifyPathIdentity()
      return database
    } catch (error) {
      database?.close()
      throw error
    } finally {
      this.close()
    }
  }

  close(): void {
    if (this.descriptor !== undefined) {
      closeSync(this.descriptor)
      this.descriptor = undefined
    }
  }

  private verifyPathIdentity(): void {
    if (this.descriptor === undefined) {
      throw new Error('SQLite database verification descriptor is closed')
    }
    const descriptorStats = fstatSync(this.descriptor, { bigint: true })
    const pathStats = lstatSync(this.path, { bigint: true })
    assertSameFile(descriptorStats, pathStats)
    this.assertPrivatePosixFile(descriptorStats)
  }

  private assertPrivatePosixParent(parentStats: BigIntStats): void {
    if (process.platform === 'win32') {
      return
    }
    const uid = process.getuid?.()
    if (
      uid === undefined ||
      parentStats.uid !== BigInt(uid) ||
      (parentStats.mode & 0o077n) !== 0n
    ) {
      throw new Error(
        'SQLite database parent must be private and owned by the current UID'
      )
    }
  }

  private assertPrivatePosixFile(fileStats: BigIntStats): void {
    if (process.platform === 'win32') {
      return
    }
    const uid = process.getuid?.()
    if (
      uid === undefined ||
      fileStats.uid !== BigInt(uid) ||
      (fileStats.mode & 0o777n) !== 0o600n
    ) {
      throw new Error(
        'SQLite database must be mode 0600 and owned by the current UID'
      )
    }
  }
}

export function openPrivateSqliteDatabase(
  databasePath: string,
  timeout = 5_000
): DatabaseSync {
  const prepared = new PreparedPrivateSqliteDatabaseFile(databasePath)
  try {
    return prepared.openDatabase(timeout)
  } finally {
    prepared.close()
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
