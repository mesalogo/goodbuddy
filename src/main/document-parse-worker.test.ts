// @vitest-environment node
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import type { KnowledgeChunkingSettings } from '../shared/knowledge-contracts'
import {
  buildDocumentParseWorker,
  createDocx,
  createLargePdf,
  createPptx,
  createTextPdf,
  createXlsx,
  sentenceGenerator
} from '../../tests/support/document-parse-worker-fixture'
import { createImagePptx } from '../../tests/support/pptx-fixture'
import {
  chunkDocumentOffMain,
  DocumentParseWorkerClient,
  DocumentParseWorkerUnavailableError,
  extractPdfTextPagesOffMain,
  extractPptxPagesOffMain,
  parseDocumentOffMain,
  sha256OffMain
} from './document-parse-client'
import {
  chunkDocumentAdvanced,
  DocumentTextUnavailableError,
  extractPdfTextPages,
  parseDocument
} from './knowledge/document-parser'
import { extractPptxPages } from './knowledge/pptx-parser'

let workerPath: string
let dispose: () => Promise<void>
let client: DocumentParseWorkerClient

beforeAll(async () => {
  ({ workerPath, dispose } = await buildDocumentParseWorker())
  client = new DocumentParseWorkerClient(workerPath)
}, 60_000)
afterAll(async () => {
  client?.close()
  await dispose?.()
})

const sentence = sentenceGenerator(3)
const markdown = [
  '# GoodBuddy',
  '知识内容。'.repeat(400),
  '## 安装',
  ...Array.from({ length: 40 }, (_, index) => `Step ${index}: ${sentence(30)}.`),
  '### 配置\r\n' + sentence(200),
  '# 附录',
  sentence(600)
].join('\n')

/** Fixture corpus: every format the parser accepts, plus edge cases. */
const fixtures: Array<{ name: string; buffer: Buffer }> = [
  { name: 'notes.md', buffer: Buffer.from(markdown) },
  { name: 'plain.txt', buffer: Buffer.from(`  ${sentence(5_000)}  `) },
  { name: 'data.json', buffer: Buffer.from(JSON.stringify({ items: Array.from({ length: 200 }, (_, id) => ({ id, text: sentence(8) })) }, null, 2)) },
  { name: 'page.html', buffer: Buffer.from('<main><h1>安全标题</h1><p>网页正文</p><table><tr><td>a</td><td>b</td></tr></table></main><script>恶意脚本</script><style>x{}</style>') },
  { name: 'large.txt', buffer: Buffer.from('x'.repeat(5_000_100)) },
  { name: 'sample.pdf', buffer: createTextPdf([['PDF body text']]) },
  { name: 'multi.pdf', buffer: createTextPdf([['first line', 'second (line)'], [], ['third page', 'ends.']]) },
  { name: 'big.pdf', buffer: createLargePdf(40, 40) },
  { name: 'sample.docx', buffer: createDocx(['文档正文', '第二段', ''], [[['h1', 'h2'], ['v1', 'v2']]]) },
  { name: 'sample.xlsx', buffer: createXlsx([[['name', 'qty', 'note'], ['apple', '3', 'fresh']], [['b', '7', 'inline']]]) },
  { name: 'shared.xlsx', buffer: Buffer.from(zipSync({ 'xl/sharedStrings.xml': strToU8('<sst><si><t>表格内容</t></si></sst>') })) },
  { name: 'sample.pptx', buffer: createPptx(['幻灯片内容', 'second slide', 'third']) },
  { name: 'image.pptx', buffer: createPptx(['with image', 'two'], true) }
]

const failureFixtures: Array<{ name: string; buffer: Buffer }> = [
  { name: 'archive.zip', buffer: Buffer.from('not supported') },
  { name: 'empty.txt', buffer: Buffer.alloc(0) },
  { name: 'large.txt', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) },
  { name: 'expanded.docx', buffer: Buffer.from(zipSync({ 'word/document.xml': new Uint8Array(11 * 1024 * 1024) })) },
  { name: 'invalid.txt', buffer: Buffer.from([0xc3, 0x28]) },
  { name: 'nulls.txt', buffer: Buffer.from('a\0b\0c\0d') },
  { name: 'blank.md', buffer: Buffer.from('   \n\n ') },
  { name: 'broken.pdf', buffer: Buffer.from('%PDF-1.4 not really') },
  { name: 'empty.pdf', buffer: createTextPdf([[]]) },
  { name: 'corrupt.xlsx', buffer: Buffer.from('PK not a zip') }
]

