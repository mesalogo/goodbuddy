import {
  mkdtemp,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShortcutDetails } from 'electron'
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import {
  isInstalledWindowsBuild,
  repairStaleWindowsNotificationShortcuts,
  resolveWindowsAppUserModelId,
  WINDOWS_APP_USER_MODEL_ID
} from './windows-notification-identity'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'goodbuddy-notification-identity-')
  )
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
  )
})

describe('Windows notification identity', () => {
  it('reserves the production AUMID for an installed build', () => {
    expect(
      resolveWindowsAppUserModelId({
        installed: true,
        executablePath: 'C:\\Program Files\\GoodBuddy\\GoodBuddy.exe'
      })
    ).toBe(WINDOWS_APP_USER_MODEL_ID)
  })

  it('uses stable path-scoped identities for standalone builds', () => {
    const first = resolveWindowsAppUserModelId({
      installed: false,
      executablePath: 'D:\\repo\\GoodBuddy.exe'
    })

    expect(first).not.toBe(WINDOWS_APP_USER_MODEL_ID)
    expect(
      resolveWindowsAppUserModelId({
        installed: false,
        executablePath: 'd:\\REPO\\goodbuddy.exe'
      })
    ).toBe(first)
    expect(
      resolveWindowsAppUserModelId({
        installed: false,
        executablePath: 'D:\\other\\GoodBuddy.exe'
      })
    ).not.toBe(first)
  })

  it('recognizes only packaged Windows layouts with an uninstaller', async () => {
    const directory = await createTemporaryDirectory()
    const executablePath = join(directory, 'GoodBuddy.exe')
    await writeFile(join(directory, 'Uninstall GoodBuddy.exe'), '')

    expect(
      isInstalledWindowsBuild({
        packaged: true,
        platform: 'win32',
        executablePath
      })
    ).toBe(true)
    expect(
      isInstalledWindowsBuild({
        packaged: false,
        platform: 'win32',
        executablePath
      })
    ).toBe(false)
    expect(
      isInstalledWindowsBuild({
        packaged: true,
        platform: 'linux',
        executablePath
      })
    ).toBe(false)
    expect(
      isInstalledWindowsBuild({
        packaged: true,
        platform: 'win32',
        executablePath: '\0'
      })
    ).toBe(false)
  })

  it('moves stale shortcuts off the production identity without changing their targets', async () => {
    const programsDirectory = await createTemporaryDirectory()
    const stalePath = join(programsDirectory, 'Electron.lnk')
    const currentPath = join(programsDirectory, 'GoodBuddy.lnk')
    await Promise.all([
      writeFile(stalePath, ''),
      writeFile(currentPath, '')
    ])

    const staleDetails: ShortcutDetails = {
      target: 'D:\\repo\\node_modules\\electron\\electron.exe',
      appUserModelId: WINDOWS_APP_USER_MODEL_ID,
      toastActivatorClsid:
        '{6D4C974B-001A-47E5-AE4B-F8F12FFDA281}'
    }
    const details = new Map<string, ShortcutDetails>([
      [stalePath, staleDetails],
      [
        currentPath,
        {
          target:
            'C:\\Program Files\\GoodBuddy\\GoodBuddy.exe',
          appUserModelId: WINDOWS_APP_USER_MODEL_ID
        }
      ]
    ])
    const writeShortcutLink = vi.fn(() => true)

    await expect(
      repairStaleWindowsNotificationShortcuts({
        platform: 'win32',
        installed: true,
        executablePath:
          'C:\\Program Files\\GoodBuddy\\GoodBuddy.exe',
        programsDirectory,
        shortcutAccess: {
          readShortcutLink: (shortcutPath) =>
            details.get(shortcutPath)!,
          writeShortcutLink
        }
      })
    ).resolves.toEqual({
      scanned: 2,
      repaired: 1,
      failed: 0
    })
    expect(writeShortcutLink).toHaveBeenCalledOnce()
    expect(writeShortcutLink).toHaveBeenCalledWith(
      stalePath,
      'update',
      expect.objectContaining({
        target: staleDetails.target,
        toastActivatorClsid: staleDetails.toastActivatorClsid,
        appUserModelId: expect.not.stringMatching(
          /^live\.digiman\.goodbuddy$/u
        )
      })
    )
  })

  it('does not touch shortcuts from development or portable builds', async () => {
    const programsDirectory = await createTemporaryDirectory()
    await writeFile(join(programsDirectory, 'Electron.lnk'), '')
    const readShortcutLink = vi.fn()
    const writeShortcutLink = vi.fn()

    await expect(
      repairStaleWindowsNotificationShortcuts({
        platform: 'win32',
        installed: false,
        executablePath: 'D:\\repo\\GoodBuddy.exe',
        programsDirectory,
        shortcutAccess: {
          readShortcutLink,
          writeShortcutLink
        }
      })
    ).resolves.toEqual({
      scanned: 0,
      repaired: 0,
      failed: 0
    })
    expect(readShortcutLink).not.toHaveBeenCalled()
    expect(writeShortcutLink).not.toHaveBeenCalled()
  })
})
