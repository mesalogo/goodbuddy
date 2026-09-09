export type ExternalKnowledgeProvider = 'dify' | 'fastgpt' | 'ragflow'

export type ExternalKnowledgeCatalogItem = {
  id: string
  name: string
  description?: string
  graphEnabled?: boolean
}

export type ExternalKnowledgeCatalogPage = {
  items: ExternalKnowledgeCatalogItem[]
  total?: number
  hasMore: boolean
}

export type ExternalKnowledgeRetrievalConfig =
  | { provider: 'dify'; useDatasetDefaults: true }
  | {
      provider: 'fastgpt'
      searchMode: 'embedding' | 'fullTextRecall' | 'mixedRecall'
      tokenLimit: number
      similarity: number
      usingRerank: boolean
    }
  | {
      provider: 'ragflow'
      similarityThreshold: number
      vectorSimilarityWeight: number
      knnTopK: number
      useKg: boolean
      includeKnowledgeCompilation: boolean
    }

export type ExternalKnowledgeRetrievalResult = {
  documentTitle: string
  sourceDisplayName: string
  snippet: string
  providerScore?: number
  remoteDocumentId?: string
  remoteChunkId?: string
  location?: string
}

export class ExternalKnowledgeError extends Error {
  constructor(
    readonly code:
      | 'EXTERNAL_KB_NETWORK'
      | 'EXTERNAL_KB_TIMEOUT'
      | 'EXTERNAL_KB_AUTH'
      | 'EXTERNAL_KB_FORBIDDEN'
      | 'EXTERNAL_KB_NOT_FOUND'
      | 'EXTERNAL_KB_RATE_LIMITED'
      | 'EXTERNAL_KB_INVALID_RESPONSE'
      | 'EXTERNAL_KB_SERVER',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ExternalKnowledgeError'
  }
}

