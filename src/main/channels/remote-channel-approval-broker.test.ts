import { describe, expect, it, vi } from 'vitest'
import { RemoteChannelApprovalBroker } from './remote-channel-approval-broker'

const request = {
  requestId: '00000000-0000-4000-8000-000000000001',
  kind: 'request' as const,
  channel: 'weixin' as const,
  channelLabel: '微信 ClawBot',
  senderDisplay: '发送者 ****1234',
  projectName: '微信 ClawBot',
  rootPath: 'C:\\Users\\tester',
  title: '请求执行任务',
  description: '创建一份报告'
}

describe('RemoteChannelApprovalBroker', () => {
  it('accepts only a local one-time response for the matching request', async () => {
    const published: Array<{ approvalId: string }> = []
    const broker = new RemoteChannelApprovalBroker(
      (approval) => published.push(approval),
      10_000
    )
    const controller = new AbortController()
    const result = broker.request(request, controller.signal)

    expect(published).toHaveLength(1)
    expect(broker.listPending()).toEqual([
      expect.objectContaining({
        approvalId: published[0]!.approvalId,
        channel: 'weixin'
      })
    ])
    expect(
      broker.respond(published[0]!.approvalId, 'once')
    ).toBe(true)
    await expect(result).resolves.toBe('once')
    expect(broker.listPending()).toEqual([])
    expect(
      broker.respond(published[0]!.approvalId, 'deny')
    ).toBe(false)
  })

  it('denies pending approvals when aborted or cleared', async () => {
    const published: Array<{ approvalId: string }> = []
    const broker = new RemoteChannelApprovalBroker(
      (approval) => published.push(approval),
      10_000
    )
    const firstController = new AbortController()
    const first = broker.request(request, firstController.signal)
    firstController.abort()
    await expect(first).resolves.toBe('deny')

    const second = broker.request(
      { ...request, requestId: crypto.randomUUID() },
      new AbortController().signal
    )
    broker.clear()
    await expect(second).resolves.toBe('deny')
  })

  it('denies an approval after its bounded timeout', async () => {
    vi.useFakeTimers()
    try {
      const broker = new RemoteChannelApprovalBroker(() => undefined, 500)
      const result = broker.request(
        request,
        new AbortController().signal
      )
      await vi.advanceTimersByTimeAsync(500)
      await expect(result).resolves.toBe('deny')
    } finally {
      vi.useRealTimers()
    }
  })
})
