import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  InstalledDocumentOcrModel,
  DocumentParsingSettings,
  DocumentParsingSnapshot
} from '../../shared/document-parsing-contracts'
import { changeUiLocale } from './i18n'
import { DocumentParsingSettingsSection } from './DocumentParsingSettingsSection'

const settings: DocumentParsingSettings = {
  chatWorkflow: 'auto',
  knowledgeWorkflow: 'complete-index',
  localOcrModelId: 'pp-ocrv6-tiny',
  maximumPages: 100,
  pageTimeoutSeconds: 60
}

const modelEntry = {
  id: 'pp-ocrv6-tiny' as const,
  displayName: 'PP-OCRv6 Tiny',
  description: '轻量中文 OCR 模型',
  languages: ['中文', '英语'],
  runtime: 'onnxruntime-web-wasm' as const,
  quality: 'basic' as const,
  speed: 'fast' as const,
  recommended: false,
  repositoryUrl:
    'https://modelscope.cn/models/PaddlePaddle/PP-OCRv6_tiny_rec_onnx',
  license: {
    name: 'Apache License 2.0',
    notice: '使用前请阅读模型许可证。',
    url: 'https://example.com/license'
  },
  files: [
    {
      name: 'detection.onnx',
      role: 'detection' as const,
      download: {
        url: 'https://modelscope.cn/models/example/detection.onnx',
        size: 1_000,
        sha256: 'a'.repeat(64)
      }
    },
    {
      name: 'recognition.onnx',
      role: 'recognition' as const,
      download: {
        url: 'https://modelscope.cn/models/example/recognition.onnx',
        size: 2_000,
        sha256: 'b'.repeat(64)
      }
    },
    {
      name: 'dictionary.yml',
      role: 'dictionary' as const,
      download: {
        url: 'https://modelscope.cn/models/example/dictionary.yml',
        size: 500,
        sha256: 'c'.repeat(64)
      }
    }
  ]
}
const secondModelEntry = {
  ...modelEntry,
  id: 'pp-ocrv6-small',
  displayName: 'PP-OCRv6 Small',
  quality: 'balanced' as const,
  speed: 'balanced' as const,
  recommended: true
}
const thirdModelEntry = {
  ...modelEntry,
  id: 'pp-ocrv6-medium',
  displayName: 'PP-OCRv6 Medium',
  quality: 'high' as const,
  speed: 'slow' as const,
  recommended: false
}

const snapshot: DocumentParsingSnapshot = {
  settings,
  status: {
    nativeParsingAvailable: true,
    conversionAvailable: false,
    localOcr: {
      id: 'pp-ocrv6-tiny',
      displayName: 'PP-OCRv6 Tiny',
      available: false,
      verified: false,
      runtime: 'onnxruntime-web-wasm',
      detail: '模型尚未安装'
    }
  },
  ocrModels: {
    rootDirectory: 'C:\\Users\\test\\models\\document-ocr',
    catalog: [modelEntry, secondModelEntry, thirdModelEntry],
    installed: [
      {
        id: 'pp-ocrv6-small',
        displayName: 'PP-OCRv6 Small',
        source: 'download',
        installedAt: '2026-08-11T00:00:00.000Z',
        files: secondModelEntry.files.map((file) => ({
          name: file.name,
          role: file.role,
          size: file.download.size,
          sha256: file.download.sha256
        }))
      }
    ],
    operations: []
  }
}

const getSnapshot = vi.fn(async () => snapshot)
const update = vi.fn(async (input: DocumentParsingSettings) => ({
  ...snapshot,
  settings: input
}))
const test = vi.fn(async () => ({
  fileName: 'scan.pdf',
  sourceFormat: 'PDF',
  pageCount: 2,
  ocrPageCount: 2,
  characterCount: 120,
  method: 'ocr' as const,
  durationMs: 1_250,
  preview: '扫描件识别正文',
  warnings: []
}))
const installOcrModel =
  vi.fn<() => Promise<DocumentParsingSnapshot>>(async () => ({
    ...snapshot,
    status: {
      ...snapshot.status,
      localOcr: {
        ...snapshot.status.localOcr,
        available: true,
        verified: true,
        detail: '模型已安装并校验'
      }
    },
    ocrModels: {
      ...snapshot.ocrModels,
      installed: [
        {
          id: 'pp-ocrv6-tiny',
          displayName: 'PP-OCRv6 Tiny',
          source: 'download',
          installedAt: '2026-08-11T00:00:00.000Z',
          files: modelEntry.files.map((file) => ({
            name: file.name,
            role: file.role,
            size: file.download.size,
            sha256: file.download.sha256
          }))
        }
      ]
    }
  }))
