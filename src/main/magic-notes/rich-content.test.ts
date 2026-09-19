import { describe, expect, it } from 'vitest'
import {
  magicNoteChecklistItems,
  magicNoteEmbeddedBytes,
  magicNoteImageBytes,
  magicNotePlainText,
  setMagicNoteChecklistCompletion,
  validateMagicNoteContent,
  validateMagicNoteRichContent
} from './rich-content'

const pngDataUrl = `data:image/png;base64,${Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]).toString('base64')}`
const mp4Bytes = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d
])
const mp4DataUrl = `data:video/mp4;base64,${mp4Bytes.toString('base64')}`
const attachmentBytes = Buffer.from('release notes')
const attachmentDataUrl =
  `data:text/plain;base64,${attachmentBytes.toString('base64')}`

describe('magic note rich content', () => {
  it('preserves canvas resources, native flow breaks and checklist positions', () => {
    const content = validateMagicNoteContent({
      version: 2, kind: 'paged-canvas',
      pages: [{ id: 'page-1', width: 794, height: 1123,
        background: { type: 'pdf', assetId: 'pdf', pageNumber: 1, text: 'Extracted PDF text' },
        objects: [{ type: 'IText', text: 'Annotation', left: 12 }, { type: 'Image', assetId: 'image' }] }],
      flow: { version: 1, ops: [{ insert: { canvasPageBreak: 'page-1' } }, { insert: 'Task' }, { insert: '\n', attributes: { list: 'unchecked', custom: 'preserve' } }] },
      assets: [{ id: 'pdf', name: 'document.pdf', mimeType: 'application/pdf', dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF-1.7').toString('base64')}` },
        { id: 'image', name: 'image.png', mimeType: 'image/png', dataUrl: pngDataUrl }]
    })
    expect(magicNotePlainText(content)).toBe('Task\nExtracted PDF text\nAnnotation')
    expect(magicNoteChecklistItems(content)).toEqual([{ sourceIndex: 0, title: 'Task', completed: false }])
    expect(magicNoteEmbeddedBytes(content)).toBe(16)
    expect(magicNoteImageBytes(content)).toBe(8)
    const updated = setMagicNoteChecklistCompletion(content, 0, true)
    expect(updated.version === 2 && updated.pages).toEqual(content.version === 2 && content.pages)
    expect(updated.version === 2 && updated.flow).toMatchObject({ version: 1, ops: [
      { insert: { canvasPageBreak: 'page-1' } }, { insert: 'Task' }, { insert: '\n', attributes: { list: 'checked', custom: 'preserve' } }
    ] })
    if (content.version !== 2) throw new Error('Expected canvas')
    expect(() => validateMagicNoteContent({ ...content, assets: [] })).toThrow('PDF')
    expect(() => validateMagicNoteContent({ ...content, assets: [...content.assets, content.assets[0]] })).toThrow('ID')
    expect(() => validateMagicNoteContent({ ...content, pages: [{ ...content.pages[0], objects: [{ assetId: 'missing' }] }] })).toThrow('资源不存在')
    expect(() => validateMagicNoteContent({ ...content, pages: [{ ...content.pages[0], objects: [{ type: 'Image', src: 'https://example.com/image.png' }] }] })).toThrow('只支持本地')
    expect(validateMagicNoteContent({ ...content, pages: [{ ...content.pages[0], objects: [{ type: 'Image', src: pngDataUrl }] }] })).toMatchObject({ version: 2 })
  })
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

  it('accepts bounded font formats, local videos, and attachments', () => {
    const content = validateMagicNoteRichContent({
      version: 1,
      ops: [
        {
          insert: '重点',
          attributes: { size: 'large', color: '#e60000' }
        },
        { insert: '\n' },
        {
          insert: {
            localVideo: {
              name: 'demo.mp4',
              mimeType: 'video/mp4',
              size: mp4Bytes.length,
              dataUrl: mp4DataUrl
            }
          }
        },
        {
          insert: {
            attachment: {
              name: 'notes.txt',
              mimeType: 'text/plain',
              size: attachmentBytes.length,
              dataUrl: attachmentDataUrl
            }
          }
        },
        { insert: '\n' }
      ]
    })

    expect(magicNotePlainText(content)).toBe(
      '重点\n[视频：demo.mp4][附件：notes.txt]'
    )
    expect(magicNoteImageBytes(content)).toBe(0)
    expect(magicNoteEmbeddedBytes(content)).toBe(
      mp4Bytes.length + attachmentBytes.length
    )
  })

  it('rejects spoofed videos and mismatched attachment metadata', () => {
    expect(() =>
      validateMagicNoteRichContent({
        version: 1,
        ops: [
          {
            insert: {
              localVideo: {
                name: 'demo.mp4',
                mimeType: 'video/mp4',
                size: attachmentBytes.length,
                dataUrl: `data:video/mp4;base64,${attachmentBytes.toString('base64')}`
              }
            }
          }
        ]
      })
    ).toThrow('视频内容与声明的格式不一致')

    expect(() =>
      validateMagicNoteRichContent({
        version: 1,
        ops: [
          {
            insert: {
              attachment: {
                name: 'notes.txt',
                mimeType: 'text/plain',
                size: attachmentBytes.length + 1,
                dataUrl: attachmentDataUrl
              }
            }
          }
        ]
      })
    ).toThrow('附件内容与声明的大小不一致')
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
