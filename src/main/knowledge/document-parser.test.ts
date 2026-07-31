import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { chunkDocument, parseDocument } from './document-parser'

describe('document parser', () => {
  it('parses text and creates overlapping bounded chunks', async () => {
    const parsed = await parseDocument(
      'notes.md',
      Buffer.from(`# GoodBuddy\n\n${'知识内容。'.repeat(500)}`)
    )
    const chunks = chunkDocument(parsed, 500, 50)

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
})
