import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openPrivateSqliteDatabase,
  PreparedPrivateSqliteDatabaseFile
} from './private-sqlite-database'

describe('private SQLite database opening', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    )
  })

  async function privateDirectory(): Promise<string> {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-private-sqlite-')
    )
    temporaryDirectories.push(directory)
    return directory
  }

  it('opens a verified regular filesystem database', async () => {
    const path = join(await privateDirectory(), 'verified.sqlite')
    const database = openPrivateSqliteDatabase(path)
    database.exec('CREATE TABLE verified (value TEXT) STRICT')
    database.close()
  })

  it.runIf(process.platform !== 'win32')(
    'rejects a symbolic-link database path',
    async () => {
      const directory = await privateDirectory()
      const target = join(directory, 'target.sqlite')
      const link = join(directory, 'link.sqlite')
      await writeFile(target, '')
      await symlink(target, link)

      expect(() => openPrivateSqliteDatabase(link)).toThrow(
        'non-symbolic-link'
      )
    }
  )

  it.runIf(process.platform !== 'win32')(
    'rejects a symbolic-link parent path',
    async () => {
      const directory = await privateDirectory()
      const realParent = join(directory, 'real-parent')
      const linkedParent = join(directory, 'linked-parent')
      await mkdir(realParent, { mode: 0o700 })
      await symlink(realParent, linkedParent, 'dir')

      expect(() =>
        openPrivateSqliteDatabase(join(linkedParent, 'database.sqlite'))
      ).toThrow('parent must be a real directory')
    }
  )

  it.runIf(process.platform !== 'win32')(
    'rejects a parent outside the private same-UID boundary',
    async () => {
      const directory = await privateDirectory()
      await chmod(directory, 0o755)

      expect(() =>
        openPrivateSqliteDatabase(join(directory, 'database.sqlite'))
      ).toThrow('parent must be private')
    }
  )

  it.runIf(process.platform !== 'win32')(
    'rejects path replacement while the verified descriptor remains open',
    async () => {
      const directory = await privateDirectory()
      const path = join(directory, 'database.sqlite')
      const moved = join(directory, 'moved.sqlite')
      const prepared = new PreparedPrivateSqliteDatabaseFile(path)
      try {
        await rename(path, moved)
        await writeFile(path, '')
        await expect(() => prepared.openDatabase()).toThrow(
          'path identity changed'
        )
      } finally {
        prepared.close()
      }
    }
  )
})
