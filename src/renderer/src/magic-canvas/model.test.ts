import { describe, expect, it } from 'vitest'
import { canvasHasContent, createEmptyCanvasContent, fromCoreContent, toCoreContent } from './model'
import { magicNoteCanvasContentSchema } from '../../../shared/magic-notes-contracts'

describe('canvas document adapter', () => {
  it('round trips all templates and page identity through the PeopleLib model', () => {
    const content = createEmptyCanvasContent()
    content.pages = ['blank', 'ruled', 'grid', 'dot'].map((template, index) => ({
      ...content.pages[0]!, id: `page-${index}`, background: { type: 'template', template: template as 'blank' | 'ruled' | 'grid' | 'dot' }
    }))
    expect(fromCoreContent(toCoreContent(content), [])).toEqual(content)
    expect(canvasHasContent(content)).toBe(true)
    expect(canvasHasContent(createEmptyCanvasContent())).toBe(false)
  })

  it('deduplicates image assets and restores src only in the renderer model', () => {
    const core = toCoreContent(createEmptyCanvasContent())
    const image = { type: 'Image', canvasKind: 'image', src: 'data:image/png;base64,AAAA', left: 10, scaleX: 2 }
    core.pages[0]!.objects = [image, { ...image, left: 50 }]
    const assets: ReturnType<typeof createEmptyCanvasContent>['assets'] = []
    const content = fromCoreContent(core, assets)
    expect(content.assets).toHaveLength(1)
    expect(content.pages[0]!.objects[0]).not.toHaveProperty('src')
    expect(content.pages[0]!.objects[0]!.assetId).toBe(content.pages[0]!.objects[1]!.assetId)
    expect(toCoreContent(content)).toEqual(core)
    expect(fromCoreContent(core, assets)).toEqual(content)
    expect(magicNoteCanvasContentSchema.parse(content)).toEqual(content)
  })

  it('preserves PDF native text, page number and flow breaks in the shared contract', () => {
    const core = toCoreContent(createEmptyCanvasContent())
    core.pages[0]!.background = { type: 'pdf', assetId: 'pdf-1', page: 3 }
    core.flow = { version: 1, ops: [{ insert: '正文\n' }, { insert: { canvasPageBreak: 'next-page' } }] }
    const assets = [{ id: 'pdf-1', name: 'test.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBERg==' }]
    const result = fromCoreContent(core, assets, [{ assetId: 'pdf-1', pageNumber: 3, text: 'Native PDF text' }])
    expect(result.pages[0]!.background).toEqual({ type: 'pdf', assetId: 'pdf-1', pageNumber: 3, text: 'Native PDF text' })
    expect(magicNoteCanvasContentSchema.parse(result)).toEqual(result)
    expect(toCoreContent(result)).toEqual(core)
  })

  it('removes unreferenced assets only from output, retaining undo resources', () => {
    const assets = [{ id: 'old', name: 'old.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }]
    expect(fromCoreContent(toCoreContent(createEmptyCanvasContent()), assets).assets).toEqual([])
    expect(assets).toHaveLength(1)
  })
})
