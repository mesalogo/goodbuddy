import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '../../shared/ipc-channels'
import { registerFeedbackIpcHandler } from './feedback-ipc'

type InvokeHandler = (event: unknown, input: unknown) => unknown

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  handle: vi.fn((channel: string, handler: InvokeHandler) => {
    electronMocks.handlers.set(channel, handler)
  }),
  removeHandler: vi.fn((channel: string) => {
    electronMocks.handlers.delete(channel)
  })
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler
  }
}))

describe('feedback IPC', () => {
  it('validates input and accepts only the trusted main frame', async () => {
    const webContents = {
      mainFrame: {
        url: 'file:///goodbuddy/index.html'
      },
      getURL: vi.fn(() => 'file:///goodbuddy/index.html')
    }
    const window = { webContents }
    const submit = vi.fn(async () => ({
      ok: true as const,
      reference: 'GOODBUDDY-000001',
      duplicate: false
    }))
    const remove = registerFeedbackIpcHandler(
      window as never,
      { submit }
    )
    const handler = electronMocks.handlers.get(
      ipcChannels.feedbackSubmit
    )!
    const event = {
      sender: webContents,
      senderFrame: webContents.mainFrame
    }
    const input = {
      category: 'bug',
      title: '  Feedback title  ',
      description: 'A useful feedback description.',
      locale: 'zh-CN',
      clientRequestId:
        '00000000-0000-4000-8000-000000000501'
    }

    await expect(handler(event, input)).resolves.toMatchObject({
      ok: true,
      reference: 'GOODBUDDY-000001'
    })
    expect(submit).toHaveBeenCalledWith({
      ...input,
      title: 'Feedback title'
    })
    expect(() =>
      handler(
        {
          sender: {},
          senderFrame: webContents.mainFrame
        },
        input
      )
    ).toThrow('拒绝来自未知窗口的 IPC 请求')
    expect(() =>
      handler(event, {
        ...input,
        endpoint: 'https://attacker.example/api/v1/feedback'
      })
    ).toThrow()
    expect(submit).toHaveBeenCalledOnce()

    remove()
    expect(
      electronMocks.handlers.has(ipcChannels.feedbackSubmit)
    ).toBe(false)
  })
})
