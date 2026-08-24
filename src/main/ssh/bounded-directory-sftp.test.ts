import { EventEmitter } from 'node:events'
import type { FileEntryWithStats } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import {
  listBoundedSftpDirectories,
  type DirectorySftp,
  type DirectorySftpOpener
} from './bounded-directory-sftp'

type TestSftp = DirectorySftp

function entry(
  filename: string,
  type: 'directory' | 'file' | 'symbolic-link' = 'directory'
): FileEntryWithStats {
  return {
    filename,
    longname: filename,
    attrs: {
      size: 0,
      uid: 1,
      gid: 1,
      mode: 0o755,
      atime: 0,
      mtime: 0,
      isDirectory: () => type === 'directory',
      isFile: () => type === 'file',
      isSymbolicLink: () => type === 'symbolic-link',
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false
    }
  }
}

function createSftp(options: {
  home?: string
  canonicalPath?: string
  batches?: FileEntryWithStats[][]
} = {}): TestSftp {
  const emitter = new EventEmitter()
  const batches = [...(options.batches ?? [[]])]
  const sftp = Object.assign(emitter, {
    realpath: vi.fn(
      (
        path: string,
        callback: (
          error: Error | undefined,
          result: string
        ) => void
      ) => {
        callback(
          undefined,
          path === '.'
            ? (options.home ?? '/home/builder')
            : (options.canonicalPath ?? path)
        )
      }
    ),
    opendir: vi.fn(
      (
        _path: string,
        callback: (
          error: Error | undefined,
          handle: Buffer
        ) => void
      ) => callback(undefined, Buffer.from('directory-handle'))
    ),
    readdir: vi.fn(
      (
        _handle: Buffer,
        callback: (
          error: Error | undefined,
          entries: FileEntryWithStats[]
        ) => void
      ) => callback(undefined, batches.shift() ?? [])
    ),
    close: vi.fn(
      (
        _handle: Buffer,
        callback: (error?: Error | null) => void
      ) => callback()
    ),
    end: vi.fn()
  })
  return sftp as unknown as TestSftp
}

function opener(sftp: TestSftp): DirectorySftpOpener {
  return (callback) => callback(undefined, sftp)
}

