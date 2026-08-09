import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../shared/contracts'
import type { RemoteChannelApproval } from '../../shared/remote-channel-contracts'
import { RemoteChannelApprovalDialog } from './RemoteChannelApprovalDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RemoteChannelApprovalDialog', () => {
  it('requires an explicit local one-time decision', async () => {
    let publish: ((approval: RemoteChannelApproval) => void) | undefined
    const respondRemoteApproval = vi.fn(async () => true)
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          getPendingRemoteApprovals: vi.fn(async () => []),
          onRemoteApproval: vi.fn((listener) => {
            publish = listener
            return () => undefined
          }),
          respondRemoteApproval
        }
      } as unknown as DesktopApi
    })

    render(<RemoteChannelApprovalDialog />)
    publish?.({
      approvalId: '00000000-0000-4000-8000-000000000001',
      requestId: '00000000-0000-4000-8000-000000000002',
      kind: 'request',
      channel: 'weixin',
      channelLabel: '微信 ClawBot',
      senderDisplay: '发送者 ****1234',
      projectName: '微信 ClawBot',
      rootPath: 'C:\\Users\\tester',
      title: '请求执行任务',
      description: '创建一份本地报告',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })

    expect(
      await screen.findByRole('alertdialog', {
        name: '确认远程执行请求'
      })
    ).toBeInTheDocument()
    expect(screen.getByText('创建一份本地报告')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /永久|会话/u })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '仅批准本次执行' })
    )
    await waitFor(() =>
      expect(respondRemoteApproval).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000001',
        'once'
      )
    )
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
