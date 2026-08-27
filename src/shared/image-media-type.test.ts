import { describe, expect, it } from 'vitest'
import { detectSupportedImage } from './image-media-type'

describe('supported image detection', () => {
  it.each([
    {
      bytes: [0xff, 0xd8, 0xff],
      extension: 'jpg',
      mimeType: 'image/jpeg'
    },
    {
      bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      extension: 'png',
      mimeType: 'image/png'
    },
    {
      bytes: [
        0x52,
        0x49,
        0x46,
        0x46,
        0,
        0,
        0,
        0,
        0x57,
        0x45,
        0x42,
        0x50
      ],
      extension: 'webp',
      mimeType: 'image/webp'
    }
  ])('detects $mimeType bytes', ({ bytes, extension, mimeType }) => {
    expect(detectSupportedImage(Uint8Array.from(bytes))).toEqual({
      extension,
      mimeType
    })
  })

  it('rejects unsupported bytes', () => {
    expect(() =>
      detectSupportedImage(Uint8Array.from([1, 2, 3]))
    ).toThrow('图片格式不受支持')
  })
})
