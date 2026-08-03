import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('fails safely for a non-Git directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-changes-'))
    temporaryDirectories.push(directory)

    const changes = await getWorkspaceChanges(directory)

    expect(changes.available).toBe(false)
    expect(changes.files).toEqual([])
    expect(changes.error).toBeTruthy()
  })
})

describe('workspace file browsing', () => {
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

  it('rejects traversal, unsupported files, invalid UTF-8, and oversized files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-files-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'image.bin'), Buffer.from([0, 1, 2]))
    await writeFile(join(directory, 'invalid.txt'), Buffer.from([0xff]))
    await writeFile(
      join(directory, 'large.txt'),
      Buffer.alloc(256 * 1024 + 1, 97)
    )

    await expect(
      readWorkspaceFile(directory, '../outside.txt')
    ).rejects.toThrow('相对路径')
    await expect(
      readWorkspaceFile(directory, 'image.bin')
    ).rejects.toThrow('不支持安全预览')
    await expect(
      readWorkspaceFile(directory, 'invalid.txt')
    ).rejects.toThrow('有效 UTF-8')
    await expect(
      readWorkspaceFile(directory, 'large.txt')
    ).rejects.toThrow('超过 256KB')
  })
})
