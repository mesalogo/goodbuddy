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
          streamTextContent: vi.fn(() =>
            new ReadableStream({
              start(controller) {
                controller.enqueue({ items: [{ str: 'PDF body text' }] })
                controller.close()
              }
            })
          ),
          cleanup
        }))
      }),
      destroy
    })

    await expect(
      extractPdfTextPages(Buffer.from('synthetic PDF'))
    ).resolves.toEqual({
      pageCount: 1,
      truncated: false,
      pages: [{
        pageNumber: 1,
        content: 'PDF body text'
      }]
    })
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

  it('uses PDF line endings and conservative coordinate line grouping', async () => {
    const cleanup = vi.fn()
    const destroy = vi.fn(async () => undefined)
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn(async () => ({
          streamTextContent: vi.fn(() =>
            new ReadableStream({
              start(controller) {
                controller.enqueue({
                  items: [
                    {
                      str: 'first',
                      hasEOL: true,
                      transform: [1, 0, 0, 1, 10, 100],
                      height: 10
                    },
                    {
                      str: 'second',
                      transform: [1, 0, 0, 1, 10, 80],
                      height: 10
                    },
                    {
                      str: 'line',
                      transform: [1, 0, 0, 1, 50, 80],
                      height: 10
                    }
                  ]
                })
                controller.close()
              }
            })
          ),
          cleanup
        }))
      }),
      destroy
    })

    await expect(
      extractPdfTextPages(Buffer.from('synthetic PDF'))
    ).resolves.toEqual({
      pageCount: 1,
      truncated: false,
      pages: [{
        pageNumber: 1,
        content: 'first\nsecond line'
      }]
    })
  })

  it('stops extracting pages at the aggregate character limit', async () => {
    const getPage = vi.fn(async (pageNumber: number) => ({
      streamTextContent: vi.fn(() =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              items: [{ str: pageNumber === 1 ? 'first' : 'second' }]
            })
            controller.close()
          }
        })
      ),
      cleanup: vi.fn()
    }))
    const destroy = vi.fn(async () => undefined)
    getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 2, getPage }),
      destroy
    })

    await expect(
      extractPdfTextPages(Buffer.from('synthetic PDF'), {
        maximumCharacters: 5
      })
    ).resolves.toEqual({
      pageCount: 2,
      truncated: true,
      pages: [{ pageNumber: 1, content: 'first' }]
    })
    expect(getPage).toHaveBeenCalledOnce()
  })

  it('cancels the PDF text stream after reaching the character limit', async () => {
    let pulls = 0
    const cancel = vi.fn()
    const streamTextContent = vi.fn(() =>
      new ReadableStream({
        pull(controller) {
          pulls += 1
          controller.enqueue({ items: [{ str: 'abcde' }] })
        },
        cancel
      })
    )
    const destroy = vi.fn(async () => undefined)
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn(async () => ({
          streamTextContent,
          cleanup: vi.fn()
        }))
      }),
      destroy
    })

    await expect(
      extractPdfTextPages(Buffer.from('synthetic PDF'), {
        maximumCharacters: 5
      })
    ).resolves.toEqual({
      pageCount: 1,
      truncated: true,
      pages: [{ pageNumber: 1, content: 'abcde' }]
    })
    expect(pulls).toBeLessThanOrEqual(2)
    expect(cancel).toHaveBeenCalled()
  })

  it('rejects oversized PDFs before reading pages', async () => {
    const getPage = vi.fn()
    const destroy = vi.fn(async () => undefined)
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage
      }),
      destroy
    })

    await expect(
      extractPdfTextPages(Buffer.from('synthetic PDF'), {
        maximumPages: 2
      })
    ).rejects.toThrow('超过 2 页限制')
    expect(getPage).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('destroys PDF loading when extraction is cancelled', async () => {
    let resolveLoading: ((value: {
      numPages: number
      getPage: ReturnType<typeof vi.fn>
    }) => void) | undefined
    const destroy = vi.fn(async () => undefined)
    getDocument.mockReturnValue({
      promise: new Promise((resolve) => {
        resolveLoading = resolve
      }),
      destroy
    })
    const controller = new AbortController()
    const extraction = extractPdfTextPages(
      Buffer.from('synthetic PDF'),
      { signal: controller.signal }
    )

    controller.abort(new Error('cancel PDF extraction'))
    resolveLoading?.({ numPages: 0, getPage: vi.fn() })

    await expect(extraction).rejects.toThrow('cancel PDF extraction')
    expect(destroy).toHaveBeenCalled()
  })
})
