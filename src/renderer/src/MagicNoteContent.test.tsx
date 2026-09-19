import { act, cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MagicNoteContent } from './MagicNoteContent'
import type { MagicCanvasContentHandle } from './MagicCanvasContent'
import { createEmptyCanvasContent } from './magic-canvas/model'
import './i18n'

const core = vi.hoisted(() => ({ mount: vi.fn() }))
vi.mock('./magic-canvas/canvas-note.mjs', () => ({ mountCanvasNote: core.mount }))

afterEach(cleanup)

describe('MagicNoteContent dispatch', () => {
  it('switches between rich text and a read-only canvas with capture access', async () => {
    const content = createEmptyCanvasContent()
    const images = [{ pageId: content.pages[0]!.id, dataUrl: 'data:image/png;base64,YQ==' }]
    const capturePages = vi.fn(async () => images)
    const destroy = vi.fn(async () => {})
    core.mount.mockImplementation((_host, value) => ({
      content: () => value, flush: async () => value, destroy, capturePages,
      focus: vi.fn(), setDisabled: vi.fn()
    }))
    const ref = createRef<MagicCanvasContentHandle>()
    const view = render(<MagicNoteContent content={{ version: 1, ops: [{ insert: 'Rich text remains readable\n' }] }} />)
    expect(screen.getByText('Rich text remains readable')).toBeVisible()
    view.rerender(<MagicNoteContent content={content} canvasRef={ref} />)
    await act(async () => {})
    expect(core.mount.mock.calls[0]![2].disabled).toBe(true)
    expect(await ref.current!.capturePages()).toEqual(images)
    view.rerender(<MagicNoteContent content={{ version: 1, ops: [{ insert: 'Back to text\n' }] }} />)
    expect(screen.getByText('Back to text')).toBeVisible()
    expect(ref.current).toBeNull()
    expect(destroy).toHaveBeenCalledOnce()
  })
})
