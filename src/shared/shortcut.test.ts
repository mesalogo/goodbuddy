import { describe, expect, it } from 'vitest'
import { formatShortcutForDisplay } from './shortcut'

describe('formatShortcutForDisplay', () => {
  it.each([
    ['win32', 'Ctrl+Shift+Space'],
    ['linux', 'Ctrl+Shift+Space'],
    ['darwin', 'Command+Shift+Space']
  ])('formats the launcher accelerator for %s', (platform, expected) => {
    expect(
      formatShortcutForDisplay(
        'CommandOrControl+Shift+Space',
        platform
      )
    ).toBe(expected)
  })
})
