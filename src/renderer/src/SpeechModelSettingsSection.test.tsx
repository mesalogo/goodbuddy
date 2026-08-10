import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpeechModelSnapshot } from '../../shared/speech-model-contracts'
import type { DesktopApi } from '../../shared/contracts'
import { SpeechModelSettingsSection } from './SpeechModelSettingsSection'

const entry = {
  id: 'sensevoice-small-int8',
  displayName: 'SenseVoiceSmall INT8',
  description: '快速中文语音识别。',
  languages: ['中文', '粤语'],
  family: 'sensevoice' as const,
  quantization: 'int8' as const,
  quality: 'high' as const,
  speed: 'fast' as const,
  recommended: true,
  repositoryUrl: 'https://huggingface.co/example/model',
  license: {
    name: '模型仓库自定义许可',
    notice: '使用前请阅读许可。',
    url: 'https://example.com/license'
  },
  manualOnly: false,
  files: [
    {
      name: 'model.int8.onnx',
      role: 'model' as const,
      download: {
        url: 'https://huggingface.co/example/model/resolve/revision/model.int8.onnx',
        size: 1_000,
        sha256: 'a'.repeat(64)
      }
    },
    {
      name: 'tokens.txt',
      role: 'tokens' as const,
      download: {
        url: 'https://huggingface.co/example/model/resolve/revision/tokens.txt',
        size: 100,
        sha256: 'b'.repeat(64)
      }
    }
  ]
}

