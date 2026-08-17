import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { dirname, join, resolve, win32 } from 'node:path'
import type { ShortcutDetails } from 'electron'

export const WINDOWS_APP_USER_MODEL_ID = 'live.digiman.goodbuddy'

const windowsUninstallerName = 'Uninstall GoodBuddy.exe'
const standaloneIdentityPrefix = `${WINDOWS_APP_USER_MODEL_ID}.standalone`
const knownShortcutNames = ['Electron.lnk', 'GoodBuddy.lnk'] as const

interface ShortcutAccess {
  readShortcutLink(shortcutPath: string): ShortcutDetails
  writeShortcutLink(
    shortcutPath: string,
    operation: 'update',
    options: ShortcutDetails
  ): boolean
}

export interface WindowsNotificationShortcutRepairResult {
  scanned: number
  repaired: number
  failed: number
}

function normalizeWindowsExecutablePath(executablePath: string): string {
  return win32.resolve(executablePath).toLocaleLowerCase('en-US')
}

function resolveStandaloneWindowsAppUserModelId(
  executablePath: string
): string {
  const executableHash = createHash('sha256')
    .update(normalizeWindowsExecutablePath(executablePath))
    .digest('hex')
    .slice(0, 24)
  return `${standaloneIdentityPrefix}.${executableHash}`
}

export function isInstalledWindowsBuild(input: {
  packaged: boolean
  platform: NodeJS.Platform
  executablePath: string
}): boolean {
  if (!input.packaged || input.platform !== 'win32') {
    return false
  }
  try {
    const uninstallerPath = join(
      dirname(resolve(input.executablePath)),
      windowsUninstallerName
    )
    return statSync(uninstallerPath, {
      throwIfNoEntry: false
    })?.isFile() === true
  } catch {
    return false
  }
}

export function resolveWindowsAppUserModelId(input: {
  installed: boolean
  executablePath: string
}): string {
  return input.installed
    ? WINDOWS_APP_USER_MODEL_ID
    : resolveStandaloneWindowsAppUserModelId(input.executablePath)
}

export async function repairStaleWindowsNotificationShortcuts(input: {
  platform: NodeJS.Platform
  installed: boolean
  executablePath: string
  programsDirectory: string
  shortcutAccess: ShortcutAccess
}): Promise<WindowsNotificationShortcutRepairResult> {
  if (input.platform !== 'win32' || !input.installed) {
    return { scanned: 0, repaired: 0, failed: 0 }
  }

  const shortcutPaths = knownShortcutNames.map((shortcutName) =>
    join(input.programsDirectory, shortcutName)
  )
  const currentExecutablePath = normalizeWindowsExecutablePath(
    input.executablePath
  )
  let scanned = 0
  let repaired = 0
  let failed = 0

  for (const shortcutPath of shortcutPaths) {
    let details: ShortcutDetails
    try {
      details = input.shortcutAccess.readShortcutLink(shortcutPath)
    } catch {
      continue
    }
    scanned += 1
    if (
      details.appUserModelId !== WINDOWS_APP_USER_MODEL_ID ||
      normalizeWindowsExecutablePath(details.target) ===
        currentExecutablePath
    ) {
      continue
    }

    try {
      const updated = input.shortcutAccess.writeShortcutLink(
        shortcutPath,
        'update',
        {
          ...details,
          appUserModelId:
            resolveStandaloneWindowsAppUserModelId(details.target)
        }
      )
      if (updated) {
        repaired += 1
      } else {
        failed += 1
      }
    } catch {
      failed += 1
    }
  }

  return {
    scanned,
    repaired,
    failed
  }
}
