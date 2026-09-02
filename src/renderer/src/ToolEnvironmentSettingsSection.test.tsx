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
      version: 'Python 3.12.8',
      executablePath: 'C:\\GoodBuddy\\python.exe',
      detail: 'Ready'
    },
    pip: {
      available: true,
      source: 'managed',
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
    expect(screen.getAllByText('工具状态')).toHaveLength(2)
    expect(screen.getAllByText('工具链/配套工具状态')).toHaveLength(2)
    expect(screen.getAllByText('能力依赖状态')).toHaveLength(2)
    expect(
      screen.getByRole('button', {
        name: /C:\\Tools\\node\.exe/u
      })
    ).toHaveTextContent('22.14.0 · x64')
    expect(
      screen.getByText(
        /仅用于本机项目的新建本地 Runtime 进程和 stdio MCP Server/u
      )
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

  it('uses real diagnose, file selection, managed Python, and progress APIs', async () => {
    const onNotify = vi.fn()
    render(
      <ToolEnvironmentSettingsSection onNotify={onNotify} />
    )

    await screen.findByText('工具下载源')
    fireEvent.click(
      screen.getByRole('button', { name: '诊断全部' })
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
    fireEvent.click(
      within(pythonCard).getByRole('button', {
        name: '更新 Python'
      })
    )
    await waitFor(() => expect(installPython).toHaveBeenCalledOnce())

    act(() => {
      progressListener?.({
        snapshot: {
          ...baseSnapshot,
          managedPython: {
            ...baseSnapshot.managedPython,
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
      name: 'Python 安装或更新进度'
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
          name: 'Python 安装或更新进度'
        })
      ).not.toBeInTheDocument()
    )
    const updatedPythonCard = screen
      .getByRole('heading', { name: 'Python' })
      .closest('article')!
    fireEvent.click(
      within(updatedPythonCard).getByRole('button', {
        name: '移除 Python'
      })
    )
    expect(
      within(updatedPythonCard).getByText(
        /本机 Runtime 和 stdio MCP 将无法使用/u
      )
    ).toBeVisible()
    fireEvent.click(
      within(updatedPythonCard).getByRole('button', {
        name: '确认移除 Python'
      })
    )
    await waitFor(() => expect(removePython).toHaveBeenCalledOnce())
  })

  it('does not report a cancelled Python install as a failure', async () => {
    const onNotify = vi.fn()
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
      within(pythonCard).getByRole('button', { name: '更新 Python' })
    )
    await waitFor(() => expect(installPython).toHaveBeenCalledOnce())
    act(() => {
      progressListener?.({
        snapshot: {
          ...baseSnapshot,
          managedPython: {
            ...baseSnapshot.managedPython,
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
        screen.queryByText('安装或更新 Python 失败')
      ).not.toBeInTheDocument()
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onNotify).not.toHaveBeenCalled()
  })
})