const snapshot: SpeechModelSnapshot = {
  rootDirectory: 'C:\\Users\\test\\models\\speech',
  catalog: [entry],
  installed: [],
  operations: [],
  selectedModelId: null
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SpeechModelSettingsSection', () => {
  it('lists downloadable models and starts a verified download', async () => {
    const installedSnapshot: SpeechModelSnapshot = {
      ...snapshot,
      installed: [
        {
          id: entry.id,
          displayName: entry.displayName,
          source: 'download',
          installedAt: '2026-08-06T00:00:00.000Z',
          files: [
            {
              name: 'model.int8.onnx',
              role: 'model',
              size: 1_000,
              sha256: 'a'.repeat(64)
            }
          ]
        }
      ]
    }
    const install = vi.fn(async () => installedSnapshot)
    const onNotify = vi.fn()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        speechModels: {
          getSnapshot: vi.fn(async () => snapshot),
          install,
          cancel: vi.fn(async () => true),
          remove: vi.fn(),
          select: vi.fn(),
          importLocalDirectory: vi.fn(),
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    render(<SpeechModelSettingsSection onNotify={onNotify} />)
    expect(await screen.findByText('SenseVoiceSmall INT8'))
      .toBeInTheDocument()
    expect(screen.getByText('推荐')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {
      name: '下载 SenseVoiceSmall INT8'
    }))

    await waitFor(() =>
      expect(install).toHaveBeenCalledWith('sensevoice-small-int8')
    )
    expect(onNotify).toHaveBeenCalledWith({
      tone: 'success',
      message: 'SenseVoiceSmall INT8 已安装',
      dedupeKey: 'speech-model-sensevoice-small-int8'
    })
  })

  it('offers a download button for a verified Whisper model', async () => {
    const whisperEntry = {
      ...entry,
      id: 'whisper-tiny-multilingual',
      displayName: 'Whisper Tiny（多语言）',
      family: 'whisper' as const,
      files: [
        {
          ...entry.files[0],
          name: 'tiny-encoder.int8.onnx',
          role: 'encoder' as const
        }
      ]
    }
    const whisperSnapshot: SpeechModelSnapshot = {
      ...snapshot,
      catalog: [whisperEntry]
    }
    const install = vi.fn(async () => whisperSnapshot)
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        speechModels: {
          getSnapshot: vi.fn(async () => whisperSnapshot),
          install,
          cancel: vi.fn(async () => true),
          remove: vi.fn(),
          select: vi.fn(),
          importLocalDirectory: vi.fn(),
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    render(<SpeechModelSettingsSection />)
    expect(await screen.findByText('Whisper Tiny（多语言）'))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {
      name: '下载 Whisper Tiny（多语言）'
    }))

    await waitFor(() =>
      expect(install).toHaveBeenCalledWith('whisper-tiny-multilingual')
    )
  })

  it('shows live progress and cancellation for an active download', async () => {
    const active: SpeechModelSnapshot = {
      ...snapshot,
      operations: [
        {
          modelId: entry.id,
          kind: 'download',
          phase: 'transferring',
          currentFile: 'model.int8.onnx',
          completedBytes: 550,
          totalBytes: 1_100
        }
      ]
    }
    const cancel = vi.fn(async () => true)
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        speechModels: {
          getSnapshot: vi.fn(async () => active),
          install: vi.fn(),
          cancel,
          remove: vi.fn(),
          select: vi.fn(),
          importLocalDirectory: vi.fn(),
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    render(<SpeechModelSettingsSection />)
    expect(await screen.findByRole('progressbar', {
      name: 'SenseVoiceSmall INT8下载进度'
    })).toHaveValue(50)
    fireEvent.click(screen.getByRole('button', {
      name: '取消 SenseVoiceSmall INT8 操作'
    }))
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith('sensevoice-small-int8')
    )
  })

  it('resumes polling an active download after remounting', async () => {
    const active: SpeechModelSnapshot = {
      ...snapshot,
      operations: [
        {
          modelId: entry.id,
          kind: 'download',
          phase: 'transferring',
          currentFile: 'model.int8.onnx',
          completedBytes: 550,
          totalBytes: 1_100
        }
      ]
    }
    const completed: SpeechModelSnapshot = {
      ...snapshot,
      installed: [
        {
          id: entry.id,
          displayName: entry.displayName,
          source: 'download',
          installedAt: '2026-08-06T00:00:00.000Z',
          files: [
            {
              name: 'model.int8.onnx',
              role: 'model',
              size: 1_000,
              sha256: 'a'.repeat(64)
            }
          ]
        }
      ]
    }
    const getSnapshot = vi
      .fn<() => Promise<SpeechModelSnapshot>>()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(active)
      .mockResolvedValue(completed)
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        speechModels: {
          getSnapshot,
          install: vi.fn(),
          cancel: vi.fn(async () => true),
          remove: vi.fn(),
          select: vi.fn(),
          importLocalDirectory: vi.fn(),
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    const first = render(<SpeechModelSettingsSection />)
    expect(await screen.findByRole('progressbar')).toBeInTheDocument()
    first.unmount()
    render(<SpeechModelSettingsSection />)
    expect(await screen.findByRole('progressbar')).toBeInTheDocument()

    await waitFor(
      () => {
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
        expect(screen.getByText('已安装')).toBeInTheDocument()
      },
      { timeout: 1_000 }
    )
    expect(getSnapshot.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('shows installed and selected states and switches with a radio choice', async () => {
    const installed = {
      id: entry.id,
      displayName: entry.displayName,
      source: 'download' as const,
      installedAt: '2026-08-06T00:00:00.000Z',
      files: [
        {
          name: 'model.int8.onnx',
          role: 'model' as const,
          size: 1_000,
          sha256: 'a'.repeat(64)
        }
      ]
    }
    const installedSnapshot: SpeechModelSnapshot = {
      ...snapshot,
      installed: [installed]
    }
    const selectedSnapshot: SpeechModelSnapshot = {
      ...installedSnapshot,
      selectedModelId: entry.id
    }
    let currentSnapshot = installedSnapshot
    const select = vi.fn(async () => {
      currentSnapshot = selectedSnapshot
      return selectedSnapshot
    })
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        speechModels: {
          getSnapshot: vi.fn(async () => currentSnapshot),
          install: vi.fn(),
          cancel: vi.fn(async () => true),
          remove: vi.fn(),
          select,
          importLocalDirectory: vi.fn(),
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    render(<SpeechModelSettingsSection />)
    const choice = await screen.findByRole('radio', {
      name: '使用 SenseVoiceSmall INT8'
    })
    expect(choice).not.toBeChecked()
    expect(screen.getByText('已安装')).toBeInTheDocument()

    fireEvent.click(choice)
    await waitFor(() =>
      expect(select).toHaveBeenCalledWith('sensevoice-small-int8')
    )
    expect(await screen.findByText('正在使用')).toBeInTheDocument()
    expect(choice).toBeChecked()
  })
})
