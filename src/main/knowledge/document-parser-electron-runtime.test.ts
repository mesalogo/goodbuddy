import { beforeEach, describe, expect, it, vi } from 'vitest'

const getDocument = vi.hoisted(() => vi.fn())

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument
}))

import { extractPdfTextPages } from './document-parser'

describe('PDF extraction in Electron main', () => {
  beforeEach(() => {
    getDocument.mockReset()
  })

  it('disables PDF.js DOM factories for headless text extraction', async () => {
    const cleanup = vi.fn()
    const destroy = vi.fn(async () => undefined)
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn(async () => ({
          getTextContent: vi.fn(async () => ({
            items: [{ str: 'PDF body text' }]
          })),
          cleanup
        }))
      }),
      destroy
    })

    await expect(
      extractPdfTextPages(Buffer.from('synthetic PDF'))
    ).resolves.toEqual([
      {
        pageNumber: 1,
        content: 'PDF body text'
      }
    ])
    expect(getDocument).toHaveBeenCalledWith({
      data: expect.any(Uint8Array),
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
      useSystemFonts: false,
      useWorkerFetch: false
    })
    expect(cleanup).toHaveBeenCalledOnce()
    expect(destroy).toHaveBeenCalledOnce()
  })
})
