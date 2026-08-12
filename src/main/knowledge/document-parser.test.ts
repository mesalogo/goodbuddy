import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  buildChunkContextPrefix,
  chunkDocumentAdvanced,
  parseDocument
} from './document-parser'

function createPdfFixture(text: string): Buffer {
  const stream = `BT /F1 18 Tf 50 100 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ]
  let content = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content))
    content += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(content)
  content += `xref\n0 ${objects.length + 1}\n`
  content += '0000000000 65535 f \n'
  content += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  content += `startxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(content)
}

describe('document parser', () => {
  it('parses text and creates overlapping bounded chunks', async () => {
    const parsed = await parseDocument(
      'notes.md',
      Buffer.from(`# GoodBuddy\n\n${'知识内容。'.repeat(500)}`)
    )
    const chunks = chunkDocumentAdvanced(parsed, {
      version: 1,
      mode: 'fixed',
      targetCharacters: 500,
      overlapCharacters: 50,
      parentCharacters: 4_800,
      childCharacters: 900,
      contextualIndexingEnabled: false
    })

    expect(parsed.title).toBe('notes')
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.content.length <= 501)).toBe(true)
    expect(chunks[0]?.locator).toBe('全文')
  })

  it('removes scripts when parsing HTML', async () => {
    const parsed = await parseDocument(
      'page.html',
      Buffer.from(
        '<main><h1>安全标题</h1><p>网页正文</p></main><script>恶意脚本</script>'
      )
    )

    expect(parsed.content).toContain('安全标题')
    expect(parsed.content).toContain('网页正文')
    expect(parsed.content).not.toContain('恶意脚本')
  })

  it('extracts text from DOCX, XLSX and PPTX archives', async () => {
    const fixtures = [
      {
        name: 'sample.docx',
        path: 'word/document.xml',
        xml: '<w:document><w:p><w:t>文档正文</w:t></w:p></w:document>'
      },
      {
        name: 'sample.xlsx',
        path: 'xl/sharedStrings.xml',
        xml: '<sst><si><t>表格内容</t></si></sst>'
      },
      {
        name: 'sample.pptx',
        path: 'ppt/slides/slide1.xml',
        xml: '<p:sld><a:p><a:t>幻灯片内容</a:t></a:p></p:sld>'
      }
    ]

    for (const fixture of fixtures) {
      const archive = zipSync({
        [fixture.path]: strToU8(fixture.xml)
      })
      const parsed = await parseDocument(
        fixture.name,
        Buffer.from(archive)
      )
      expect(parsed.content).toContain(
        fixture.name.endsWith('.docx')
          ? '文档正文'
          : fixture.name.endsWith('.xlsx')
            ? '表格内容'
            : '幻灯片内容'
      )
    }
  })

  it('extracts page text and locators from PDF files', async () => {
    const parsed = await parseDocument(
      'sample.pdf',
      createPdfFixture('PDF body text')
    )

    expect(parsed.content).toContain('PDF body text')
    expect(parsed.sections).toEqual([
      {
        locator: '第 1 页',
        content: 'PDF body text',
        pageNumber: 1,
        blockKind: 'text'
      }
    ])
    expect(parsed.pageCount).toBe(1)
  })

  it('rejects unsupported or oversized content', async () => {
    await expect(
      parseDocument('archive.zip', Buffer.from('not supported'))
    ).rejects.toThrow('不支持')
    await expect(
      parseDocument('large.txt', Buffer.alloc(20 * 1024 * 1024 + 1))
    ).rejects.toThrow('20MB')
    const expandedArchive = zipSync({
      'word/document.xml': new Uint8Array(11 * 1024 * 1024)
    })
    await expect(
      parseDocument('expanded.docx', Buffer.from(expandedArchive))
    ).rejects.toThrow('损坏')
  })

  it('preserves headings and creates recall-only children with parent context', () => {
    const chunks = chunkDocumentAdvanced(
      {
        title: 'Guide',
        sourceFormat: '.md',
        content: '# 安装\n' + '安装步骤和配置说明。'.repeat(250),
        sections: [
          {
            locator: '全文',
            content: '# 安装\n' + '安装步骤和配置说明。'.repeat(250)
          }
        ],
        warnings: []
      },
      {
        version: 1,
        mode: 'parent-child',
        targetCharacters: 1_600,
        overlapCharacters: 100,
        parentCharacters: 1_600,
        childCharacters: 400,
        contextualIndexingEnabled: false
      }
    )
    const parents = chunks.filter((chunk) => chunk.role === 'parent')
    const children = chunks.filter((chunk) => chunk.role === 'child')
    expect(parents.length).toBeGreaterThan(0)
    expect(children.length).toBeGreaterThan(parents.length)
    expect(children.every((chunk) => chunk.heading === '安装')).toBe(true)
    expect(
      children.every((chunk) =>
        parents.some((parent) => parent.position === chunk.parentPosition)
      )
    ).toBe(true)
  })

  it('tracks nested Markdown heading paths and resets deeper levels', () => {
    const chunks = chunkDocumentAdvanced(
      {
        title: 'Guide',
        sourceFormat: '.md',
        content: '# A\none\n## B\ntwo\n### C\nthree\n## D\nfour\n# E\nfive',
        sections: [
          {
            locator: '全文',
            content:
              '# A\none\n## B\ntwo\n### C\nthree\n## D\nfour\n# E\nfive'
          }
        ],
        warnings: []
      },
      {
        version: 1,
        mode: 'structure',
        targetCharacters: 500,
        overlapCharacters: 0,
        parentCharacters: 1_000,
        childCharacters: 300,
        contextualIndexingEnabled: false
      }
    )

    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ['A'],
      ['A', 'B'],
      ['A', 'B', 'C'],
      ['A', 'D'],
      ['E']
    ])
    expect(chunks.map((chunk) => chunk.heading)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E'
    ])
    expect(chunks[1]?.content).toBe('## B\ntwo')
  })

  it('propagates page and table metadata without crossing section boundaries', () => {
    const chunks = chunkDocumentAdvanced(
      {
        title: 'Workbook',
        sourceFormat: '.xlsx',
        content: '第一页\n\n表格行',
        sections: [
          {
            locator: '第 1 页',
            content: '第一页',
            pageNumber: 1,
            blockKind: 'text'
          },
          {
            locator: '工作表 1',
            content: '表格行'.repeat(200),
            blockKind: 'table'
          }
        ],
        warnings: []
      },
      {
        version: 1,
        mode: 'parent-child',
        targetCharacters: 300,
        overlapCharacters: 20,
        parentCharacters: 300,
        childCharacters: 100,
        contextualIndexingEnabled: false
      }
    )

    expect(
      chunks
        .filter((chunk) => chunk.locator === '第 1 页')
        .every(
          (chunk) =>
            chunk.pageNumber === 1 && chunk.blockKind === 'text'
        )
    ).toBe(true)
    expect(
      chunks
        .filter((chunk) => chunk.locator === '工作表 1')
        .every(
          (chunk) =>
            chunk.pageNumber === undefined && chunk.blockKind === 'table'
        )
    ).toBe(true)
    expect(
      chunks.every((chunk) =>
        chunk.locator === '第 1 页'
          ? chunk.content.includes('第一页')
          : !chunk.content.includes('第一页')
      )
    ).toBe(true)
  })

  it('builds deterministic bounded context without changing citation content', () => {
    const chunk = {
      position: 0,
      locator: ' 第 2 页 \n 附录 ',
      content: '## API\n原始引用内容',
      headingPath: [' 指南 ', 'API'],
      pageNumber: 2,
      blockKind: 'table' as const
    }
    const originalContent = chunk.content
    const first = buildChunkContextPrefix(' GoodBuddy \n 手册 ', chunk)
    const second = buildChunkContextPrefix(' GoodBuddy \n 手册 ', chunk)

    expect(first).toBe(second)
    expect(first).toBe(
      '[context title="GoodBuddy 手册" heading="指南 > API" page="2" locator="第 2 页 附录" block="table"]\n'
    )
    expect(first.length).toBeLessThanOrEqual(512)
    expect(chunk.content).toBe(originalContent)
    expect(first).not.toContain(originalContent)
  })
})
