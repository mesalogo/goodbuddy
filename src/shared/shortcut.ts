import { z } from 'zod'

export const defaultGlobalShortcutSettings = {
  enabled: true,
  accelerator: 'CommandOrControl+Shift+Space'
} as const

const modifierAliases = new Map<string, string>([
  ['cmdorctrl', 'CommandOrControl'],
  ['commandorcontrol', 'CommandOrControl'],
  ['cmd', 'Command'],
  ['command', 'Command'],
  ['control', 'Control'],
  ['ctrl', 'Control'],
  ['option', 'Alt'],
  ['alt', 'Alt'],
  ['altgr', 'AltGr'],
  ['shift', 'Shift'],
  ['super', 'Super'],
  ['meta', 'Super']
])

const keyAliases = new Map<string, string>([
  ['space', 'Space'],
  ['spacebar', 'Space'],
  ['esc', 'Escape'],
  ['escape', 'Escape'],
  ['return', 'Enter'],
  ['enter', 'Enter'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
  ['del', 'Delete'],
  ['insert', 'Insert'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['tab', 'Tab'],
  ['up', 'Up'],
  ['arrowup', 'Up'],
  ['down', 'Down'],
  ['arrowdown', 'Down'],
  ['left', 'Left'],
  ['arrowleft', 'Left'],
  ['right', 'Right'],
  ['arrowright', 'Right']
])

export function canonicalizeShortcutAccelerator(
  accelerator: string
): string {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 2 || parts.length > 5) {
    throw new Error('Shortcut must contain modifiers and one key')
  }
  const modifiers: string[] = []
  let key: string | undefined
  for (const part of parts) {
    const normalized = part.toLowerCase()
    const modifier = modifierAliases.get(normalized)
    if (modifier) {
      if (modifiers.includes(modifier)) {
        throw new Error('Shortcut contains a duplicate modifier')
      }
      modifiers.push(modifier)
      continue
    }
    if (key) {
      throw new Error('Shortcut must contain exactly one non-modifier key')
    }
    const aliasedKey = keyAliases.get(normalized)
    if (aliasedKey) {
      key = aliasedKey
      continue
    }
    if (/^[a-z0-9]$/iu.test(part)) {
      key = part.toUpperCase()
      continue
    }
    const functionKey = /^f([1-9]|1\d|2[0-4])$/iu.exec(part)
    if (functionKey) {
      key = `F${functionKey[1]}`
      continue
    }
    throw new Error('Shortcut contains an unsupported key')
  }
  if (modifiers.length === 0 || !key) {
    throw new Error('Shortcut must contain modifiers and one key')
  }
  return [...modifiers, key].join('+')
}

export const shortcutAcceleratorSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .transform(canonicalizeShortcutAccelerator)

export const globalShortcutSettingsSchema = z
  .object({
    enabled: z.boolean(),
    accelerator: shortcutAcceleratorSchema
  })
  .strict()

export const globalShortcutSettingsUpdateSchema =
  globalShortcutSettingsSchema

export type GlobalShortcutSettings = z.infer<
  typeof globalShortcutSettingsSchema
>

export type GlobalShortcutRegistrationStatus =
  | 'registered'
  | 'disabled'
  | 'conflict'
  | 'failed'

export type GlobalShortcutSettingsSnapshot = {
  settings: GlobalShortcutSettings
  defaultSettings: GlobalShortcutSettings
  platform: string
  displayAccelerator: string
  registered: boolean
  registeredAccelerator?: string
  status: GlobalShortcutRegistrationStatus
}

export function areShortcutAcceleratorsEquivalent(
  left: string,
  right: string,
  platform: string
): boolean {
  const normalize = (accelerator: string): string => {
    const parts = canonicalizeShortcutAccelerator(accelerator).split('+')
    const key = parts.pop()
    const modifiers = parts
      .map((modifier) => {
        if (platform === 'darwin') {
          return modifier === 'CommandOrControl' ||
            modifier === 'Command'
            ? 'Command'
            : modifier
        }
        return modifier === 'CommandOrControl' ||
          modifier === 'Control'
          ? 'Control'
          : modifier
      })
      .sort()
    return [...modifiers, key].join('+')
  }
  return normalize(left) === normalize(right)
}

export type GlobalShortcutUpdateErrorCode =
  | 'conflict'
  | 'registration-failed'
  | 'save-failed'

export type GlobalShortcutSettingsUpdateResult =
  | {
      ok: true
      snapshot: GlobalShortcutSettingsSnapshot
    }
  | {
      ok: false
      error: GlobalShortcutUpdateErrorCode
      snapshot: GlobalShortcutSettingsSnapshot
    }

export function formatShortcutForDisplay(
  accelerator: string,
  platform: string
): string {
  return accelerator
    .split('+')
    .map((key) => {
      if (key === 'CommandOrControl' || key === 'CmdOrCtrl') {
        return platform === 'darwin' ? 'Command' : 'Ctrl'
      }
      if (key === 'Control' || key === 'Ctrl') {
        return 'Ctrl'
      }
      if (key === 'Cmd' || key === 'Command') {
        return 'Command'
      }
      return key
    })
    .join('+')
}
