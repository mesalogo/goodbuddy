import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installManagedPython,
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
