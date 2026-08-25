import { FormData } from 'undici'
import { describe, expect, it, vi } from 'vitest'
import type {
  FeedbackPublicPayload
} from '../../shared/feedback-contracts'
import {
  createStrictFeedbackDispatcher,
  GOODBUDDY_FEEDBACK_ENDPOINT,
  StrictFeedbackHttpClient,
  type FeedbackRequest
} from './feedback-http-client'

const payload: FeedbackPublicPayload = {
  schemaVersion: 1,
  productKey: 'goodbuddy',
  category: 'bug',
  title: 'Feedback title',
  description: 'A useful feedback description.',
  environment: {
    appVersion: '0.11.0',
    platform: 'windows',
    architecture: 'x64',
    locale: 'zh-CN'
  },
  installationId: '00000000-0000-4000-8000-000000000301',
  clientRequestId: '00000000-0000-4000-8000-000000000302'
}

function response(
  statusCode: number,
  value: string,
  contentType = 'application/json; charset=utf-8'
) {
  const destroy = vi.fn()
  return {
    response: {
      statusCode,
      headers: {
        'content-type': contentType,
        'content-length': String(Buffer.byteLength(value))
      },
      body: {
        destroy,
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(value)
        }
      }
    },
    destroy
  }
}

function dispatcher() {
  return {
    close: vi.fn(async () => undefined)
  }
}

function client(
  request: FeedbackRequest,
  timeoutMilliseconds = 15_000
) {
  const strictDispatcher = dispatcher()
  return {
    client: new StrictFeedbackHttpClient({
      appVersion: '0.11.0',
      dispatcher: strictDispatcher as never,
      request,
      timeoutMilliseconds
    }),
    dispatcher: strictDispatcher
  }
}

describe('StrictFeedbackHttpClient', () => {
  it('creates a dedicated dispatcher with certificate validation enabled', () => {
    const strictDispatcher = dispatcher()
    const createAgent = vi.fn(() => strictDispatcher as never)
    expect(createStrictFeedbackDispatcher(createAgent)).toBe(
      strictDispatcher
    )
    expect(createAgent).toHaveBeenCalledWith({
      connect: {
        rejectUnauthorized: true
      }
    })
  })

  it('posts JSON to the fixed endpoint without credentials', async () => {
    const success = response(
      201,
      JSON.stringify({
        reference: 'GOODBUDDY-000001',
        duplicate: false
      })
    )
    const request = vi.fn<FeedbackRequest>(
      async () => success.response
    )
    const fixture = client(request)

    await expect(
      fixture.client.submit(payload, undefined, new AbortController().signal)
    ).resolves.toEqual({
      reference: 'GOODBUDDY-000001',
      duplicate: false
    })
    expect(request).toHaveBeenCalledOnce()
    const [url, options] = request.mock.calls[0]!
    expect(url.toString()).toBe(GOODBUDDY_FEEDBACK_ENDPOINT)
    expect(options.method).toBe('POST')
    expect(options.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'GoodBuddy-Feedback/0.11.0'
    })
    expect(JSON.parse(options.body as string)).toEqual(payload)
    expect(JSON.stringify(options)).not.toMatch(
      /authorization|cookie|api.?key/iu
    )
  })

  it('uses one payload field and one normalized PNG part', async () => {
    const success = response(
      200,
      JSON.stringify({
        reference: 'GOODBUDDY-000002',
        duplicate: true
      })
    )
    const request = vi.fn<FeedbackRequest>(
      async () => success.response
    )
    const fixture = client(request)
    const screenshot = Buffer.from('normalized PNG')

    await fixture.client.submit(
      payload,
      screenshot,
      new AbortController().signal
    )
    const body = request.mock.calls[0]![1].body
    expect(body).toBeInstanceOf(FormData)
    const form = body as FormData
    expect(JSON.parse(String(form.get('payload')))).toEqual(payload)
    expect(form.getAll('payload')).toHaveLength(1)
    expect(form.getAll('screenshot')).toHaveLength(1)
    expect(form.get('screenshot')).toMatchObject({
      name: 'feedback.png',
      type: 'image/png',
      size: screenshot.byteLength
    })
  })

  it.each([
    [400, 'invalid-submission'],
    [403, 'incompatible-client'],
    [404, 'unavailable'],
    [413, 'screenshot-too-large'],
    [429, 'rate-limited'],
    [503, 'service-error'],
    [302, 'unavailable']
  ] as const)(
    'maps HTTP %i to %s without following it',
    async (statusCode, code) => {
      const failure = response(statusCode, '{"error":"failure"}')
      const request = vi.fn<FeedbackRequest>(
        async () => failure.response
      )
      const fixture = client(request)
      await expect(
        fixture.client.submit(
          payload,
          undefined,
          new AbortController().signal
        )
      ).rejects.toMatchObject({
        code
      })
      expect(failure.destroy).toHaveBeenCalledOnce()
    }
  )

  it('rejects non-JSON and oversized success responses', async () => {
    const wrongType = response(201, 'ok', 'text/plain')
    const wrongTypeRequest = vi.fn<FeedbackRequest>(
      async () => wrongType.response
    )
    await expect(
      client(wrongTypeRequest).client.submit(
        payload,
        undefined,
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const largeBody = Buffer.alloc(16 * 1_024 + 1, 1)
    const destroy = vi.fn()
    const largeRequest = vi.fn<FeedbackRequest>(async () => ({
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: {
        destroy,
        async *[Symbol.asyncIterator]() {
          yield largeBody
        }
      }
    }))
    await expect(
      client(largeRequest).client.submit(
        payload,
        undefined,
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'invalid-response'
    })
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('bounds request time and closes only its own dispatcher', async () => {
    const request = vi.fn<FeedbackRequest>(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true }
          )
        })
    )
    const fixture = client(request, 5)
    await expect(
      fixture.client.submit(
        payload,
        undefined,
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'timeout'
    })
    await fixture.client.close()
    expect(fixture.dispatcher.close).toHaveBeenCalledOnce()
  })
})
