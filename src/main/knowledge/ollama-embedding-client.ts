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
const MAX_TIMEOUT_MS = 120_000

export interface OllamaEmbeddingClientOptions {
  url: string
  model: string
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

function endpointFor(input: string): string {
  const value = requiredString(input, 'url', MAX_URL_LENGTH)
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new RangeError('url must use HTTP or HTTPS')
  }
  if (url.username || url.password) {
    throw new RangeError('url must not contain credentials')
  }
  url.search = ''
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/api/embed`
  return url.toString()
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (
    declaredLength !== null &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    throw new RangeError('Ollama embedding response is too large')
  }
  if (!response.body) {
    throw new Error('Ollama embedding response has no body')
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
      throw new RangeError('Ollama embedding response is too large')
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
    throw new Error('Ollama embedding response is not valid JSON')
  }
}

function validateEmbeddings(value: unknown, expected: number): number[][] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('embeddings' in value) ||
    !Array.isArray(value.embeddings) ||
    value.embeddings.length !== expected
  ) {
    throw new Error('Ollama embedding response has an invalid result count')
  }
  let dimensions: number | undefined
  return value.embeddings.map((candidate, embeddingIndex) => {
    if (
      !Array.isArray(candidate) ||
      candidate.length < 1 ||
      candidate.length > MAX_DIMENSIONS
    ) {
      throw new RangeError(
        `Ollama embedding ${embeddingIndex} has invalid dimensions`
      )
    }
    if (dimensions === undefined) {
      dimensions = candidate.length
    } else if (candidate.length !== dimensions) {
      throw new Error('Ollama embeddings have inconsistent dimensions')
    }
    let magnitudeSquared = 0
    const vector = candidate.map((component) => {
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        throw new TypeError('Ollama embeddings must contain finite numbers')
      }
      magnitudeSquared += component * component
      return component
    })
    if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 0) {
      throw new RangeError('Ollama embeddings must have a finite non-zero norm')
    }
    return vector
  })
}

export class OllamaEmbeddingClient implements EmbeddingProvider {
  readonly provider = 'ollama'
  readonly model: string
  readonly fingerprint: string
  private readonly endpoint: string
  private readonly batchSize: number
  private readonly timeoutMs: number
  private readonly transport: typeof fetch

  constructor(options: OllamaEmbeddingClientOptions) {
    this.endpoint = endpointFor(options.url)
    this.model = requiredString(options.model, 'model', MAX_MODEL_LENGTH)
    this.fingerprint = `${this.provider}:${this.endpoint}:${this.model}`
    this.batchSize = boundedInteger(
      options.batchSize ?? 16,
      'batchSize',
      1,
      MAX_BATCH_SIZE
    )
    this.timeoutMs = boundedInteger(
      options.timeoutMs ?? 15_000,
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
      const batch = normalized.slice(offset, end)
      const vectors = await this.embedBatch(batch, signal)
      for (const vector of vectors) {
        if (expectedDimensions === undefined) {
          expectedDimensions = vector.length
        } else if (vector.length !== expectedDimensions) {
          throw new Error('Ollama embedding batches have inconsistent dimensions')
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
    if (signal?.aborted) {
      throw signal.reason
    }
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.transport(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          input,
          truncate: true
        }),
        redirect: 'error',
        signal: requestSignal
      })
    } catch (error) {
      if (requestSignal.aborted) {
        const abortError = new Error('Ollama embedding request was cancelled')
        abortError.name = 'AbortError'
        throw abortError
      }
      throw new Error('Ollama embedding request failed', { cause: error })
    }
    if (!response.ok) {
      throw new Error(`Ollama embedding request failed with HTTP ${response.status}`)
    }
    return validateEmbeddings(await readBoundedJson(response), input.length)
  }
}
