import type { EmbeddingProvider } from './types'

const MAX_INPUTS = 256
const MAX_BATCH_SIZE = 32
const MAX_INPUT_LENGTH = 16_000
const MAX_BATCH_CHARACTERS = 128_000
const MAX_MODEL_LENGTH = 256
const MAX_URL_LENGTH = 2_048
const MAX_DIMENSIONS = 8_192
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const MIN_TIMEOUT_MS = 100
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = DEFAULT_TIMEOUT_MS

export interface OpenAIEmbeddingClientOptions {
  endpoint: string
  model: string
  apiKey?: string
  batchSize?: number
  timeoutMs?: number
  fetch?: typeof fetch
}

function boundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${field} must be an integer between ${minimum} and ${maximum}`
    )
  }
  return value
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
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new RangeError('endpoint must use HTTP or HTTPS')
  }
  url.hash = ''
  return url.toString()
}

function embeddingAbortError(
  requestSignal: AbortSignal,
  timeoutError: Error
): Error {
  if (requestSignal.reason === timeoutError) {
    return timeoutError
  }
  const error = new Error('Embedding request was cancelled')
  error.name = 'AbortError'
  return error
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (
    declaredLength !== null &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    throw new RangeError('Embedding response is too large')
  }
  if (!response.body) {
    throw new Error('Embedding response has no body')
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
      throw new RangeError('Embedding response is too large')
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
    throw new Error('Embedding response is not valid JSON')
  }
}

function validateVector(value: unknown, index: number): number[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_DIMENSIONS
  ) {
    throw new RangeError(`Embedding ${index} has invalid dimensions`)
  }
  let magnitudeSquared = 0
  const vector = value.map((component) => {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new TypeError('Embeddings must contain finite numbers')
    }
    magnitudeSquared += component * component
    return component
  })
  if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 0) {
    throw new RangeError('Embeddings must have a finite non-zero norm')
  }
  return vector
}

function validateEmbeddings(value: unknown, expected: number): number[][] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('data' in value) ||
    !Array.isArray(value.data) ||
    value.data.length !== expected
  ) {
    throw new Error('Embedding response has an invalid result count')
  }
  const vectors: Array<number[] | undefined> = Array.from({
    length: expected
  })
  for (const [position, item] of value.data.entries()) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('embedding' in item)
    ) {
      throw new Error(`Embedding response item ${position} is invalid`)
    }
    const index =
      'index' in item && Number.isSafeInteger(item.index)
        ? (item.index as number)
        : position
    if (index < 0 || index >= expected || vectors[index]) {
      throw new Error('Embedding response contains invalid indexes')
    }
    vectors[index] = validateVector(item.embedding, index)
  }
  const dimensions = vectors[0]?.length
  if (
    dimensions === undefined ||
    vectors.some((vector) => vector?.length !== dimensions)
  ) {
    throw new Error('Embeddings have inconsistent dimensions')
  }
  return vectors as number[][]
}

export class OpenAIEmbeddingClient implements EmbeddingProvider {
  readonly provider = 'openai-compatible'
  readonly model: string
  readonly fingerprint: string
  private readonly endpoint: string
  private readonly apiKey?: string
  private readonly batchSize: number
  private readonly timeoutMs: number
  private readonly transport: typeof fetch

  constructor(options: OpenAIEmbeddingClientOptions) {
    this.endpoint = normalizedEndpoint(options.endpoint)
    this.model = requiredString(options.model, 'model', MAX_MODEL_LENGTH)
    this.apiKey = options.apiKey?.trim() || undefined
    this.fingerprint = `${this.provider}:${this.endpoint}:${this.model}`
    this.batchSize = boundedInteger(
      options.batchSize ?? 16,
      'batchSize',
      1,
      MAX_BATCH_SIZE
    )
    this.timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeoutMs',
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    )
    this.transport = options.fetch ?? globalThis.fetch
    if (typeof this.transport !== 'function') {
      throw new Error('A Fetch API implementation is required')
    }
  }

  async embed(
    input: readonly string[],
    signal?: AbortSignal
  ): Promise<number[][]> {
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_INPUTS) {
      throw new RangeError(`input must contain between 1 and ${MAX_INPUTS} items`)
    }
    const normalized = input.map((item, index) => {
      if (typeof item !== 'string' || item.length < 1) {
        throw new TypeError(`input[${index}] must be a non-empty string`)
      }
      if (item.length > MAX_INPUT_LENGTH) {
        throw new RangeError(
          `input[${index}] must be at most ${MAX_INPUT_LENGTH} characters`
        )
      }
      return item
    })

    const embeddings: number[][] = []
    let offset = 0
    let expectedDimensions: number | undefined
    while (offset < normalized.length) {
      let end = offset
      let characters = 0
      while (end < normalized.length && end - offset < this.batchSize) {
        const next = normalized[end]
        if (next === undefined) {
          break
        }
        if (end > offset && characters + next.length > MAX_BATCH_CHARACTERS) {
          break
        }
        characters += next.length
        end += 1
      }
      const vectors = await this.embedBatch(
        normalized.slice(offset, end),
        signal
      )
      for (const vector of vectors) {
        if (expectedDimensions === undefined) {
          expectedDimensions = vector.length
        } else if (vector.length !== expectedDimensions) {
          throw new Error('Embedding batches have inconsistent dimensions')
        }
        embeddings.push(vector)
      }
      offset = end
    }
    return embeddings
  }

  private async embedBatch(
    input: readonly string[],
    signal?: AbortSignal
  ): Promise<number[][]> {
    const timeoutError = new Error('Embedding request timed out')
    timeoutError.name = 'TimeoutError'
    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => {
      timeoutController.abort(timeoutError)
    }, this.timeoutMs)
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
    if (requestSignal.aborted) {
      clearTimeout(timeoutId)
      throw embeddingAbortError(requestSignal, timeoutError)
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
        body: JSON.stringify({ model: this.model, input }),
        redirect: 'error',
        signal: requestSignal
      })
      if (!response.ok) {
        throw new Error(
          `Embedding request failed with HTTP ${response.status}`
        )
      }
      return validateEmbeddings(
        await readBoundedJson(response),
        input.length
      )
    } catch (error) {
      if (requestSignal.aborted) {
        throw embeddingAbortError(requestSignal, timeoutError)
      }
      if (response) {
        throw error
      }
      throw new Error('Embedding request failed', { cause: error })
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
