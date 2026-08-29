import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BoundedStagedSftp } from './bounded-sftp'

type Entry = {
  type: 'file' | 'directory' | 'symbolic-link'
  contents?: Buffer
  reportedSize?: number
}

function stats(entry: Entry) {
  return {
    mode:
      entry.type === 'directory'
        ? 0o40700
        : entry.type === 'symbolic-link'
          ? 0o120777
          : 0o100600,
    uid: 1000,
    gid: 1000,
    size: entry.reportedSize ?? entry.contents?.byteLength ?? 0,
    atime: 1,
    mtime: 2,
    isDirectory: () => entry.type === 'directory',
    isFile: () => entry.type === 'file',
    isSymbolicLink: () => entry.type === 'symbolic-link',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false
  }
}

function missingError(): Error & { code: number } {
  return Object.assign(new Error('not found'), { code: 2 })
}

function createSftp(root = '/safe/staging') {
  const emitter = new EventEmitter()
  const entries = new Map<string, Entry>([
    [root, { type: 'directory' }]
  ])
  const handles = new Map<string, Entry>()
  let nextHandle = 0
  const lookup = (
    path: string,
    callback: (error?: Error, value?: ReturnType<typeof stats>) => void
  ): void => {
    const entry = entries.get(path)
    if (!entry) {
      callback(missingError())
      return
    }
    callback(undefined, stats(entry))
  }
  const sftp = Object.assign(emitter, {
    mkdir: vi.fn(
      (
        path: string,
        _attributes: unknown,
        callback: (error?: Error) => void
      ) => {
        entries.set(path, { type: 'directory' })
        callback()
      }
    ),
    writeFile: vi.fn(
      (
        path: string,
        contents: Buffer,
        _options: unknown,
        callback: (error?: Error) => void
      ) => {
        entries.set(path, {
          type: 'file',
          contents: Buffer.from(contents)
        })
        callback()
      }
    ),
    chmod: vi.fn(
      (
        _path: string,
        _mode: number,
        callback: (error?: Error) => void
      ) => callback()
    ),
    rename: vi.fn(
      (
        source: string,
        destination: string,
        callback: (error?: Error) => void
      ) => {
        const entry = entries.get(source)
        if (!entry) {
          callback(missingError())
          return
        }
        entries.delete(source)
        entries.set(destination, entry)
        callback()
      }
    ),
    ext_openssh_rename: vi.fn(
      (
        source: string,
        destination: string,
        callback: (error?: Error) => void
      ) => {
        const entry = entries.get(source)
        if (!entry) {
          callback(missingError())
          return
        }
        entries.delete(source)
        entries.set(destination, entry)
        callback()
      }
    ),
    ext_openssh_hardlink: vi.fn(
      (
        source: string,
        destination: string,
        callback: (error?: Error) => void
      ) => {
        const entry = entries.get(source)
        if (!entry) {
          callback(missingError())
          return
        }
        if (entries.has(destination)) {
          callback(new Error('destination exists'))
          return
        }
        entries.set(destination, entry)
        callback()
      }
    ),
    unlink: vi.fn(
      (path: string, callback: (error?: Error) => void) => {
        entries.delete(path)
        callback()
      }
    ),
    rmdir: vi.fn(
      (path: string, callback: (error?: Error) => void) => {
        entries.delete(path)
        callback()
      }
    ),
    lstat: vi.fn(lookup),
    stat: vi.fn(lookup),
    open: vi.fn(
      (
        path: string,
        mode: string,
        attributesOrCallback:
          | { mode: number }
          | ((error?: Error, handle?: Buffer) => void),
        possibleCallback?: (
          error?: Error,
          handle?: Buffer
        ) => void
      ) => {
        const callback =
          typeof attributesOrCallback === 'function'
            ? attributesOrCallback
            : possibleCallback!
        let entry = entries.get(path)
        if (mode === 'wx') {
          if (entry) {
            callback(new Error('destination exists'))
            return
          }
          entry = { type: 'file', contents: Buffer.alloc(0) }
          entries.set(path, entry)
        } else if (!entry) {
          callback(missingError())
          return
        }
        const handle = Buffer.from(`handle-${nextHandle++}`)
        handles.set(handle.toString(), entry)
        callback(undefined, handle)
      }
    ),
    write: vi.fn(
      (
        handle: Buffer,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
        callback: (
          error: Error | undefined,
          bytesWritten: number
        ) => void
      ) => {
        const entry = handles.get(handle.toString())
        if (!entry) {
          callback(missingError(), 0)
          return
        }
        const requiredSize = position + length
        if (
          !entry.contents ||
          entry.contents.byteLength < requiredSize
        ) {
          const grown = Buffer.alloc(requiredSize)
          entry.contents?.copy(grown)
          entry.contents = grown
        }
        buffer.copy(
          entry.contents,
          position,
          offset,
          offset + length
        )
        callback(undefined, length)
      }
    ),
    fstat: vi.fn(
      (
        handle: Buffer,
        callback: (
          error?: Error,
          value?: ReturnType<typeof stats>
        ) => void
      ) => {
        const entry = handles.get(handle.toString())
        if (!entry) {
          callback(missingError())
          return
        }
        callback(undefined, stats(entry))
      }
    ),
    read: vi.fn(
      (
        handle: Buffer,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
        callback: (
          error: Error | undefined,
          bytesRead: number
        ) => void
      ) => {
        const contents =
          handles.get(handle.toString())?.contents ?? Buffer.alloc(0)
        const bytesRead = Math.min(
          length,
          Math.max(0, contents.byteLength - position)
        )
        contents.copy(
          buffer,
          offset,
          position,
          position + bytesRead
        )
        callback(undefined, bytesRead)
      }
    ),
    close: vi.fn(
      (handle: Buffer, callback: (error?: Error) => void) => {
        handles.delete(handle.toString())
        callback()
      }
    ),
    end: vi.fn()
  })
  return { sftp, entries }
}