const chunkingModes: KnowledgeChunkingSettings[] = [
  { version: 1, mode: 'fixed', targetCharacters: 500, overlapCharacters: 50, parentCharacters: 4_800, childCharacters: 900, contextualIndexingEnabled: false },
  { version: 1, mode: 'structure', targetCharacters: 800, overlapCharacters: 80, parentCharacters: 4_800, childCharacters: 900, contextualIndexingEnabled: true },
  { version: 1, mode: 'parent-child', targetCharacters: 1_600, overlapCharacters: 100, parentCharacters: 1_600, childCharacters: 400, contextualIndexingEnabled: false }
]

/** Byte-level comparison: JSON (key order) plus deep equality (undefined fields, typed arrays). */
function expectIdentical(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
  expect(isDeepStrictEqual(normalizeBytes(actual), normalizeBytes(expected))).toBe(true)
}

function normalizeBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') }
  if (Array.isArray(value)) return value.map(normalizeBytes)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeBytes(item)]))
  }
  return value
}

async function settle<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error }
  }
}

function describeError(error: unknown): unknown {
  return error instanceof Error
    ? { constructor: error.constructor, name: error.name, message: error.message,
      own: Object.entries(error).filter(([key]) => key !== 'stack'),
      unavailable: error instanceof DocumentTextUnavailableError,
      cause: describeError(error.cause) }
    : error
}

describe('document parse worker equivalence', () => {
  it('parses every fixture to output identical to the inline parser', async () => {
    for (const fixture of fixtures) {
      const inline = await parseDocument(fixture.name, fixture.buffer)
      const before = Buffer.from(fixture.buffer)
      const offMain = await parseDocumentOffMain(fixture.name, fixture.buffer, undefined, client)
      expectIdentical(offMain, inline)
      // The caller's buffer is not detached or modified by the transfer.
      expect(fixture.buffer.equals(before)).toBe(true)
    }
  }, 60_000)

  it('chunks every fixture identically in all chunking modes', async () => {
    // large.txt (5M chars, no break points) is excluded: splitNatural's backwards
    // boundary scan makes it take minutes on either path.
    for (const fixture of fixtures.filter((item) => item.name !== 'large.txt')) {
      const parsed = await parseDocument(fixture.name, fixture.buffer)
      for (const settings of chunkingModes) {
        const inline = await settle(async () => chunkDocumentAdvanced(parsed, settings))
        const offMain = await settle(() => chunkDocumentOffMain(parsed, settings, client))
        expect(offMain.ok).toBe(inline.ok)
        if (inline.ok && offMain.ok) expectIdentical(offMain.value, inline.value)
        else expect(describeError(offMain.ok ? undefined : offMain.error)).toEqual(describeError(inline.ok ? undefined : inline.error))
      }
    }
  }, 60_000)

  it('extracts PDF pages and PPTX pages identically', async () => {
    // Pre-existing PDF.js behaviour on the inline path: cancelling a text stream
    // at the character limit can leave a stray "Controller is already closed".
    const strayPdfRejection = (reason: unknown): void => {
      if ((reason as { code?: string })?.code !== 'ERR_INVALID_STATE') throw reason
    }
    process.on('unhandledRejection', strayPdfRejection)
    onTestFinished(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      process.removeListener('unhandledRejection', strayPdfRejection)
    })
    for (const fixture of fixtures.filter((item) => item.name.endsWith('.pdf'))) {
      for (const options of [{}, { maximumCharacters: 50 }, { maximumPages: 1 }]) {
        const inline = await settle(() => extractPdfTextPages(fixture.buffer, options))
        const offMain = await settle(() => extractPdfTextPagesOffMain(fixture.buffer, options, client))
        if (inline.ok && offMain.ok) expectIdentical(offMain.value, inline.value)
        else expect(describeError(offMain.ok ? undefined : offMain.error)).toEqual(describeError(inline.ok ? undefined : inline.error))
      }
    }
    for (const buffer of [createPptx(['a', 'b'], true), createImagePptx('native', 3), createPptx(['plain'])]) {
      const inline = extractPptxPages(buffer)
      const offMain = await extractPptxPagesOffMain(buffer, client)
      expectIdentical(offMain, inline)
      for (const page of offMain) {
        for (const image of page.images) expect(image.data).toBeInstanceOf(Uint8Array)
      }
    }
  }, 60_000)

  it('hashes identically', async () => {
    for (const buffer of [Buffer.alloc(0), Buffer.from('abc'), createLargePdf(40, 40), Buffer.alloc(3 * 1024 * 1024, 7)]) {
      expect(await sha256OffMain(buffer, client)).toBe(createHash('sha256').update(buffer).digest('hex'))
    }
  })

  it('maps errors to the same types and messages as the inline parser', async () => {
    for (const fixture of failureFixtures) {
      const inline = await settle(() => parseDocument(fixture.name, fixture.buffer))
      const offMain = await settle(() => parseDocumentOffMain(fixture.name, fixture.buffer, undefined, client))
      expect(inline.ok, fixture.name).toBe(false)
      expect(offMain.ok, fixture.name).toBe(false)
      expect(describeError(offMain.ok ? undefined : offMain.error), fixture.name)
        .toEqual(describeError(inline.ok ? undefined : inline.error))
    }
    const tooManySections = {
      title: 'Too many', sourceFormat: '.txt', content: '', warnings: [],
      sections: Array.from({ length: 10_001 }, (_, index) => ({ locator: `s-${index}`, content: 'content' }))
    }
    const inline = await settle(async () => chunkDocumentAdvanced(tooManySections, chunkingModes[0]!))
    const offMain = await settle(() => chunkDocumentOffMain(tooManySections, chunkingModes[0]!, client))
    expect(describeError(offMain.ok ? undefined : offMain.error)).toEqual(describeError(inline.ok ? undefined : inline.error))
    const range = await settle(() => extractPdfTextPagesOffMain(createTextPdf([['x']]), { maximumPages: 0 }, client))
    expect(range.ok ? undefined : range.error).toBeInstanceOf(RangeError)
  })
})

