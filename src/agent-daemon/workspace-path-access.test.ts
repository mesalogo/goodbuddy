import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkspacePathAccess,
  WorkspaceServiceError
} from './workspace-path-access'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('WorkspacePathAccess', () => {
  it('lists deterministically and reads bounded UTF-8 with a digest', async () => {
    const root = temporaryDirectory()
    mkdirSync(join(root, 'directory'))
    writeFileSync(join(root, 'z.txt'), 'zero\nneedle here\n')
    writeFileSync(join(root, 'a.txt'), 'alpha')
    const service = accessFor(root)
    const page = await service.list({
      workspaceId: 'workspace-a',
      generation: 1,
      relativePath: '',
      limit: 2
    })

    expect(page.entries.map((entry) => entry.name)).toEqual([
      'directory',
      'a.txt'
    ])
    expect(page.nextCursor).toBe('2')
    const secondPage = await service.list({
      workspaceId: 'workspace-a',
      generation: 1,
      relativePath: '',
      cursor: page.nextCursor,
      limit: 2
    })
    expect(secondPage.entries.map((entry) => entry.name)).toEqual(['z.txt'])

    const read = await service.readText({
      workspaceId: 'workspace-a',
      generation: 1,
      relativePath: 'z.txt',
      offsetBytes: 0,
      maximumBytes: 5
    })
    expect(read).toMatchObject({
      content: 'zero\n',
      bytesRead: 5,
      totalBytes: 17,
      truncated: true
    })
    expect(read.digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    await expect(
      service.readText({
        workspaceId: 'workspace-a',
        generation: 1,
        relativePath: 'z.txt',
        offsetBytes: 0,
        maximumBytes: 5,
        expectedDigest: `sha256:${'0'.repeat(64)}`
      })
    ).rejects.toMatchObject({ code: 'digest-mismatch' })
  })

  it('searches with result cursors and does not follow links', async () => {
    const root = temporaryDirectory()
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'one.txt'), 'needle one\nneedle two')
    const external = temporaryDirectory()
    writeFileSync(join(external, 'secret.txt'), 'needle secret')
    symlinkSync(
      external,
      join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const service = accessFor(root)

    const first = await service.search({
      workspaceId: 'workspace-a',
      generation: 1,
      query: 'needle',
      caseSensitive: true,
      limit: 1
    })
    expect(first.matches).toHaveLength(1)
    expect(first.matches[0]?.relativePath).toBe('nested/one.txt')
    expect(first.nextCursor).toBe('1')
    expect(first.truncated).toBe(true)
    await expect(service.stat('linked/secret.txt')).rejects.toMatchObject({
      code: 'symlink-rejected'
    })
  })

  it('rejects cancellation and stale root replacement', async () => {
    const root = temporaryDirectory()
    writeFileSync(join(root, 'file.txt'), 'value')
    const service = accessFor(root)
    const controller = new AbortController()
    controller.abort()
    await expect(
      service.stat('file.txt', { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'aborted' })
    await expect(
      service.stat('file.txt', { deadlineAt: Date.now() - 1 })
    ).rejects.toMatchObject({ code: 'deadline-exceeded' })

    const moved = `${root}-moved`
    renameSync(root, moved)
    temporaryPaths.push(moved)
    mkdirSync(root)
    await expect(service.stat('file.txt')).rejects.toBeInstanceOf(
      WorkspaceServiceError
    )
    await expect(service.stat('file.txt')).rejects.toMatchObject({
      code: 'stale-workspace'
    })
  })
})

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'goodbuddy-workspace-'))
  temporaryPaths.push(path)
  return path
}

function accessFor(root: string): WorkspacePathAccess {
  const metadata = statSync(root)
  return new WorkspacePathAccess({
    canonicalPath: root,
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    workspaceIdentity: 'workspace-identity-test'
  })
}
