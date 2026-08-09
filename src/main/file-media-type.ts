import { extname } from 'node:path'

const mimeTypes: Readonly<Record<string, string>> = {
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.java': 'text/x-java-source',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.py': 'text/x-python',
  '.sql': 'text/plain',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xlsx':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip'
}

export function mimeTypeFromFileName(
  name: string,
  fallback = 'application/octet-stream'
): string {
  return mimeTypes[extname(name).toLocaleLowerCase()] ?? fallback
}

export function detectSupportedImage(data: Buffer): {
  extension: 'jpg' | 'png' | 'webp'
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
} {
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
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) {
    return { extension: 'png', mimeType: 'image/png' }
  }
  if (
    data.byteLength >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: 'webp', mimeType: 'image/webp' }
  }
  throw new Error('图片格式不受支持')
}
