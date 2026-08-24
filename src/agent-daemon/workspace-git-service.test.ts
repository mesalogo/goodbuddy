import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseGitConfigListOutput,
  resolveVerifiedGitExecutable,
  WorkspaceGitService
} from './workspace-git-service'
import { WorkspacePathAccess } from './workspace-path-access'

const temporaryPaths: string[] = []
const linuxIt = process.platform === 'linux' ? it : it.skip

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('WorkspaceGitService', () => {
  it('parses Git null-delimited key-newline-value records', () => {
    expect(
      parseGitConfigListOutput(
        Buffer.from(
          'core.bare\nfalse\0user.name\nGoodBuddy Test\0section.empty\n\0'
        )
      )
    ).toEqual([
      ['core.bare', 'false'],
      ['user.name', 'GoodBuddy Test'],
      ['section.empty', '']
    ])
  })

  it('rejects malformed Git null-delimited configuration records', () => {
    expect(() =>
      parseGitConfigListOutput(
        Buffer.from('core.bare\0')
      )
    ).toThrow('Git configuration output is malformed')
  })

  linuxIt('returns bounded read-only status and diff snapshots', async () => {
    const root = temporaryDirectory()
    const executable = await resolveVerifiedGitExecutable()
    git(executable, root, 'init', '--quiet')
    git(executable, root, 'config', 'user.name', 'GoodBuddy Test')
    git(executable, root, 'config', 'user.email', 'test@example.invalid')
    writeFileSync(join(root, 'tracked.txt'), 'before\n')
    git(executable, root, 'add', 'tracked.txt')
    git(executable, root, 'commit', '--quiet', '-m', 'initial')
    writeFileSync(join(root, 'tracked.txt'), 'after\n')
    writeFileSync(join(root, 'untracked.txt'), 'new\n')
    const access = accessFor(root)
    const service = new WorkspaceGitService({ gitExecutable: executable })

    await expect(service.inspect(access)).resolves.toBe('available')
    const status = await service.status(access, {
      workspaceId: 'workspace-a',
      generation: 1,
      includeIgnored: false,
      maximumEntries: 10
    })
    expect(status.repositoryIdentity).toMatch(/^repository-[a-f0-9]{64}$/u)
    expect(status.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'tracked.txt',
          worktree: 'modified'
        }),
        expect.objectContaining({
          relativePath: 'untracked.txt',
          index: 'untracked',
          worktree: 'untracked'
        })
      ])
    )

    const first = await service.diff(access, {
      workspaceId: 'workspace-a',
      generation: 1,
      staged: false,
      maximumBytes: 20
    })
    expect(Buffer.byteLength(first.patch)).toBeLessThanOrEqual(20)
    expect(first.truncated).toBe(true)
    expect(first.nextCursor).toBeDefined()
    const second = await service.diff(access, {
      workspaceId: 'workspace-a',
      generation: 1,
      staged: false,
      cursor: first.nextCursor,
      maximumBytes: 4 * 1024
    })
    expect(`${first.patch}${second.patch}`).toContain('-before')
    expect(`${first.patch}${second.patch}`).toContain('+after')
  })

  linuxIt('rejects includes, worktrees, and object alternates', async () => {
    const executable = await resolveVerifiedGitExecutable()
    const unsafeConfigRoot = temporaryDirectory()
    git(executable, unsafeConfigRoot, 'init', '--quiet')
    appendFileSync(
      join(unsafeConfigRoot, '.git', 'config'),
      '\n[include]\n\tpath = /tmp/not-allowed\n'
    )
    const service = new WorkspaceGitService({ gitExecutable: executable })
    await expect(service.inspect(accessFor(unsafeConfigRoot))).rejects.toMatchObject({
      code: 'git-unsafe'
    })

    const alternateRoot = temporaryDirectory()
    git(executable, alternateRoot, 'init', '--quiet')
    const info = join(alternateRoot, '.git', 'objects', 'info')
    mkdirSync(info, { recursive: true })
    writeFileSync(join(info, 'alternates'), '/tmp/not-allowed\n')
    await expect(service.inspect(accessFor(alternateRoot))).rejects.toMatchObject({
      code: 'git-unsafe'
    })
  })
})

function git(executable: string, cwd: string, ...args: string[]): void {
  execFileSync(executable, args, {
    cwd,
    env: {
      HOME: cwd,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0'
    },
    stdio: 'ignore'
  })
}

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'goodbuddy-git-'))
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