describe('bounded directory SFTP', () => {
  it('resolves home and requested paths, filters entries, and closes every resource', async () => {
    const sftp = createSftp({
      home: '/home/builder',
      canonicalPath: '/srv/projects',
      batches: [
        [
          entry('zeta'),
          entry('alpha'),
          entry('file.txt', 'file'),
          entry('link', 'symbolic-link'),
          entry('.'),
          entry('..'),
          entry('nested/name'),
          entry('back\\slash'),
          entry('control\u0001'),
          entry('\ufffd'),
          entry('x'.repeat(256)),
          entry('alpha')
        ],
        []
      ]
    })

    await expect(
      listBoundedSftpDirectories(
        opener(sftp),
        '/srv/requested'
      )
    ).resolves.toEqual({
      path: '/srv/projects',
      homeDirectory: '/home/builder',
      parentPath: '/srv',
      entries: [
        { name: 'alpha', path: '/srv/projects/alpha' },
        { name: 'zeta', path: '/srv/projects/zeta' }
      ],
      truncated: false
    })
    expect(sftp.realpath).toHaveBeenNthCalledWith(
      1,
      '.',
      expect.any(Function)
    )
    expect(sftp.realpath).toHaveBeenNthCalledWith(
      2,
      '/srv/requested',
      expect.any(Function)
    )
    expect(sftp.opendir).toHaveBeenCalledWith(
      '/srv/projects',
      expect.any(Function)
    )
    expect(sftp.readdir).toHaveBeenCalledTimes(2)
    expect(sftp.close).toHaveBeenCalledOnce()
    expect(sftp.end).toHaveBeenCalledOnce()
  })

  it('uses canonical home by default and reports root without a parent', async () => {
    const sftp = createSftp({
      home: '/',
      canonicalPath: '/',
      batches: [[entry('tmp')], []]
    })

    await expect(
      listBoundedSftpDirectories(opener(sftp))
    ).resolves.toMatchObject({
      path: '/',
      homeDirectory: '/',
      parentPath: null,
      entries: [{ name: 'tmp', path: '/tmp' }]
    })
    expect(sftp.realpath).toHaveBeenNthCalledWith(
      2,
      '/',
      expect.any(Function)
    )
  })

  it('sorts names by their UTF-8 bytes rather than UTF-16 code units', async () => {
    const sftp = createSftp({
      batches: [[entry('\u{10000}'), entry('\ue000')], []]
    })

    const result = await listBoundedSftpDirectories(opener(sftp))

    expect(result.entries.map(({ name }) => name)).toEqual([
      '\ue000',
      '\u{10000}'
    ])
  })

  it('returns at most 500 directories after scanning at most 2000 entries', async () => {
    const entries = Array.from({ length: 2_100 }, (_, index) =>
      entry(`dir-${index.toString().padStart(4, '0')}`)
    )
    const sftp = createSftp({ batches: [entries] })

    const result = await listBoundedSftpDirectories(opener(sftp))

    expect(result.entries).toHaveLength(500)
    expect(result.entries[0]?.name).toBe('dir-0000')
    expect(result.entries[499]?.name).toBe('dir-0499')
    expect(result.truncated).toBe(true)
    expect(sftp.readdir).toHaveBeenCalledOnce()
    expect(sftp.close).toHaveBeenCalledOnce()
    expect(sftp.end).toHaveBeenCalledOnce()
  })

  it('stops after 64 handle-based READDIR callbacks', async () => {
    const sftp = createSftp({
      batches: Array.from({ length: 65 }, (_, index) => [
        entry(`dir-${index.toString().padStart(2, '0')}`)
      ])
    })

    const result = await listBoundedSftpDirectories(opener(sftp))

    expect(sftp.readdir).toHaveBeenCalledTimes(64)
    expect(result.entries).toHaveLength(64)
    expect(result.truncated).toBe(true)
    expect(sftp.readdir).toHaveBeenCalledWith(
      Buffer.from('directory-handle'),
      expect.any(Function)
    )
  })

  it('times out the whole operation and ends a pending channel', async () => {
    vi.useFakeTimers()
    try {
      const sftp = createSftp()
      sftp.realpath = vi.fn()
      const pending = listBoundedSftpDirectories(opener(sftp))
      const expectation = expect(pending).rejects.toThrow(
        '目录浏览超时'
      )

      await vi.advanceTimersByTimeAsync(30_000)

      await expectation
      expect(sftp.close).not.toHaveBeenCalled()
      expect(sftp.end).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending read and ignores its late callback', async () => {
    const sftp = createSftp()
    let callback:
      | ((
          error: Error | undefined,
          entries: FileEntryWithStats[]
        ) => void)
      | undefined
    sftp.readdir = vi.fn((_handle, next) => {
      callback = next
    })
    const controller = new AbortController()
    const pending = listBoundedSftpDirectories(
      opener(sftp),
      undefined,
      controller.signal
    )
    controller.abort()

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(sftp.close).toHaveBeenCalledOnce()
    expect(sftp.end).toHaveBeenCalledOnce()

    callback?.(undefined, [entry('late')])
    expect(sftp.close).toHaveBeenCalledOnce()
    expect(sftp.end).toHaveBeenCalledOnce()
  })

  it('closes the handle and channel when READDIR fails', async () => {
    const sftp = createSftp()
    sftp.readdir = vi.fn((_handle, callback) => {
      callback(new Error('READDIR failed'), [])
    })

    await expect(
      listBoundedSftpDirectories(opener(sftp))
    ).rejects.toThrow('READDIR failed')
    expect(sftp.close).toHaveBeenCalledOnce()
    expect(sftp.end).toHaveBeenCalledOnce()
  })

  it('treats SFTP status code 1 as the end of the directory', async () => {
    const sftp = createSftp({
      batches: [[entry('project')]]
    })
    let reads = 0
    sftp.readdir = vi.fn((_handle, callback) => {
      reads += 1
      if (reads === 1) {
        callback(undefined, [entry('project')])
        return
      }
      callback(
        Object.assign(new Error('End of file'), { code: 1 }),
        []
      )
    })

    await expect(
      listBoundedSftpDirectories(opener(sftp))
    ).resolves.toMatchObject({
      entries: [{
        name: 'project',
        path: '/home/builder/project'
      }],
      truncated: false
    })
    expect(sftp.readdir).toHaveBeenCalledTimes(2)
    expect(sftp.close).toHaveBeenCalledOnce()
    expect(sftp.end).toHaveBeenCalledOnce()
  })

  it('closes a handle returned after cancellation', async () => {
    const sftp = createSftp()
    let callback:
      | ((error: Error | undefined, handle: Buffer) => void)
      | undefined
    sftp.opendir = vi.fn((_path, next) => {
      callback = next
    })
    const controller = new AbortController()
    const pending = listBoundedSftpDirectories(
      opener(sftp),
      undefined,
      controller.signal
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError'
    })

    callback?.(undefined, Buffer.from('late-handle'))
    expect(sftp.close).toHaveBeenCalledWith(
      Buffer.from('late-handle'),
      expect.any(Function)
    )
    expect(sftp.end).toHaveBeenCalledOnce()
  })

  it('rejects non-canonical inputs and provider paths without opening directories', async () => {
    const sftp = createSftp({ canonicalPath: '/bad/../path' })

    expect(() =>
      listBoundedSftpDirectories(opener(sftp), 'relative')
    ).toThrow('目录路径无效')
    await expect(
      listBoundedSftpDirectories(opener(sftp), '/requested')
    ).rejects.toThrow('目录路径无效')
    expect(sftp.opendir).not.toHaveBeenCalled()
    expect(sftp.end).toHaveBeenCalledOnce()
  })

  it('ends an SFTP channel delivered after an open timeout', async () => {
    vi.useFakeTimers()
    try {
      let callback:
        | Parameters<DirectorySftpOpener>[0]
        | undefined
      const pending = listBoundedSftpDirectories((next) => {
        callback = next
      })
      const expectation = expect(pending).rejects.toThrow(
        '目录浏览超时'
      )
      await vi.advanceTimersByTimeAsync(30_000)
      await expectation

      const late = createSftp()
      callback?.(undefined, late)
      expect(late.end).toHaveBeenCalledOnce()
      expect(late.realpath).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
