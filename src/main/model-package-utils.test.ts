import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupStaleModelInstallArtifacts,
  writeModelBuffer
} from './model-package-utils'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('cleanupStaleModelInstallArtifacts', () => {
  it('preserves active staging and names outside the manager contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-model-cleanup-'))
    temporaryDirectories.push(root)
    const active =
      '.install-active-model-00000000-0000-4000-8000-000000000001'
    const stale =
      '.install-owned-model-00000000-0000-4000-8000-000000000002'
    const userDirectory = '.install-owned-model-backup'
    await Promise.all([
      mkdir(join(root, active)),
      mkdir(join(root, stale)),
      mkdir(join(root, userDirectory)),
      mkdir(join(root, 'owned-model'))
    ])
    await writeFile(join(root, userDirectory, 'keep.txt'), 'keep')
    await writeFile(join(root, 'owned-model', 'package.bin.partial'), 'stale')
    await writeFile(join(root, 'owned-model', 'notes.partial'), 'keep')

    await cleanupStaleModelInstallArtifacts({
      rootDirectory: root,
      isModelId: (value) =>
        value === 'active-model' || value === 'owned-model',
      activeModelIds: new Set(['active-model']),
      partialFileNames: new Set(['package.bin']),
      escapeMessage: 'escaped'
    })

    expect(await readdir(root)).toEqual(
      expect.arrayContaining([active, userDirectory, 'owned-model'])
    )
    expect(await readdir(root)).not.toContain(stale)
    await expect(
      readFile(join(root, userDirectory, 'keep.txt'), 'utf8')
    ).resolves.toBe('keep')
    await expect(
      readFile(join(root, 'owned-model', 'notes.partial'), 'utf8')
    ).resolves.toBe('keep')
    await expect(
      readFile(
        join(root, 'owned-model', 'package.bin.partial'),
        'utf8'
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('ignores a selection partial renamed after enumeration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-model-cleanup-'))
    temporaryDirectories.push(root)
    const partialName =
      '.selection.json.00000000-0000-4000-8000-000000000001.partial'
    const partialPath = join(root, partialName)
    const renamedPath = join(root, 'selection-completed')
    await writeFile(partialPath, 'selection')

    await expect(
      cleanupStaleModelInstallArtifacts({
        rootDirectory: root,
        isModelId: () => false,
        activeModelIds: new Set(),
        partialFileNames: new Set(),
        cleanSelectionPartials: true,
        activeSelectionPartialNames: new Set(),
        escapeMessage: 'escaped',
        operations: {
          unlinkFile: async (path) => {
            await rename(path, renamedPath)
            await unlink(path)
          }
        }
      })
    ).resolves.toBeUndefined()
    await expect(readFile(renamedPath, 'utf8')).resolves.toBe(
      'selection'
    )
  })
})

describe('writeModelBuffer', () => {
  it('retries short writes until every byte is persisted', async () => {
    const persisted: number[] = []
    const write = vi.fn(
      async (
        buffer: Uint8Array,
        offset = 0,
        length = buffer.byteLength - offset
      ) => {
        const bytesWritten = Math.min(2, length)
        persisted.push(
          ...buffer.subarray(offset, offset + bytesWritten)
        )
        return { bytesWritten, buffer }
      }
    )
    const value = Uint8Array.from([1, 2, 3, 4, 5])
    const hash = createHash('sha256')
    const onPersisted = vi.fn((buffer: Uint8Array) => {
      hash.update(buffer)
    })

    await expect(
      writeModelBuffer({ write } as never, value, onPersisted)
    ).resolves.toBe(value.byteLength)
    expect(persisted).toEqual([...value])
    expect(write).toHaveBeenCalledTimes(3)
    expect(onPersisted).toHaveBeenCalledOnce()
    expect(hash.digest('hex')).toBe(
      createHash('sha256').update(value).digest('hex')
    )
  })

  it('fails closed when a write makes no progress', async () => {
    await expect(
      writeModelBuffer(
        {
          write: vi.fn(async (buffer: Uint8Array) => ({
            bytesWritten: 0,
            buffer
          }))
        } as never,
        Uint8Array.from([1])
      )
    ).rejects.toThrow('写入不完整')
  })
})
