import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LocalWorkspaceAccess,
  UnsupportedRemoteWorkspaceAccess
} from './index'
import { buildWorkspaceGitEnvironment } from './local-workspace-access'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'goodbuddy-workspace-access-')
  )
  temporaryDirectories.push(directory)
  return directory
}

async function runGit(
  directory: string,
  ...args: string[]
): Promise<void> {
  await execFileAsync('git', args, {
    cwd: directory,
    windowsHide: true
  })
}

async function createGitWorkspace(): Promise<string> {
  const directory = await createWorkspace()
  await runGit(directory, 'init')
  await runGit(directory, 'config', 'user.name', 'GoodBuddy Test')
  await runGit(
    directory,
    'config',
    'user.email',
    'goodbuddy@example.invalid'
  )
  await writeFile(join(directory, 'tracked.txt'), 'original\n', 'utf8')
  await runGit(directory, 'add', 'tracked.txt')
  await runGit(directory, 'commit', '-m', 'initial')
  return directory
}

async function createMarkerCommand(
  directory: string,
  name: string,
  markerPath: string,
  passthrough: boolean
): Promise<string> {
  if (process.platform === 'win32') {
    const commandPath = join(directory, `${name}.cmd`)
    await writeFile(
      commandPath,
      [
        '@echo off',
        `> "${markerPath}" echo invoked`,
        ...(passthrough ? ['type "%~1"'] : []),
        'exit /b 0',
        ''
      ].join('\r\n'),
      'utf8'
    )
    return commandPath
  }

  const commandPath = join(directory, `${name}.sh`)
  await writeFile(
    commandPath,
    [
      '#!/bin/sh',
      `printf invoked > '${markerPath.replaceAll("'", "'\\''")}'`,
      ...(passthrough ? ['cat "$1"'] : []),
      ''
    ].join('\n'),
    'utf8'
  )
  await chmod(commandPath, 0o700)
  return commandPath
}

function gitCommandValue(commandPath: string): string {
  return `"${commandPath.replaceAll('\\', '/').replaceAll('"', '\\"')}"`
}