describe('bounded staged SFTP', () => {
  it('streams local files in bounded chunks and verifies both identities', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-sftp-upload-')
    )
    try {
      const sourcePath = join(directory, 'package.gbagent')
      const contents = Buffer.alloc(3 * 64 * 1024 + 17, 0x5a)
      await writeFile(sourcePath, contents)
      const { sftp, entries } = createSftp()
      const staged = new BoundedStagedSftp(
        sftp as never,
        '/safe/staging',
        {
          maximumFileBytes: contents.byteLength,
          maximumTotalBytes: contents.byteLength
        }
      )

      await staged.uploadFile('package.gbagent', sourcePath, {
        size: contents.byteLength,
        sha256: createHash('sha256')
          .update(contents)
          .digest('hex')
      })

      expect(
        entries.get('/safe/staging/package.gbagent')?.contents
      ).toEqual(contents)
      expect(sftp.write).toHaveBeenCalledTimes(4)
      expect(
        Math.max(
          ...sftp.write.mock.calls.map(
            ([, , , length]) => length
          )
        )
      ).toBe(64 * 1024)
      expect(
        sftp.write.mock.calls.every(
          ([, buffer]) => buffer.byteLength <= 64 * 1024
        )
      ).toBe(true)
      expect(sftp.open).toHaveBeenCalledWith(
        '/safe/staging/package.gbagent',
        'wx',
        { mode: 0o600 },
        expect.any(Function)
      )
      expect(sftp.fstat).toHaveBeenCalledTimes(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects local upload size and hash mismatches', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-sftp-upload-')
    )
    try {
      const sourcePath = join(directory, 'package.gbagent')
      const contents = Buffer.alloc(64 * 1024 + 1, 0x41)
      await writeFile(sourcePath, contents)

      const sizeHarness = createSftp()
      const sizeSftp = new BoundedStagedSftp(
        sizeHarness.sftp as never,
        '/safe/staging',
        {
          maximumFileBytes: contents.byteLength,
          maximumTotalBytes: contents.byteLength
        }
      )
      await expect(
        sizeSftp.uploadFile('size', sourcePath, {
          size: contents.byteLength - 1,
          sha256: createHash('sha256')
            .update(contents)
            .digest('hex')
        })
      ).rejects.toThrow('预期的普通文件')
      expect(sizeHarness.sftp.open).not.toHaveBeenCalled()

      const hashHarness = createSftp()
      const hashSftp = new BoundedStagedSftp(
        hashHarness.sftp as never,
        '/safe/staging',
        {
          maximumFileBytes: contents.byteLength,
          maximumTotalBytes: contents.byteLength
        }
      )
      await expect(
        hashSftp.uploadFile('hash', sourcePath, {
          size: contents.byteLength,
          sha256: '0'.repeat(64)
        })
      ).rejects.toThrow('SHA-256 校验失败')
      expect(hashHarness.sftp.close).toHaveBeenCalledOnce()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('cancels a streaming upload and rejects unsafe boundaries', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-sftp-upload-')
    )
    try {
      const sourcePath = join(directory, 'package.gbagent')
      const contents = Buffer.alloc(2 * 64 * 1024, 0x42)
      await writeFile(sourcePath, contents)
      const hash = createHash('sha256').update(contents).digest('hex')

      const cancellationHarness = createSftp()
      cancellationHarness.sftp.write.mockImplementation(
        () => undefined
      )
      const cancellable = new BoundedStagedSftp(
        cancellationHarness.sftp as never,
        '/safe/staging',
        {
          maximumFileBytes: contents.byteLength,
          maximumTotalBytes: contents.byteLength
        }
      )
      const controller = new AbortController()
      const upload = cancellable.uploadFile(
        'package.gbagent',
        sourcePath,
        { size: contents.byteLength, sha256: hash },
        controller.signal
      )
      await vi.waitFor(() =>
        expect(
          cancellationHarness.sftp.write
        ).toHaveBeenCalledOnce()
      )
      controller.abort()
      await expect(upload).rejects.toMatchObject({
        name: 'AbortError'
      })
      expect(
        cancellationHarness.sftp.end
      ).toHaveBeenCalledOnce()

      const boundaryHarness = createSftp()
      const bounded = new BoundedStagedSftp(
        boundaryHarness.sftp as never,
        '/safe/staging',
        {
          maximumFileBytes: contents.byteLength - 1,
          maximumTotalBytes: contents.byteLength
        }
      )
      await expect(
        bounded.uploadFile('too-large', sourcePath, {
          size: contents.byteLength,
          sha256: hash
        })
      ).rejects.toThrow('大小超过安全限制')
      boundaryHarness.entries.set('/safe/staging/link', {
        type: 'symbolic-link'
      })
      const ancestors = new BoundedStagedSftp(
        boundaryHarness.sftp as never,
        '/safe/staging',
        {
          maximumFileBytes: contents.byteLength,
          maximumTotalBytes: contents.byteLength
        }
      )
      await expect(
        ancestors.uploadFile('link/package', sourcePath, {
          size: contents.byteLength,
          sha256: hash
        })
      ).rejects.toThrow('符号链接')
      expect(boundaryHarness.sftp.open).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps writes inside staging and supports bounded metadata and reads', async () => {
    const { sftp } = createSftp(
      '/home/builder/.goodbuddy/staging/random'
    )
    const staged = new BoundedStagedSftp(
      sftp as never,
      '/home/builder/.goodbuddy/staging/random'
    )

    await staged.mkdir('bin')
    await staged.writeFile(
      'bin/goodbuddy-agent',
      Buffer.from('agent')
    )
    await expect(
      staged.readFile('bin/goodbuddy-agent')
    ).resolves.toEqual(Buffer.from('agent'))
    await expect(
      staged.lstat('bin/goodbuddy-agent')
    ).resolves.toMatchObject({
      type: 'file',
      size: 5,
      mode: 0o600
    })
    await expect(
      staged.stat('bin/goodbuddy-agent')
    ).resolves.toMatchObject({ type: 'file', size: 5 })
    await staged.setExecutable('bin/goodbuddy-agent')
    await staged.rename(
      'bin/goodbuddy-agent',
      'bin/agent-ready'
    )

    expect(sftp.mkdir).toHaveBeenCalledWith(
      '/home/builder/.goodbuddy/staging/random/bin',
      { mode: 0o700 },
      expect.any(Function)
    )
    expect(sftp.writeFile).toHaveBeenCalledWith(
      '/home/builder/.goodbuddy/staging/random/bin/goodbuddy-agent',
      Buffer.from('agent'),
      { mode: 0o600, flag: 'wx' },
      expect.any(Function)
    )
    expect(sftp.chmod).toHaveBeenCalledWith(
      '/home/builder/.goodbuddy/staging/random/bin/goodbuddy-agent',
      0o700,
      expect.any(Function)
    )
  })

  it('pipelines bounded reads for large files', async () => {
    const { sftp, entries } = createSftp()
    const contents = Buffer.alloc(4 * 64 * 1024, 0x5a)
    entries.set('/safe/staging/large', {
      type: 'file',
      contents
    })
    const pending: Array<{
      buffer: Buffer
      offset: number
      length: number
      position: number
      callback: (
        error: Error | undefined,
        bytesRead: number
      ) => void
    }> = []
    sftp.read.mockImplementation(
      (
        _handle,
        buffer,
        offset,
        length,
        position,
        callback
      ) => {
        pending.push({
          buffer,
          offset,
          length,
          position,
          callback
        })
      }
    )
    const staged = new BoundedStagedSftp(
      sftp as never,
      '/safe/staging',
      {
        maximumFileBytes: contents.byteLength,
        maximumTotalBytes: contents.byteLength
      }
    )

    const read = staged.readFile('large')
    await vi.waitFor(() => expect(pending).toHaveLength(4))
    for (const request of pending.splice(0)) {
      contents.copy(
        request.buffer,
        request.offset,
        request.position,
        request.position + request.length
      )
      request.callback(undefined, request.length)
    }
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!.callback(undefined, 0)

    await expect(read).resolves.toEqual(contents)
  })

  it('allows only exact safe modes and removes only real directories', async () => {
    const { sftp } = createSftp()
    const staged = new BoundedStagedSftp(
      sftp as never,
      '/safe/staging'
    )
    await staged.mkdir('empty')
    await staged.chmod('empty', 0o755)
    await staged.writeFile('public-file', Buffer.from('ok'))
    await staged.chmod('public-file', 0o644)

    await expect(
      staged.chmod('public-file', 0o666 as never)
    ).rejects.toThrow('允许列表')
    await expect(
      staged.chmod('empty', 0o600)
    ).rejects.toThrow('目录权限')
    await staged.rmdir('empty')

    expect(sftp.chmod).toHaveBeenCalledWith(
      '/safe/staging/empty',
      0o755,
      expect.any(Function)
    )
    expect(sftp.rmdir).toHaveBeenCalledWith(
      '/safe/staging/empty',
      expect.any(Function)
    )
  })

  it('atomically replaces only a regular managed file', async () => {
    const { sftp, entries } = createSftp()
    entries.set('/safe/staging/current', {
      type: 'file',
      contents: Buffer.from('old')
    })
    const staged = new BoundedStagedSftp(
      sftp as never,
      '/safe/staging'
    )
    await staged.writeFile('replacement', Buffer.from('new'))
    await staged.replaceFile('replacement', 'current')

    expect(entries.get('/safe/staging/current')?.contents).toEqual(
      Buffer.from('new')
    )
    expect(sftp.ext_openssh_rename).toHaveBeenCalledWith(
      '/safe/staging/replacement',
      '/safe/staging/current',
      expect.any(Function)
    )
    expect(sftp.rename).not.toHaveBeenCalled()

    entries.set('/safe/staging/link', {
      type: 'symbolic-link'
    })
    await staged.writeFile('other', Buffer.from('other'))
    await expect(
      staged.replaceFile('other', 'link')
    ).rejects.toThrow('符号链接')
  })

  it('hard-links only regular files to absent managed destinations', async () => {
    const { sftp, entries } = createSftp()
    entries.set('/safe/staging/current', {
      type: 'directory'
    })
    entries.set('/safe/staging/current/node', {
      type: 'file',
      contents: Buffer.from('node')
    })
    entries.set('/safe/staging/current/link', {
      type: 'symbolic-link'
    })
    entries.set('/safe/staging/linked-source', {
      type: 'symbolic-link'
    })
    entries.set('/safe/staging/linked-source/node', {
      type: 'file',
      contents: Buffer.from('escaped')
    })
    entries.set('/safe/staging/candidate', {
      type: 'directory'
    })
    entries.set('/safe/staging/linked-destination', {
      type: 'symbolic-link'
    })
    const staged = new BoundedStagedSftp(
      sftp as never,
      '/safe/staging',
      {
        maximumFileBytes: 1,
        maximumTotalBytes: 1,
        maximumOperations: 6
      }
    )

    await staged.hardLink(
      'current/node',
      'candidate/node'
    )

    expect(entries.get('/safe/staging/candidate/node')).toBe(
      entries.get('/safe/staging/current/node')
    )
    expect(sftp.ext_openssh_hardlink).toHaveBeenCalledWith(
      '/safe/staging/current/node',
      '/safe/staging/candidate/node',
      expect.any(Function)
    )
    await expect(
      staged.hardLink('current/link', 'candidate/other')
    ).rejects.toThrow('符号链接')
    await expect(
      staged.hardLink(
        'linked-source/node',
        'candidate/escaped-source'
      )
    ).rejects.toThrow('符号链接')
    await expect(
      staged.hardLink(
        'current/node',
        'linked-destination/escaped-destination'
      )
    ).rejects.toThrow('符号链接')
    await expect(
      staged.hardLink('current/node', 'candidate/node')
    ).rejects.toThrow('目标已存在')
    await expect(
      staged.hardLink('../current/node', 'candidate/escape')
    ).rejects.toThrow('相对路径无效')
    expect(sftp.ext_openssh_hardlink).toHaveBeenCalledOnce()
  })

  it('propagates hard-link extension errors without transferring bytes', async () => {
    const { sftp, entries } = createSftp()
    entries.set('/safe/staging/current', {
      type: 'file',
      contents: Buffer.alloc(8)
    })
    sftp.ext_openssh_hardlink.mockImplementation(
      (
        _source,
        _destination,
        callback
      ) => callback(new Error('unsupported extension'))
    )
    const staged = new BoundedStagedSftp(
      sftp as never,
      '/safe/staging',
      {
        maximumFileBytes: 1,
        maximumTotalBytes: 1,
        maximumOperations: 2
      }
    )

    await expect(
      staged.hardLink('current', 'candidate')
    ).rejects.toThrow('unsupported extension')
    await expect(staged.mkdir('still-available')).resolves
      .toBeUndefined()
    await expect(staged.mkdir('operation-limit')).rejects.toThrow(
      '操作数量'
    )
    expect(sftp.writeFile).not.toHaveBeenCalled()
    expect(sftp.open).not.toHaveBeenCalled()
  })

  it('fails closed for symlinks and unsupported remote types', async () => {
    const { sftp, entries } = createSftp()
    entries.set('/safe/staging/link', {
      type: 'symbolic-link'
    })
    entries.set('/safe/staging/link/agent', {
      type: 'file',
      contents: Buffer.from('escaped')
    })
    const staged = new BoundedStagedSftp(
      sftp as never,
      '/safe/staging'
    )

    await expect(staged.stat('link')).rejects.toThrow(
      '符号链接'
    )
    await expect(staged.lstat('link')).resolves.toMatchObject({
      type: 'symbolic-link'
    })
    await expect(staged.readFile('link')).rejects.toThrow(
      '符号链接'
    )
    await expect(staged.unlink('link')).rejects.toThrow(
      '符号链接'
    )
    await expect(staged.readFile('link/agent')).rejects.toThrow(
      '符号链接'
    )
    expect(sftp.open).not.toHaveBeenCalled()
    expect(sftp.unlink).not.toHaveBeenCalled()
  })

  it('rejects reads that exceed metadata or grow during transfer', async () => {
    const { sftp, entries } = createSftp()
    entries.set('/safe/staging/large', {
      type: 'file',
      contents: Buffer.alloc(5)
    })
    entries.set('/safe/staging/growing', {
      type: 'file',
      contents: Buffer.alloc(5),
      reportedSize: 4
    })
    const staged = new BoundedStagedSftp(
      sftp as never,
      '/safe/staging',
      {
        maximumFileBytes: 4,
        maximumTotalBytes: 8
      }
    )

    await expect(staged.readFile('large')).rejects.toThrow(
      '读取大小'
    )
    await expect(staged.readFile('growing')).rejects.toThrow(
      '读取大小'
    )
    expect(sftp.close).toHaveBeenCalledOnce()
  })

  it('rejects traversal, absolute relative paths, and unsafe staging roots', async () => {
    const { sftp } = createSftp()
    expect(
      () =>
        new BoundedStagedSftp(
          sftp as never,
          'relative/staging'
        )
    ).toThrow('暂存目录无效')
    const staged = new BoundedStagedSftp(
      sftp as never,
      '/safe/staging'
    )

    await expect(staged.mkdir('../escape')).rejects.toThrow(
      '相对路径无效'
    )
    await expect(
      staged.writeFile('/escape', Buffer.alloc(1))
    ).rejects.toThrow('相对路径无效')
    expect(sftp.mkdir).not.toHaveBeenCalled()
    expect(sftp.writeFile).not.toHaveBeenCalled()
  })

  it('bounds total bytes, operation count, timeout, and cancellation', async () => {
    const firstHarness = createSftp()
    const staged = new BoundedStagedSftp(
      firstHarness.sftp as never,
      '/safe/staging',
      {
        maximumFileBytes: 4,
        maximumTotalBytes: 5,
        maximumOperations: 2
      }
    )

    await staged.writeFile('first', Buffer.alloc(3))
    await expect(
      staged.writeFile('total', Buffer.alloc(3))
    ).rejects.toThrow('传输总量')
    await expect(staged.mkdir('third')).rejects.toThrow(
      '操作数量'
    )

    const pendingHarness = createSftp()
    pendingHarness.sftp.writeFile.mockImplementation(
      () => undefined
    )
    const cancellable = new BoundedStagedSftp(
      pendingHarness.sftp as never,
      '/safe/staging'
    )
    const controller = new AbortController()
    const write = cancellable.writeFile(
      'agent',
      Buffer.alloc(1),
      controller.signal
    )
    await vi.waitFor(() =>
      expect(
        pendingHarness.sftp.writeFile
      ).toHaveBeenCalledOnce()
    )
    controller.abort()

    await expect(write).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(pendingHarness.sftp.end).toHaveBeenCalledOnce()

    vi.useFakeTimers()
    try {
      const timeoutHarness = createSftp()
      timeoutHarness.sftp.writeFile.mockImplementation(
        () => undefined
      )
      const timed = new BoundedStagedSftp(
        timeoutHarness.sftp as never,
        '/safe/staging',
        { operationTimeoutMs: 1 }
      )
      const timedWrite = timed.writeFile(
        'agent',
        Buffer.alloc(1)
      )
      const timedRejection = expect(timedWrite).rejects.toThrow(
        '操作超时'
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(
        timeoutHarness.sftp.writeFile
      ).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      await timedRejection
      expect(timeoutHarness.sftp.end).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('scales large transfer timeouts by the bounded file size', async () => {
    vi.useFakeTimers()
    try {
      const writeHarness = createSftp()
      writeHarness.sftp.writeFile.mockImplementation(
        () => undefined
      )
      const writeSftp = new BoundedStagedSftp(
        writeHarness.sftp as never,
        '/safe/staging',
        {
          maximumFileBytes: 64 * 1024,
          operationTimeoutMs: 1
        }
      )
      const write = writeSftp.writeFile(
        'large',
        Buffer.alloc(64 * 1024)
      )
      const writeRejection = expect(write).rejects.toThrow(
        '操作超时'
      )
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(999)
      expect(writeHarness.sftp.end).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await writeRejection
      expect(writeHarness.sftp.end).toHaveBeenCalledOnce()

      const readHarness = createSftp()
      readHarness.entries.set('/safe/staging/large', {
        type: 'file',
        contents: Buffer.alloc(64 * 1024)
      })
      readHarness.sftp.read.mockImplementation(
        () => undefined
      )
      const readSftp = new BoundedStagedSftp(
        readHarness.sftp as never,
        '/safe/staging',
        {
          maximumFileBytes: 64 * 1024,
          maximumTotalBytes: 64 * 1024,
          operationTimeoutMs: 1
        }
      )
      const read = readSftp.readFile('large')
      const readRejection = expect(read).rejects.toThrow(
        '操作超时'
      )
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(999)
      expect(readHarness.sftp.end).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await readRejection
      expect(readHarness.sftp.end).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts operation deadlines only after queued work reaches the head', async () => {
    vi.useFakeTimers()
    try {
      const { sftp } = createSftp()
      let finishWrite: ((error?: Error) => void) | undefined
      sftp.writeFile.mockImplementation(
        (
          _path: string,
          _contents: Buffer,
          _options: unknown,
          callback: (error?: Error) => void
        ) => {
          finishWrite = callback
        }
      )
      sftp.mkdir.mockImplementation(() => undefined)
      const staged = new BoundedStagedSftp(
        sftp as never,
        '/safe/staging',
        { operationTimeoutMs: 10 }
      )

      const first = staged.writeFile('first', Buffer.alloc(1))
      const second = staged.mkdir('second')
      const secondRejection = expect(second).rejects.toThrow(
        '操作超时'
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(sftp.writeFile).toHaveBeenCalledOnce()
      expect(sftp.mkdir).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(9)
      finishWrite?.()
      await expect(first).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(0)
      expect(sftp.mkdir).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(1)
      expect(sftp.end).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(9)
      await secondRejection
      expect(sftp.end).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels queued work promptly without waiting for the active operation', async () => {
    vi.useFakeTimers()
    try {
      const { sftp } = createSftp()
      sftp.writeFile.mockImplementation(() => undefined)
      const staged = new BoundedStagedSftp(
        sftp as never,
        '/safe/staging',
        { operationTimeoutMs: 10 }
      )
      const active = staged.writeFile('active', Buffer.alloc(1))
      const activeRejection = expect(active).rejects.toThrow(
        '操作超时'
      )
      const controller = new AbortController()
      const queued = staged.mkdir('queued', controller.signal)
      await vi.advanceTimersByTimeAsync(0)

      controller.abort()

      await expect(queued).rejects.toMatchObject({
        name: 'AbortError'
      })
      expect(sftp.end).toHaveBeenCalledOnce()
      expect(sftp.mkdir).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10)
      await activeRejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the opened file size instead of the configured read maximum', async () => {
    vi.useFakeTimers()
    try {
      const { sftp, entries } = createSftp()
      entries.set('/safe/staging/small', {
        type: 'file',
        contents: Buffer.alloc(64 * 1024)
      })
      sftp.read.mockImplementation(() => undefined)
      const staged = new BoundedStagedSftp(
        sftp as never,
        '/safe/staging',
        {
          maximumFileBytes: 128 * 1024 * 1024,
          operationTimeoutMs: 1
        }
      )

      const read = staged.readFile('small')
      const rejection = expect(read).rejects.toThrow(
        '操作超时'
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(sftp.read).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(999)
      expect(sftp.end).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await rejection
      expect(sftp.end).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps stalled read metadata checks on the fixed operation timeout', async () => {
    vi.useFakeTimers()
    try {
      const { sftp } = createSftp()
      sftp.lstat.mockImplementation(() => undefined)
      const staged = new BoundedStagedSftp(
        sftp as never,
        '/safe/staging',
        {
          maximumFileBytes: 128 * 1024 * 1024,
          operationTimeoutMs: 1
        }
      )

      const read = staged.readFile('small')
      const rejection = expect(read).rejects.toThrow(
        '操作超时'
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(sftp.lstat).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      await rejection
      expect(sftp.end).toHaveBeenCalledOnce()
      expect(sftp.open).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps transfer deadlines at the revised 60-minute size boundary', async () => {
    vi.useFakeTimers()
    try {
      const { sftp, entries } = createSftp()
      entries.set('/safe/staging/capped', {
        type: 'file',
        reportedSize: 64 * 1024 * 60 * 60 + 1
      })
      sftp.read.mockImplementation(() => undefined)
      const staged = new BoundedStagedSftp(
        sftp as never,
        '/safe/staging',
        { operationTimeoutMs: 1 }
      )

      const read = staged.readFile('capped')
      const rejection = expect(read).rejects.toThrow(
        '操作超时'
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(sftp.read).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60 * 60_000 - 1)
      expect(sftp.end).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await rejection
      expect(sftp.end).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
