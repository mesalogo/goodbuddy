import interItalicUrl from '@fontsource-variable/inter/files/inter-latin-standard-italic.woff2?url'
import interNormalUrl from '@fontsource-variable/inter/files/inter-latin-standard-normal.woff2?url'

const interFaces = [
  { style: 'normal', url: interNormalUrl },
  { style: 'italic', url: interItalicUrl }
] as const

export function installBundledUiFonts(): void {
  for (const face of interFaces) {
    document.fonts.add(
      new FontFace(
        'Inter Variable',
        `url("${face.url}") format("woff2-variations")`,
        {
          display: 'swap',
          style: face.style,
          weight: '100 900'
        }
      )
    )
  }
}
