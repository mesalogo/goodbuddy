import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../shared/contracts'
import type {
  LocalToolEnvironmentProgress,
  LocalToolEnvironmentSnapshot
} from '../../shared/local-tool-environment-contracts'
import { changeUiLocale } from './i18n'
import { ToolEnvironmentSettingsSection } from './ToolEnvironmentSettingsSection'

const baseSnapshot: LocalToolEnvironmentSnapshot = {
  settings: {
    artifactDownloadSource: 'native',
    node: {
      source: 'custom',
      executablePath: 'C:\\Broken\\node.exe'
    },
    python: { source: 'managed' }
  },
  candidates: [
    {
      kind: 'node',
      executablePath: 'C:\\Tools\\node.exe',
      version: '22.14.0',
      architecture: 'x64'
    },
    {
      kind: 'python',
      executablePath: 'C:\\Python\\python.exe',
      version: '3.12.8',
      architecture: 'amd64'
    }
  ],
  diagnostics: {
    node: {
      available: false,
      source: 'custom',
      executablePath: 'C:\\Broken\\node.exe',
      detail: 'The selected executable could not be started.'
    },
    npm: {
      available: false,
      source: 'custom',
      detail: 'npm is unavailable.'
    },
    npx: {
      available: false,
      source: 'custom',
      detail: 'npx is unavailable.'
    },
    python: {
      available: true,
      source: 'managed',
      origin: 'managed',
      version: '3.12.8',
      executablePath: 'C:\\GoodBuddy\\python.exe',
      detail: 'Ready'
    },
    pip: {
      available: true,
      source: 'managed',
      origin: 'managed',
      version: 'pip 24.3',
      executablePath: 'C:\\GoodBuddy\\pip.exe',
      detail: 'Ready'
    }
  },
  managedPython: {
    version: '3.12.8',
    installed: true,
    executablePath: 'C:\\GoodBuddy\\python.exe'
  }
}

const notInstalledSnapshot: LocalToolEnvironmentSnapshot = {
  ...baseSnapshot,
  settings: { ...baseSnapshot.settings, python: { source: 'auto' } },
  diagnostics: {
    ...baseSnapshot.diagnostics,
    python: {
      available: false,
      source: 'auto',
      detail: 'No Python was found on PATH.'
    },
    pip: undefined
  },
  managedPython: { version: '3.12.8', installed: false }
}

