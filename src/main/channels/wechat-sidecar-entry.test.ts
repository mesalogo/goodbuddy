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

afterEach(() => {
  if (originalParentPort) {
    Object.defineProperty(process, 'parentPort', originalParentPort)
  } else {
    delete (process as Partial<NodeJS.Process>).parentPort
  }
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
})
