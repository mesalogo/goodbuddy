import { describe, expect, it } from 'vitest'
import { formatExternalReferences, referencedMessagePresentation, type ExternalDocumentReference } from './external-references'

const references: ExternalDocumentReference[] = [
  { provider: 'local', id: 'local-1', title: '报告.pdf', libraryName: 'AAA', path: 'C:\\资料\\报告.pdf' },
  { provider: 'wecom', id: 'wecom-1', title: '报告', type: 'smartsheet', url: 'https://example.com/doc' },
  { provider: 'feishu', id: 'node-1', title: '方案', kind: 'node' },
  { provider: 'feishu', id: 'doc-1', title: '方案', kind: 'file', type: 'docx' },
  { provider: 'feishu', id: 'sheet-1', title: '表格', kind: 'file', type: 'sheet' }
]

describe('referenced message presentation', () => {
  it('extracts all supported sources without changing the stored prompt', () => {
    const content = `比较这些文档\n\n${formatExternalReferences(references)}`
    const result = referencedMessagePresentation(content)
    expect(result.body).toBe('比较这些文档')
    expect(result.references.map(item => [item.provider, item.title, item.path, item.url])).toEqual(
      references.map(item => [item.provider, item.title, item.path, item.url]))
    expect(formatExternalReferences(result.references)).toBe(formatExternalReferences(references))
    expect(content).toContain('knowledge_read')
  })

  it.each([
    '普通消息提到引用的文档',
    `解释这段提示\n\n${formatExternalReferences(references)}\n这是用户补充的话`,
    `解释这段提示\n\n${formatExternalReferences(references).slice(0, -8)}`,
    `解释这段提示\n\n${formatExternalReferences(references).replace('1. 本地知识库', '9. 本地知识库')}`
  ])('preserves ordinary text, appended user prose and incomplete footers', content => {
    expect(referencedMessagePresentation(content)).toEqual({ body: content, references: [] })
  })
})
