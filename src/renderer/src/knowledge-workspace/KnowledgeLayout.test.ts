import { describe, expect, it } from 'vitest'
import { readStylesheetBundle } from '../stylesheet-bundle'

const css = readStylesheetBundle()

/** Body of the first `@container <name> (max-width: <width>px)` block. */
function containerBlock(name: string, width: number): string {
  const start = css.indexOf(`@container ${name} (max-width: ${width}px) {`)
  expect(start, `@container ${name} ${width}px`).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}' && --depth === 0) return css.slice(start, index)
  }
  throw new Error('unterminated block')
}

describe('knowledge workspace layout', () => {
  it('declares a page container and a detail-pane container', () => {
    expect(css).toMatch(/\.knowledge-page\s*\{[^}]*container:\s*knowledge-page\s*\/\s*inline-size;/)
    expect(css).toMatch(/\.knowledge-workspace__main\s*\{[^}]*container:\s*knowledge-main\s*\/\s*inline-size;/)
  })

  it('collapses the library list by the page width, not by its own frame', () => {
    // A container query cannot style the container itself.
    expect(css).not.toMatch(/\.knowledge-workspace\s*\{[^}]*container(-type)?:/)
    expect(containerBlock('knowledge-page', 780)).toMatch(/\.knowledge-workspace\s*\{\s*flex:\s*none;\s*grid-template-columns:\s*minmax\(0, 1fr\);/)
  })

  it('sizes detail content by the detail pane', () => {
    expect(containerBlock('knowledge-main', 720)).toContain('.knowledge-workspace__header {')
    expect(containerBlock('knowledge-main', 880)).toContain('.knowledge-graph {')
    expect(containerBlock('knowledge-main', 560)).toContain('.knowledge-task__heading')
    // Unnamed container queries would resolve against the nearest container and
    // mix the page width with the pane width.
    expect(css).not.toMatch(/@container \(max-width: \d+px\)\s*\{\s*\.knowledge-/)
  })

  it('makes the library list the second column in the workbench layout', () => {
    const wb = ":root[data-layout='workbench']"
    expect(css).toContain(`${wb} .knowledge-page > .knowledge-workspace {\n  display: contents;`)
    expect(css).toMatch(/:root\[data-layout='workbench'\] \.knowledge-page\s*\{[^}]*grid-template-columns:\s*var\(--wb-object-list-width\) minmax\(0, 1fr\);/)
    expect(css).toMatch(/:root\[data-layout='workbench'\] \.knowledge-workspace__main\s*\{\s*grid-column:\s*2;\s*grid-row:\s*1 \/ -1;/)
    // The page shell is the named container; the page grid collapses by its width.
    expect(css).toMatch(/\.page-shell--master-detail\s*\{[^}]*container:\s*page-shell \/ inline-size;/)
    expect(containerBlock('page-shell', 780)).toContain(`${wb} .knowledge-page {`)
  })

  it('scrolls the create form inside the detail pane', () => {
    expect(css).toMatch(/\.knowledge-workspace__create\s*\{[^}]*overflow:\s*hidden auto;/)
    expect(css).toMatch(/\.knowledge-workspace__create > \.knowledge-create\s*\{\s*margin:\s*0;/)
  })
})
