import { strToU8, zipSync } from 'fflate'

export function createImagePptx(nativeText = '', pageCount = 1): Buffer {
  const files: Record<string, Uint8Array> = {
    'ppt/media/image1.png': new Uint8Array([1, 2, 3])
  }
  for (let page = 1; page <= pageCount; page += 1) {
    files[`ppt/slides/slide${page}.xml`] = strToU8(
      `<p:sld><a:p><a:t>${nativeText}</a:t></a:p><p:pic><a:blip r:embed="rId1"/></p:pic></p:sld>`
    )
    files[`ppt/slides/_rels/slide${page}.xml.rels`] = strToU8(
      '<Relationships><Relationship Id="rId1" Target="../media/image1.png"/></Relationships>'
    )
  }
  return Buffer.from(zipSync(files))
}
