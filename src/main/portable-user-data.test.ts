import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePortableUserDataPath } from './portable-user-data'

const temporaryDirectories: string[] = []

async function createExecutableDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-portable-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
  )
})

describe('resolvePortableUserDataPath', () => {
  it('uses data beside a marked packaged Windows executable', async () => {
    const directory = await createExecutableDirectory()
    await writeFile(
      join(directory, '.goodbuddy-portable.json'),
      JSON.stringify({
        formatVersion: 1,
        productName: 'GoodBuddy',
        version: '0.1.0'
      }),
      'utf8'
    )

    expect(
      resolvePortableUserDataPath({
        packaged: true,
        platform: 'win32',
        executablePath: join(directory, 'GoodBuddy.exe')
      })
    ).toBe(join(directory, 'data'))
  })

  it('keeps installed, development, and unmarked builds on system userData', async () => {
    const directory = await createExecutableDirectory()
    const executablePath = join(directory, 'GoodBuddy.exe')

    expect(
      resolvePortableUserDataPath({
        packaged: true,
        platform: 'win32',
        executablePath
      })
    ).toBeUndefined()
    expect(
      resolvePortableUserDataPath({
        packaged: false,
        platform: 'win32',
        executablePath
      })
    ).toBeUndefined()
    expect(
      resolvePortableUserDataPath({
        packaged: true,
        platform: 'darwin',
        executablePath
      })
    ).toBeUndefined()
  })
})
