import { describe, expect, it } from 'vitest'
import {
  areShortcutAcceleratorsEquivalent,
  canonicalizeShortcutAccelerator,
  formatShortcutForDisplay,
  globalShortcutSettingsSchema
} from './shortcut'

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

  it('canonicalizes recorder and typed accelerator aliases', () => {
    expect(canonicalizeShortcutAccelerator('ctrl + shift + space')).toBe(
      'Control+Shift+Space'
    )
    expect(
      globalShortcutSettingsSchema.parse({
        enabled: true,
        accelerator: 'cmdorctrl+alt+k'
      })
    ).toEqual({
      enabled: true,
      accelerator: 'CommandOrControl+Alt+K'
    })
  })

  it.each(['Space', 'Control+Shift', 'Control+A+B', 'Control+Nope'])(
    'rejects invalid accelerator %s',
    (accelerator) => {
      expect(() =>
        canonicalizeShortcutAccelerator(accelerator)
      ).toThrow()
    }
  )

  it.each([
    ['win32', 'CmdOrCtrl+Shift+K', 'Control+Shift+K', true],
    ['linux', 'Control+Shift+K', 'CommandOrControl+Shift+K', true],
    ['darwin', 'CmdOrCtrl+Shift+K', 'Command+Shift+K', true],
    ['darwin', 'Control+Shift+K', 'Command+Shift+K', false]
  ])(
    'compares physical accelerator aliases on %s',
    (platform, left, right, expected) => {
      expect(
        areShortcutAcceleratorsEquivalent(left, right, platform)
      ).toBe(expected)
    }
  )
})
