import { describe, expect, it, vi } from 'vitest'
import type {
  SftpEntryMetadata,
  StagedSftp
} from '../ssh/bounded-sftp'
import {
  REMOTE_ENVIRONMENT_METADATA_PATHS,
  restoreRemoteEnvironmentMetadata,
  snapshotRemoteEnvironmentMetadata,
  type RemoteEnvironmentMetadataSnapshot
} from './remote-environment-metadata'

const UID = 1000

function missingPath(): Error & { code: string } {
  return Object.assign(new Error('missing'), { code: 'ENOENT' })
}

function fileMetadata(
  contents: Buffer,
  overrides: Partial<SftpEntryMetadata> = {}
): SftpEntryMetadata {
  return {
    type: 'file',
    size: contents.byteLength,
    mode: 0o600,
    uid: UID,
    gid: UID,
    atime: 0,
    mtime: 0,
    ...overrides
  }
}

function createSftp(
  initial: ReadonlyMap<string, Buffer>,
  metadataOverrides: ReadonlyMap<string, Partial<SftpEntryMetadata>> =
    new Map()
) {
  const files = new Map(
    [...initial].map(([path, contents]) => [path, Buffer.from(contents)])
  )
  const temporary = new Map<string, Buffer>()
  const sftp: StagedSftp = {
    stagingDirectory: '/home/goodbuddy',
    mkdir: vi.fn(),
    uploadFile: vi.fn(),
    writeFile: vi.fn(async (path, contents) => {
      temporary.set(path, Buffer.from(contents))
    }),
    readFile: vi.fn(async (path) => {
      const contents = files.get(path) ?? temporary.get(path)
      if (!contents) throw missingPath()
      return Buffer.from(contents)
    }),
    lstat: vi.fn(async (path) => {
      const contents = files.get(path) ?? temporary.get(path)
      if (!contents) throw missingPath()
      return fileMetadata(
        contents,
        metadataOverrides.get(path)
      )
    }),
    stat: vi.fn(),
    chmod: vi.fn(),
    setExecutable: vi.fn(),
    rename: vi.fn(),
    replaceFile: vi.fn(async (source, destination) => {
      const contents = temporary.get(source)
      if (!contents) throw missingPath()
      files.set(destination, Buffer.from(contents))
      temporary.delete(source)
    }),
    unlink: vi.fn(async (path) => {
      if (!files.delete(path) && !temporary.delete(path)) {
        throw missingPath()
      }
    }),
    rmdir: vi.fn(),
    close: vi.fn()
  }
  return { sftp, files, temporary }
}

describe('remote environment metadata', () => {
  it('snapshots original bytes and restores them exactly', async () => {
    const originals = new Map(
      REMOTE_ENVIRONMENT_METADATA_PATHS.map((path, index) => [
        path,
        Buffer.from([0, index, 255, 10])
      ])
    )
    const value = createSftp(originals)
    const snapshots = await snapshotRemoteEnvironmentMetadata(
      value.sftp,
      UID,
      new AbortController().signal
    )
    for (const path of REMOTE_ENVIRONMENT_METADATA_PATHS) {
      value.files.set(path, Buffer.from('changed'))
    }

    await restoreRemoteEnvironmentMetadata(value.sftp, snapshots)

    expect(
      REMOTE_ENVIRONMENT_METADATA_PATHS.map((path) =>
        value.files.get(path)
      )
    ).toEqual(
      REMOTE_ENVIRONMENT_METADATA_PATHS.map((path) =>
        originals.get(path)
      )
    )
    expect(value.sftp.chmod).toHaveBeenCalledTimes(5)
    expect(value.sftp.replaceFile).toHaveBeenCalledTimes(5)
  })

  it('records missing metadata and removes files created after the snapshot', async () => {
    const value = createSftp(new Map())
    const snapshots = await snapshotRemoteEnvironmentMetadata(
      value.sftp,
      UID,
      new AbortController().signal
    )
    for (const path of REMOTE_ENVIRONMENT_METADATA_PATHS) {
      value.files.set(path, Buffer.from('new'))
    }

    await restoreRemoteEnvironmentMetadata(value.sftp, snapshots)

    expect(value.files.size).toBe(0)
    expect(value.sftp.unlink).toHaveBeenCalledTimes(5)
  })

  it('distinguishes an empty original file from a missing file', async () => {
    const path = REMOTE_ENVIRONMENT_METADATA_PATHS[0]
    const value = createSftp(
      new Map([[path, Buffer.alloc(0)]])
    )
    const snapshots = await snapshotRemoteEnvironmentMetadata(
      value.sftp,
      UID,
      new AbortController().signal
    )
    value.files.set(path, Buffer.from('changed'))

    await restoreRemoteEnvironmentMetadata(value.sftp, snapshots)

    expect(value.files.get(path)).toEqual(Buffer.alloc(0))
  })

  it.each([
    ['permissions', { mode: 0o644 }],
    ['owner', { uid: UID + 1 }],
    ['symbolic link', { type: 'symbolic-link' as const }]
  ])('rejects metadata with invalid %s', async (_label, override) => {
    const path = REMOTE_ENVIRONMENT_METADATA_PATHS[0]
    const contents = Buffer.from('metadata')
    const value = createSftp(
      new Map([[path, contents]]),
      new Map([[path, override]])
    )

    await expect(snapshotRemoteEnvironmentMetadata(
      value.sftp,
      UID,
      new AbortController().signal
    )).rejects.toThrow('类型、所有者或权限无效')
    expect(value.sftp.readFile).not.toHaveBeenCalled()
  })

  it('continues restoring remaining files and aggregates every error', async () => {
    const first = REMOTE_ENVIRONMENT_METADATA_PATHS[0]
    const second = REMOTE_ENVIRONMENT_METADATA_PATHS[1]
    const third = REMOTE_ENVIRONMENT_METADATA_PATHS[2]
    const value = createSftp(new Map([
      [first, Buffer.from('changed-1')],
      [second, Buffer.from('changed-2')],
      [third, Buffer.from('created')]
    ]))
    const firstError = new Error('first replace failed')
    const secondError = new Error('second replace failed')
    vi.mocked(value.sftp.replaceFile).mockImplementation(
      async (_source, destination) => {
        throw destination === first ? firstError : secondError
      }
    )
    const snapshots: readonly RemoteEnvironmentMetadataSnapshot[] = [
      { path: first, contents: Buffer.from('original-1'), uid: UID },
      { path: second, contents: Buffer.from('original-2'), uid: UID },
      { path: third, uid: UID }
    ]

    const caught = await restoreRemoteEnvironmentMetadata(
      value.sftp,
      snapshots
    ).catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([
      firstError,
      secondError
    ])
    expect(value.sftp.replaceFile).toHaveBeenCalledTimes(2)
    expect(value.files.has(third)).toBe(false)
  })
})
