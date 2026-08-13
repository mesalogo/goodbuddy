import { describe, expect, it, vi } from 'vitest'
import { WechatBindingController } from './wechat-binding-controller'
import type { WechatSidecarChild } from './wechat-sidecar-client'

function createDeferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('WechatBindingController', () => {
  it('coalesces duplicate credential messages from the same login', async () => {
    const saveReleased = createDeferred()
    const saveWeixinBinding = vi.fn(async () => {
      await saveReleased.promise
      return {} as never
    })
    let messageListener: ((message: unknown) => void) | undefined
    const child: WechatSidecarChild = {
      postMessage: vi.fn(),
      kill: vi.fn(() => true),
      on: vi.fn((_event, listener) => {
        messageListener = listener
        return child
      }),
      once: vi.fn(() => child)
    }
    const onChanged = vi.fn(async () => undefined)
    const controller = new WechatBindingController(
      { saveWeixinBinding } as never,
      () => child,
      onChanged,
      vi.fn()
    )
    const credential = {
      type: 'credential' as const,
      accountId: 'account-1',
      userId: 'user-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'binding-token'
    }

    controller.start()
    messageListener?.(credential)
    messageListener?.(credential)
    await vi.waitFor(() =>
      expect(saveWeixinBinding).toHaveBeenCalledOnce()
    )
    saveReleased.resolve()
    await controller.stop()

    expect(saveWeixinBinding).toHaveBeenCalledOnce()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('accepts only the first credential from one login generation', async () => {
    const firstSaveStarted = createDeferred()
    const firstSaveReleased = createDeferred()
    const saveWeixinBinding = vi
      .fn()
      .mockImplementationOnce(async () => {
        firstSaveStarted.resolve()
        await firstSaveReleased.promise
        return {} as never
      })
    let messageListener: ((message: unknown) => void) | undefined
    const child: WechatSidecarChild = {
      postMessage: vi.fn(),
      kill: vi.fn(() => true),
      on: vi.fn((_event, listener) => {
        messageListener = listener
        return child
      }),
      once: vi.fn(() => child)
    }
    const onChanged = vi.fn(async () => undefined)
    const controller = new WechatBindingController(
      { saveWeixinBinding } as never,
      () => child,
      onChanged,
      vi.fn()
    )

    controller.start()
    messageListener?.({
      type: 'credential',
      accountId: 'account-1',
      userId: 'user-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'binding-token-1'
    })
    messageListener?.({
      type: 'credential',
      accountId: 'account-2',
      userId: 'user-2',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'binding-token-2'
    })
    await firstSaveStarted.promise

    expect(() => controller.start()).toThrow(
      '微信绑定凭据正在保存，请稍后重试'
    )

    let stopped = false
    const stop = controller.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    firstSaveReleased.resolve()
    await stop
    expect(saveWeixinBinding).toHaveBeenCalledOnce()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('waits for an in-flight credential save when stopping', async () => {
    const saveStarted = createDeferred()
    const saveReleased = createDeferred()
    const saveWeixinBinding = vi.fn(async () => {
      saveStarted.resolve()
      await saveReleased.promise
      return {} as never
    })
    let messageListener: ((message: unknown) => void) | undefined
    const child: WechatSidecarChild = {
      postMessage: vi.fn(),
      kill: vi.fn(() => true),
      on: vi.fn((_event, listener) => {
        messageListener = listener
        return child
      }),
      once: vi.fn(() => child)
    }
    const onChanged = vi.fn(async () => undefined)
    const controller = new WechatBindingController(
      { saveWeixinBinding } as never,
      () => child,
      onChanged,
      vi.fn()
    )

    controller.start()
    messageListener?.({
      type: 'credential',
      accountId: 'account-1',
      userId: 'user-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'binding-token'
    })
    await saveStarted.promise

    let stopped = false
    const stop = controller.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    saveReleased.resolve()
    await stop
    expect(saveWeixinBinding).toHaveBeenCalledOnce()
    expect(onChanged).not.toHaveBeenCalled()
  })
})
