import { describe, expect, it } from 'vitest'
import {
  magicNoteChecklistItems,
  magicNoteImageBytes,
  magicNotePlainText,
  setMagicNoteChecklistCompletion,
  validateMagicNoteRichContent
} from './rich-content'

const pngDataUrl = `data:image/png;base64,${Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]).toString('base64')}`

describe('magic note rich content', () => {
  it('accepts bounded text formats and signature-checked local images', () => {
    const content = validateMagicNoteRichContent({
      version: 1,
      ops: [
        { insert: '发布清单', attributes: { header: 2 } },
        { insert: '\n' },
        { insert: { image: pngDataUrl } },
        { insert: '\n' }
      ]
    })

    expect(magicNotePlainText(content)).toBe('发布清单\n[图片]')
    expect(magicNoteImageBytes(content)).toBe(8)
  })

  it('rejects remote images and unsupported rich attributes', () => {
    expect(() =>
      validateMagicNoteRichContent({
        version: 1,
        ops: [{ insert: { image: 'https://example.com/image.png' } }]
      })
    ).toThrow()
    expect(() =>
      validateMagicNoteRichContent({
        version: 1,
        ops: [
          {
            insert: '伪装链接',
            attributes: { link: 'https://example.com' }
          }
        ]
      })
    ).toThrow()
  })

  it('rejects image payloads whose declared type does not match', () => {
    const spoofed = `data:image/jpeg;base64,${Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]).toString('base64')}`
    expect(() =>
      validateMagicNoteRichContent({
        version: 1,
        ops: [{ insert: { image: spoofed } }]
      })
    ).toThrow('图片内容与声明的格式不一致')
  })

  it('rejects more than twelve images in one record', () => {
    expect(() =>
      validateMagicNoteRichContent({
        version: 1,
        ops: Array.from({ length: 13 }, () => ({
          insert: { image: pngDataUrl }
        }))
      })
    ).toThrow('每条记录最多包含 12 张图片')
  })

  it('rejects oversized aggregate text content', () => {
    expect(() =>
      validateMagicNoteRichContent({
        version: 1,
        ops: Array.from({ length: 3 }, () => ({
          insert: '字'.repeat(60_000)
        }))
      })
    ).toThrow('每条记录的文字内容不能超过 500 KB')
  })

  it('extracts Quill checklists and updates completion by source index', () => {
    const content = validateMagicNoteRichContent({
      version: 1,
      ops: [
        { insert: '第一项' },
        { insert: '\n', attributes: { list: 'unchecked' } },
        { insert: '普通正文\n' },
        { insert: '第二项' },
        { insert: '\n', attributes: { list: 'checked' } }
      ]
    })

    expect(magicNoteChecklistItems(content)).toEqual([
      { sourceIndex: 0, title: '第一项', completed: false },
      { sourceIndex: 1, title: '第二项', completed: true }
    ])
    expect(
      magicNoteChecklistItems(
        setMagicNoteChecklistCompletion(content, 0, true)
      )
    ).toEqual([
      { sourceIndex: 0, title: '第一项', completed: true },
      { sourceIndex: 1, title: '第二项', completed: true }
    ])
  })
})
