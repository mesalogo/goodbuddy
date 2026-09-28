import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'),
  'utf8'
).replaceAll('\r\n', '\n')

describe('primary sidebar layout', () => {
  it('keeps the original new conversation typography and left alignment, centering only its compact icon', () => {
    const button = stylesheet.match(/\.new-chat\s*\{([^}]*)\}/u)?.[1]
    const label = stylesheet.match(/\.new-chat span\s*\{([^}]*)\}/u)?.[1]
    const compact = stylesheet.match(/\.sidebar-conversation-controls--searching \.new-chat\s*\{([^}]*)\}/u)?.[1]
    expect(button).toContain('justify-content: flex-start;')
    expect(button).toContain('padding: 0 var(--space-3);')
    expect(label).toContain('font-size: 13px;')
    expect(label).toContain('font-weight: 600;')
    expect(label).not.toContain('white-space: nowrap;')
    expect(compact).toContain('justify-content: center;')
    expect(compact).toContain('padding: 0;')
  })
  it('keeps conversation controls fixed above an independently scrolling list', () => {
    const section = stylesheet.match(/\.sidebar-conversations\s*\{([^}]*)\}/u)?.[1]
    const controls = stylesheet.match(/\.sidebar-conversation-controls\s*\{([^}]*)\}/u)?.[1]
    const list = stylesheet.match(/\.conversation-list\s*\{([^}]*)\}/u)?.[1]
    expect(section).toContain('min-height: 0;')
    expect(section).toContain('flex-direction: column;')
    expect(section).toContain('background: var(--surface-raised);')
    expect(controls).toContain('flex: 0 0 44px;')
    expect(controls).toContain('height: 44px;')
    expect(stylesheet).not.toContain('.sidebar-conversations__header')
    expect(list).toContain('min-width: 0;')
    expect(list).toContain('min-height: 0;')
    expect(list).toContain('overflow: auto;')
    const shortWindow = stylesheet.split('@media (max-height: 600px) {')[1]?.split('@media')[0]
    expect(shortWindow).toContain('overflow-y: auto;')
    expect(shortWindow).toContain('flex-shrink: 0;')
    expect(shortWindow).toContain('min-height: 200px;')
  })

  it('expands search within the row and disables its width animation for reduced motion', () => {
    const slot = stylesheet.match(/\.sidebar-search-slot\s*\{([^}]*)\}/u)?.[1]
    expect(slot).toContain('margin-left: auto;')
    expect(slot).toContain('transition: width var(--motion-normal) ease-out;')
    expect(stylesheet).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.sidebar-search-slot\s*\{\s*transition: none;/u)
    const responsive = stylesheet.split('@media (max-width: 1020px) {')[1]?.split('@media')[0]
    expect(responsive).not.toMatch(/\.(?:new-chat|sidebar-search),/u)
  })

  it('floats conversation actions outside list layout with viewport limits', () => {
    const rule = stylesheet.match(/\.conversation-actions\s*\{([^}]*)\}/u)?.[1]
    expect(rule).toContain('position: fixed;')
    expect(rule).toContain('max-width: calc(100vw - 16px);')
    expect(rule).toContain('max-height: calc(100vh - 16px);')
    expect(rule).toContain('overflow: auto;')
    expect(rule).toContain('z-index: calc(var(--z-dialog) - 1);')
  })

  it('keeps the resize hit target from adding space beside the divider', () => {
    const rule = stylesheet.match(
      /\.primary-sidebar-resize-handle\s*\{([^}]*)\}/u
    )?.[1]

    expect(rule).toContain('width: 9px;')
    expect(rule).toContain('margin-left: -5px;')
    expect(rule).toContain('margin-right: -4px;')
  })
})
