import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { getWorkspaceChanges } from './workspace-changes-service'

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
    expect(changes.patch).toContain('-before')
    expect(changes.patch).toContain('+after')
  })

  it('fails safely for a non-Git directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-changes-'))
    temporaryDirectories.push(directory)

    const changes = await getWorkspaceChanges(directory)

    expect(changes.available).toBe(false)
    expect(changes.error).toBeTruthy()
  })
})
