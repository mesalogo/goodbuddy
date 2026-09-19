import type { MagicNoteCanvasContent } from '../../../shared/magic-notes-contracts'
export type { MagicNoteCanvasContent } from '../../../shared/magic-notes-contracts'
export type CanvasFlow = NonNullable<MagicNoteCanvasContent['flow']>
export type CanvasAsset = MagicNoteCanvasContent['assets'][number]
export type PdfPageText = { assetId: string; pageNumber: number; text: string }

export type CoreContent = {
  version: 2
  pages: {
    id: string
    width: number
    height: number
    background: { type: 'template'; template: string } | { type: 'pdf'; assetId: string; page: number }
    objects: Record<string, unknown>[]
    flowAuto?: boolean
  }[]
  flow?: CanvasFlow
}

export function createEmptyCanvasContent(): MagicNoteCanvasContent {
  return {
    version: 2, kind: 'paged-canvas', assets: [],
    pages: [{ id: crypto.randomUUID(), width: 794, height: 1123, background: { type: 'template', template: 'blank' }, objects: [] }]
  }
}

export function canvasHasContent(content?: MagicNoteCanvasContent): boolean {
  return !!content && (content.pages.length > 1 || content.pages.some((page) =>
    page.objects.length > 0 || page.background.type === 'pdf' || page.background.template !== 'blank'
  ) || !!content.flow?.ops.some((op) => typeof op.insert === 'string' && op.insert.trim()))
}

export function toCoreContent(content: MagicNoteCanvasContent): CoreContent {
  return {
    version: 2,
    pages: content.pages.map((page) => ({
      ...page,
      background: page.background.type === 'pdf'
        ? { type: 'pdf', assetId: page.background.assetId, page: page.background.pageNumber }
        : { type: 'template', template: page.background.template === 'ruled' ? 'lined' : page.background.template === 'dot' ? 'dots' : page.background.template },
      objects: page.objects.map((object) => {
        if (object.canvasKind !== 'image') return structuredClone(object)
        const asset = content.assets.find((item) => item.id === object.assetId)
        if (!asset && typeof object.src === 'string') return structuredClone(object)
        if (!asset) throw new Error(`图片资源不可用：${String(object.assetId)}`)
        const rest = { ...object }
        delete rest.assetId
        return { ...rest, src: asset.dataUrl }
      })
    })),
    ...(content.flow ? { flow: { ...content.flow, version: 1 } } : {})
  }
}

export function fromCoreContent(core: CoreContent, assets: CanvasAsset[], pdfText: PdfPageText[] = []): MagicNoteCanvasContent {
  const used = new Set<string>()
  const pages = core.pages.map((page): MagicNoteCanvasContent['pages'][number] => {
    if (page.background.type === 'pdf') used.add(page.background.assetId)
    return {
      ...page,
      background: page.background.type === 'pdf'
        ? { type: 'pdf', assetId: page.background.assetId, pageNumber: page.background.page,
          text: pdfText.find((item) => page.background.type === 'pdf' && item.assetId === page.background.assetId && item.pageNumber === page.background.page)?.text }
        : { type: 'template', template: page.background.template === 'lined' ? 'ruled' : page.background.template === 'dots' ? 'dot' : page.background.template as 'blank' | 'grid' },
      objects: page.objects.map((object) => {
        if (object.canvasKind !== 'image' || typeof object.src !== 'string') return structuredClone(object)
        let asset = assets.find((item) => item.dataUrl === object.src)
        if (!asset) {
          asset = { id: crypto.randomUUID(), name: '画布图片', mimeType: object.src.slice(5, object.src.indexOf(';')), dataUrl: object.src }
          assets.push(asset)
        }
        used.add(asset.id)
        const rest = { ...object }
        delete rest.src
        return { ...rest, assetId: asset.id }
      })
    }
  })
  return {
    version: 2, kind: 'paged-canvas', pages,
    ...(core.flow ? { flow: structuredClone(core.flow) } : {}),
    assets: structuredClone(assets.filter((asset) => used.has(asset.id)))
  }
}
