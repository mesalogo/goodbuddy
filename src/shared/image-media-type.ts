export type SupportedImageFormat = {
  extension: 'jpg' | 'png' | 'webp'
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
}

function matchesAscii(
  data: Uint8Array,
  offset: number,
  value: string
): boolean {
  return [...value].every(
    (character, index) =>
      data[offset + index] === character.charCodeAt(0)
  )
}

export function detectSupportedImage(
  data: Uint8Array
): SupportedImageFormat {
  if (
    data.byteLength >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return { extension: 'jpg', mimeType: 'image/jpeg' }
  }
  if (
    data.byteLength >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => data[index] === value
    )
  ) {
    return { extension: 'png', mimeType: 'image/png' }
  }
  if (
    data.byteLength >= 12 &&
    matchesAscii(data, 0, 'RIFF') &&
    matchesAscii(data, 8, 'WEBP')
  ) {
    return { extension: 'webp', mimeType: 'image/webp' }
  }
  throw new Error('图片格式不受支持')
}
