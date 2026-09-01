import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'),
  'utf8'
).replaceAll('\r\n', '\n')

describe('primary sidebar layout', () => {
  it('keeps the resize hit target from adding space beside the divider', () => {
    const rule = stylesheet.match(
      /\.primary-sidebar-resize-handle\s*\{([^}]*)\}/u
    )?.[1]

    expect(rule).toContain('width: 9px;')
    expect(rule).toContain('margin-left: -5px;')
    expect(rule).toContain('margin-right: -4px;')
  })
})
