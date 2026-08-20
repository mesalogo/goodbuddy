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
import { changeUiLocale } from './i18n'
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
      size: 1_000,
      sha256: 'a'.repeat(64)
    },
    {
      name: 'tokens.txt',
      role: 'tokens' as const,
      size: 100,
      sha256: 'b'.repeat(64)
    }
  ],
  downloadAvailability: [
    {
      source: 'modelscope' as const,
      available: true,
      totalBytes: 1_100
    },
    {
      source: 'hugging-face' as const,
      available: true,
      totalBytes: 1_100
    }
  ]
}

const snapshot: SpeechModelSnapshot = {
  rootDirectory: 'C:\\Users\\test\\models\\speech',
  selectedDownloadSource: 'modelscope',
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
  it('renders speech model controls and metadata in English', async () => {
    await changeUiLocale('en-US')
    const openRepository = vi.fn()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        speechModels: {
          getSnapshot: vi.fn(async () => snapshot),
          install: vi.fn(),
          cancel: vi.fn(async () => true),
          remove: vi.fn(),
          select: vi.fn(),
          importArchive: vi.fn(),
          exportArchive: vi.fn(),
          openRepository,
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    render(<SpeechModelSettingsSection />)

    expect(
      await screen.findByText('Speech models')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', {
        name: 'Current speech model'
      })
    ).toHaveValue('sensevoice-small-int8')
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    expect(screen.getByText('Chinese / Cantonese')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Download SenseVoiceSmall INT8'
      })
    ).toBeInTheDocument()
    expect(screen.getByText('模型仓库自定义许可')).toBeInTheDocument()
    expect(screen.queryByText('Model details')).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open the ModelScope repository for SenseVoiceSmall INT8'
      })
    )
    expect(openRepository).toHaveBeenCalledWith('sensevoice-small-int8')
  })

  it('shows the selected download source artifact size', async () => {
    await changeUiLocale('en-US')
    const sourceSpecificSnapshot: SpeechModelSnapshot = {
      ...snapshot,
      catalog: [
        {
          ...entry,
          downloadAvailability: [
            {
              source: 'modelscope',
              available: true,
              totalBytes: 2 * 1024 * 1024
            },
            {
              source: 'hugging-face',
              available: true,
              totalBytes: 1_100
            }
          ]
        }
      ]
    }
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        speechModels: {
          getSnapshot: vi.fn(async () => sourceSpecificSnapshot),
          install: vi.fn(),
          cancel: vi.fn(async () => true),
          remove: vi.fn(),
          select: vi.fn(),
          importArchive: vi.fn(),
          exportArchive: vi.fn(),
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    render(<SpeechModelSettingsSection />)

    expect(await screen.findByText('2.0 MB')).toBeInTheDocument()
  })

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
          importArchive: vi.fn(),
          exportArchive: vi.fn(),
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
      expect(install).toHaveBeenCalledWith(
        'sensevoice-small-int8',
        'modelscope'
      )
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
          ...entry.files[0]!,
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
          importArchive: vi.fn(),
          exportArchive: vi.fn(),
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
      expect(install).toHaveBeenCalledWith(
        'whisper-tiny-multilingual',
        'modelscope'
      )
    )
  })

  it('keeps an unavailable source explicit and offers General settings', async () => {
    await changeUiLocale('zh-CN')
    const onOpenModelDownloadSourceSettings = vi.fn()
    const unavailableSnapshot: SpeechModelSnapshot = {
      ...snapshot,
      catalog: [
        {
          ...entry,
          downloadAvailability: [
            {
              source: 'modelscope',
              available: false,
              unavailableReason:
                '当前下载源暂不提供此模型的完整已验证文件'
            },
            {
              source: 'hugging-face',
              available: true,
              totalBytes: 1_100
            }
          ]
        }
      ]
    }
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        speechModels: {
          getSnapshot: vi.fn(async () => unavailableSnapshot),
          install: vi.fn(),
          cancel: vi.fn(async () => true),
          remove: vi.fn(),
          select: vi.fn(),
          importArchive: vi.fn(),
          exportArchive: vi.fn(),
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    render(
      <SpeechModelSettingsSection
        onOpenModelDownloadSourceSettings={
          onOpenModelDownloadSourceSettings
        }
      />
    )

    expect(
      await screen.findByText('当前来源不可下载')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: '下载 SenseVoiceSmall INT8'
      })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: '打开 SenseVoiceSmall INT8 的 ModelScope 模型仓库'
      })
    ).toBeDisabled()
    fireEvent.click(
      screen.getByRole('button', { name: '前往通用设置' })
    )
    expect(onOpenModelDownloadSourceSettings).toHaveBeenCalledOnce()
  })

  it('imports and exports verified speech model ZIP archives', async () => {
    const installedSnapshot: SpeechModelSnapshot = {
      ...snapshot,
      installed: [
        {
          id: entry.id,
          displayName: entry.displayName,
          source: 'local',
          installedAt: '2026-08-11T00:00:00.000Z',
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
    const importArchive = vi.fn(async () => installedSnapshot)
    const exportArchive = vi.fn(async () => installedSnapshot)
    const select = vi.fn()
    const onNotify = vi.fn()
    const getSnapshot = vi
      .fn<() => Promise<SpeechModelSnapshot>>()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue(installedSnapshot)
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        speechModels: {
          getSnapshot,
          install: vi.fn(),
          cancel: vi.fn(async () => true),
          remove: vi.fn(),
          select,
          importArchive,
          exportArchive,
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    render(<SpeechModelSettingsSection onNotify={onNotify} />)
    fireEvent.click(
      await screen.findByRole('button', {
        name: '从 ZIP 导入 SenseVoiceSmall INT8'
      })
    )
    await waitFor(() =>
      expect(importArchive).toHaveBeenCalledWith(
        'sensevoice-small-int8'
      )
    )
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'SenseVoiceSmall INT8 已从 ZIP 导入'
      })
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: '将 SenseVoiceSmall INT8 导出为 ZIP'
      })
    )
    await waitFor(() =>
      expect(exportArchive).toHaveBeenCalledWith(
        'sensevoice-small-int8'
      )
    )
    expect(select).not.toHaveBeenCalled()
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'SenseVoiceSmall INT8 已导出为 ZIP'
      })
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
          totalBytes: 1_100,
          downloadSource: 'modelscope'
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
          importArchive: vi.fn(),
          exportArchive: vi.fn(),
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    render(<SpeechModelSettingsSection />)
    expect(await screen.findByRole('progressbar', {
      name: 'SenseVoiceSmall INT8下载进度'
    })).toHaveValue(50)
    expect(screen.getByText('正在从 ModelScope 下载')).toBeInTheDocument()
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
          totalBytes: 1_100,
          downloadSource: 'modelscope'
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
          importArchive: vi.fn(),
          exportArchive: vi.fn(),
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
      { timeout: 1_500 }
    )
    expect(getSnapshot.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps a dropdown choice pending until the parent saves it', async () => {
    const installedSenseVoice = {
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
    const paraformerEntry = {
      ...entry,
      id: 'paraformer-bilingual-zh-en-int8',
      displayName: 'Paraformer 中英双语 INT8',
      family: 'paraformer' as const
    }
    const installedParaformer = {
      ...installedSenseVoice,
      id: paraformerEntry.id,
      displayName: paraformerEntry.displayName
    }
    const installedSnapshot: SpeechModelSnapshot = {
      ...snapshot,
      catalog: [entry, paraformerEntry],
      installed: [installedSenseVoice, installedParaformer],
      selectedModelId: entry.id
    }
    const select = vi.fn()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        speechModels: {
          getSnapshot: vi.fn(async () => installedSnapshot),
          install: vi.fn(),
          cancel: vi.fn(async () => true),
          remove: vi.fn(),
          select,
          importArchive: vi.fn(),
          exportArchive: vi.fn(),
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    render(<SpeechModelSettingsSection />)
    const selector = await screen.findByRole('combobox', {
      name: '当前语音模型'
    })
    expect(selector).toHaveValue('sensevoice-small-int8')
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByText('正在使用')).toBeInTheDocument()

    fireEvent.change(selector, {
      target: { value: 'paraformer-bilingual-zh-en-int8' }
    })
    expect(select).not.toHaveBeenCalled()
    expect(screen.getByText('待保存')).toBeInTheDocument()
    expect(selector).toHaveValue('paraformer-bilingual-zh-en-int8')
    expect(screen.getAllByRole('article')).toHaveLength(1)
  })

  it('synchronizes the card when a controlled selection is reset', async () => {
    const paraformerEntry = {
      ...entry,
      id: 'paraformer-bilingual-zh-en-int8',
      displayName: 'Paraformer 中英双语 INT8',
      family: 'paraformer' as const
    }
    const installed = [entry, paraformerEntry].map((model) => ({
      id: model.id,
      displayName: model.displayName,
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
    }))
    const installedSnapshot: SpeechModelSnapshot = {
      ...snapshot,
      catalog: [entry, paraformerEntry],
      installed,
      selectedModelId: entry.id
    }
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        speechModels: {
          getSnapshot: vi.fn(async () => installedSnapshot),
          install: vi.fn(),
          cancel: vi.fn(async () => true),
          remove: vi.fn(),
          select: vi.fn(),
          importArchive: vi.fn(),
          exportArchive: vi.fn(),
          openRepository: vi.fn(),
          openModelsDirectory: vi.fn()
        }
      } as unknown as DesktopApi
    })

    const view = render(
      <SpeechModelSettingsSection
        persistedSelectedModelId={entry.id}
        selectedModelId={paraformerEntry.id}
      />
    )
    const selector = await screen.findByRole('combobox', {
      name: '当前语音模型'
    })
    expect(selector).toHaveValue(paraformerEntry.id)

    view.rerender(
      <SpeechModelSettingsSection
        persistedSelectedModelId={entry.id}
        selectedModelId={entry.id}
      />
    )

    await waitFor(() => expect(selector).toHaveValue(entry.id))
  })
})
