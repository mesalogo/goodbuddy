import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { URL } from 'node:url'
import { TextDecoder } from 'node:util'

const fetch = globalThis.fetch
const AbortSignal = globalThis.AbortSignal

const providers = ['dify', 'fastgpt', 'ragflow']
const arguments_ = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=')
    return [key, value.join('=') || 'true']
  })
)
const selectedProvider = arguments_.get('provider') ?? 'all'
const query = arguments_.get('query') ?? '知识库'
const extended = arguments_.get('extended') === 'true'
const outputPath = arguments_.get('output')

if (selectedProvider !== 'all' && !providers.includes(selectedProvider)) {
  throw new Error(`Unsupported provider: ${selectedProvider}`)
}
if (!query.trim() || query.length > 250) {
  throw new Error('Probe query must contain 1 to 250 characters')
}

const asRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
const objectKeys = (value) => Object.keys(asRecord(value) ?? {}).sort()
const unionKeys = (values) => [...new Set(values.flatMap(objectKeys))].sort()
const finiteNumbers = (values) => values.filter(Number.isFinite)

async function configurations(provider) {
  const prefix = `GOODBUDDY_${provider.toUpperCase()}`
  const environmentUrl = process.env[`${prefix}_BASE_URL`]?.trim()
  const environmentKey = process.env[`${prefix}_API_KEY`]?.trim()
  if (environmentUrl && environmentKey) {
    return [{ baseUrl: environmentUrl, apiKey: environmentKey }]
  }
  const file = resolve(`.env.${provider}`)
  const lines = (await readFile(file, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 2) {
    return [{ baseUrl: lines[0], apiKey: lines[1] }]
  }
  if (provider === 'dify' && lines.length % 3 === 0) {
    return Array.from({ length: lines.length / 3 }, (_, index) => {
      const label = lines[index * 3].replace(/:$/, '')
      const profile = /^dify[0-9.x-]+$/i.test(label)
        ? label.replace(/^dify/i, '')
        : `profile-${index + 1}`
      return {
        profile,
        baseUrl: lines[index * 3 + 1],
        apiKey: lines[index * 3 + 2]
      }
    })
  }
  throw new Error(
    `${file} must contain one URL/key pair or labeled Dify URL/key triples`
  )
}

function baseUrl(provider, input) {
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${provider} URL must use HTTP or HTTPS`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${provider} URL cannot contain credentials, query, or fragment`)
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (provider === 'dify') url.pathname = url.pathname.replace(/\/v1$/, '')
  if (provider === 'fastgpt' && !url.pathname.endsWith('/api')) url.pathname += '/api'
  if (provider === 'ragflow') url.pathname = url.pathname.replace(/\/api\/v1$/, '')
  return url
}

function endpoint(base, path) {
  const url = new URL(base)
  url.pathname = `${url.pathname}${path}`.replace(/\/{2,}/g, '/')
  return url
}

async function boundedJson(response, maximumBytes = 5_000_000) {
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maximumBytes) throw new Error('response-too-large')
  return JSON.parse(new TextDecoder().decode(bytes))
}

async function request(context, name, url, init = {}) {
  const startedAt = performance.now()
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${context.apiKey}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      }
    })
    const body = await boundedJson(response)
    context.operations.push({
      name,
      method: init.method ?? 'GET',
      path: url.pathname
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '{id}')
        .replace(/[0-9a-f]{24}/gi, '{id}'),
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      responseKeys: objectKeys(body)
    })
    return { response, body }
  } catch (error) {
    context.operations.push({
      name,
      method: init.method ?? 'GET',
      path: url.pathname
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '{id}')
        .replace(/[0-9a-f]{24}/gi, '{id}'),
      status: 'failed',
      durationMs: Math.round(performance.now() - startedAt),
      error: error?.name ?? 'Error'
    })
    return undefined
  }
}

function resultShape(items, scoreKey) {
  const scores = finiteNumbers(items.map((item) => asRecord(item)?.[scoreKey]))
  return {
    count: items.length,
    itemKeys: unionKeys(items),
    contentPresent: items.some((item) => {
      const record = asRecord(item)
      return typeof record?.content === 'string' || typeof record?.q === 'string'
    }),
    scoreRange: scores.length > 0
      ? { minimum: Math.min(...scores), maximum: Math.max(...scores) }
      : undefined
  }
}