describe('document parse worker lifecycle', () => {
  it('cancels a running parse by terminating the worker and keeps serving later tasks', async () => {
    const local = new DocumentParseWorkerClient(workerPath)
    try {
      const big = createLargePdf(400, 50)
      const controller = new AbortController()
      const reason = new Error('文档解析已取消')
      const running = parseDocumentOffMain('big.pdf', big, controller.signal, local)
      const queued = parseDocumentOffMain('notes.md', Buffer.from(markdown), undefined, local)
      const queuedCancelled = new AbortController()
      const queuedAbort = expect(parseDocumentOffMain('plain.txt', Buffer.from('x'), queuedCancelled.signal, local)).rejects.toBe(reason)
      queuedCancelled.abort(reason)
      await new Promise((resolve) => setTimeout(resolve, 30))
      controller.abort(reason)
      await expect(running).rejects.toBe(reason)
      await queuedAbort
      expectIdentical(await queued, await parseDocument('notes.md', Buffer.from(markdown)))
      expect(local.pendingCount).toBe(0)
    } finally {
      local.close()
    }
  }, 60_000)

  it('rejects with the abort reason when already aborted, without starting the worker', async () => {
    const local = new DocumentParseWorkerClient(workerPath)
    try {
      const controller = new AbortController()
      const reason = new Error('cancelled')
      controller.abort(reason)
      await expect(parseDocumentOffMain('a.txt', Buffer.from('a'), controller.signal, local)).rejects.toBe(reason)
    } finally {
      local.close()
    }
  })

  it('falls back to the inline path when the worker crashes or cannot start', async () => {
    const local = new DocumentParseWorkerClient(workerPath)
    try {
      const running = local.call('parseDocument', ['big.pdf', Uint8Array.from(createLargePdf(200, 50)).buffer])
      await new Promise((resolve) => setTimeout(resolve, 20))
      await local.terminateWorkerForTest()
      await expect(running).rejects.toBeInstanceOf(DocumentParseWorkerUnavailableError)
      expect(local.available).toBe(false)
      // While backing off, calls run inline with identical output.
      const buffer = Buffer.from(markdown)
      expectIdentical(await parseDocumentOffMain('notes.md', buffer, undefined, local), await parseDocument('notes.md', buffer))
      local.resetBackoffForTest()
      expect(local.available).toBe(true)
      expectIdentical(await parseDocumentOffMain('notes.md', buffer, undefined, local), await parseDocument('notes.md', buffer))
    } finally {
      local.close()
    }

    const missing = new DocumentParseWorkerClient(`${workerPath}.missing.cjs`)
    try {
      const buffer = createDocx(['fallback'])
      expectIdentical(await parseDocumentOffMain('a.docx', buffer, undefined, missing), await parseDocument('a.docx', buffer))
      expect(missing.available).toBe(false)
    } finally {
      missing.close()
    }
  }, 60_000)

  it('runs tasks one at a time in FIFO order', async () => {
    const local = new DocumentParseWorkerClient(workerPath)
    try {
      const names = fixtures.slice(0, 6)
      const results = await Promise.all(names.map((fixture) => parseDocumentOffMain(fixture.name, fixture.buffer, undefined, local)))
      for (const [index, fixture] of names.entries()) {
        expectIdentical(results[index], await parseDocument(fixture.name, fixture.buffer))
      }
    } finally {
      local.close()
    }
  }, 60_000)
})
