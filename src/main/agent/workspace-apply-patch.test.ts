import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalWorkspaceAccess } from '../workspace'
import { applyWorkspacePatch } from './workspace-apply-patch'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  )
})

async function createWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'goodbuddy-apply-patch-'))
  temporaryDirectories.push(path)
  return path
}

describe('workspace apply patch', () => {
  it('validates and applies add, update, and delete operations', async () => {
    const root = await createWorkspace()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'app.ts'), 'const old = 1\n', 'utf8')
    await writeFile(join(root, 'obsolete.txt'), 'remove me\n', 'utf8')

    const result = await applyWorkspacePatch(
      [
        '*** Begin Patch',
        '*** Update File: src/app.ts',
        '@@',
        '-const old = 1',
        '+const current = 2',
        '*** Add File: nested/new.ts',
        '+export const added = true',
        '*** Delete File: obsolete.txt',
        '*** End Patch'
      ].join('\n'),
      new LocalWorkspaceAccess(root),
      new AbortController().signal
    )

    expect(result).toContain('3 file(s)')
    await expect(readFile(join(root, 'src', 'app.ts'), 'utf8')).resolves.toBe(
      'const current = 2\n'
    )
    await expect(readFile(join(root, 'nested', 'new.ts'), 'utf8')).resolves.toBe(
      'export const added = true'
    )
    await expect(readFile(join(root, 'obsolete.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('does not modify any file when validation fails', async () => {
    const root = await createWorkspace()
    await writeFile(join(root, 'first.txt'), 'original\n', 'utf8')

    await expect(
      applyWorkspacePatch(
        [
          '*** Begin Patch',
          '*** Update File: first.txt',
          '@@',
          '-original',
          '+changed',
          '*** Update File: missing.txt',
          '@@',
          '-missing',
          '+changed',
          '*** End Patch'
        ].join('\n'),
        new LocalWorkspaceAccess(root),
        new AbortController().signal
      )
    ).rejects.toThrow('补丁目标不存在')
    await expect(readFile(join(root, 'first.txt'), 'utf8')).resolves.toBe(
      'original\n'
    )
  })

  it('rejects traversal before creating files', async () => {
    const root = await createWorkspace()
    await expect(
      applyWorkspacePatch(
        '*** Begin Patch\n*** Add File: ../outside.txt\n+blocked\n*** End Patch',
        new LocalWorkspaceAccess(root),
        new AbortController().signal
      )
    ).rejects.toThrow('不能超出工作区')
  })
})
