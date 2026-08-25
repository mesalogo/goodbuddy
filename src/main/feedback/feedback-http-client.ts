import {
  Agent,
  FormData,
  request as undiciRequest,
  type Dispatcher
} from 'undici'
import {
  feedbackPublicResponseSchema,
  type FeedbackPublicPayload,
  type FeedbackPublicResponse,
  type FeedbackSubmissionErrorCode
} from '../../shared/feedback-contracts'

export const GOODBUDDY_FEEDBACK_ENDPOINT =
  'https://imp.mesalogo.com/api/v1/feedback'

const maximumResponseBytes = 16 * 1_024
const defaultTimeoutMilliseconds = 15_000

type FeedbackResponseBody = AsyncIterable<Uint8Array> & {
  destroy(error?: Error): void
}

type FeedbackHttpResponse = {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: FeedbackResponseBody
}

type FeedbackRequestOptions = {
  dispatcher: Dispatcher
  method: 'POST'
  headers: Record<string, string>
  body: string | FormData
  signal: AbortSignal
  headersTimeout: number
  bodyTimeout: number
  idempotent: false
  blocking: true
}

export type FeedbackRequest = (
  url: URL,
  options: FeedbackRequestOptions
) => Promise<FeedbackHttpResponse>

type StrictFeedbackAgentOptions = {
  connect: {
    rejectUnauthorized: true
  }
}

const defaultFeedbackRequest: FeedbackRequest = async (
  url,
  options
) => {
  const response = await undiciRequest(url, options)
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body
  }
}

export function createStrictFeedbackDispatcher(
  createAgent: (
    options: StrictFeedbackAgentOptions
  ) => Dispatcher = (options) => new Agent(options)
): Dispatcher {
  return createAgent({
    connect: {
      rejectUnauthorized: true
    }
  })
}

export class FeedbackClientError extends Error {
  constructor(readonly code: FeedbackSubmissionErrorCode) {
    super(code)
    this.name = 'FeedbackClientError'
  }
}

function feedbackEndpoint(value: string): URL {
  const endpoint = new URL(value)
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/api/v1/feedback'
  ) {
    throw new Error('Feedback endpoint must be the versioned HTTPS API')
  }
  return endpoint
}

function headerValue(
  headers: FeedbackHttpResponse['headers'],
  name: string
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

async function readBoundedBody(
  body: FeedbackResponseBody
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body) {
    const bytes = Buffer.from(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength
    )
    total += bytes.byteLength
    if (total > maximumResponseBytes) {
      body.destroy()
      throw new FeedbackClientError('invalid-response')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total)
}

function mapStatus(statusCode: number): FeedbackSubmissionErrorCode {
  if (statusCode === 400 || statusCode === 422) {
    return 'invalid-submission'
  }
  if (statusCode === 403) {
    return 'incompatible-client'
  }
  if (statusCode === 404 || (statusCode >= 300 && statusCode < 400)) {
    return 'unavailable'
  }
  if (statusCode === 413) {
    return 'screenshot-too-large'
  }
  if (statusCode === 429) {
    return 'rate-limited'
  }
  if (statusCode >= 500) {
    return 'service-error'
  }
  return 'unavailable'
}

export class StrictFeedbackHttpClient {
  private readonly endpoint: URL
  private closed = false

  constructor(
    private readonly options: {
      appVersion: string
      dispatcher: Dispatcher
      request?: FeedbackRequest
      endpoint?: string
      timeoutMilliseconds?: number
    }
  ) {
    this.endpoint = feedbackEndpoint(
      options.endpoint ?? GOODBUDDY_FEEDBACK_ENDPOINT
    )
  }

  async submit(
    payload: FeedbackPublicPayload,
    screenshot: Buffer | undefined,
    externalSignal: AbortSignal
  ): Promise<FeedbackPublicResponse> {
    if (this.closed) {
      throw new FeedbackClientError('unavailable')
    }
    const controller = new AbortController()
    const forwardAbort = (): void => {
      controller.abort(externalSignal.reason)
    }
    if (externalSignal.aborted) {
      forwardAbort()
    } else {
      externalSignal.addEventListener('abort', forwardAbort, {
        once: true
      })
    }
    const timeoutMilliseconds =
      this.options.timeoutMilliseconds ??
      defaultTimeoutMilliseconds
    const timeout = setTimeout(() => {
      controller.abort(new Error('Feedback request timed out'))
    }, timeoutMilliseconds)
    timeout.unref()

    try {
      const serializedPayload = JSON.stringify(payload)
      const headers: Record<string, string> = {
        accept: 'application/json',
        'user-agent': `GoodBuddy-Feedback/${this.options.appVersion}`
      }
      let body: string | FormData = serializedPayload
      if (screenshot) {
        const form = new FormData()
        const screenshotBytes = new Uint8Array(screenshot.byteLength)
        screenshotBytes.set(screenshot)
        form.append('payload', serializedPayload)
        form.append(
          'screenshot',
          new File([screenshotBytes], 'feedback.png', {
            type: 'image/png'
          })
        )
        body = form
      } else {
        headers['content-type'] = 'application/json'
      }

      const response = await (
        this.options.request ?? defaultFeedbackRequest
      )(this.endpoint, {
        dispatcher: this.options.dispatcher,
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        headersTimeout: timeoutMilliseconds,
        bodyTimeout: timeoutMilliseconds,
        idempotent: false,
        blocking: true
      })
      if (response.statusCode !== 200 && response.statusCode !== 201) {
        response.body.destroy()
        throw new FeedbackClientError(
          mapStatus(response.statusCode)
        )
      }
      const contentType = headerValue(
        response.headers,
        'content-type'
      )
      if (
        !contentType ||
        !/^application\/json(?:;|$)/iu.test(contentType)
      ) {
        response.body.destroy()
        throw new FeedbackClientError('invalid-response')
      }
      const contentLength = Number(
        headerValue(response.headers, 'content-length')
      )
      if (
        Number.isFinite(contentLength) &&
        contentLength > maximumResponseBytes
      ) {
        response.body.destroy()
        throw new FeedbackClientError('invalid-response')
      }
      const responseBody = await readBoundedBody(response.body)
      let parsed: unknown
      try {
        parsed = JSON.parse(responseBody.toString('utf8')) as unknown
      } catch {
        throw new FeedbackClientError('invalid-response')
      }
      const result = feedbackPublicResponseSchema.safeParse(parsed)
      if (!result.success) {
        throw new FeedbackClientError('invalid-response')
      }
      return result.data
    } catch (error) {
      if (error instanceof FeedbackClientError) {
        throw error
      }
      if (externalSignal.aborted) {
        throw new FeedbackClientError('network')
      }
      if (controller.signal.aborted) {
        throw new FeedbackClientError('timeout')
      }
      throw new FeedbackClientError('network')
    } finally {
      clearTimeout(timeout)
      externalSignal.removeEventListener('abort', forwardAbort)
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    await this.options.dispatcher.close()
  }
}
