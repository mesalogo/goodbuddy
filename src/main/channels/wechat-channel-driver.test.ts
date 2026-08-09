import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedChannelSettings } from './channel-settings-store'
import { WechatChannelDriver } from './wechat-channel-driver'
import type { WechatSidecarChild } from './wechat-sidecar-client'

class FakeSidecar extends EventEmitter {
  readonly posted: unknown[] = []

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  kill(): boolean {
    return true
  }
}

const settings: Extract<
  ResolvedChannelSettings,
  { channel: 'weixin' }
> = {
  channel: 'weixin',
  enabled: true,
  accountId: 'bot-account',
  userId: 'bound-user',
  baseUrl: 'https://ilinkai.weixin.qq.com',
  token: 'private-token',
  allowedSenderIds: ['bound-user'],
  allowGroupMessages: false,
  source: 'encrypted',
  readOnly: false
}

describe('WechatChannelDriver', () => {
  it('starts an isolated account, forwards text, and correlates replies', async () => {
    const child = new FakeSidecar()
    const handler = vi.fn()
    const driver = new WechatChannelDriver(
      settings,
      () => child as unknown as WechatSidecarChild
    )

    const starting = driver.start(handler)
    await vi.waitFor(() =>
      expect(child.posted).toContainEqual(
        expect.objectContaining({
          type: 'start_account',
          accountId: 'bot-account',
          token: 'private-token'
        })
      )
    )
    child.emit('message', {
      type: 'status',
      status: 'connected'
    })
    await starting

    child.emit('message', {
      type: 'inbound_text',
      eventId: 'event-1',
      senderId: 'sender-1',
      conversationId: 'sender-1',
      text: '你好'
    })
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'weixin',
        eventId: 'event-1',
        senderId: 'sender-1',
        workMode: 'ask'
      }),
      expect.any(Function)
    )

    const sending = driver.send(
      {
        channel: 'weixin',
        eventId: 'event-1',
        conversationId: 'sender-1',
        recipientId: 'sender-1',
        status: 'completed',
        output: '收到'
      },
      new AbortController().signal
    )
    const reply = child.posted.find(
      (
        message
      ): message is {
        type: 'reply'
        replyId: string
      } =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'reply'
    )
    expect(reply).toBeDefined()
    child.emit('message', {
      type: 'reply_result',
      replyId: reply!.replyId,
      ok: true
    })
    await expect(sending).resolves.toBeUndefined()
    driver.stop()
  })

  it('rejects incomplete persisted bindings before launching', async () => {
    const launch = vi.fn(
      () => new FakeSidecar() as unknown as WechatSidecarChild
    )
    const driver = new WechatChannelDriver(
      { ...settings, token: undefined },
      launch
    )
    await expect(driver.start(vi.fn())).rejects.toThrow(
      '尚未完成扫码绑定'
    )
    expect(launch).not.toHaveBeenCalled()
  })

  it('rejects in-flight replies when the sidecar fails', async () => {
    const child = new FakeSidecar()
    const driver = new WechatChannelDriver(
      settings,
      () => child as unknown as WechatSidecarChild
    )
    const starting = driver.start(vi.fn())
    await vi.waitFor(() =>
      expect(child.posted).toContainEqual(
        expect.objectContaining({ type: 'start_account' })
      )
    )
    child.emit('message', {
      type: 'status',
      status: 'connected'
    })
    await starting

    const sending = driver.send(
      {
        channel: 'weixin',
        eventId: 'event-failed',
        conversationId: 'sender-1',
        recipientId: 'sender-1',
        status: 'completed',
        output: '结果'
      },
      new AbortController().signal
    )
    child.emit('message', {
      type: 'status',
      status: 'failed',
      detail: 'Sidecar 已退出'
    })
    await expect(sending).rejects.toThrow('Sidecar 已退出')
    driver.stop()
  })
})
