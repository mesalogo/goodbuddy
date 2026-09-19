import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MagicCanvasThumbnail } from './MagicCanvasThumbnail'
import { mountCanvasNote } from './magic-canvas/canvas-note.mjs'
import type { MagicNoteCanvasContent } from './magic-canvas/model'
import './i18n'

vi.mock('./magic-canvas/canvas-note.mjs', () => ({ mountCanvasNote: vi.fn() }))

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('MagicCanvasThumbnail cleanup', () => {
  it.each(['unmount', 'replace'] as const)('immediately destroys pending capture on %s and releases the shared render queue', async (action) => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const content: MagicNoteCanvasContent = { version: 2, kind: 'paged-canvas', assets: [], pages: [
      { id: 'page', width: 794, height: 1123, objects: [], background: { type: 'template', template: 'blank' } }
    ] }
    let rejectCapture!: (error: Error) => void
    const pending = new Promise<{ pageId: string; dataUrl: string }[]>((_resolve, reject) => { rejectCapture = reject })
    const first = {
      capturePages: vi.fn(() => pending),
      destroy: vi.fn(() => {
        // Core destroy cancels tasks synchronously, then waits for its operation queue.
        rejectCapture(new DOMException('Cancelled', 'AbortError'))
        return pending.then(() => {}, () => {})
      })
    }
    const second = { capturePages: vi.fn(async () => [{ pageId: 'page', dataUrl: 'data:image/png;base64,YQ==' }]), destroy: vi.fn(async () => {}) }
    vi.mocked(mountCanvasNote)
      .mockReturnValueOnce(first as unknown as ReturnType<typeof mountCanvasNote>)
      .mockReturnValueOnce(second as unknown as ReturnType<typeof mountCanvasNote>)
    const view = render(<MagicCanvasThumbnail content={content} />)
    await waitFor(() => expect(first.capturePages).toHaveBeenCalledOnce())
    if (action === 'unmount') view.unmount()
    else view.rerender(<MagicCanvasThumbnail content={structuredClone(content)} />)
    expect(first.destroy).toHaveBeenCalledOnce()
    if (action === 'unmount') render(<MagicCanvasThumbnail content={structuredClone(content)} />)
    await screen.findByRole('img')
    expect(second.capturePages).toHaveBeenCalledWith({ firstPageOnly: true, thumbnailWidth: 240 })
    await waitFor(() => expect(document.querySelector('.magic-note-thumbnail-renderer')).toBeNull())
    act(() => cleanup())
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(second.destroy).toHaveBeenCalledOnce()
  })
})
