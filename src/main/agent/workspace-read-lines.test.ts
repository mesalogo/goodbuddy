import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalWorkspaceAccess } from '../workspace'
import { readWorkspaceLines } from './workspace-read-lines'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  )
})

describe('workspace line reader', () => {
  it('reads a selected line page without adding a line after the final newline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-read-lines-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'sample.txt'), 'one\ntwo\nthree\nfour\n', 'utf8')

    const result = await readWorkspaceLines(
      new LocalWorkspaceAccess(root),
      { path: 'sample.txt', offset: 2, limit: 2 },
      new AbortController().signal
    )

    expect(result).toBe('2: two\n3: three\n[lines 2-3; more available]')
    const last = await readWorkspaceLines(
      new LocalWorkspaceAccess(root),
      { path: 'sample.txt', offset: 4, limit: 10 },
      new AbortController().signal
    )
    expect(last).toContain('4: four')
    expect(last).not.toContain('5:')
  })

  it('bounds a line that spans multiple byte pages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-read-lines-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'long.txt'), `${'x'.repeat(300_000)}\nnext`, 'utf8')

    const result = await readWorkspaceLines(
      new LocalWorkspaceAccess(root),
      { path: 'long.txt', offset: 1, limit: 2 },
      new AbortController().signal
    )

    expect(result).toContain('1: ')
    expect(result).toContain('...[line truncated]')
    expect(result).toContain('2: next')
    expect(Buffer.byteLength(result)).toBeLessThan(20_000)

    const rawPage = await readWorkspaceLines(
      new LocalWorkspaceAccess(root),
      { path: 'long.txt', offset: 1, limit: 1, offsetBytes: 0 },
      new AbortController().signal
    )
    expect(rawPage).toContain('continue with offsetBytes=')
  })
})
