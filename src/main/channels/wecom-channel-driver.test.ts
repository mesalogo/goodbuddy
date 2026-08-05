import { describe, expect, it, vi } from 'vitest'
import { WeComChannelDriver } from './wecom-channel-driver'
import type { WeComSdkTransport } from './wecom-driver'

type MessageListener = (frame: unknown) => void
type ErrorListener = (error: Error) => void

class FakeTransport implements WeComSdkTransport {
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
  readonly replyStream = vi.fn<WeComSdkTransport['replyStream']>(
    async () => ({})
  )
  private messageListener?: MessageListener

  on(event: 'message', listener: MessageListener): unknown
  on(event: 'error', listener: ErrorListener): unknown
  on(
    event: 'message' | 'error',
    listener: MessageListener | ErrorListener
  ): unknown {
    if (event === 'message') {
      this.messageListener = listener as MessageListener
    }
    return this
  }

  off(event: 'message', listener: MessageListener): unknown
  off(event: 'error', listener: ErrorListener): unknown
  off(event: 'message' | 'error'): unknown {
    if (event === 'message') {
      this.messageListener = undefined
    }
    return this
  }

  emit(frame: unknown): void {
    this.messageListener?.(frame)
  }
}

function groupFrame(
  eventId: string,
  requestId: string
): Record<string, unknown> {
  return {
    cmd: 'aibot_msg_callback',
    headers: { req_id: requestId },
    body: {
      msgid: eventId,
      aibotid: 'bot-1',
      chatid: 'group-1',
      chattype: 'group',
      from: { userid: 'user-1' },
      create_time: 1_700_000_000,
      msgtype: 'text',
      text: { content: '@GoodBuddy 请规划下一步' }
    }
  }
}

describe('WeComChannelDriver', () => {
  it('adapts mentioned group messages and bounds reply contexts', async () => {
    const transport = new FakeTransport()
    const driver = new WeComChannelDriver({
      botId: 'bot-1',
      secret: 'secret',
      transportFactory: () => transport,
      maximumReplyContexts: 1
    })
    const messages: unknown[] = []
    await driver.start((message) => {
      messages.push(message)
    })

    transport.emit(groupFrame('event-1', 'request-1'))
    transport.emit(groupFrame('event-2', 'request-2'))
    expect(messages[0]).toEqual({
      channel: 'wecom',
      eventId: 'event-1',
      senderId: 'user-1',
      conversationId: 'group-1',
      conversationType: 'group',
      text: '@GoodBuddy 请规划下一步',
      mentioned: true,
      workMode: 'ask',
      receivedAt: 1_700_000_000
    })

    await expect(
      driver.send(
        {
          channel: 'wecom',
          eventId: 'event-1',
          conversationId: 'group-1',
          recipientId: 'user-1',
          status: 'completed',
          output: '旧回复'
        },
        new AbortController().signal
      )
    ).rejects.toThrow('上下文无效')
    await driver.send(
      {
        channel: 'wecom',
        eventId: 'event-2',
        conversationId: 'group-1',
        recipientId: 'user-1',
        status: 'completed',
        output: '新回复'
      },
      new AbortController().signal
    )
    expect(transport.replyStream).toHaveBeenCalledWith(
      { headers: { req_id: 'request-2' } },
      expect.stringMatching(/^goodbuddy_/u),
      '新回复',
      true
    )
    await driver.stop()
    expect(transport.disconnect).toHaveBeenCalledOnce()
  })
})
