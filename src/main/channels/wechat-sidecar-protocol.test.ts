import { describe, expect, it } from 'vitest'
import {
  WECHAT_SIDECAR_MAX_QR_PAYLOAD_LENGTH,
  WECHAT_SIDECAR_MAX_TEXT_LENGTH,
  WechatQrStateMachine,
  wechatSidecarCommandSchema,
  wechatSidecarMessageSchema
} from './wechat-sidecar-protocol'

const NOW = Date.parse('2026-08-06T10:00:00.000Z')

function qr(expiresAt = NOW + 60_000): {
  type: 'qr'
  qrId: string
  payload: string
  expiresAt: string
} {
  return {
    type: 'qr',
    qrId: 'qr-1',
    payload: 'bounded-local-qr-payload',
    expiresAt: new Date(expiresAt).toISOString()
  }
}

describe('wechatSidecarMessageSchema', () => {
  it('accepts the bounded message variants and reply correlation', () => {
    expect(
      wechatSidecarMessageSchema.parse({
        type: 'status',
        status: 'connected'
      })
    ).toEqual({ type: 'status', status: 'connected' })

    expect(
      wechatSidecarMessageSchema.parse({
        type: 'inbound_text',
        eventId: 'event-1',
        senderId: 'sender-1',
        conversationId: 'conversation-1',
        text: '你好'
      })
    ).toMatchObject({ eventId: 'event-1', text: '你好' })

    expect(
      wechatSidecarCommandSchema.parse({
        type: 'reply',
        replyId: 'reply-1',
        inReplyToEventId: 'event-1',
        conversationId: 'conversation-1',
        text: '收到'
      })
    ).toMatchObject({
      replyId: 'reply-1',
      inReplyToEventId: 'event-1'
    })

    expect(
      wechatSidecarMessageSchema.parse({
        type: 'reply_result',
        replyId: 'reply-1',
        ok: true
      })
    ).toEqual({
      type: 'reply_result',
      replyId: 'reply-1',
      ok: true
    })
  })

  it.each(['session', 'cookie', 'token'])(
    'rejects the sensitive %s field',
    (field) => {
      expect(() =>
        wechatSidecarMessageSchema.parse({
          type: 'status',
          status: 'connected',
          [field]: 'must-not-cross-boundary'
        })
      ).toThrow()
    }
  )

  it('rejects unknown, malicious, and oversized payloads', () => {
    expect(() =>
      wechatSidecarMessageSchema.parse({
        type: 'inbound_text',
        eventId: 'event-1',
        senderId: 'sender-1',
        conversationId: 'conversation-1',
        text: 'hello',
        command: 'exec'
      })
    ).toThrow()

    expect(() =>
      wechatSidecarMessageSchema.parse({
        type: 'inbound_text',
        eventId: 'event-1\nforged',
        senderId: 'sender-1',
        conversationId: 'conversation-1',
        text: 'hello'
      })
    ).toThrow()

    expect(() =>
      wechatSidecarMessageSchema.parse({
        type: 'inbound_text',
        eventId: 'event-1',
        senderId: 'sender-1',
        conversationId: 'conversation-1',
        text: 'x'.repeat(WECHAT_SIDECAR_MAX_TEXT_LENGTH + 1)
      })
    ).toThrow()

    expect(() =>
      wechatSidecarMessageSchema.parse({
        ...qr(),
        payload: 'x'.repeat(
          WECHAT_SIDECAR_MAX_QR_PAYLOAD_LENGTH + 1
        )
      })
    ).toThrow()
  })
})

describe('WechatQrStateMachine', () => {
  it('allows the expected scan flow and rejects skipped states', () => {
    const machine = new WechatQrStateMachine()

    expect(() => machine.transition('connected', NOW)).toThrow(
      '非法的微信扫码状态转换'
    )
    expect(machine.transition('starting', NOW).status).toBe('starting')
    expect(machine.transition('pending', NOW).status).toBe('pending')
    expect(machine.setQr(qr(), NOW).qr?.qrId).toBe('qr-1')
    expect(machine.transition('scanned', NOW).status).toBe('scanned')

    const connected = machine.transition('connected', NOW)
    expect(connected).toEqual({ status: 'connected' })
  })

  it('expires a short-lived QR and prevents scanning it', () => {
    const machine = new WechatQrStateMachine()
    machine.transition('starting', NOW)
    machine.transition('pending', NOW)
    machine.setQr(qr(NOW + 1_000), NOW)

    expect(machine.expire(NOW + 1_000)).toBe(true)
    expect(machine.snapshot()).toEqual({ status: 'expired' })
    expect(() => machine.transition('scanned', NOW + 1_000)).toThrow(
      '非法的微信扫码状态转换'
    )
  })

  it('rejects expired and excessively long-lived QR payloads', () => {
    const machine = new WechatQrStateMachine()
    machine.transition('starting', NOW)
    machine.transition('pending', NOW)

    expect(() => machine.setQr(qr(NOW), NOW)).toThrow(
      '二维码有效期无效'
    )
    expect(() =>
      machine.setQr(qr(NOW + 5 * 60_000 + 1), NOW)
    ).toThrow('二维码有效期无效')
  })
})