const importOcrModelArchive = vi.fn(async () => snapshot)
const exportOcrModelArchive = vi.fn(async () => snapshot)
const openOcrModelRepository = vi.fn(async () => undefined)

describe('DocumentParsingSettingsSection', () => {
  beforeEach(async () => {
    await changeUiLocale('zh-CN')
    vi.clearAllMocks()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        documentParsing: {
          getSnapshot,
          update,
          test,
          installOcrModel,
          cancelOcrModelOperation: vi.fn(async () => true),
          removeOcrModel: vi.fn(async () => snapshot),
          importOcrModelArchive,
          exportOcrModelArchive,
          openOcrModelRepository,
          openOcrModelsDirectory: vi.fn(),
          getOcrAssets: vi.fn(),
          respondOcr: vi.fn(),
          onOcrRequest: vi.fn(() => () => undefined),
          onOcrCancel: vi.fn(() => () => undefined)
        }
      }
    })
  })

  afterEach(() => cleanup())

  it.each([
    ['zh-CN', '正在加载…'],
    ['en-US', 'Loading…']
  ] as const)('localizes the loading state in %s', async (locale, label) => {
    await changeUiLocale(locale)
    getSnapshot.mockImplementationOnce(
      () => new Promise(() => undefined)
    )

    render(<DocumentParsingSettingsSection />)

    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('localizes built-in OCR model metadata in English', async () => {
    await changeUiLocale('en-US')

    render(<DocumentParsingSettingsSection />)

    expect(await screen.findByText('PP-OCRv6 Tiny')).toBeInTheDocument()
    expect(
      screen.getByText(
        'The official lightweight PaddleOCR Chinese model for local CPU recognition of scanned PDFs and images.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Chinese / English')).toBeInTheDocument()
    expect(screen.queryByText('轻量中文 OCR 模型')).not.toBeInTheDocument()
  })

  it('localizes recovered document parsing settings warnings', async () => {
    await changeUiLocale('en-US')
    getSnapshot.mockResolvedValueOnce({
      ...snapshot,
      warnings: [{ code: 'document-parsing-settings-recovered' }]
    })

    render(<DocumentParsingSettingsSection />)

    expect(
      await screen.findByText(
        /The document parsing settings file was corrupt/u
      )
    ).toBeInTheDocument()
  })

  it('shows actual capability status and saves workflow settings', async () => {
    const onNotify = vi.fn()
    render(
      <DocumentParsingSettingsSection onNotify={onNotify} />
    )

    expect(await screen.findByText('PP-OCRv6 Tiny')).toBeInTheDocument()
    expect(screen.getByText('ModelScope')).toBeInTheDocument()
    expect(screen.getByText('质量：基础')).toBeInTheDocument()
    expect(screen.getByText('速度：快')).toBeInTheDocument()
    expect(screen.getByText('旧版 Office 转换')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByText('隐私与云端处理')).not.toBeInTheDocument()
    expect(
      screen.queryByText('模型详情与手动导入')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('可从 ModelScope 下载')
    ).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: '打开 PP-OCRv6 Tiny 的 ModelScope 页面'
      })
    )
    expect(openOcrModelRepository).toHaveBeenCalledWith('pp-ocrv6-tiny')

    fireEvent.change(screen.getByLabelText('聊天与成果文件'), {
      target: { value: 'fast-text' }
    })
    expect(
      screen.getByRole('button', {
        name: '测试聊天与成果模式'
      })
    ).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ chatWorkflow: 'fast-text' })
      )
    )
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '文档解析设置已保存'
      })
    )
  })

  it('downloads the verified OCR model from the model catalog', async () => {
    const onNotify = vi.fn()
    render(
      <DocumentParsingSettingsSection onNotify={onNotify} />
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: '下载 PP-OCRv6 Tiny'
      })
    )

    await waitFor(() =>
      expect(installOcrModel).toHaveBeenCalledWith('pp-ocrv6-tiny')
    )
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'PP-OCRv6 Tiny 已安装'
      })
    )
  })

  it('downloads and selects an uninstalled model in one action', async () => {
    const installedMedium = {
      ...snapshot,
      settings: {
        ...snapshot.settings,
        localOcrModelId: 'pp-ocrv6-medium'
      }
    }
    installOcrModel.mockResolvedValueOnce({
      ...snapshot,
      ocrModels: {
        ...snapshot.ocrModels,
        installed: [
          ...snapshot.ocrModels.installed,
          {
            id: 'pp-ocrv6-medium',
            displayName: 'PP-OCRv6 Medium',
            source: 'download',
            installedAt: '2026-08-11T00:00:00.000Z',
            files: thirdModelEntry.files.map((file) => ({
              name: file.name,
              role: file.role,
              size: file.download.size,
              sha256: file.download.sha256
            }))
          } satisfies InstalledDocumentOcrModel
        ]
      }
    })
    update.mockResolvedValueOnce(installedMedium)
    render(<DocumentParsingSettingsSection />)

    fireEvent.change(await screen.findByLabelText('当前 OCR 模型'), {
      target: { value: 'pp-ocrv6-medium' }
    })
    expect(
      screen.getByRole('button', { name: '保存设置' })
    ).toBeDisabled()
    fireEvent.click(
      screen.getByRole('button', {
        name: '下载 PP-OCRv6 Medium'
      })
    )

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          localOcrModelId: 'pp-ocrv6-medium'
        })
      )
    )
  })

  it('imports and exports verified OCR model ZIP archives', async () => {
    const onNotify = vi.fn()
    render(
      <DocumentParsingSettingsSection onNotify={onNotify} />
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: '从 ZIP 导入 PP-OCRv6 Tiny'
      })
    )
    await waitFor(() =>
      expect(importOcrModelArchive).toHaveBeenCalledWith(
        'pp-ocrv6-tiny'
      )
    )
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'PP-OCRv6 Tiny 已从 ZIP 导入'
      })
    )

    fireEvent.change(screen.getByLabelText('当前 OCR 模型'), {
      target: { value: 'pp-ocrv6-small' }
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: '将 PP-OCRv6 Small 导出为 ZIP'
      })
    )
    await waitFor(() =>
      expect(exportOcrModelArchive).toHaveBeenCalledWith(
        'pp-ocrv6-small'
      )
    )
    expect(update).not.toHaveBeenCalled()
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'PP-OCRv6 Small 已导出为 ZIP'
      })
    )
  })

  it('switches the selected OCR model only when settings are saved', async () => {
    render(<DocumentParsingSettingsSection />)
    const selector = await screen.findByLabelText('当前 OCR 模型')

    expect(
      screen.getByRole('option', {
        name: 'PP-OCRv6 Tiny · 可下载'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', {
        name: 'PP-OCRv6 Small · 已安装'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', {
        name: 'PP-OCRv6 Medium · 可下载'
      })
    ).toBeInTheDocument()

    fireEvent.change(selector, {
      target: { value: 'pp-ocrv6-small' }
    })

    expect(
      screen.getByText('模型选择尚未生效，点击“保存设置”后切换。')
    ).toBeInTheDocument()
    expect(screen.getByText('PP-OCRv6 Small')).toBeInTheDocument()
    expect(screen.getByText('质量：均衡')).toBeInTheDocument()
    expect(screen.getByText('速度：均衡')).toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: '保存设置' })
    )
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          localOcrModelId: 'pp-ocrv6-small'
        })
      )
    )
  })

  it('runs a real-file diagnostic flow and displays its result', async () => {
    render(<DocumentParsingSettingsSection />)
    await screen.findByText('PP-OCRv6 Tiny')

    fireEvent.click(
      screen.getByRole('button', {
        name: '测试聊天与成果模式'
      })
    )

    expect(
      await screen.findByRole('dialog', {
        name: '解析测试结果'
      })
    ).toHaveTextContent('扫描件识别正文')
    expect(test).toHaveBeenCalledWith('chat-attachment')
    expect(update).not.toHaveBeenCalled()
  })
})
