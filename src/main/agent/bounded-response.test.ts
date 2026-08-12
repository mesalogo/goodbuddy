import { describe, expect, it } from 'vitest'
import { readBoundedResponseText } from './bounded-response'

describe('readBoundedResponseText', () => {
  it('cancels an oversized response as soon as it crosses the byte limit', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let pulls = 0
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1
          controller.enqueue(chunk)
        }
      })
    )

    await expect(
      readBoundedResponseText(response, {
        maxBytes: 8 * 1024 * 1024,
        tooLargeMessage: 'response too large'
      })
    ).rejects.toThrow('response too large')
    expect(pulls).toBeLessThan(20)
  })

  it('rejects an invalid declared response length without reading the body', async () => {
    let pulls = 0
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1
          controller.enqueue(new Uint8Array([1]))
        }
      }),
      {
        headers: { 'content-length': 'invalid' }
      }
    )

    await expect(
      readBoundedResponseText(response, {
        maxBytes: 1024,
        tooLargeMessage: 'response too large'
      })
    ).rejects.toThrow('response too large')
    expect(pulls).toBe(0)
  })
})
