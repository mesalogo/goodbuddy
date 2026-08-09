import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../shared/contracts'
import { UpdateSettingsSection } from './UpdateSettingsSection'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('UpdateSettingsSection', () => {
  it('checks the official release manifest and updates the startup preference', async () => {
    const updateSettings = vi.fn<
      NonNullable<DesktopApi['updates']>['updateSettings']
    >(async (input) => ({
      checkUpdatesOnStartup:
        input.checkUpdatesOnStartup ?? true,
      magicNotesEnabled: input.magicNotesEnabled ?? true
    }))
    const check = vi.fn<
      NonNullable<DesktopApi['updates']>['check']
    >(async () => ({
      updateAvailable: true,
      currentVersion: '0.8.1',
      latestVersion: '0.9.0',
      releaseUrl:
        'https://github.com/mesalogo/goodbuddy/releases/tag/v0.9.0',
      target: {
        platform: 'windows' as const,
        arch: 'x64' as const,
        formats: ['nsis', 'portable'],
        files: [
          {
            name: 'GoodBuddy-0.9.0-windows-x64-setup.exe',
            size: 1024 * 1024,
            sha256: 'a'.repeat(64)
          }
        ]
      }
    }))
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        app: {
          getInfo: vi.fn(async () => ({
            name: 'GoodBuddy',
            version: '0.8.1',
            platform: 'win32',
            arch: 'x64',
            shortcut: 'Ctrl+Shift+Space'
          }))
        },
        updates: {
          getSettings: vi.fn(async () => ({
            checkUpdatesOnStartup: true,
            magicNotesEnabled: true
          })),
          updateSettings,
          check,
          openReleasePage: vi.fn(),
          onResult: vi.fn(() => () => {})
        }
      } as unknown as DesktopApi
    })

    render(<UpdateSettingsSection />)
    const startup = await screen.findByRole('checkbox', {
      name: '启动时检查新版本'
    })
    expect(startup).toBeChecked()
    fireEvent.click(startup)
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        checkUpdatesOnStartup: false
      })
    )

    fireEvent.click(
      screen.getByRole('button', { name: '立即检查更新' })
    )
    expect(await screen.findByText('发现新版本 0.9.0'))
      .toBeInTheDocument()
    expect(
      screen.getByText('GoodBuddy-0.9.0-windows-x64-setup.exe')
    ).toBeInTheDocument()
  })

  it('replaces Electron fetch wrappers with an actionable network error', async () => {
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        app: {
          getInfo: vi.fn(async () => ({
            name: 'GoodBuddy',
            version: '0.8.1',
            platform: 'win32',
            arch: 'x64',
            shortcut: 'Ctrl+Shift+Space'
          }))
        },
        updates: {
          getSettings: vi.fn(async () => ({
            checkUpdatesOnStartup: true,
            magicNotesEnabled: true
          })),
          updateSettings: vi.fn(async () => ({
            checkUpdatesOnStartup: true,
            magicNotesEnabled: true
          })),
          check: vi.fn(async () => {
            throw new Error(
              "Error invoking remote method 'application:update:check': TypeError: fetch failed"
            )
          }),
          openReleasePage: vi.fn(),
          onResult: vi.fn(() => () => {})
        }
      } as unknown as DesktopApi
    })

    render(<UpdateSettingsSection />)
    fireEvent.click(
      await screen.findByRole('button', { name: '立即检查更新' })
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      '版本检查失败：无法连接 GoodBuddy 官方 GitHub Release，请检查网络或代理后重试'
    )
    expect(alert).not.toHaveTextContent('Error invoking remote method')
  })
})
