import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  addContinuePermanentPermission,
  createContinuePermissionRule
} from './continue-permissions'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-permissions-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('Continue permissions', () => {
  it('generates an exact narrow rule for command and file tools', () => {
    expect(
      createContinuePermissionRule('Bash', {
        command: 'git status --short'
      })
    ).toBe('Bash(git status --short)')
    expect(
      createContinuePermissionRule('MultiEdit', {
        file_path: 'D:\\workspace\\report.md'
      })
    ).toBe('MultiEdit(D:\\workspace\\report.md)')
    expect(() =>
      createContinuePermissionRule('Write', {
        filepath: 'D:\\workspace\\report.md'
      })
    ).toThrow('足够窄化')
  })

  it('atomically adds an allow rule and preserves restrictive policies', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = join(directory, 'permissions.yaml')
    await writeFile(
      filePath,
      'exclude:\n  - Bash(rm *)\nask: []\nallow:\n  - Read\n',
      'utf8'
    )

    await addContinuePermanentPermission(
      'Bash(git status --short)',
      filePath
    )

    const value = parse(await readFile(filePath, 'utf8')) as {
      allow: string[]
      ask: string[]
      exclude: string[]
    }
    expect(value.allow).toEqual(['Read', 'Bash(git status --short)'])
    expect(value.ask).toEqual([])
    expect(value.exclude).toEqual(['Bash(rm *)'])
  })

  it('refuses to weaken a higher-priority ask rule', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = join(directory, 'permissions.yaml')
    const contents = 'ask:\n  - Bash(git *)\nallow: []\n'
    await writeFile(filePath, contents, 'utf8')

    await expect(
      addContinuePermanentPermission(
        'Bash(git status --short)',
        filePath
      )
    ).rejects.toThrow('ask 规则优先级')
    await expect(readFile(filePath, 'utf8')).resolves.toBe(contents)
  })

  it('fails closed when an existing policy file is malformed', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = join(directory, 'permissions.yaml')
    await writeFile(filePath, 'allow: not-an-array\n', 'utf8')

    await expect(
      addContinuePermanentPermission('Read', filePath)
    ).rejects.toThrow('无法安全解析')
    await expect(readFile(filePath, 'utf8')).resolves.toBe(
      'allow: not-an-array\n'
    )
  })
})
