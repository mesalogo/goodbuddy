import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FeedbackScreenshotError,
  normalizeFeedbackScreenshot
} from './feedback-screenshot'

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01
])
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01])
const webp = Buffer.from('RIFFxxxxWEBPdata', 'ascii')
const normalizedPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02
])

const imageMocks = vi.hoisted(() => ({
  createFromBuffer: vi.fn()
}))

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: imageMocks.createFromBuffer
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  imageMocks.createFromBuffer.mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: 640, height: 480 }),
    toPNG: () => normalizedPng
  })
})

describe('normalizeFeedbackScreenshot', () => {
  it.each([
    ['image/png', png],
    ['image/jpeg', jpeg],
    ['image/webp', webp]
  ] as const)('decodes and re-encodes %s as PNG', (mimeType, data) => {
    const result = normalizeFeedbackScreenshot({
      data,
      mimeType
    })
    expect(result).toEqual({
      data: normalizedPng,
      width: 640,
      height: 480
    })
    expect(result.data).not.toBe(data)
  })

  it('rejects a declared type that does not match the file signature', () => {
    expect(() =>
      normalizeFeedbackScreenshot({
        data: jpeg,
        mimeType: 'image/png'
      })
    ).toThrowError(
      expect.objectContaining<Partial<FeedbackScreenshotError>>({
        code: 'invalid-submission'
      })
    )
    expect(imageMocks.createFromBuffer).not.toHaveBeenCalled()
  })

  it('rejects unsafe dimensions and oversized normalized output', () => {
    imageMocks.createFromBuffer.mockReturnValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: 8_193, height: 1 }),
      toPNG: () => normalizedPng
    })
    expect(() =>
      normalizeFeedbackScreenshot({
        data: png,
        mimeType: 'image/png'
      })
    ).toThrowError(
      expect.objectContaining<Partial<FeedbackScreenshotError>>({
        code: 'invalid-submission'
      })
    )

    imageMocks.createFromBuffer.mockReturnValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: 640, height: 480 }),
      toPNG: () => Buffer.alloc(5 * 1_024 * 1_024 + 1)
    })
    expect(() =>
      normalizeFeedbackScreenshot({
        data: png,
        mimeType: 'image/png'
      })
    ).toThrowError(
      expect.objectContaining<Partial<FeedbackScreenshotError>>({
        code: 'screenshot-too-large'
      })
    )
  })
})
