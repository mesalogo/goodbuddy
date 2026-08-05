export const MAX_BOUNDED_JPEG_BYTES = 220 * 1024
export const BOUNDED_JPEG_QUALITIES = [60, 45, 30, 20, 10] as const

type JpegImage = {
  getSize(): { width: number; height: number }
  resize(options: {
    width: number
    quality: 'good'
  }): JpegImage
  toJPEG(quality: number): Buffer
}

export function isValidJpeg(data: Buffer): boolean {
  return (
    data.byteLength >= 4 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data.at(-2) === 0xff &&
    data.at(-1) === 0xd9
  )
}

export function encodeBoundedJpeg(
  image: JpegImage,
  maximumBytes = MAX_BOUNDED_JPEG_BYTES
): Buffer {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4) {
    throw new Error('JPEG 大小限制无效')
  }
  const initialWidth = Math.max(1, image.getSize().width)
  const widths = [
    initialWidth,
    1_600,
    1_280,
    960,
    720
  ].filter(
    (width, index, values) =>
      width <= initialWidth && values.indexOf(width) === index
  )

  for (const width of widths) {
    const candidate =
      width === initialWidth
        ? image
        : image.resize({ width, quality: 'good' })
    for (const quality of BOUNDED_JPEG_QUALITIES) {
      const data = candidate.toJPEG(quality)
      if (!isValidJpeg(data)) {
        throw new Error('JPEG 图片内容无效')
      }
      if (data.byteLength <= maximumBytes) {
        return data
      }
    }
  }
  throw new Error('JPEG 图片压缩后仍然过大')
}