describe('ToolEnvironmentSettingsSection', () => {
  let progressListener:
    | ((progress: LocalToolEnvironmentProgress) => void)
    | undefined
  const unsubscribe = vi.fn()
  const getSnapshot = vi.fn(async () => baseSnapshot)
  const updateSettings = vi.fn<
    NonNullable<DesktopApi['localToolEnvironment']>['updateSettings']
  >(async (settings) => ({ ...baseSnapshot, settings }))
  const refreshCandidates = vi.fn(async () => baseSnapshot)
  const selectExecutable = vi.fn(async () => baseSnapshot)
  const diagnose = vi.fn(async () => baseSnapshot)
  const installPython = vi.fn(async () => baseSnapshot)
  const cancelPython = vi.fn(async () => true)
  const removePython = vi.fn(async () => ({
    ...baseSnapshot,
    managedPython: {
      version: '3.12.8',
      installed: false
    }
  }))

  beforeEach(async () => {
    vi.clearAllMocks()
    await changeUiLocale('zh-CN')
    progressListener = undefined
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        localToolEnvironment: {
          getSnapshot,
          updateSettings,
          refreshCandidates,
          selectExecutable,
          diagnose,
          installPython,
          cancelPython,
          removePython,
          onProgress: (
            listener: (
              progress: LocalToolEnvironmentProgress
            ) => void
          ) => {
            progressListener = listener
            return unsubscribe
          }
        }
      } as unknown as DesktopApi
    })
  })

  afterEach(cleanup)

  it('loads and unsubscribes while preserving an invalid selected path', async () => {
    const view = render(<ToolEnvironmentSettingsSection />)

    expect(
      (await screen.findAllByText('C:\\Broken\\node.exe'))[0]
    ).toBeVisible()
    expect(screen.getByText('指定的 Node.js 不存在或无法运行')).toBeVisible()
    expect(
      screen.getByText('正在使用 GoodBuddy 内置 Python 3.12.8')
    ).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: /C:\\Tools\\node\.exe/u
      })
    ).toHaveTextContent('22.14.0 · x64')
    expect(
      screen.getByText(/不影响终端和远程 Host/u)
    ).toBeVisible()

    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('saves the full nested settings and rolls back a failed source change', async () => {
    const onNotify = vi.fn()
    updateSettings.mockRejectedValueOnce(new Error('source offline'))
    render(
      <ToolEnvironmentSettingsSection onNotify={onNotify} />
    )

    const sourceGroup = await screen.findByRole('group', {
      name: '选择工具制品下载源'
    })
    const native = within(sourceGroup).getByRole('radio', {
      name: /原生地址/u
    })
    const oss = within(sourceGroup).getByRole('radio', {
      name: /OSS 镜像/u
    })
    expect(native).toBeChecked()
    fireEvent.click(oss)

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        artifactDownloadSource: 'oss',
        node: {
          source: 'custom',
          executablePath: 'C:\\Broken\\node.exe'
        },
        python: { source: 'managed' }
      })
    )
    await waitFor(() => expect(native).toBeChecked())
    expect(screen.getByRole('alert')).toHaveTextContent('source offline')
    expect(onNotify).not.toHaveBeenCalled()
  })

  it('keeps custom Python operable without implicitly selecting the first candidate', async () => {
    render(<ToolEnvironmentSettingsSection />)

    const pythonCard = (
      await screen.findByRole('heading', { name: 'Python' })
    ).closest('article')!
    const custom = within(pythonCard).getByRole('radio', {
      name: /指定路径/u
    })
    expect(custom).toBeEnabled()
    expect(
      within(pythonCard).queryByRole('button', {
        name: /C:\\Python\\python\.exe/u
      })
    ).not.toBeInTheDocument()

    fireEvent.click(custom)

    expect(custom).toBeChecked()
    expect(updateSettings).not.toHaveBeenCalled()
    expect(
      within(pythonCard).getByText(/完成验证前不会更改当前执行环境/u)
    ).toBeVisible()
    const candidate = within(pythonCard).getByRole('button', {
      name: /C:\\Python\\python\.exe/u
    })
    expect(candidate).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(candidate)

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        ...baseSnapshot.settings,
        python: {
          source: 'custom',
          executablePath: 'C:\\Python\\python.exe'
        }
      })
    )
  })

  it('keeps file-picker cancellation quiet and shows validation errors inside the runtime card', async () => {
    const onNotify = vi.fn()
    selectExecutable
      .mockResolvedValueOnce(baseSnapshot)
      .mockRejectedValueOnce(new Error('Python 3 validation failed'))
    render(<ToolEnvironmentSettingsSection onNotify={onNotify} />)

    const pythonCard = (
      await screen.findByRole('heading', { name: 'Python' })
    ).closest('article')!
    fireEvent.click(
      within(pythonCard).getByRole('radio', {
        name: /指定路径/u
      })
    )
    const choose = within(pythonCard).getByRole('button', {
      name: '选择可执行文件'
    })

    fireEvent.click(choose)
    await waitFor(() =>
      expect(selectExecutable).toHaveBeenCalledWith('python')
    )
    expect(onNotify).not.toHaveBeenCalled()
    expect(within(pythonCard).queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(choose)
    expect(
      await within(pythonCard).findByRole('alert')
    ).toHaveTextContent('Python 3 validation failed')
    expect(onNotify).not.toHaveBeenCalled()
  })

  it('uses real diagnose, file selection, managed Python, and progress APIs', async () => {
    const onNotify = vi.fn()
    getSnapshot.mockResolvedValueOnce(notInstalledSnapshot)
    diagnose.mockResolvedValueOnce(notInstalledSnapshot)
    diagnose.mockResolvedValueOnce(notInstalledSnapshot)
    selectExecutable.mockResolvedValueOnce(notInstalledSnapshot)
    render(
      <ToolEnvironmentSettingsSection onNotify={onNotify} />
    )

    await screen.findByText('工具下载源')
    fireEvent.click(
      screen.getByRole('button', { name: '重新检测' })
    )
    await waitFor(() => expect(diagnose).toHaveBeenCalledWith('all'))

    const nodeCard = screen
      .getByRole('heading', { name: 'Node.js' })
      .closest('article')!
    fireEvent.click(
      within(nodeCard).getByRole('button', {
        name: '选择可执行文件'
      })
    )
    await waitFor(() =>
      expect(selectExecutable).toHaveBeenCalledWith('node')
    )

    const pythonCard = (
      await screen.findByRole('heading', { name: 'Python' })
    ).closest('article')!
    expect(
      within(pythonCard).getByText(
        '未找到 Python：系统 PATH 中没有，内置 Python 也未安装'
      )
    ).toBeVisible()
    fireEvent.click(
      within(pythonCard).getByRole('button', {
        name: '安装内置 Python'
      })
    )
    await waitFor(() => expect(installPython).toHaveBeenCalledOnce())

    act(() => {
      progressListener?.({
        snapshot: {
          ...notInstalledSnapshot,
          managedPython: {
            ...notInstalledSnapshot.managedPython,
            operation: {
              source: 'native',
              phase: 'downloading',
              receivedBytes: 50,
              totalBytes: 100
            }
          }
        }
      })
    })
    const progress = await screen.findByRole('progressbar', {
      name: 'Python 安装进度'
    })
    expect(progress).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText('下载源：原生地址')).toBeVisible()
    fireEvent.click(
      within(pythonCard).getByRole('button', { name: '取消' })
    )
    await waitFor(() => expect(cancelPython).toHaveBeenCalledOnce())

    act(() => {
      progressListener?.({ snapshot: baseSnapshot })
    })
    await waitFor(() =>
      expect(
        screen.queryByRole('progressbar', {
          name: 'Python 安装进度'
        })
      ).not.toBeInTheDocument()
    )
    const updatedPythonCard = screen
      .getByRole('heading', { name: 'Python' })
      .closest('article')!
    fireEvent.click(
      within(updatedPythonCard).getByRole('button', {
        name: '移除内置 Python'
      })
    )
    expect(
      within(updatedPythonCard).getByText(
        /自动模式会改用系统 PATH 中的 Python/u
      )
    ).toBeVisible()
    fireEvent.click(
      within(updatedPythonCard).getByRole('button', {
        name: '确认移除'
      })
    )
    await waitFor(() => expect(removePython).toHaveBeenCalledOnce())
  })

  it('hides the built-in Python controls when a specific path is selected', async () => {
    const customPython: LocalToolEnvironmentSnapshot = {
      ...baseSnapshot,
      settings: {
        ...baseSnapshot.settings,
        python: { source: 'custom', executablePath: 'C:\\Python\\python.exe' }
      }
    }
    getSnapshot.mockResolvedValueOnce(customPython)
    diagnose.mockResolvedValueOnce(customPython)
    render(<ToolEnvironmentSettingsSection />)
    const pythonCard = (
      await screen.findByRole('heading', { name: 'Python' })
    ).closest('article')!
    expect(
      within(pythonCard).queryByRole('button', { name: /内置 Python/u })
    ).not.toBeInTheDocument()
  })

  it('detects the tools once when the page opens', async () => {
    render(<ToolEnvironmentSettingsSection />)
    await waitFor(() => expect(diagnose).toHaveBeenCalledWith('all'))
    expect(diagnose).toHaveBeenCalledOnce()
  })

  it('explains a broken system program instead of reporting it missing', async () => {
    const broken: LocalToolEnvironmentSnapshot = {
      ...notInstalledSnapshot,
      diagnostics: {
        ...notInstalledSnapshot.diagnostics,
        python: {
          available: false,
          source: 'auto',
          origin: 'system',
          executablePath: 'C:\\Python39\\python.exe',
          detail: 'python was found but could not run (exit).'
        }
      }
    }
    diagnose.mockResolvedValueOnce(broken)
    render(<ToolEnvironmentSettingsSection />)
    expect(
      await screen.findByText(/系统 PATH 中的 Python 无法运行/u)
    ).toBeVisible()
    expect(screen.getByText('C:\\Python39\\python.exe')).toBeVisible()
  })

  it('switches to automatic detection with one click', async () => {
    render(<ToolEnvironmentSettingsSection />)
    const nodeCard = (
      await screen.findByRole('heading', { name: 'Node.js' })
    ).closest('article')!
    fireEvent.click(within(nodeCard).getByRole('radio', { name: /自动/u }))
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        ...baseSnapshot.settings,
        node: { source: 'auto' }
      })
    )
  })

  it('does not report a cancelled Python install as a failure', async () => {
    const onNotify = vi.fn()
    getSnapshot.mockResolvedValueOnce(notInstalledSnapshot)
    diagnose.mockResolvedValueOnce(notInstalledSnapshot)
    let rejectInstall!: (reason: unknown) => void
    installPython.mockImplementationOnce(
      () =>
        new Promise<LocalToolEnvironmentSnapshot>((_resolve, reject) => {
          rejectInstall = reject
        })
    )
    render(<ToolEnvironmentSettingsSection onNotify={onNotify} />)

    const pythonCard = (
      await screen.findByRole('heading', { name: 'Python' })
    ).closest('article')!
    fireEvent.click(
      within(pythonCard).getByRole('button', { name: '安装内置 Python' })
    )
    await waitFor(() => expect(installPython).toHaveBeenCalledOnce())
    act(() => {
      progressListener?.({
        snapshot: {
          ...notInstalledSnapshot,
          managedPython: {
            ...notInstalledSnapshot.managedPython,
            operation: {
              source: 'oss',
              phase: 'validating'
            }
          }
        }
      })
    })
    expect(await screen.findByText('下载源：OSS 镜像')).toBeVisible()

    fireEvent.click(
      within(pythonCard).getByRole('button', { name: '取消' })
    )
    await waitFor(() => expect(cancelPython).toHaveBeenCalledOnce())
    act(() => {
      progressListener?.({ snapshot: baseSnapshot })
      rejectInstall(
        new Error(
          "Error invoking remote method 'local-tool-environment:install-python': AbortError: Managed Python operation cancelled"
        )
      )
    })

    await waitFor(() =>
      expect(
        screen.queryByText('安装内置 Python 失败')
      ).not.toBeInTheDocument()
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onNotify).not.toHaveBeenCalled()
  })
})