function difyResultShape(records) {
  const segments = records.map((record) => asRecord(record)?.segment)
  const documents = segments.map((segment) => asRecord(segment)?.document)
  const childChunks = records.flatMap((record) => {
    const value = asRecord(record)?.child_chunks
    return Array.isArray(value) ? value : []
  })
  const files = records.flatMap((record) => {
    const value = asRecord(record)?.files
    return Array.isArray(value) ? value : []
  })
  const scores = finiteNumbers(records.map((record) => asRecord(record)?.score))
  return {
    count: records.length,
    itemKeys: unionKeys(records),
    segmentKeys: unionKeys(segments),
    documentKeys: unionKeys(documents),
    childChunkKeys: unionKeys(childChunks),
    fileKeys: unionKeys(files),
    contentPresent: segments.some((segment) =>
      typeof asRecord(segment)?.content === 'string'
    ),
    childContentPresent: childChunks.some((chunk) =>
      typeof asRecord(chunk)?.content === 'string'
    ),
    summaryPresent: records.some((record) =>
      typeof asRecord(record)?.summary === 'string'
    ),
    scoreRange: scores.length > 0
      ? { minimum: Math.min(...scores), maximum: Math.max(...scores) }
      : undefined
  }
}

async function probeDify(configuration_) {
  const context = { apiKey: configuration_.apiKey, operations: [] }
  const base = baseUrl('dify', configuration_.baseUrl)
  const catalogUrl = endpoint(base, '/v1/datasets')
  catalogUrl.searchParams.set('page', '1')
  catalogUrl.searchParams.set('limit', '100')
  const catalog = await request(context, 'catalog', catalogUrl)
  const catalogBody = asRecord(catalog?.body)
  const items = Array.isArray(catalogBody?.data) ? catalogBody.data : []
  const first = asRecord(items[0])
  let detail
  const retrievals = []
  if (typeof first?.id === 'string') {
    detail = await request(
      context,
      'detail',
      endpoint(base, `/v1/datasets/${encodeURIComponent(first.id)}`)
    )
    const retrieval = await request(
      context,
      'retrieve-defaults',
      endpoint(base, `/v1/datasets/${encodeURIComponent(first.id)}/retrieve`),
      { method: 'POST', body: JSON.stringify({ query }) }
    )
    const retrievalBody = asRecord(retrieval?.body)
    const records = Array.isArray(retrievalBody?.records) ? retrievalBody.records : []
    retrievals.push({ mode: 'dataset-defaults', ...difyResultShape(records) })
    if (extended && asRecord(first.retrieval_model_dict)) {
      const override = await request(
        context,
        'retrieve-explicit-config',
        endpoint(base, `/v1/datasets/${encodeURIComponent(first.id)}/retrieve`),
        {
          method: 'POST',
          body: JSON.stringify({
            query,
            retrieval_model: first.retrieval_model_dict
          })
        }
      )
      const overrideBody = asRecord(override?.body)
      const overrideRecords = Array.isArray(overrideBody?.records) ? overrideBody.records : []
      retrievals.push({ mode: 'explicit-current-config', ...difyResultShape(overrideRecords) })
    }
  }
  return {
    provider: 'dify',
    profile: configuration_.profile,
    detectedVersion: catalog?.response.headers.get('x-version') ?? undefined,
    transport: {
      protocol: base.protocol,
      tlsVerificationDisabled: base.protocol === 'https:'
        ? process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
        : undefined
    },
    catalog: {
      count: items.length,
      total: Number.isFinite(catalogBody?.total) ? catalogBody.total : undefined,
      itemKeys: unionKeys(items),
      retrievalModelKeys: unionKeys(items.map((item) => asRecord(item)?.retrieval_model_dict)),
      indexingTechniques: [...new Set(items.map((item) => asRecord(item)?.indexing_technique).filter((value) => typeof value === 'string'))].sort(),
      metadataSchemaCount: items.filter((item) => {
        const value = asRecord(item)?.doc_metadata
        return Array.isArray(value) && value.length > 0
      }).length,
      multimodalCount: items.filter((item) => asRecord(item)?.is_multimodal === true).length,
      pipelineConfiguredCount: items.filter((item) => typeof asRecord(item)?.pipeline_id === 'string').length,
      summaryIndexConfiguredCount: items.filter((item) => asRecord(item)?.summary_index_setting !== null && asRecord(item)?.summary_index_setting !== undefined).length
    },
    detail: { keys: objectKeys(detail?.body) },
    retrievals,
    features: {
      datasetDefaults: true,
      detailSupported: detail?.response.ok === true,
      retrievalOverrideObserved: items.some((item) => asRecord(item)?.retrieval_model_dict !== undefined),
      retrievalOverrideProbed: retrievals.some((item) => item.mode === 'explicit-current-config'),
      nonEmptyResultObserved: retrievals.some((item) => item.count > 0)
    },
    operations: context.operations
  }
}

