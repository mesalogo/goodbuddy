import type {
  RerankProvider,
  RerankProviderResult
} from './types'

const DEFAULT_ENDPOINT = 'https://api.cohere.com/v1/rerank'
const DEFAULT_MODEL = 'rerank-v3.5'
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 120_000
const MAX_URL_LENGTH = 2_048
const MAX_MODEL_LENGTH = 256
const MAX_QUERY_LENGTH = 4_000
const MAX_DOCUMENTS = 100
const MAX_DOCUMENT_LENGTH = 8_000
const MAX_BODY_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024

export interface CohereRerankClientOptions {
  endpoint?: string
  model?: string
  apiKey?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

function requiredString(value: string, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  const normalized = value.trim()
  if (normalized.length > maximum) {
    throw new RangeError(`${field} must be at most ${maximum} characters`)
  }
  return normalized
}

function normalizedEndpoint(input: string): string {
  const value = requiredString(input, 'endpoint', MAX_URL_LENGTH)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RangeError('endpoint must be a valid HTTP or HTTPS URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new RangeError('endpoint must use HTTP or HTTPS')
  }
  url.hash = ''
  return url.toString()
}

function timeoutValue(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`
    )
  }
  return value
}

function rerankAbortError(
  requestSignal: AbortSignal,
  timeoutError: Error
): Error {
  if (requestSignal.reason === timeoutError) {
    return timeoutError
  }
  const error = new Error('Rerank request was cancelled')
  error.name = 'AbortError'
  return error
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    throw new RangeError('Rerank response is too large')
  }
  if (!response.body) {
    throw new Error('Rerank response has no body')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const result = await reader.read()
    if (result.done) {
      break
    }
    length += result.value.byteLength
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new RangeError('Rerank response is too large')
    }
    chunks.push(result.value)
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new Error('Rerank response is not valid JSON')
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  )
}

function validateResults(
  value: unknown,
  candidateCount: number,
  topN: number
): RerankProviderResult[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, ['results'])
  ) {
    throw new Error('Rerank response has an invalid shape')
  }
  const rawResults = (value as { results: unknown }).results
  const expectedCount = Math.min(candidateCount, topN)
  if (!Array.isArray(rawResults) || rawResults.length !== expectedCount) {
    throw new Error(
      `Rerank response must contain exactly ${expectedCount} results`
    )
  }

  const indexes = new Set<number>()
  const results = rawResults.map((item, position) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item) ||
      !hasExactKeys(item as Record<string, unknown>, [
        'index',
        'relevance_score'
      ])
    ) {
      throw new Error(`Rerank response item ${position} is invalid`)
    }
    const { index, relevance_score: relevanceScore } = item as {
      index: unknown
      relevance_score: unknown
    }
    if (
      !Number.isSafeInteger(index) ||
      (index as number) < 0 ||
      (index as number) >= candidateCount ||
      indexes.has(index as number)
    ) {
      throw new Error('Rerank response contains invalid indexes')
    }
    if (
      typeof relevanceScore !== 'number' ||
      !Number.isFinite(relevanceScore) ||
      relevanceScore < 0 ||
      relevanceScore > 1
    ) {
      throw new TypeError('Rerank response contains an invalid score')
    }
    indexes.add(index as number)
    return {
      index: index as number,
      relevanceScore
    }
  })

  return results.sort(
    (left, right) =>
      right.relevanceScore - left.relevanceScore ||
      left.index - right.index
  )
}

export class CohereRerankClient implements RerankProvider {
  readonly provider = 'cohere-compatible'
  readonly model: string
  readonly fingerprint: string
  private readonly endpoint: string
  private readonly apiKey?: string
  private readonly timeoutMs: number
  private readonly transport: typeof fetch

  constructor(options: CohereRerankClientOptions = {}) {
    this.endpoint = normalizedEndpoint(options.endpoint ?? DEFAULT_ENDPOINT)
    this.model = requiredString(
      options.model ?? DEFAULT_MODEL,
      'model',
      MAX_MODEL_LENGTH
    )
    this.apiKey = options.apiKey?.trim() || undefined
    this.fingerprint = `${this.provider}:${this.endpoint}:${this.model}`
    this.timeoutMs = timeoutValue(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.transport = options.fetch ?? globalThis.fetch
    if (typeof this.transport !== 'function') {
      throw new Error('A Fetch API implementation is required')
    }
  }

  async rerank(
    query: string,
    documents: readonly string[],
    topN: number,
    signal?: AbortSignal
  ): Promise<RerankProviderResult[]> {
    const normalizedQuery = requiredString(query, 'query', MAX_QUERY_LENGTH)
    if (
      !Array.isArray(documents) ||
      documents.length < 1 ||
      documents.length > MAX_DOCUMENTS
    ) {
      throw new RangeError(
        `documents must contain between 1 and ${MAX_DOCUMENTS} items`
      )
    }
    const normalizedDocuments = documents.map((document, index) => {
      if (typeof document !== 'string' || document.length < 1) {
        throw new TypeError(`documents[${index}] must be a non-empty string`)
      }
      if (document.length > MAX_DOCUMENT_LENGTH) {
        throw new RangeError(
          `documents[${index}] must be at most ${MAX_DOCUMENT_LENGTH} characters`
        )
      }
      return document
    })
    if (
      !Number.isSafeInteger(topN) ||
      topN < 1 ||
      topN > normalizedDocuments.length
    ) {
      throw new RangeError(
        'topN must be an integer between 1 and the document count'
      )
    }

    const body = JSON.stringify({
      model: this.model,
      query: normalizedQuery,
      documents: normalizedDocuments,
      top_n: topN,
      return_documents: false
    })
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      throw new RangeError('Rerank request body is too large')
    }

    const timeoutError = new Error('Rerank request timed out')
    timeoutError.name = 'TimeoutError'
    const timeoutController = new AbortController()
    const timeoutId = setTimeout(
      () => timeoutController.abort(timeoutError),
      this.timeoutMs
    )
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
    if (requestSignal.aborted) {
      clearTimeout(timeoutId)
      throw rerankAbortError(requestSignal, timeoutError)
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json'
    }
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`
    }

    let response: Response | undefined
    try {
      response = await this.transport(this.endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: requestSignal
      })
      if (!response.ok) {
        throw new Error(`Rerank request failed with HTTP ${response.status}`)
      }
      return validateResults(
        await readBoundedJson(response),
        normalizedDocuments.length,
        topN
      )
    } catch (error) {
      if (requestSignal.aborted) {
        throw rerankAbortError(requestSignal, timeoutError)
      }
      if (response) {
        throw error
      }
      throw new Error('Rerank request failed', { cause: error })
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
