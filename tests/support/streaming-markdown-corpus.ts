// Frozen pre-optimization implementation: an independent streaming equivalence oracle.
function originalReplace(line: string): string {
  let output = ''
  let index = 0
  let codeDelimiterLength = 0
  while (index < line.length) {
    if (line[index] === '`') {
      let runLength = 1
      while (line[index + runLength] === '`') runLength += 1
      if (codeDelimiterLength === 0 || codeDelimiterLength === runLength) {
        codeDelimiterLength = codeDelimiterLength === 0 ? runLength : 0
      }
      output += line.slice(index, index + runLength)
      index += runLength
      continue
    }
    if (codeDelimiterLength === 0 && line[index] === '\\' &&
      line[index - 1] !== '\\' && (line[index + 1] === '(' || line[index + 1] === ')')) {
      output += '$'
      index += 2
      continue
    }
    output += line[index]
    index += 1
  }
  return output
}

export function originalNormalize(content: string): string {
  let fence: { character: '`' | '~'; length: number } | undefined
  return content.split(/\r?\n/u).map(line => {
    if (fence) {
      const closingFence = new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`, 'u')
      if (closingFence.test(line)) fence = undefined
      return line
    }
    const openingFence = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
    if (openingFence) {
      const marker = openingFence[1]!
      fence = { character: marker[0] as '`' | '~', length: marker.length }
      return line
    }
    const standaloneDollar = /^ {0,3}\$(?!\$)(.+?)(?<!\\)\$\s*$/u.exec(line)
    if (standaloneDollar) return `$$\n${standaloneDollar[1]}\n$$`
    const standaloneParentheses = /^ {0,3}\\\(\s*(.*?)\s*\\\)\s*$/u.exec(line)
    if (standaloneParentheses) return `$$\n${standaloneParentheses[1]}\n$$`
    const singleLineDisplay = /^ {0,3}\\\[\s*(.*?)\s*\\\]\s*$/u.exec(line)
    if (singleLineDisplay) return `$$\n${singleLineDisplay[1]}\n$$`
    if (/^ {0,3}\\\[\s*$/u.test(line)) return '$$'
    if (/^ {0,3}\\\]\s*$/u.test(line)) return '$$'
    return originalReplace(line)
  }).join('\n')
}

export const equivalenceCorpus = [
  '# Heading\n\n**bold** and [link](https://example.com)\n- [x] ready\n',
  'Inline \\(a+b\\), $x$ and \\\\(escaped\\).\n$x^2$\n\\(y\\)\n\\[z\\]\n\\[\na+b\n\\]\n',
  '`\\(code\\)` ``a ` \\(b\\)`` and \\(x\\)\n```tex\n\\(x\\)\n```\n~~~\n$y$\n~~~\n',
  '````tex\n```\n\\[x\\]\n````\n   ~~~txt\n\\(y\\)\n  ~~~~\n\\(z\\)\n',
  'a\r\nb\r\n$x$\r\n```txt\r\n\\(code\\)\r\n```\r\nend\r',
  '```markdown\r\n# Title\r\n\r\n\\(x\\)\r\n```',
  '<html>\r\n<body><p>\\(x\\)</p></body>\r\n</html>',
  '```html\r\n<section><strong>bold</strong></section>\r\n```',
  '<section>**raw**\r\ntext</section>',
  'partial \\(x + \\) then `code \\( and `` and \\[\n\\',
  '\n\nplain\rtext\r\n\n    $indented$\n    \\(indented\\)\n'
]

const prose = '# Streaming answer\n\n' + (
  'A growing paragraph with **emphasis**, `inline code`, and [a link](https://example.com).\n\n' +
  '- First item\n- Second item\n\n> A quoted explanation.\n\n'
).repeat(48)
export const performanceCorpus = [
  { name: 'prose', content: prose },
  { name: 'mixed', content: (prose.slice(0, 1200) + '\n\\(x^2 + y^2\\)\n\n' +
    '```ts\nconst value = "\\(literal\\)"\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n').repeat(5) },
  { name: 'crlf', content: prose.replaceAll('\n', '\r\n') }
]

const longSection = [
  '## Deployment review\n',
  'The service processes incoming records in order and stores the last completed sequence. ' +
    'A restart resumes from that sequence so operators can inspect partial progress without repeating successful work. ' +
    'Keep **validation results** next to the source record and link the [runbook](https://example.com/runbook) in the report.\n',
  'Before deployment, compare the proposed configuration with the active settings. ' +
    'Check the database connection, confirm the worker count, and run a small representative batch. ' +
    'Record the elapsed time and any rejected records before increasing concurrency.\n',
  '- Validate required fields before writing.\n- Commit each completed batch.\n- Review rejected records separately.\n',
  '```ts\nasync function processBatch(records: Record<string, string>[]) {\n' +
    '  for (const record of records) {\n    const label = record.name ?? "unnamed"\n' +
    '    await store.save({ ...record, label })\n  }\n}\n```\n',
  '| Check | Expected result | Follow-up |\n| --- | --- | --- |\n' +
    '| Validation | Required fields present | Review rejected rows |\n' +
    '| Persistence | Completed batches stored | Resume from checkpoint |\n' +
    '| Throughput | Stable processing time | Inspect slow operations |\n',
  '> Keep the original input available until the final reconciliation has completed.\n\n'
].join('\n')
const longBody = longSection.repeat(Math.floor(102_400 / longSection.length))
// ASCII makes character and UTF-8 byte lengths identical: exactly 100 KiB.
export const longAnswerCorpus = longBody + 'Final review notes. '.repeat(100)
  .slice(0, 102_400 - longBody.length)
