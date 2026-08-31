import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../shared/contracts'
import { FeedbackDialog } from './FeedbackDialog'

const createObjectUrl = vi.fn(() => 'blob:feedback-screenshot')
const revokeObjectUrl = vi.fn()

class TestImage {
  naturalWidth = 640
  naturalHeight = 480
  onload?: () => void
  onerror?: () => void

  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

function installApi(
  submit: DesktopApi['feedback']['submit']
): void {
  Object.defineProperty(window, 'goodbuddy', {
    configurable: true,
    value: {
      feedback: { submit }
    } as unknown as DesktopApi
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectUrl
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectUrl
  })
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: TestImage
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FeedbackDialog', () => {
  it('preserves the draft and request ID across a failed manual retry', async () => {
    const submit = vi
      .fn<DesktopApi['feedback']['submit']>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'network'
      })
      .mockResolvedValueOnce({
        ok: true,
        reference: 'GOODBUDDY-000007',
        duplicate: false
      })
    installApi(submit)
    render(
      <FeedbackDialog
        appInfo={{
          name: 'GoodBuddy',
          version: '0.11.0',
          platform: 'win32',
          arch: 'x64',
          shortcut: 'Ctrl+Shift+Space'
        }}
        onClose={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText('标题'), {
      target: { value: '无法显示魔法笔记页签' }
    })
    fireEvent.change(screen.getByLabelText('详细描述'), {
      target: {
        value: '打开平台功能后，魔法笔记页签没有显示。'
      }
    })
    const diagnostics = screen.getByRole('checkbox', {
      name: '附加最近桌面诊断记录'
    })
    expect(diagnostics).not.toBeChecked()
    fireEvent.click(diagnostics)
    const submitButton = screen.getByRole('button', {
      name: '提交反馈'
    })
    expect(submitButton).toBeEnabled()
    fireEvent.click(submitButton)

    expect(
      await screen.findByText(
        '无法连接反馈服务，请检查网络后重试。'
      )
    ).toBeInTheDocument()
    expect(screen.getByLabelText('标题')).toHaveValue(
      '无法显示魔法笔记页签'
    )
    expect(screen.getByLabelText('详细描述')).toHaveValue(
      '打开平台功能后，魔法笔记页签没有显示。'
    )
    const firstRequestId =
      submit.mock.calls[0]![0].clientRequestId

    fireEvent.click(
      screen.getByRole('button', { name: '重试提交' })
    )
    expect(await screen.findByText('GOODBUDDY-000007'))
      .toBeInTheDocument()
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[1]![0].clientRequestId).toBe(
      firstRequestId
    )
    expect(submit.mock.calls[0]![0].includeDiagnostics).toBe(true)
    expect(submit.mock.calls[1]![0].includeDiagnostics).toBe(true)
  })

  it('keeps an over-budget diagnostics draft and shows a field error', () => {
    installApi(
      vi.fn<DesktopApi['feedback']['submit']>(async () => ({
        ok: true,
        reference: 'GOODBUDDY-000016',
        duplicate: false
      }))
    )
    render(
      <FeedbackDialog
        appInfo={{
          name: 'GoodBuddy',
          version: '0.11.0',
          platform: 'win32',
          arch: 'x64',
          shortcut: 'Ctrl+Shift+Space'
        }}
        onClose={vi.fn()}
      />
    )
    const description = 'x'.repeat(3_399)
    fireEvent.change(screen.getByLabelText('标题'), {
      target: { value: 'Diagnostics budget' }
    })
    fireEvent.change(screen.getByLabelText('详细描述'), {
      target: { value: description }
    })
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '附加最近桌面诊断记录'
      })
    )
    expect(screen.getByLabelText('详细描述')).toHaveValue(
      description
    )
    expect(
      screen.getByText(
        '附加桌面诊断时，详细描述不能超过 3398 个字符；草稿已保留，请缩短后重试。'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '提交反馈' })
    ).toBeDisabled()
  })

  it('validates fields, traps focus, and closes with Escape', () => {
    installApi(
      vi.fn<DesktopApi['feedback']['submit']>(async () => ({
        ok: true,
        reference: 'GOODBUDDY-000008',
        duplicate: false
      }))
    )
    const onClose = vi.fn()
    render(
      <FeedbackDialog
        appInfo={{
          name: 'GoodBuddy',
          version: '0.11.0',
          platform: 'linux',
          arch: 'arm64',
          shortcut: 'Ctrl+Shift+Space'
        }}
        onClose={onClose}
      />
    )
    const dialog = screen.getByRole('dialog', {
      name: '提交反馈'
    })
    const category = screen.getByLabelText('反馈类型')
    expect(category).toHaveFocus()
    fireEvent.change(screen.getByLabelText('标题'), {
      target: { value: '有效标题' }
    })
    fireEvent.submit(dialog.querySelector('form')!)
    expect(
      screen.getByText('详细描述至少需要 10 个字符。')
    ).toBeInTheDocument()
    expect(screen.getByLabelText('详细描述')).toHaveFocus()
    fireEvent.change(screen.getByLabelText('详细描述'), {
      target: { value: '这是一段足够长的详细描述。' }
    })

    const submitButton = screen.getByRole('button', {
      name: '提交反馈'
    })
    submitButton.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    const closeButton = screen.getByRole('button', {
      name: '关闭反馈对话框'
    })
    expect(closeButton).toHaveFocus()
    fireEvent.keyDown(dialog, {
      key: 'Tab',
      shiftKey: true
    })
    expect(submitButton).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('accepts one image, keeps text paste native, and releases the preview URL', async () => {
    installApi(
      vi.fn<DesktopApi['feedback']['submit']>(async () => ({
        ok: true,
        reference: 'GOODBUDDY-000009',
        duplicate: false
      }))
    )
    render(
      <FeedbackDialog
        appInfo={{
          name: 'GoodBuddy',
          version: '0.11.0',
          platform: 'darwin',
          arch: 'arm64',
          shortcut: 'Command+Shift+Space'
        }}
        onClose={vi.fn()}
      />
    )
    const screenshotArea = screen
      .getByText('截图（可选）')
      .closest('.feedback-screenshot')!
    const textPaste = new Event('paste', {
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(textPaste, 'clipboardData', {
      value: {
        items: [],
        files: []
      }
    })
    screenshotArea.dispatchEvent(textPaste)
    expect(textPaste.defaultPrevented).toBe(false)

    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      'screen.png',
      { type: 'image/png' }
    )
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () =>
        new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer
    })
    fireEvent.change(screen.getByLabelText('选择反馈截图'), {
      target: { files: [file] }
    })
    expect(
      await screen.findByAltText('待发送反馈截图预览')
    ).toHaveAttribute('src', 'blob:feedback-screenshot')
    expect(screen.getByText('640 × 480')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '移除截图' })
    )
    await waitFor(() =>
      expect(
        screen.queryByAltText('待发送反馈截图预览')
      ).not.toBeInTheDocument()
    )
    expect(revokeObjectUrl).toHaveBeenCalledWith(
      'blob:feedback-screenshot'
    )
  })

  it('keeps the newest screenshot when file reads finish out of order', async () => {
    installApi(
      vi.fn<DesktopApi['feedback']['submit']>(async () => ({
        ok: true,
        reference: 'GOODBUDDY-000010',
        duplicate: false
      }))
    )
    let resolveFirst!: (value: ArrayBuffer) => void
    const first = new File(['first'], 'first.png', {
      type: 'image/png'
    })
    Object.defineProperty(first, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          resolveFirst = resolve
        })
    })
    const secondBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47
    ])
    const second = new File([secondBytes], 'second.png', {
      type: 'image/png'
    })
    Object.defineProperty(second, 'arrayBuffer', {
      value: async () => secondBytes.buffer
    })
    createObjectUrl.mockReturnValueOnce('blob:newest-screenshot')
    render(
      <FeedbackDialog
        appInfo={{
          name: 'GoodBuddy',
          version: '0.11.0',
          platform: 'win32',
          arch: 'x64',
          shortcut: 'Ctrl+Shift+Space'
        }}
        onClose={vi.fn()}
      />
    )
    const input = screen.getByLabelText('选择反馈截图')
    fireEvent.change(input, {
      target: { files: [first] }
    })
    fireEvent.change(input, {
      target: { files: [second] }
    })
    expect(
      await screen.findByAltText('待发送反馈截图预览')
    ).toHaveAttribute('src', 'blob:newest-screenshot')

    await act(async () => {
      resolveFirst(new Uint8Array([0x89, 0x50]).buffer)
    })
    expect(
      screen.getByAltText('待发送反馈截图预览')
    ).toHaveAttribute('src', 'blob:newest-screenshot')
    expect(createObjectUrl).toHaveBeenCalledOnce()
  })
})