describe('LocalWorkspaceAccess', () => {
  it('provides bounded local identity, file, search, and change operations', async () => {
    const directory = await createWorkspace()
    await mkdir(join(directory, 'docs'))
    await writeFile(
      join(directory, 'docs', 'guide.txt'),
      'first\nsearch target\n',
      'utf8'
    )
    const access = new LocalWorkspaceAccess(directory)

    await expect(access.getIdentity()).resolves.toMatchObject({
      kind: 'local',
      canonicalDisplayPath: directory,
      access: 'read-write'
    })
    await expect(
      access.listDirectory({ path: '', maximumEntries: 10 })
    ).resolves.toMatchObject({
      entries: [
        { name: 'docs', path: 'docs', type: 'directory' }
      ],
      truncated: false
    })
    await expect(
      access.stat({ path: 'docs/guide.txt' })
    ).resolves.toMatchObject({
      name: 'guide.txt',
      path: 'docs/guide.txt',
      type: 'file'
    })
    await expect(
      access.readText({
        path: 'docs/guide.txt',
        maximumBytes: 256
      })
    ).resolves.toMatchObject({
      content: 'first\nsearch target\n',
      size: 20
    })
    await expect(
      access.search({
        query: 'target',
        maximumResults: 10
      })
    ).resolves.toEqual({
      matches: [
        {
          path: 'docs/guide.txt',
          line: 2,
          column: 8,
          preview: 'search target'
        }
      ],
      truncated: false
    })
    await expect(
      access.writeTextAtomic({
        path: 'docs/output.txt',
        content: 'saved',
        maximumBytes: 32
      })
    ).resolves.toEqual({
      path: 'docs/output.txt',
      bytesWritten: 5
    })
    await expect(
      readFile(join(directory, 'docs', 'output.txt'), 'utf8')
    ).resolves.toBe('saved')
    await expect(access.getChanges({})).resolves.toMatchObject({
      rootPath: directory,
      available: false,
      files: []
    })
  })

  it('rejects traversal and bounded read and write overflows', async () => {
    const directory = await createWorkspace()
    await writeFile(join(directory, 'file.txt'), '12345', 'utf8')
    const access = new LocalWorkspaceAccess(directory)

    await expect(
      access.readText({ path: '../file.txt' })
    ).rejects.toThrow('不能超出工作区')
    await expect(
      access.readText({ path: 'file.txt', maximumBytes: 4 })
    ).rejects.toThrow('安全限制')
    await expect(
      access.writeTextAtomic({
        path: 'output.txt',
        content: '12345',
        maximumBytes: 4
      })
    ).rejects.toThrow('512KB')
  })

  it('reports ordinary tracked and untracked Git changes', async () => {
    const directory = await createGitWorkspace()
    await writeFile(join(directory, 'tracked.txt'), 'changed\n', 'utf8')
    await writeFile(join(directory, 'untracked.txt'), 'new\n', 'utf8')

    await expect(
      new LocalWorkspaceAccess(directory).getChanges({})
    ).resolves.toMatchObject({
      rootPath: directory,
      available: true,
      files: [
        { path: 'tracked.txt', status: ' M' },
        { path: 'untracked.txt', status: '??' }
      ],
      truncated: false
    })
    const changes = await new LocalWorkspaceAccess(
      directory
    ).getChanges({})
    expect(changes.patch).toContain('-original')
    expect(changes.patch).toContain('+changed')
  })

  it('does not run a repository-configured fsmonitor command', async () => {
    const directory = await createGitWorkspace()
    const markerPath = join(directory, 'fsmonitor-invoked')
    const commandPath = await createMarkerCommand(
      directory,
      'fsmonitor',
      markerPath,
      false
    )
    await runGit(
      directory,
      'config',
      'core.fsmonitor',
      gitCommandValue(commandPath)
    )
    await writeFile(join(directory, 'tracked.txt'), 'changed\n', 'utf8')
    await runGit(directory, 'status', '--porcelain')
    await expect(readFile(markerPath, 'utf8')).resolves.toContain(
      'invoked'
    )
    await rm(markerPath)

    const changes = await new LocalWorkspaceAccess(
      directory
    ).getChanges({})

    expect(changes.available).toBe(true)
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('does not run a repository-configured textconv command', async () => {
    const directory = await createGitWorkspace()
    const markerPath = join(directory, 'textconv-invoked')
    const commandPath = await createMarkerCommand(
      directory,
      'textconv',
      markerPath,
      true
    )
    await writeFile(
      join(directory, '.gitattributes'),
      'tracked.txt diff=marker\n',
      'utf8'
    )
    await runGit(
      directory,
      'config',
      'diff.marker.textconv',
      gitCommandValue(commandPath)
    )
    await runGit(directory, 'add', '.gitattributes')
    await runGit(directory, 'commit', '-m', 'configure attributes')
    await writeFile(join(directory, 'tracked.txt'), 'changed\n', 'utf8')
    await runGit(directory, 'diff', '--textconv', 'HEAD')
    await expect(readFile(markerPath, 'utf8')).resolves.toContain(
      'invoked'
    )
    await rm(markerPath)

    const changes = await new LocalWorkspaceAccess(
      directory
    ).getChanges({})

    expect(changes.available).toBe(true)
    expect(changes.patch).toContain('+changed')
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('neutralizes filter names containing an equals sign', async () => {
    const directory = await createGitWorkspace()
    const markerPath = join(directory, 'filter-invoked')
    const commandPath = await createMarkerCommand(
      directory,
      'filter',
      markerPath,
      true
    )
    await writeFile(
      join(directory, '.gitattributes'),
      'tracked.txt filter=foo=bar\n',
      'utf8'
    )
    await runGit(
      directory,
      'config',
      'filter.foo=bar.clean',
      gitCommandValue(commandPath)
    )
    await runGit(directory, 'add', '.gitattributes')
    await runGit(directory, 'commit', '-m', 'configure filter')
    await rm(markerPath, { force: true })
    await writeFile(join(directory, 'tracked.txt'), 'changed\n', 'utf8')

    const changes = await new LocalWorkspaceAccess(
      directory
    ).getChanges({})

    expect(changes.available).toBe(true)
    expect(changes.patch).toContain('+changed')
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('builds a fresh Git environment without Main-process secrets', () => {
    const environment = buildWorkspaceGitEnvironment({
      PATH: '/safe/bin',
      PATHEXT: '.EXE',
      SystemRoot: 'C:\\Windows',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'provider-secret',
      OPENAI_API_KEY: 'provider-secret',
      GIT_TRACE: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'attacker-command'
    })

    expect(environment).toMatchObject({
      PATH: '/safe/bin',
      PATHEXT: '.EXE',
      SystemRoot: 'C:\\Windows',
      LANG: 'en_US.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never'
    })
    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('GIT_TRACE')
    expect(environment).not.toHaveProperty('GIT_CONFIG_COUNT')
    expect(environment).not.toHaveProperty('GIT_CONFIG_KEY_0')
    expect(environment).not.toHaveProperty('GIT_CONFIG_VALUE_0')
  })
})

describe('UnsupportedRemoteWorkspaceAccess', () => {
  it('fails closed for every operation', async () => {
    const access = new UnsupportedRemoteWorkspaceAccess()
    const operations = [
      access.getIdentity(),
      access.listDirectory({ path: '' }),
      access.stat({ path: 'file.txt' }),
      access.readText({ path: 'file.txt' }),
      access.writeTextAtomic({ path: 'file.txt', content: 'x' }),
      access.search({ query: 'x' }),
      access.getChanges({})
    ]

    for (const operation of operations) {
      await expect(operation).rejects.toThrow('远程工作区访问尚不可用')
    }
    await expect(access.dispose()).resolves.toBeUndefined()
    await expect(access.dispose()).resolves.toBeUndefined()
  })
})