type ExternalKnowledgeClientOptions = {
  provider: ExternalKnowledgeProvider
  baseUrl: string
  apiKey: string
  fetcher?: typeof fetch
  timeoutMs?: number
  maximumResponseBytes?: number
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const boundedString = (value: unknown, maximum: number): string | undefined =>
  typeof value === 'string' && value.length > 0
    ? value.slice(0, maximum)
    : undefined

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function normalizeBaseUrl(provider: ExternalKnowledgeProvider, input: string): URL {
  const url = new URL(input.trim())
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('External knowledge base URL must use HTTP or HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('External knowledge base URL cannot contain credentials, query, or fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (provider === 'dify') {
    url.pathname = url.pathname.replace(/\/v1$/, '')
  } else if (provider === 'fastgpt') {
    url.pathname = url.pathname.replace(/\/api\/core\/dataset$/, '/api')
    if (!url.pathname.endsWith('/api')) url.pathname += '/api'
  } else {
    url.pathname = url.pathname.replace(/\/api\/v1$/, '')
  }
  return url
}

function endpoint(baseUrl: URL, path: string): URL {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname}${path}`.replace(/\/{2,}/g, '/')
  return url
}

function errorForStatus(status: number): ExternalKnowledgeError {
  if (status === 401) return new ExternalKnowledgeError('EXTERNAL_KB_AUTH', 'External knowledge authentication failed')
  if (status === 403) return new ExternalKnowledgeError('EXTERNAL_KB_FORBIDDEN', 'External knowledge access is forbidden')
  if (status === 404) return new ExternalKnowledgeError('EXTERNAL_KB_NOT_FOUND', 'External knowledge target was not found')
  if (status === 429) return new ExternalKnowledgeError('EXTERNAL_KB_RATE_LIMITED', 'External knowledge service rate limit reached')
  return new ExternalKnowledgeError('EXTERNAL_KB_SERVER', `External knowledge service returned HTTP ${status}`)
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ExternalKnowledgeError('EXTERNAL_KB_INVALID_RESPONSE', 'External knowledge response is too large')
  }
  if (!response.body) {
    throw new ExternalKnowledgeError('EXTERNAL_KB_INVALID_RESPONSE', 'External knowledge response is empty')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new ExternalKnowledgeError('EXTERNAL_KB_INVALID_RESPONSE', 'External knowledge response is too large')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
  try {
    return JSON.parse(body) as unknown
  } catch (error) {
    throw new ExternalKnowledgeError('EXTERNAL_KB_INVALID_RESPONSE', 'External knowledge response is not valid JSON', { cause: error })
  }
}

export class ExternalKnowledgeClient {
  readonly provider: ExternalKnowledgeProvider
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number
  private readonly maximumResponseBytes: number
  private readonly normalizedBaseUrl: URL

  constructor(options: ExternalKnowledgeClientOptions) {
    this.provider = options.provider
    this.normalizedBaseUrl = normalizeBaseUrl(options.provider, options.baseUrl)
    this.baseUrl = this.normalizedBaseUrl.href.replace(/\/$/, '')
    this.apiKey = options.apiKey.trim()
    if (!this.apiKey) throw new TypeError('External knowledge API key is required')
    this.fetcher = options.fetcher ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.maximumResponseBytes = options.maximumResponseBytes ?? 5_000_000
  }

  async listKnowledgeBases(signal?: AbortSignal): Promise<ExternalKnowledgeCatalogPage> {
    if (this.provider === 'dify') {
      const url = endpoint(this.normalizedBaseUrl, '/v1/datasets')
      url.searchParams.set('page', '1')
      url.searchParams.set('limit', '100')
      const body = asRecord(await this.request(url, { method: 'GET' }, signal))
      const items = Array.isArray(body?.data) ? body.data : undefined
      if (!items) throw this.invalidResponse()
      return {
        items: items.slice(0, 100).map((item) => this.catalogItem(item)),
        total: finiteNumber(body?.total),
        hasMore: body?.has_more === true
      }
    }

    if (this.provider === 'fastgpt') {
      const body = asRecord(await this.request(
        endpoint(this.normalizedBaseUrl, '/core/dataset/list'),
        { method: 'POST', body: JSON.stringify({ pageNum: 1, pageSize: 100 }) },
        signal
      ))
      const data = asRecord(body?.data)
      const items = Array.isArray(body?.data)
        ? body.data
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.list)
            ? data.list
            : undefined
      if (body?.code !== 200 || !items) throw this.invalidResponse()
      const datasets = items.filter((item) => asRecord(item)?.type === 'dataset')
      return {
        items: datasets.slice(0, 100).map((item) => this.catalogItem(item, '_id', 'intro')),
        total: finiteNumber(data?.total) ?? datasets.length,
        hasMore: datasets.length > 100
      }
    }

    const url = endpoint(this.normalizedBaseUrl, '/api/v1/datasets')
    url.searchParams.set('page', '1')
    url.searchParams.set('page_size', '100')
    const body = asRecord(await this.request(url, { method: 'GET' }, signal))
    if (body?.code !== 0 || !Array.isArray(body.data)) throw this.invalidResponse()
    return {
      items: body.data.slice(0, 100).map((item) => {
        const record = asRecord(item)
        const graphFinishedAt = record?.graphrag_task_finish_at
        return {
          ...this.catalogItem(item),
          graphEnabled:
            (typeof graphFinishedAt === 'number' && graphFinishedAt > 0) ||
            (typeof graphFinishedAt === 'string' && graphFinishedAt.length > 0)
        }
      }),
      total: finiteNumber(body.total_datasets),
      hasMore: (finiteNumber(body.total_datasets) ?? 0) > 100
    }
  }

  async retrieve(
    remoteKnowledgeBaseId: string,
    query: string,
    config: ExternalKnowledgeRetrievalConfig,
    signal?: AbortSignal
  ): Promise<ExternalKnowledgeRetrievalResult[]> {
    if (config.provider !== this.provider) throw new TypeError('Provider configuration does not match client')
    const remoteId = remoteKnowledgeBaseId.trim()
    const question = query.trim()
    if (!remoteId || !question) throw new TypeError('Remote knowledge base ID and query are required')

    if (this.provider === 'dify') {
      if (question.length > 250) throw new RangeError('Dify queries cannot exceed 250 characters')
      const body = asRecord(await this.request(
        endpoint(this.normalizedBaseUrl, `/v1/datasets/${encodeURIComponent(remoteId)}/retrieve`),
        { method: 'POST', body: JSON.stringify({ query: question }) },
        signal
      ))
      if (!Array.isArray(body?.records)) throw this.invalidResponse()
      return body.records.slice(0, 20).map((item) => this.difyResult(item))
    }

    if (this.provider === 'fastgpt' && config.provider === 'fastgpt') {
      const body = asRecord(await this.request(
        endpoint(this.normalizedBaseUrl, '/core/dataset/searchTest'),
        {
          method: 'POST',
          body: JSON.stringify({
            datasetId: remoteId,
            text: question,
            limit: config.tokenLimit,
            similarity: config.similarity,
            searchMode: config.searchMode,
            usingReRank: config.usingRerank
          })
        },
        signal
      ))
      const data = asRecord(body?.data)
      if (body?.code !== 200 || !Array.isArray(data?.list)) throw this.invalidResponse()
      return data.list.slice(0, 20).map((item) => this.fastGptResult(item))
    }

    if (this.provider === 'ragflow' && config.provider === 'ragflow') {
      const body = asRecord(await this.request(
        endpoint(this.normalizedBaseUrl, '/api/v1/retrieval'),
        {
          method: 'POST',
          body: JSON.stringify({
            question,
            dataset_ids: [remoteId],
            page: 1,
            page_size: 20,
            similarity_threshold: config.similarityThreshold,
            vector_similarity_weight: config.vectorSimilarityWeight,
            knn_top_k: config.knnTopK,
            use_kg: config.useKg,
            include_knowledge_compilation: config.includeKnowledgeCompilation
          })
        },
        signal
      ))
      const data = asRecord(body?.data)
      if (body?.code !== 0 || !Array.isArray(data?.chunks)) throw this.invalidResponse()
      return data.chunks.slice(0, 20).map((item) => this.ragflowResult(item))
    }

    throw new TypeError('Provider configuration does not match client')
  }

  private async request(url: URL, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const effectiveSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs)
    let response: Response
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: 'error',
        signal: effectiveSignal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {})
        }
      })
    } catch (error) {
      const code = effectiveSignal.aborted ? 'EXTERNAL_KB_TIMEOUT' : 'EXTERNAL_KB_NETWORK'
      throw new ExternalKnowledgeError(code, code === 'EXTERNAL_KB_TIMEOUT' ? 'External knowledge request timed out' : 'External knowledge service is unreachable', { cause: error })
    }
    if (!response.ok) throw errorForStatus(response.status)
    return readBoundedJson(response, this.maximumResponseBytes)
  }

  private catalogItem(value: unknown, idKey = 'id', descriptionKey = 'description'): ExternalKnowledgeCatalogItem {
    const record = asRecord(value)
    const id = boundedString(record?.[idKey], 128)
    const name = boundedString(record?.name, 512)
    if (!id || !name) throw this.invalidResponse()
    return { id, name, description: boundedString(record?.[descriptionKey], 2_000) }
  }

  private difyResult(value: unknown): ExternalKnowledgeRetrievalResult {
    const record = asRecord(value)
    const segment = asRecord(record?.segment)
    const document = asRecord(segment?.document)
    const snippet = boundedString(segment?.content, 8_000)
    if (!snippet) throw this.invalidResponse()
    const title = boundedString(document?.name, 512) ?? 'Dify document'
    return {
      documentTitle: title,
      sourceDisplayName: title,
      snippet,
      providerScore: finiteNumber(record?.score),
      remoteDocumentId: boundedString(document?.id, 128),
      remoteChunkId: boundedString(segment?.id, 128),
      location: finiteNumber(segment?.position) === undefined ? undefined : `segment ${segment?.position}`
    }
  }

  private fastGptResult(value: unknown): ExternalKnowledgeRetrievalResult {
    const record = asRecord(value)
    const question = boundedString(record?.q, 8_000)
    const answer = boundedString(record?.a, 8_000)
    const snippet = [question, answer].filter(Boolean).join('\n')
    if (!snippet) throw this.invalidResponse()
    const title = boundedString(record?.sourceName, 512) ?? 'FastGPT document'
    return {
      documentTitle: title,
      sourceDisplayName: title,
      snippet: snippet.slice(0, 8_000),
      providerScore: finiteNumber(record?.score),
      remoteDocumentId: boundedString(record?.sourceId, 128),
      remoteChunkId: boundedString(record?.id, 128),
      location: finiteNumber(record?.chunkIndex) === undefined ? undefined : `chunk ${record?.chunkIndex}`
    }
  }

  private ragflowResult(value: unknown): ExternalKnowledgeRetrievalResult {
    const record = asRecord(value)
    const snippet = boundedString(record?.content, 8_000)
    if (!snippet) throw this.invalidResponse()
    const title = boundedString(record?.document_keyword, 512) ?? 'RAGFlow document'
    const positions = Array.isArray(record?.positions) ? record.positions : undefined
    return {
      documentTitle: title,
      sourceDisplayName: title,
      snippet,
      providerScore: finiteNumber(record?.similarity),
      remoteDocumentId: boundedString(record?.document_id, 128),
      remoteChunkId: boundedString(record?.id, 128),
      location: positions ? JSON.stringify(positions).slice(0, 8_192) : undefined
    }
  }

  private invalidResponse(): ExternalKnowledgeError {
    return new ExternalKnowledgeError('EXTERNAL_KB_INVALID_RESPONSE', 'External knowledge response does not match the supported API')
  }
}
