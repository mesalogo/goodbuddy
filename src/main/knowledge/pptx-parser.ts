import { posix } from 'node:path'
import { extractXmlText, readOfficeArchive } from './document-parser'

export type PptxPage = {
  pageNumber: number
  content: string
  images: Array<{
    name: string
    data: Uint8Array
    mimeType?: 'image/png' | 'image/jpeg' | 'image/webp'
  }>
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}=["']([^"']*)["']`, 'u').exec(tag)?.[1]
}

function relationships(xml: string, owner: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const tag of xml.match(/<(?:\w+:)?Relationship\b[^>]*>/gu) ?? []) {
    const id = attribute(tag, 'Id')
    const target = attribute(tag, 'Target')
    if (!id || !target || attribute(tag, 'TargetMode') === 'External') {
      continue
    }
    result.set(
      id,
      posix.normalize(
        target.startsWith('/')
          ? target.slice(1)
          : posix.join(posix.dirname(owner), target)
      )
    )
  }
  return result
}

export function extractPptxPages(buffer: Buffer): PptxPage[] {
  const archive = readOfficeArchive(buffer, [
    /^ppt\/presentation\.xml$/,
    /^ppt\/_rels\/presentation\.xml\.rels$/,
    /^ppt\/slides\/[^/]+\.xml$/,
    /^ppt\/slides\/_rels\/[^/]+\.xml\.rels$/,
    /^ppt\/media\/[^/]+$/
  ])
  const text = (name: string): string =>
    archive[name] ? Buffer.from(archive[name]).toString('utf8') : ''
  const slideRelationships = relationships(
    text('ppt/_rels/presentation.xml.rels'),
    'ppt/presentation.xml'
  )
  const slideIds =
    text('ppt/presentation.xml').match(/<(?:\w+:)?sldId\b[^>]*>/gu) ?? []
  const paths = slideIds.length > 0
    ? slideIds.map((tag) => {
        const path = slideRelationships.get(attribute(tag, 'r:id') ?? '')
        if (!path || !archive[path]) {
          throw new Error('PPTX 幻灯片关系无效')
        }
        return path
      })
    : Object.keys(archive)
        .filter((path) => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))

  return paths.map((path, index) => {
    const xml = text(path)
    const imageRelationships = relationships(
      text(posix.join(posix.dirname(path), '_rels', `${posix.basename(path)}.rels`)),
      path
    )
    const imagePaths = new Set(
      (xml.match(/<(?:\w+:)?blip\b[^>]*>/gu) ?? [])
        .map((tag) => imageRelationships.get(attribute(tag, 'r:embed') ?? ''))
        .filter((value): value is string => value !== undefined)
    )
    const images: PptxPage['images'] = []
    for (const imagePath of imagePaths) {
      const extension = posix.extname(imagePath).toLowerCase()
      const mimeType = extension === '.png'
        ? 'image/png'
        : extension === '.jpg' || extension === '.jpeg'
          ? 'image/jpeg'
          : extension === '.webp'
            ? 'image/webp'
            : undefined
      const data = archive[imagePath]
      if (!data) {
        throw new Error(`幻灯片 ${index + 1} 的内嵌图片缺失`)
      }
      images.push({ name: posix.basename(imagePath), data, mimeType })
    }
    return {
      pageNumber: index + 1,
      content: extractXmlText(xml),
      images
    }
  })
}
