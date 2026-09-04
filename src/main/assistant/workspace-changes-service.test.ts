import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceAccess } from '../workspace'
import {
  getWorkspaceChanges,
  listWorkspaceDirectory,
  readWorkspaceFile
} from './workspace-changes-service'

const execute = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('getWorkspaceChanges', () => {
  it('returns tracked and untracked Git workspace changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-changes-'))
    temporaryDirectories.push(directory)
    await execute('git', ['init'], { cwd: directory })
    await writeFile(join(directory, 'tracked.txt'), 'before\n')
    await execute('git', ['add', 'tracked.txt'], { cwd: directory })
    await execute(
      'git',
      [
        '-c',
        'user.name=GoodBuddy Test',
        '-c',
        'user.email=test@goodbuddy.invalid',
        'commit',
        '-m',
        'initial'
      ],
      { cwd: directory }
    )
    await writeFile(join(directory, 'tracked.txt'), 'after\n')
    await writeFile(join(directory, 'new.txt'), 'new\n')

    const changes = await getWorkspaceChanges(directory)

    expect(changes).toMatchObject({
      available: true,
      truncated: false
    })
    expect(changes.status).toContain('M tracked.txt')
    expect(changes.status).toContain('?? new.txt')
    expect(changes.files).toEqual(
      expect.arrayContaining([
        { path: 'tracked.txt', status: ' M' },
        { path: 'new.txt', status: '??' }
      ])
    )
    expect(changes.patch).toContain('-before')
    expect(changes.patch).toContain('+after')
  })

  it('keeps file browsing available without reporting Git errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-changes-'))
    temporaryDirectories.push(directory)

    const changes = await getWorkspaceChanges(directory)

    expect(changes.available).toBe(false)
    expect(changes.files).toEqual([])
    expect(changes.error).toBeUndefined()
  })
})

describe('workspace file browsing', () => {
  it('delegates workspace operations through WorkspaceAccess', async () => {
    const listDirectory = vi.fn(async () => ({
      path: '',
      entries: [
        { name: 'remote.md', path: 'remote.md', type: 'file' as const }
      ],
      truncated: false
    }))
    const stat = vi.fn(async () => ({
      name: 'remote.md',
      path: 'remote.md',
      type: 'file' as const,
      size: 7,
      modifiedAt: '2026-08-21T00:00:00.000Z'
    }))
    const readText = vi.fn(async () => ({
      path: 'remote.md',
      name: 'remote.md',
      content: '# fake\n',
      size: 7,
      offsetBytes: 0,
      bytesRead: 7,
      truncated: false
    }))
    const getChanges = vi.fn(async () => ({
      rootPath: '/remote',
      available: false,
      status: '',
      patch: '',
      files: [],
      truncated: false
    }))
    const workspace = {
      getIdentity: vi.fn(),
      listDirectory,
      stat,
      readText,
      writeTextAtomic: vi.fn(),
      search: vi.fn(),
      getChanges,
      dispose: vi.fn()
    } as unknown as WorkspaceAccess

    await expect(
      listWorkspaceDirectory(workspace, '')
    ).resolves.toMatchObject({
      entries: [{ name: 'remote.md', type: 'file' }]
    })
    await expect(
      readWorkspaceFile(workspace, 'remote.md')
    ).resolves.toMatchObject({
      content: '# fake\n',
      mimeType: 'text/markdown'
    })
    await expect(getWorkspaceChanges(workspace)).resolves.toMatchObject({
      rootPath: '/remote'
    })
    expect(listDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ path: '', maximumEntries: 500 })
    )
    expect(readText).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'remote.md',
        offsetBytes: 0,
        maximumBytes: 256 * 1024,
        allowTruncated: true
      })
    )
  })

  it('lists directories and reads bounded Markdown previews', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-files-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, 'docs'))
    await writeFile(join(directory, 'docs', 'guide.md'), '# 使用说明\n')
    await writeFile(join(directory, 'notes.txt'), 'hello\n')

    const root = await listWorkspaceDirectory(directory, '')
    const docs = await listWorkspaceDirectory(directory, 'docs')
    const preview = await readWorkspaceFile(directory, 'docs/guide.md')

    expect(root.entries).toEqual([
      { name: 'docs', path: 'docs', type: 'directory' },
      { name: 'notes.txt', path: 'notes.txt', type: 'file' }
    ])
    expect(docs.entries).toEqual([
      {
        name: 'guide.md',
        path: 'docs/guide.md',
        type: 'file'
      }
    ])
    expect(preview).toMatchObject({
      path: 'docs/guide.md',
      name: 'guide.md',
      content: '# 使用说明\n',
      mimeType: 'text/markdown'
    })
  })

  it('rejects traversal, unsupported files, and invalid UTF-8', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-files-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'image.bin'), Buffer.from([0, 1, 2]))
    await writeFile(join(directory, 'invalid.txt'), Buffer.from([0xff]))

    await expect(
      readWorkspaceFile(directory, '../outside.txt')
    ).rejects.toThrow('相对路径')
    await expect(
      readWorkspaceFile(directory, 'image.bin')
    ).rejects.toThrow('不支持安全预览')
    await expect(
      readWorkspaceFile(directory, 'invalid.txt')
    ).rejects.toThrow('有效 UTF-8')
  })

  it('reads large UTF-8 files page by page without a total preview limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-files-'))
    temporaryDirectories.push(directory)
    const firstPage = 'a'.repeat(256 * 1024 - 1)
    const content = `${firstPage}你\n第二页`
    await writeFile(join(directory, 'large.txt'), content)

    const first = await readWorkspaceFile(directory, 'large.txt')
    expect(first).toMatchObject({
      content: firstPage,
      offsetBytes: 0,
      nextOffsetBytes: 256 * 1024 - 1,
      truncated: true
    })

    const second = await readWorkspaceFile(
      directory,
      'large.txt',
      first.nextOffsetBytes
    )
    expect(second).toMatchObject({
      content: '你\n第二页',
      offsetBytes: first.nextOffsetBytes,
      truncated: false
    })
    expect(`${first.content}${second.content}`).toBe(content)
  })
})