async function probeFastGpt(configuration_) {
  const context = { apiKey: configuration_.apiKey, operations: [] }
  const base = baseUrl('fastgpt', configuration_.baseUrl)
  const catalog = await request(
    context,
    'catalog',
    endpoint(base, '/core/dataset/list'),
    { method: 'POST', body: JSON.stringify({ parentId: '' }) }
  )
  const catalogBody = asRecord(catalog?.body)
  const rawData = catalogBody?.data
  const nestedData = asRecord(rawData)
  const items = Array.isArray(rawData)
    ? rawData
    : Array.isArray(nestedData?.list)
      ? nestedData.list
      : []
  const datasets = items.filter((item) => asRecord(item)?.type === 'dataset')
  const first = asRecord(datasets[0])
  let detail
  const retrievals = []
  if (typeof first?._id === 'string') {
    const detailUrl = endpoint(base, '/core/dataset/detail')
    detailUrl.searchParams.set('id', first._id)
    detail = await request(context, 'detail', detailUrl)
    for (const searchMode of ['embedding', 'fullTextRecall', 'mixedRecall']) {
      const result = await request(
        context,
        `retrieve-${searchMode}`,
        endpoint(base, '/core/dataset/searchTest'),
        {
          method: 'POST',
          body: JSON.stringify({
            datasetId: first._id,
            text: query,
            limit: 1_000,
            similarity: 0,
            searchMode,
            usingReRank: false
          })
        }
      )
      const body = asRecord(result?.body)
      const data = asRecord(body?.data)
      const list = Array.isArray(body?.data)
        ? body.data
        : Array.isArray(data?.list)
          ? data.list
          : []
      retrievals.push({ searchMode, ...resultShape(list, 'score') })
    }
    if (extended) {
      const result = await request(
        context,
        'retrieve-rerank',
        endpoint(base, '/core/dataset/searchTest'),
        {
          method: 'POST',
          body: JSON.stringify({
            datasetId: first._id,
            text: query,
            limit: 1_000,
            similarity: 0,
            searchMode: 'mixedRecall',
            usingReRank: true
          })
        }
      )
      const body = asRecord(result?.body)
      const data = asRecord(body?.data)
      const list = Array.isArray(body?.data)
        ? body.data
        : Array.isArray(data?.list)
          ? data.list
          : []
      retrievals.push({
        searchMode: 'mixedRecall',
        usingRerank: true,
        ...resultShape(list, 'score')
      })
    }
  }
  const detailData = asRecord(asRecord(detail?.body)?.data)
  return {
    provider: 'fastgpt',
    profile: configuration_.profile,
    detectedVersion: undefined,
    transport: {
      protocol: base.protocol,
      tlsVerificationDisabled: base.protocol === 'https:'
        ? process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
        : undefined
    },
    catalog: {
      count: datasets.length,
      envelope: Array.isArray(rawData) ? 'data-array' : 'data-object',
      itemKeys: unionKeys(items),
      itemTypes: [...new Set(items.map((item) => asRecord(item)?.type).filter((value) => typeof value === 'string'))].sort()
    },
    detail: {
      keys: objectKeys(detailData),
      vectorModelKeys: objectKeys(detailData?.vectorModel)
    },
    retrievals,
    features: {
      searchModes: [...new Set(retrievals.filter((item) => item.count >= 0).map((item) => item.searchMode))],
      rerankProbed: extended,
      extensionQueryProbed: false
    },
    operations: context.operations
  }
}

