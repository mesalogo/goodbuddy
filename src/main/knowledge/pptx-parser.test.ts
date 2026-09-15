import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractPptxPages } from './pptx-parser'
import { createImagePptx } from '../../../tests/support/pptx-fixture'

describe('PPTX image extraction', () => {
  it('extracts referenced images with slide locators', () => {
    const pages = extractPptxPages(createImagePptx('Native text', 2))
    expect(pages.map((page) => page.pageNumber)).toEqual([1, 2])
    expect(pages[0]).toEqual({
      pageNumber: 1,
      content: 'Native text',
      images: [{
        name: 'image1.png',
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png'
      }]
    })
  })

  it('follows presentation order and ignores external and unreferenced media', () => {
    const pages = extractPptxPages(Buffer.from(zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>'),
      'ppt/_rels/presentation.xml.rels': strToU8('<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="/ppt/slides/slide2.xml"/></Relationships>'),
      'ppt/slides/slide1.xml': strToU8('<p:sld><a:t>First</a:t><a:blip r:embed="external"/></p:sld>'),
      'ppt/slides/_rels/slide1.xml.rels': strToU8('<Relationships><Relationship Id="external" Target="https://example.invalid/image.png" TargetMode="External"/></Relationships>'),
      'ppt/slides/slide2.xml': strToU8('<p:sld><a:t>Second</a:t></p:sld>'),
      'ppt/media/unused.png': new Uint8Array([1])
    })))
    expect(pages.map(({ pageNumber, content, images }) => ({
      pageNumber, content, images
    }))).toEqual([
      { pageNumber: 1, content: 'Second', images: [] },
      { pageNumber: 2, content: 'First', images: [] }
    ])
  })
})
