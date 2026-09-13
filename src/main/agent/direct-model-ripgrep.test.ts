import { execFile, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalWorkspaceAccess } from '../workspace'
import { searchWorkspaceWithRipgrep, type WorkspaceRipgrepInput } from './direct-model-ripgrep'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const mocked = { ...actual, execFile: vi.fn(actual.execFile) }
  return { ...mocked, default: mocked }
})

const input: WorkspaceRipgrepInput = {
  path: '.', pattern: 'target', glob: [], fixedStrings: false,
  ignoreCase: false, filesOnly: false, maxResults: 100
}
const match = JSON.stringify({
  type: 'match',
  data: {
    path: { text: './valid.txt' }, lines: { text: 'target\n' },
    line_number: 1, submatches: [{ start: 0 }]
  }
}) + '\n'
const accessError = 'blocked: Permission denied (os error 13)'
const directories: string[] = []
const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')

function mockResult(code: number | string, stdout: string, stderr: string) {
  const error = Object.assign(new Error(`process failed: ${code}`), { code })
  vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
    if (file !== rgPath) return actual.execFile(file, args, options, callback)
    const complete = callback as (error: Error, stdout: string, stderr: string) => void
    complete(error, stdout, stderr)
    return {} as ChildProcess
  })
  return error
}

function search(overrides: Partial<WorkspaceRipgrepInput> = {}, signal = new AbortController().signal) {
  return searchWorkspaceWithRipgrep(
    rgPath, { ...input, ...overrides }, new LocalWorkspaceAccess(process.cwd()), signal
  )
}

afterEach(async () => {
  vi.mocked(execFile).mockReset()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('searchWorkspaceWithRipgrep', () => {
  it('preserves formatted matches with bounded traversal diagnostics and an explicit warning', async () => {
    mockResult(2, match, accessError + '\n' + 'x'.repeat(10_000))
    const result = await search()
    expect(vi.mocked(execFile).mock.calls.map((call) => call[0])).toContain(rgPath)
    expect(result).toContain('valid.txt:1:1:target\\n')
    expect(result).toContain('incomplete search coverage')
    expect(result).toContain('missing results do not establish absence')
    expect(result).toContain(accessError)
    expect(result.length).toBeLessThan(2_500)
  })

  it('preserves file listings and existing result truncation', async () => {
    mockResult(2, './valid.txt\0./other.txt\0', accessError)
    const result = await search({ filesOnly: true, maxResults: 1 })
    expect(result).toContain('incomplete search coverage')
    expect(result).toContain('\nvalid.txt\n...[truncated after 1 files]')
    expect(result).not.toContain('other.txt')
  })

  it('qualifies a no-match summary when traversal was incomplete', async () => {
    mockResult(2, JSON.stringify({ type: 'summary', data: {} }) + '\n', accessError)
    const result = await search()
    expect(result).toContain('incomplete search coverage')
    expect(result).toContain('[no matches found in searched files]')
    expect(result).not.toContain('[no matches found]')
  })

  it.each([false, true])('throws detailed errors with no stdout (filesOnly=%s)', async (filesOnly) => {
    mockResult(2, '', accessError)
    await expect(search({ filesOnly })).rejects.toThrow(accessError)
  })

  it('does not turn invalid regex diagnostics into successful partial output', async () => {
    mockResult(2, match, 'regex parse error:\n    [\nerror: unclosed character class')
    await expect(search({ pattern: '[' })).rejects.toThrow('unclosed character class')
  })

  it('keeps launch failures as errors even with stdout', async () => {
    const error = mockResult('ENOENT', match, '')
    await expect(search()).rejects.toMatchObject({ cause: error })
  })

  it('preserves the cancellation reason even when partial stdout is available', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel search')
    controller.abort(reason)
    mockResult(2, match, accessError)
    await expect(search({}, controller.signal)).rejects.toBe(reason)
  })

  it('keeps exit 1 as a normal no-match result', async () => {
    mockResult(1, '', '')
    await expect(search()).resolves.toBe('[no matches found]')
  })

  it('preserves capture-limit truncation', async () => {
    mockResult('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', match, '')
    await expect(search()).resolves.toBe('valid.txt:1:1:target\\n\n...[truncated after 1 matches]')
  })

  it.each([
    { filesOnly: false, pattern: 'target', expected: 'valid.txt:1:1:target\\n' },
    { filesOnly: true, pattern: 'target', expected: '\nvalid.txt' },
    { filesOnly: false, pattern: 'absent', expected: '[no matches found in searched files]' }
  ])('handles real bundled rg with a valid file plus a missing target ($filesOnly, $pattern)', async ({ filesOnly, pattern, expected }) => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-ripgrep-'))
    directories.push(directory)
    await writeFile(join(directory, 'valid.txt'), 'target\n')
    // Add a second target at the process boundary: the public API stats its single target first.
    vi.mocked(execFile).mockImplementation((file, args, options, callback) =>
      actual.execFile(file, file === rgPath ? [...args as string[], 'missing.txt'] : args, options, callback)
    )
    const result = await searchWorkspaceWithRipgrep(
      rgPath, { ...input, path: 'valid.txt', filesOnly, pattern },
      new LocalWorkspaceAccess(directory), new AbortController().signal
    )
    expect(result).toContain(expected)
    expect(result).toContain('incomplete search coverage (ripgrep exit code 2)')
    expect(result).toContain('missing.txt')
  })

  it('rejects an invalid regex using the real bundled rg', async () => {
    await expect(search({ pattern: '[' })).rejects.toThrow(/regex parse error/u)
  })
})
