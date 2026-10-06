import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installManagedPython,
  cleanupManagedPythonOperations,
  removeManagedPython
} from './managed-python-install'

const temporaryDirectories: string[] = []

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-python-install-'))
  temporaryDirectories.push(directory)
  return join(directory, 'managed')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('Managed Python staged operations', () => {
  it('reclaims only known abandoned operation layouts inside the owned root', async () => {
    const rootDirectory = await root()
    await cleanupManagedPythonOperations(rootDirectory)
    const retained = ['cache', 'history', 'python-3.13.15', `.managed-python-download-${randomUUID()}`]
    for (const name of retained) await mkdir(join(rootDirectory, name))
    await writeFile(join(rootDirectory, '.managed-python-download-unrecognized'), 'keep')
    await writeFile(join(rootDirectory, `.managed-python-download-${'-'.repeat(36)}`), 'keep')
    await writeFile(join(rootDirectory, `.managed-python-download-${randomUUID()}`), 'partial archive')
    await mkdir(join(rootDirectory, `.managed-python-stage-${randomUUID()}`))
    await mkdir(join(rootDirectory, `.managed-python-backup-${randomUUID()}`))
    await cleanupManagedPythonOperations(rootDirectory)
    expect((await readdir(rootDirectory)).sort()).toEqual([
      '.goodbuddy-managed-python', '.managed-python-download-unrecognized',
      `.managed-python-download-${'-'.repeat(36)}`, ...retained
    ].sort())
  })
  it('publishes only after validation succeeds', async () => {
    const rootDirectory = await root()
    const installed = await installManagedPython({
      rootDirectory,
      version: '3.13.15',
      stage: async (directory) => {
        await writeFile(join(directory, 'python'), 'new')
      },
      validate: async (directory) => {
        expect(await readFile(join(directory, 'python'), 'utf8')).toBe('new')
      }
    })
    expect(await readFile(join(installed, 'python'), 'utf8')).toBe('new')
  })

  it('preserves an old same-version install after failed validation', async () => {
    const rootDirectory = await root()
    await installManagedPython({
      rootDirectory,
      version: '3.13.15',
      stage: (directory) => writeFile(join(directory, 'python'), 'old'),
      validate: async () => undefined
    })
    await expect(installManagedPython({
      rootDirectory,
      version: '3.13.15',
      stage: (directory) => writeFile(join(directory, 'python'), 'bad'),
      validate: async () => {
        throw new Error('probe failed')
      }
    })).rejects.toThrow('probe failed')
    expect(await readFile(
      join(rootDirectory, 'python-3.13.15', 'python'), 'utf8'
    )).toBe('old')
  })

  it('refuses to adopt or remove content outside an owned root', async () => {
    const rootDirectory = await root()
    await mkdir(rootDirectory)
    await writeFile(join(rootDirectory, 'unrelated'), 'keep')
    await expect(installManagedPython({
      rootDirectory,
      version: '3.13.15',
      stage: async () => undefined,
      validate: async () => undefined
    })).rejects.toThrow(/non-empty/u)
    expect(await readFile(join(rootDirectory, 'unrelated'), 'utf8')).toBe('keep')
  })

  it('removes only a selected managed version', async () => {
    const rootDirectory = await root()
    await installManagedPython({
      rootDirectory,
      version: '3.13.15',
      stage: (directory) => writeFile(join(directory, 'python'), 'ok'),
      validate: async () => undefined
    })
    await removeManagedPython({ rootDirectory, version: '3.13.15' })
    await expect(readFile(
      join(rootDirectory, 'python-3.13.15', 'python')
    )).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
