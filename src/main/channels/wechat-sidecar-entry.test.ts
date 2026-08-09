import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeParentPort extends EventEmitter {
  readonly messages: unknown[] = []

  postMessage(message: unknown): void {
    this.messages.push(message)
  }
}

const originalParentPort = Object.getOwnPropertyDescriptor(
  process,
  'parentPort'
)
const originalFetch = global.fetch

afterEach(() => {
  if (originalParentPort) {
    Object.defineProperty(process, 'parentPort', originalParentPort)
  } else {
    delete (process as Partial<NodeJS.Process>).parentPort
  }
  global.fetch = originalFetch
  vi.resetModules()
})

describe('Weixin utility-process entry', () => {
  it('uses process.parentPort for utility-process messaging', async () => {
    const parentPort = new FakeParentPort()
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      value: parentPort
    })

    await import('./wechat-sidecar')

    expect(parentPort.listenerCount('message')).toBe(1)
    expect(parentPort.messages).toEqual([
      { type: 'status', status: 'stopped' }
    ])
  })

  it('does not follow API redirects outside Tencent Weixin hosts', async () => {
    const parentPort = new FakeParentPort()
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      value: parentPort
    })
    global.fetch = vi.fn(async () =>
      new Response(null, {
        status: 307,
        headers: {
          location: 'https://attacker.example/collect'
        }
      })
    ) as typeof fetch
    await import('./wechat-sidecar')

    parentPort.emit('message', {
      data: { type: 'start_login' }
    })

    await vi.waitFor(() =>
      expect(parentPort.messages).toContainEqual(
        expect.objectContaining({
          type: 'status',
          status: 'failed',
          detail: expect.stringContaining('不受信任')
        })
      )
    )
    expect(fetch).toHaveBeenCalledOnce()
  })
})