async function probeRagflow(configuration_) {
  const context = { apiKey: configuration_.apiKey, operations: [] }
  const base = baseUrl('ragflow', configuration_.baseUrl)
  const catalogUrl = endpoint(base, '/api/v1/datasets')
  catalogUrl.searchParams.set('page', '1')
  catalogUrl.searchParams.set('page_size', '100')
  const catalog = await request(context, 'catalog', catalogUrl)
  const catalogBody = asRecord(catalog?.body)
  const items = Array.isArray(catalogBody?.data) ? catalogBody.data : []
  const graphConfiguredItems = items.filter((item) => {
    const record = asRecord(item)
    const graph = asRecord(asRecord(record?.parser_config)?.graphrag)
    return graph?.use_graphrag === true
  })
  const graphCompletedItems = items.filter((item) => {
    const value = asRecord(item)?.graphrag_task_finish_at
    return (typeof value === 'number' && value > 0) || (typeof value === 'string' && value.length > 0)
  })
  const compilationConfiguredItems = items.filter((item) => {
    const value = asRecord(asRecord(item)?.parser_config)?.compilation_template_group_id
    return typeof value === 'string' && value.length > 0
  })
  const first = asRecord(graphCompletedItems[0] ?? graphConfiguredItems[0] ?? items[0])
  let detail
  const retrievals = []
  if (typeof first?.id === 'string') {
    const detailUrl = endpoint(base, '/api/v1/datasets')
    detailUrl.searchParams.set('id', first.id)
    detail = await request(context, 'detail', detailUrl)
    for (const feature of [
      { name: 'baseline', use_kg: false, include_knowledge_compilation: false },
      ...(extended
        ? [
            { name: 'graph', use_kg: true, include_knowledge_compilation: false },
            { name: 'knowledge-compilation', use_kg: false, include_knowledge_compilation: true }
          ]
        : [])
    ]) {
      const result = await request(
        context,
        `retrieve-${feature.name}`,
        endpoint(base, '/api/v1/retrieval'),
        {
          method: 'POST',
          body: JSON.stringify({
            question: query,
            dataset_ids: [first.id],
            page: 1,
            page_size: 6,
            similarity_threshold: 0,
            vector_similarity_weight: 0.3,
            knn_top_k: 128,
            use_kg: feature.use_kg,
            include_knowledge_compilation: feature.include_knowledge_compilation
          })
        }
      )
      const data = asRecord(asRecord(result?.body)?.data)
      const chunks = Array.isArray(data?.chunks) ? data.chunks : []
      retrievals.push({ feature: feature.name, ...resultShape(chunks, 'similarity') })
    }
  }
  const detailBody = asRecord(detail?.body)
  const detailData = Array.isArray(detailBody?.data) ? detailBody.data[0] : detailBody?.data
  return {
    provider: 'ragflow',
    profile: configuration_.profile,
    detectedVersion: undefined,
    transport: {
      protocol: base.protocol,
      tlsVerificationDisabled: base.protocol === 'https:'
        ? process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
        : undefined
    },
    catalog: {
      count: items.length,
      total: Number.isFinite(catalogBody?.total_datasets) ? catalogBody.total_datasets : undefined,
      itemKeys: unionKeys(items),
      parserConfigKeys: unionKeys(items.map((item) => asRecord(item)?.parser_config)),
      graphConfiguredCount: graphConfiguredItems.length,
      graphCompletedCount: graphCompletedItems.length,
      knowledgeCompilationConfiguredCount: compilationConfiguredItems.length
    },
    detail: { keys: objectKeys(detailData) },
    retrievals,
    features: {
      graphRetrievalProbed: extended,
      knowledgeCompilationProbed: extended,
      metadataConditionProbed: false
    },
    operations: context.operations
  }
}

const selectedProviders = selectedProvider === 'all' ? providers : [selectedProvider]
const report = {
  schemaVersion: 1,
  probedAt: new Date().toISOString(),
  mode: extended ? 'extended-read-only' : 'basic-read-only',
  queryCharacters: query.length,
  privacy: 'No credentials, origins, IDs, names, queries, or content are included.',
  providers: []
}
const sensitiveValues = []

for (const provider of selectedProviders) {
  for (const config of await configurations(provider)) {
    sensitiveValues.push(config.baseUrl, config.apiKey)
    report.providers.push(
      provider === 'dify'
        ? await probeDify(config)
        : provider === 'fastgpt'
          ? await probeFastGpt(config)
          : await probeRagflow(config)
    )
  }
}

const serialized = `${JSON.stringify(report, null, 2)}\n`
const unsafeOutput =
  sensitiveValues.some((value) => value && serialized.includes(value)) ||
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(serialized) ||
  /\b[0-9a-f]{24}\b/i.test(serialized) ||
  ['PUT', 'PATCH', 'DELETE'].some((method) => serialized.includes(`"method": "${method}"`))
if (unsafeOutput) {
  throw new Error('Probe report failed its redaction and read-only audit')
}
if (outputPath) {
  const target = resolve(outputPath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, serialized, 'utf8')
  globalThis.console.log(`Wrote redacted probe report to ${target}`)
} else {
  process.stdout.write(serialized)
}
