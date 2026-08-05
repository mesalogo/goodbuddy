import { describe, expect, it, vi } from 'vitest'
import {
  encodeBoundedJpeg,
  MAX_BOUNDED_JPEG_BYTES
} from './bounded-jpeg'

function jpeg(size: number): Buffer {
  const data = Buffer.alloc(size)
  data[0] = 0xff
  data[1] = 0xd8
  data[data.length - 2] = 0xff
  data[data.length - 1] = 0xd9
  return data
}

describe('encodeBoundedJpeg', () => {
  it('reduces quality and dimensions until the JPEG fits', () => {
    const resize = vi.fn((options: { width: number }) =>
      createImage(options.width)
    )
    const createImage = (width: number) => ({
      getSize: () => ({ width, height: 800 }),
      resize,
      toJPEG: (quality: number) =>
        jpeg(Math.ceil(width * quality * 12))
    })

    const result = encodeBoundedJpeg(createImage(2_000))

    expect(result.byteLength).toBeLessThanOrEqual(
      MAX_BOUNDED_JPEG_BYTES
    )
    expect(resize).toHaveBeenCalled()
  })

  it('rejects invalid encoder output', () => {
    const image = {
      getSize: () => ({ width: 100, height: 100 }),
      resize: () => image,
      toJPEG: () => Buffer.from('not-jpeg')
    }

    expect(() => encodeBoundedJpeg(image)).toThrow('内容无效')
  })
})
