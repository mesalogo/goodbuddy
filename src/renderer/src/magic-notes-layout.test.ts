import { describe, expect, it } from 'vitest'
import { readStylesheetBundle } from './stylesheet-bundle'

const css = readStylesheetBundle()
const wb = ":root[data-layout='workbench']"

/** Bodies of every `@container <name> <query> {` block that mentions the magic notes page, joined. */
function containerBlock(name: string, query: string): string {
  const head = `@container ${name} ${query} {`
  const blocks: string[] = []
  for (let start = css.indexOf(head); start >= 0; start = css.indexOf(head, start + 1)) {
    let depth = 0
    for (let index = css.indexOf('{', start); index < css.length; index += 1) {
      if (css[index] === '{') depth += 1
      if (css[index] === '}' && --depth === 0) { blocks.push(css.slice(start, index)); break }
    }
  }
  const body = blocks.filter((block) => block.includes('.magic-notes-page')).join('\n')
  expect(body, head).not.toBe('')
  return body
}

describe('magic notes workbench layout', () => {
  const twoColumns = containerBlock('page-shell', '(width > 780px)')

  it('drops the page shell gutter and scroll for the page', () => {
    expect(css).toMatch(/:root\[data-layout='workbench'\] \.page-shell--master-detail:has\(> \.magic-notes-page\)\s*\{\s*padding:\s*0;\s*overflow:\s*hidden;/)
    // Narrow pages keep the classic single column with the gutter back on the page.
    expect(containerBlock('page-shell', '(max-width: 780px)')).toContain(`${wb} .magic-notes-page {\n    padding: var(--wb-inset);`)
  })

  it('makes the library the second column only while the page is wide', () => {
    expect(twoColumns).toMatch(/\.magic-notes-page\s*\{[^}]*grid-template-columns:\s*var\(--wb-object-list-width\) minmax\(0, 1fr\);/)
    expect(twoColumns).toContain(`${wb} .magic-notes-page > .magic-notes-workspace > .magic-notes-overview:not([hidden]) {\n    display: contents;`)
    expect(twoColumns).toMatch(/\.magic-notes-page::before\s*\{[^}]*border-right:\s*1px solid var\(--border-subtle\);\s*background:\s*var\(--surface-subtle\);/)
    expect(twoColumns).toMatch(/\.magic-notes-page \.magic-notes-detail-container\s*\{\s*grid-column:\s*-2;\s*grid-row:\s*1 \/ -1;/)
    // The classic split's handle and drawer do not apply to the page grid.
    expect(twoColumns).toContain('.magic-notes-notes-resize-handle, .magic-notes-list-backdrop')
  })

  it('heads the column with the page header and one action row', () => {
    expect(twoColumns).toMatch(/\.magic-notes-page > \.page-header\s*\{\s*grid-column:\s*1;\s*grid-row:\s*1;/)
    // Knowledge and magic notes share one column head rule, so both titles sit at the same place.
    const sharedHead = containerBlock('page-shell', '(width > 780px)')
    expect(sharedHead).toMatch(/:is\(\.knowledge-page, \.magic-notes-page\) > \.page-header\s*\{[^}]*flex-direction:\s*column;[^}]*padding:\s*var\(--wb-inset\) var\(--wb-inset\) var\(--space-3\);/)
    expect(sharedHead).toMatch(/:is\(\.knowledge-page, \.magic-notes-page\) > \.page-header \.page-header__actions > \.primary-button\s*\{[^}]*flex:\s*1;/)
    // The library switch has an id rule in the classic stylesheet; the compact rule must outrank it.
    expect(twoColumns).toContain('.page-header__actions > :is(.secondary-button, #magic-library-switch) {')
  })

  it('puts note cards and the selected todo in the content area', () => {
    expect(twoColumns).toMatch(/\.magic-notes-workspace--overview \.magic-notes-card-grid\s*\{\s*grid-column:\s*-2;\s*grid-row:\s*1 \/ -1;/)
    expect(twoColumns).toMatch(/\.magic-notes-overview--todos \.magic-todo-detail\s*\{\s*grid-column:\s*-2;\s*grid-row:\s*1 \/ -1;/)
  })

  it('falls back to one column when no list is shown', () => {
    expect(twoColumns).toMatch(/\.magic-notes-page:has\(> \.magic-notes-workspace > \.magic-notes-overview\[hidden\]\)\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/)
  })
})
