import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'),
  'utf8'
).replaceAll('\r\n', '\n')

describe('primary sidebar layout', () => {
  it('keeps search above an independently scrolling conversation list', () => {
    const section = stylesheet.match(/\.sidebar-conversations\s*\{([^}]*)\}/u)?.[1]
    const header = stylesheet.match(/\.sidebar-conversations__header\s*\{([^}]*)\}/u)?.[1]
    const list = stylesheet.match(/\.conversation-list\s*\{([^}]*)\}/u)?.[1]
    expect(section).toContain('min-height: 0;')
    expect(section).toContain('flex-direction: column;')
    expect(section).toContain('background: var(--surface-raised);')
    expect(header).toContain('flex: 0 0 auto;')
    expect(list).toContain('min-width: 0;')
    expect(list).toContain('min-height: 0;')
    expect(list).toContain('overflow: auto;')
    const shortWindow = stylesheet.split('@media (max-height: 600px) {')[1]?.split('@media')[0]
    expect(shortWindow).toContain('overflow-y: auto;')
    expect(shortWindow).toContain('flex-shrink: 0;')
    expect(shortWindow).toContain('min-height: 200px;')
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
