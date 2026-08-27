import { extname } from 'node:path'
export { detectSupportedImage } from '../shared/image-media-type'

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
