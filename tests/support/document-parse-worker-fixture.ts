import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { strToU8, zipSync } from 'fflate'

/**
 * Bundles the document parse worker for tests. The bundle lives under
 * node_modules/.cache so the external pdfjs-dist (ESM, loaded lazily by the
 * parser) resolves from the repository's node_modules.
 */
export async function buildDocumentParseWorker(): Promise<{ workerPath: string; dispose: () => Promise<void> }> {
  const directory = resolve('node_modules/.cache', `goodbuddy-document-parse-worker-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  const workerPath = join(directory, 'document-parse-worker.cjs')
  await build({
    entryPoints: [resolve('src/main/document-parse-worker.ts')],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
    external: ['pdfjs-dist', 'electron']
  })
  return {
    workerPath,
    dispose: () => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function escapePdfText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

/** A text-layer PDF with one content stream per page; each page is a list of lines. */
export function createTextPdf(pages: readonly (readonly string[])[]): Buffer {
  const pageCount = pages.length
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  for (const lines of pages) {
    const pageObject = objects.length + 1
    const stream = [
      'BT /F1 10 Tf 12 TL 40 760 Td',
      ...lines.map((line, index) => `${index === 0 ? '' : 'T* '}(${escapePdfText(line)}) Tj`),
      'ET'
    ].join('\n')
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObject + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
    )
  }
  let content = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content, 'latin1'))
    content += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(content, 'latin1')
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  content += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(content, 'latin1')
}

const words = 'lighthouse harbor policy engine renderer stream vector index budget latency schedule archive network storage contract invoice release window memory review'.split(' ')

/** Deterministic pseudo-random sentence generator. */
export function sentenceGenerator(seed = 42): (count: number) => string {
  let state = seed
  const random = (): number => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296)
  return (count) => Array.from({ length: count }, () => words[Math.floor(random() * words.length)]).join(' ')
}

export function createLargePdf(pageCount: number, linesPerPage: number): Buffer {
  const sentence = sentenceGenerator(7)
  return createTextPdf(Array.from({ length: pageCount }, (_, page) =>
    Array.from({ length: linesPerPage }, (_, line) => `Page ${page + 1} line ${line + 1}: ${sentence(10)}.`)))
}

export function createDocx(paragraphs: readonly string[], tables: readonly (readonly (readonly string[])[])[] = []): Buffer {
  const body = [
    ...paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r><w:r><w:tab/><w:t>tab</w:t></w:r></w:p>`),
    ...tables.map((rows) => `<w:tbl>${rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:p><w:t>${cell}</w:t></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`),
    '<w:p><w:t>tail &amp; &lt;end&gt; &#20013;&#x6587;</w:t></w:p>'
  ].join('')
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(`<w:document><w:body>${body}</w:body></w:document>`)
  }))
}

export function createXlsx(sheets: readonly (readonly (readonly string[])[])[]): Buffer {
  const shared: string[] = []
  const files: Record<string, Uint8Array> = {}
  sheets.forEach((rows, sheetIndex) => {
    const xmlRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, cellIndex) => {
      if (/^\d+$/u.test(cell)) return `<c r="${String.fromCharCode(65 + cellIndex)}${rowIndex + 1}"><v>${cell}</v></c>`
      if (cellIndex === 2) return `<c t="inlineStr"><is><t>${cell}</t></is></c>`
      shared.push(cell)
      return `<c t="s"><v>${shared.length - 1}</v></c>`
    }).join('')}</row>`).join('')
    files[`xl/worksheets/sheet${sheetIndex + 1}.xml`] = strToU8(`<worksheet><sheetData>${xmlRows}</sheetData></worksheet>`)
  })
  files['xl/sharedStrings.xml'] = strToU8(`<sst>${shared.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`)
  return Buffer.from(zipSync(files))
}

export function createPptx(slides: readonly string[], withImage = false): Buffer {
  const files: Record<string, Uint8Array> = {}
  if (withImage) {
    files['ppt/media/image1.png'] = new Uint8Array(Array.from({ length: 4096 }, (_, index) => index % 251))
    files['ppt/media/image2.jpg'] = new Uint8Array([255, 216, 255, 224, 1, 2, 3])
  }
  slides.forEach((text, index) => {
    const page = index + 1
    files[`ppt/slides/slide${page}.xml`] = strToU8(
      `<p:sld><a:p><a:t>${text}</a:t></a:p>${withImage ? `<p:pic><a:blip r:embed="rId${(index % 2) + 1}"/></p:pic>` : ''}</p:sld>`
    )
    if (withImage) {
      files[`ppt/slides/_rels/slide${page}.xml.rels`] = strToU8(
        '<Relationships><Relationship Id="rId1" Target="../media/image1.png"/><Relationship Id="rId2" Target="../media/image2.jpg"/></Relationships>'
      )
    }
  })
  return Buffer.from(zipSync(files))
}
