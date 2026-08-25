import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationSettings } from '../../shared/application-settings-contracts'
import type { DesktopApi } from '../../shared/contracts'
import { UpdateSettingsSection } from './UpdateSettingsSection'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('UpdateSettingsSection', () => {
  it('checks the official release manifest and updates the startup preference', async () => {
    let applicationSettings: ApplicationSettings = {
      checkUpdatesOnStartup: true,
      updateSource: 'github',
      modelDownloadSource: 'modelscope',
      remoteProjectsEnabled: false,
      magicNotesEnabled: true,
      magicNotesShowIncompleteTodoCount: true,
      magicNoteCommentMode: 'immediate' as const,
      magicNoteCommentFormat: 'combined' as const
    }
    const updateSettings = vi.fn<
      NonNullable<DesktopApi['updates']>['updateSettings']
    >(async (input) => {
      applicationSettings = {
        ...applicationSettings,
        ...input
      }
      return applicationSettings
    })
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
        feedback: {
          submit: vi.fn(async () => ({
            ok: true as const,
            reference: 'GOODBUDDY-000001',
            duplicate: false
          }))
        },
        updates: {
          getSettings: vi.fn(async () => ({
            ...applicationSettings
          })),
          updateSettings,
          check,
          openReleasePage: vi.fn(),
          onResult: vi.fn(() => () => {})
        }
      } as unknown as DesktopApi
    })

    render(<UpdateSettingsSection />)
    const startup = await screen.findByRole('switch', {
      name: '启动时检查新版本'
    })
    expect(startup).toBeChecked()
    const source = screen.getByRole('combobox', {
      name: '检查更新源'
    })
    const startupRow = startup.closest('label')
    const sourceRow = source.closest('label')
    expect(source).toHaveValue('github')
    expect(sourceRow).toHaveClass('update-settings__source')
    expect(
      startupRow!.compareDocumentPosition(sourceRow!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(source).toBeEnabled()
    fireEvent.change(source, { target: { value: 'mirror' } })
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        updateSource: 'mirror'
      })
    )
    expect(source).toHaveValue('mirror')
    expect(
      screen.getByRole('option', { name: '镜像节点' })
    ).toBeInTheDocument()

    fireEvent.click(startup)
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        checkUpdatesOnStartup: false
      })
    )
    expect(source).toBeDisabled()

    fireEvent.click(
      screen.getByRole('button', { name: '立即检查更新' })
    )
    expect(await screen.findByText('发现新版本 0.9.0'))
      .toBeInTheDocument()
    expect(
      screen.getByText('GoodBuddy-0.9.0-windows-x64-setup.exe')
    ).toBeInTheDocument()

    const feedbackTrigger = screen.getByRole('button', {
      name: '提交反馈'
    })
    feedbackTrigger.focus()
    fireEvent.click(feedbackTrigger)
    const dialog = screen.getByRole('dialog', {
      name: '提交反馈'
    })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByLabelText('反馈类型')).toHaveFocus()
    expect(
      screen.getByText(/不会自动发送对话、日志、文件/)
    ).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(
      screen.queryByRole('dialog', { name: '提交反馈' })
    ).not.toBeInTheDocument()
    expect(feedbackTrigger).toHaveFocus()
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
            updateSource: 'github',
            magicNotesEnabled: true,
            magicNoteCommentMode: 'immediate',
            magicNoteCommentFormat: 'combined'
          })),
          updateSettings: vi.fn(async () => ({
            checkUpdatesOnStartup: true,
            updateSource: 'github',
            magicNotesEnabled: true,
            magicNoteCommentMode: 'immediate',
            magicNoteCommentFormat: 'combined'
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
      '版本检查失败：无法连接更新源“GitHub”，请检查网络或代理后重试'
    )
    expect(alert).not.toHaveTextContent('Error invoking remote method')
  })

  it('keeps feedback available when update settings are unavailable', async () => {
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        app: {
          getInfo: vi.fn(async () => ({
            name: 'GoodBuddy',
            version: '0.11.0',
            platform: 'linux',
            arch: 'arm64',
            shortcut: 'Ctrl+Shift+Space'
          }))
        },
        feedback: {
          submit: vi.fn(async () => ({
            ok: true as const,
            reference: 'GOODBUDDY-000010',
            duplicate: false
          }))
        }
      } as unknown as DesktopApi
    })

    render(<UpdateSettingsSection />)
    const feedbackTrigger = await screen.findByRole('button', {
      name: '提交反馈'
    })
    expect(feedbackTrigger).toBeEnabled()
    fireEvent.click(feedbackTrigger)
    expect(
      screen.getByRole('dialog', { name: '提交反馈' })
    ).toBeInTheDocument()
    expect(
      screen.queryByText('反馈服务当前不可用')
    ).not.toBeInTheDocument()
  })
})
