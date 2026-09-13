import { describe, expect, it } from 'vitest'
import { toolOperationSummary } from './tool-operation-summary'

describe('toolOperationSummary', () => {
  it.each(['path', 'filePath', 'file_path', 'filepath', 'dirpath'])(
    'extracts %s without displaying file contents', (key) => {
      expect(toolOperationSummary({ content: 'x'.repeat(10_000), [key]: 'src/main.ts' }))
        .toBe('src/main.ts')
    }
  )
  it.each([
    [{ command: 'npm test\r\n-- --run', path: '/repo' }, 'npm test -- --run'],
    [{ pattern: 'TODO', path: 'src', filePattern: '*.ts' }, 'TODO | src | *.ts'],
    [{ query: 'latest release' }, 'latest release'],
    [{ glob: '**/*.ts' }, '**/*.ts'],
    [{ url: 'https://example.com' }, 'https://example.com']
  ])('extracts command, search and URL parameters', (args, expected) => {
    expect(toolOperationSummary(JSON.stringify(args))).toBe(expected)
  })
  it.each([undefined, null, [], 12, 'broken JSON', '{"path":', '"text"', { content: 'body' }, { path: {}, command: 42 }])(
    'falls back for invalid or irrelevant input %j', (input) => {
      expect(toolOperationSummary(input)).toBeUndefined()
    }
  )
  it('prefers a nonempty native title and bounds a single line to 240 characters', () => {
    expect(toolOperationSummary({ path: 'file' }, 'Read\n native\tfile')).toBe('Read native file')
    expect(toolOperationSummary({ path: 'file' }, ' \n ')).toBe('file')
    expect(toolOperationSummary({ command: 'x'.repeat(500) })).toHaveLength(240)
    expect(toolOperationSummary({}, 'x'.repeat(500))).toHaveLength(240)
  })
  it('can run in the Continue host bundle before input preview truncation', () => {
    const summarize = new Function(`return (${toolOperationSummary.toString()})`)() as typeof toolOperationSummary
    expect(summarize({ content: 'x'.repeat(10_000), filepath: 'report.md' })).toBe('report.md')
  })
})
