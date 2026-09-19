import { describe, expect, it } from 'vitest'
import { magicNoteCanvasPlainText } from '../src/shared/magic-note-canvas-text'
import { magicNotePlainText } from '../src/main/magic-notes/rich-content'
import type { MagicNoteCanvasContent } from '../src/shared/magic-notes-contracts'

describe('canvas plain text comparison parity', () => {
  it('matches persistence for flow, embeds, nested objects and PDF text', () => {
    const content: MagicNoteCanvasContent = {
      version: 2, kind: 'paged-canvas', assets: [],
      flow: { ops: [{ insert: 'Body\n\n\n' }, { insert: { canvasPageBreak: 'page' } }, { insert: 'Next' },
        { insert: { image: 'data:image/png;base64,YQ==' } }, { insert: { attachment: { name: 'a.txt' } } },
        { insert: { localVideo: { name: 'a.mp4' } } }, { insert: { other: {} } }] },
      pages: [{ id: 'page', width: 794, height: 1123, background: { type: 'pdf', assetId: 'pdf', pageNumber: 1, text: 'PDF text' },
        objects: [{ text: 'Annotation', objects: [{ insert: 'Nested' }] }] }]
    }
    expect(magicNoteCanvasPlainText(content)).toBe(magicNotePlainText(content))
    const moved = structuredClone(content)
    moved.pages[0]!.objects[0]!.left = 100
    expect(magicNoteCanvasPlainText(moved)).toBe(magicNoteCanvasPlainText(content))
    const empty: MagicNoteCanvasContent = { ...content, flow: undefined, pages: [] }
    expect(magicNoteCanvasPlainText(empty)).toBe(magicNotePlainText(empty))
  })
})
