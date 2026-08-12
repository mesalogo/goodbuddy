import { createHash } from 'node:crypto'
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { z } from 'zod'
import { embeddingStorageProvider } from '../../src/main/knowledge/embedding-provider-key'
import { KnowledgeService } from '../../src/main/knowledge/knowledge-service'
import { knowledgeRetrievalTerms } from '../../src/main/knowledge/retrieval-text'
import { isPathInside } from '../../src/main/workspace-file-access'
import type { EmbeddingProvider } from '../../src/main/knowledge/types'

const stableIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,63}$/u, 'must be a stable lowercase ID')
const spanSchema = z
  .object({ text: z.string().min(2).max(500) })
  .strict()
const judgmentSchema = z
  .object({
    chunkId: stableIdSchema,
    relevance: z.number().int().min(1).max(3),
    spans: z.array(spanSchema).min(1).max(8)
  })
  .strict()
const querySchema = z
  .object({
    id: stableIdSchema,
    language: z.enum(['en', 'zh-CN']),
    query: z.string().min(4).max(300),
    noAnswer: z.boolean(),
    judgments: z.array(judgmentSchema).max(10)
  })
  .strict()
const chunkSchema = z
  .object({
    id: stableIdSchema,
    content: z.string().min(20).max(2_000)
  })
  .strict()
const documentSchema = z
  .object({
    id: stableIdSchema,
    title: z.string().min(2).max(100),
    chunks: z.array(chunkSchema).min(1).max(12)
  })
  .strict()

export const retrievalFixtureSchema = z
  .object({
    version: z.literal(1),
    id: stableIdSchema,
    provenance: z
      .object({
        kind: z.enum(['synthetic', 'public']),
        license: z.string().min(2).max(64)
      })
      .strict(),
    documents: z.array(documentSchema).min(10).max(100),
    queries: z.array(querySchema).min(12).max(100)
  })
  .strict()
  .superRefine((fixture, context) => {
    const ids = new Set<string>()
    const chunks = new Map<string, string>()
    for (const document of fixture.documents) {
      if (ids.has(document.id)) {
        context.addIssue({ code: 'custom', message: `duplicate ID: ${document.id}` })
      }
      ids.add(document.id)
      for (const chunk of document.chunks) {
        if (ids.has(chunk.id)) {
          context.addIssue({ code: 'custom', message: `duplicate ID: ${chunk.id}` })
        }
        ids.add(chunk.id)
        chunks.set(chunk.id, chunk.content)
      }
    }
    for (const query of fixture.queries) {
      if (ids.has(query.id)) {
        context.addIssue({ code: 'custom', message: `duplicate ID: ${query.id}` })
      }
      ids.add(query.id)
      if (query.noAnswer !== (query.judgments.length === 0)) {
        context.addIssue({
          code: 'custom',
          message: `${query.id}: noAnswer must exactly match empty judgments`
        })
      }
      const judged = new Set<string>()
      for (const judgment of query.judgments) {
        const content = chunks.get(judgment.chunkId)
        if (!content) {
          context.addIssue({
            code: 'custom',
            message: `${query.id}: unknown chunk ${judgment.chunkId}`
          })
          continue
        }
        if (judged.has(judgment.chunkId)) {
          context.addIssue({
            code: 'custom',
            message: `${query.id}: duplicate judgment ${judgment.chunkId}`
          })
        }
        judged.add(judgment.chunkId)
        for (const span of judgment.spans) {
          if (!content.includes(span.text)) {
            context.addIssue({
              code: 'custom',
              message: `${query.id}: annotated span is not exact`
            })
          }
        }
      }
    }
    for (const language of ['en', 'zh-CN'] as const) {
      const languageQueries = fixture.queries.filter(
        (query) => query.language === language
      )
      if (!languageQueries.some((query) => !query.noAnswer)) {
        context.addIssue({
          code: 'custom',
          message: `${language}: fixture must include an answerable query`
        })
      }
      if (!languageQueries.some((query) => query.noAnswer)) {
        context.addIssue({
          code: 'custom',
          message: `${language}: fixture must include a no-answer query`
        })
      }
    }
    const forbidden = /(?:[a-z]:[\\/]|\/(?:users|home|var|etc)\/|https?:\/\/|api[_-]?key|bearer\s+[a-z0-9]|sk-[a-z0-9]{8})/iu
    if (forbidden.test(JSON.stringify(fixture))) {
      context.addIssue({
        code: 'custom',
        message: 'fixture contains a path, endpoint, or secret-like value'
      })
    }
  })

export type RetrievalFixture = z.infer<typeof retrievalFixtureSchema>
export type RetrievalAblation =
  | 'lexical'
  | 'token-hash-vector'
  | 'regression-alias-vector'
  | 'hybrid'
  | 'hybrid-rerank'

export interface RankedEvaluationItem {
  chunkId: string
  context?: string
}

export interface RetrievalMetrics {
  recallAt5: number
  recallAt10: number
  mrrAt10: number
  ndcgAt10: number
  contextPrecision: number
  contextRecall: number
  noAnswerFalsePositiveRate: number
}

export interface RetrievalEvaluationReport {
  schemaVersion: 1
  fixtureId: string
  corpusHash: string
  evaluationDefinitionHash: string
  providerFingerprintHash: string
  queryIds: string[]
  ablations: Array<{
    id: RetrievalAblation
    metrics: RetrievalMetrics
    metricsByLanguage: Record<'en' | 'zh-CN', RetrievalMetrics>
    latencyMs: {
      count: number
      min: number
      median: number
      p95: number
      max: number
      mean: number
    }
    failures: Array<{
      queryId: string
      reason: 'no-relevant-result-at-10' | 'no-answer-false-positive'
    }>
  }>
}

const fixturePath = fileURLToPath(
  new URL('../fixtures/knowledge-retrieval/synthetic-bilingual-v1.json', import.meta.url)
)
const dimensions = 256
const metricVersion = 2
const retrievalSettings = {
  version: 1 as const,
  topK: 10,
  minimumVectorSimilarity: 0.18,
  graphWeight: 0,
  candidateMultiplier: 4,
  contextMaxCharacters: 16_000,
  adjacentChunkCount: 0
}
const providerDefinitions = {
  'regression-alias': {
    fingerprint: 'goodbuddy:retrieval-eval:regression-alias:v1',
    model: 'handcrafted-alias-hash-v1'
  },
  'token-hash': {
    fingerprint: 'goodbuddy:retrieval-eval:topic-agnostic-token-hash:v1',
    model: 'topic-agnostic-token-hash-v1'
  }
} as const
type EvaluationProviderId = keyof typeof providerDefinitions

// The repository-wide setup targets jsdom. This owned config keeps the
// evaluation in Node and prevents that renderer setup from crossing boundaries.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: []
  }
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalFixtureCorpus(fixture: RetrievalFixture): string {
  return fixture.documents
    .flatMap((document) =>
      document.chunks.map((chunk) => `${document.id}\0${chunk.id}\0${chunk.content}`)
    )
    .join('\n')
}

function normalizedTerms(text: string): string[] {
  return knowledgeRetrievalTerms(text)
}

function tokenHashVector(text: string): number[] {
  const vector: number[] = Array.from({ length: dimensions }, () => 0)
  for (const term of normalizedTerms(text)) {
    const digest = createHash('sha256').update(`token:${term}`).digest()
    const bucket = digest.readUInt16LE(0) % dimensions
    vector[bucket]! += digest[2]! % 2 === 0 ? 1 : -1
  }
  if (vector.every((value) => value === 0)) {
    return [1, ...vector.slice(1)]
  }
  return vector
}

/*
 * Regression plumbing only: these fixture-specific bilingual aliases make the
 * production vector/hybrid path deterministic. They do not model embedding
 * quality and must not be presented as a provider-quality benchmark.
 */
function regressionAliasHashVector(text: string): number[] {
  const vector = tokenHashVector(text)
  const aliases: Record<string, string[]> = {
    credential: ['credential', 'credentials', 'token', 'tokens', 'key', 'keys', '凭据', '密钥', '令牌'],
    offline: ['offline', 'network', 'connection', '本地', '网络', '离线'],
    cancel: ['cancel', 'cancelled', 'aborted', 'indexing', '取消', '中止', '索引'],
    backup: ['backup', 'restore', 'database', '备份', '恢复', '数据库'],
    keyboard: ['keyboard', 'focus', 'segmented', 'arrow', '键盘', '焦点', '方向键', '分段控件'],
    image: ['image', 'images', 'generated', 'inline', '图片', '生成', '内联'],
    migration: ['migration', 'migrations', 'failed', 'rollback', '迁移', '失败', '回滚'],
    approval: ['ask', 'execute', 'approval', 'read-only', '询问', '执行', '审批', '写入'],
    font: ['font', 'fonts', 'typefaces', 'remote', '字体', '远程'],
    integrity: ['release', 'artifact', 'manifest', 'hash', 'integrity', '发布', '产物', '完整性', '校验'],
    context: ['context', 'neighboring', 'sections', 'chunks', '上下文', '相邻', '分块'],
    language: ['language', 'languages', 'interface', 'english', 'chinese', '语言', '界面', '英文', '中文']
  }
  for (const [concept, variants] of Object.entries(aliases)) {
    if (variants.some((variant) => text.toLowerCase().includes(variant))) {
      const digest = createHash('sha256').update(`concept:${concept}`).digest()
      const bucket = digest.readUInt16LE(0) % dimensions
      vector[bucket]! += digest[2]! % 2 === 0 ? 12 : -12
    }
  }
  return vector
}

function createEvaluationEmbeddingProvider(
  providerId: EvaluationProviderId
): EmbeddingProvider {
  const definition = providerDefinitions[providerId]
  const vectorize =
    providerId === 'token-hash' ? tokenHashVector : regressionAliasHashVector
  return {
    provider: 'retrieval-eval-memory',
    model: definition.model,
    fingerprint: definition.fingerprint,
    embed: async (input, signal) => {
      signal?.throwIfAborted()
      return input.map(vectorize)
    }
  }
}

/** Topic-agnostic deterministic plumbing for lexical-overlap vector ablations. */
export function createDeterministicTokenHashEmbeddingProvider(): EmbeddingProvider {
  return createEvaluationEmbeddingProvider('token-hash')
}

/** Fixture-aware regression plumbing; not an embedding-quality model. */
export function createRegressionAliasEmbeddingProvider(): EmbeddingProvider {
  return createEvaluationEmbeddingProvider('regression-alias')
}

export async function loadRetrievalFixture(
  path = fixturePath
): Promise<RetrievalFixture> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  return retrievalFixtureSchema.parse(parsed)
}

function relevantAt(
  query: RetrievalFixture['queries'][number],
  ranked: readonly RankedEvaluationItem[],
  limit: number
): number {
  const relevant = new Set(query.judgments.map((judgment) => judgment.chunkId))
  return ranked.slice(0, limit).filter((item) => relevant.has(item.chunkId)).length /
    Math.max(1, relevant.size)
}

function dedupeRanking(
  ranked: readonly RankedEvaluationItem[]
): RankedEvaluationItem[] {
  const seen = new Set<string>()
  return ranked.filter((item) => {
    if (seen.has(item.chunkId)) {
      return false
    }
    seen.add(item.chunkId)
    return true
  })
}

function unionRangeLength(ranges: Array<readonly [number, number]>): number {
  const sorted = ranges
    .filter(([start, end]) => end > start)
    .sort(([leftStart, leftEnd], [rightStart, rightEnd]) =>
      leftStart - rightStart || leftEnd - rightEnd
    )
  let total = 0
  let currentStart = -1
  let currentEnd = -1
  for (const [start, end] of sorted) {
    if (currentStart < 0) {
      currentStart = start
      currentEnd = end
    } else if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end)
    } else {
      total += currentEnd - currentStart
      currentStart = start
      currentEnd = end
    }
  }
  return currentStart < 0 ? 0 : total + currentEnd - currentStart
}

function spanRanges(
  content: string,
  spans: readonly { text: string }[]
): Array<readonly [number, number]> {
  return spans.flatMap((span) => {
    const start = content.indexOf(span.text)
    return start < 0 ? [] : [[start, start + span.text.length] as const]
  })
}

export function computeRetrievalMetrics(
  fixture: RetrievalFixture,
  rankings: ReadonlyMap<string, readonly RankedEvaluationItem[]>
): RetrievalMetrics {
  const answerable = fixture.queries.filter((query) => !query.noAnswer)
  const noAnswer = fixture.queries.filter((query) => query.noAnswer)
  let recall5 = 0
  let recall10 = 0
  let reciprocalRank = 0
  let ndcg = 0
  let matchedSpanCharacters = 0
  let returnedContextCharacters = 0
  let annotatedSpanCharacters = 0
  const chunksById = new Map(
    fixture.documents.flatMap((document) =>
      document.chunks.map((chunk) => [chunk.id, chunk.content] as const)
    )
  )

  for (const query of answerable) {
    const ranked = dedupeRanking(rankings.get(query.id) ?? [])
    const grades = new Map(
      query.judgments.map((judgment) => [judgment.chunkId, judgment.relevance])
    )
    recall5 += relevantAt(query, ranked, 5)
    recall10 += relevantAt(query, ranked, 10)
    const firstRelevant = ranked
      .slice(0, 10)
      .findIndex((item) => (grades.get(item.chunkId) ?? 0) > 0)
    reciprocalRank += firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1)
    const dcg = ranked.slice(0, 10).reduce((total, item, index) => {
      const grade = grades.get(item.chunkId) ?? 0
      return total + (2 ** grade - 1) / Math.log2(index + 2)
    }, 0)
    const ideal = [...grades.values()]
      .sort((left, right) => right - left)
      .slice(0, 10)
      .reduce((total, grade, index) => total + (2 ** grade - 1) / Math.log2(index + 2), 0)
    ndcg += ideal === 0 ? 0 : dcg / ideal

    for (const judgment of query.judgments) {
      annotatedSpanCharacters += unionRangeLength(
        spanRanges(chunksById.get(judgment.chunkId) ?? '', judgment.spans)
      )
    }
    for (const item of ranked.slice(0, 10)) {
      const context = item.context ?? ''
      returnedContextCharacters += context.length
      const judgment = query.judgments.find((candidate) => candidate.chunkId === item.chunkId)
      matchedSpanCharacters += unionRangeLength(
        spanRanges(context, judgment?.spans ?? [])
      )
    }
  }

  const falsePositives = noAnswer.filter(
    (query) => dedupeRanking(rankings.get(query.id) ?? []).length > 0
  ).length
  return {
    recallAt5: recall5 / answerable.length,
    recallAt10: recall10 / answerable.length,
    mrrAt10: reciprocalRank / answerable.length,
    ndcgAt10: ndcg / answerable.length,
    contextPrecision:
      returnedContextCharacters === 0 ? 0 : matchedSpanCharacters / returnedContextCharacters,
    contextRecall:
      annotatedSpanCharacters === 0 ? 0 : matchedSpanCharacters / annotatedSpanCharacters,
    noAnswerFalsePositiveRate:
      noAnswer.length === 0 ? 0 : falsePositives / noAnswer.length
  }
}

export function summarizeLatencies(values: readonly number[]) {
  if (values.length === 0) {
    return { count: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 }
  }
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
  return {
    count: sorted.length,
    min: sorted[0]!,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1)!,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  }
}

async function createSeededService(
  fixture: RetrievalFixture,
  providerId: EvaluationProviderId
) {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-retrieval-eval-'))
  const provider = createEvaluationEmbeddingProvider(providerId)
  const vectorize =
    providerId === 'token-hash' ? tokenHashVector : regressionAliasHashVector
  const service = new KnowledgeService({
    databasePath: join(directory, 'knowledge.sqlite'),
    managedRoot: join(directory, 'managed'),
    embeddingProvider: provider
  })
  await service.initialize()
  const library = service.createLibrary({
    id: 'library-retrieval-eval',
    name: 'Synthetic retrieval evaluation',
    storageMode: 'reference',
    graphEnabled: false
  })
  const source = service.database.upsertSource({
    id: 'source-retrieval-eval',
    knowledgeBaseId: library.id,
    type: 'file',
    location: 'fixture://synthetic-bilingual-v1',
    displayName: 'Synthetic fixture',
    status: 'ready'
  })
  for (const document of fixture.documents) {
    service.database.upsertDocument(
      {
        id: document.id,
        knowledgeBaseId: library.id,
        sourceId: source.id,
        externalId: document.id,
        title: document.title,
        mimeType: 'text/plain',
        metadata: { status: 'ready', fixtureId: fixture.id }
      },
      document.chunks.map((chunk, ordinal) => ({
        id: chunk.id,
        ordinal,
        content: chunk.content,
        role: 'standalone' as const
      }))
    )
    service.database.replaceDocumentEmbeddings(
      document.id,
      embeddingStorageProvider(provider),
      provider.model,
      document.chunks.map((chunk) => ({
        chunkId: chunk.id,
        contentChecksum: sha256(chunk.content),
        vector: vectorize(chunk.content)
      }))
    )
  }
  return { directory, service, libraryId: library.id }
}

const ablationSettings: Record<RetrievalAblation, {
  providerId: EvaluationProviderId
  ftsWeight: number
  vectorWeight: number
  localRerankEnabled: boolean
}> = {
  lexical: {
    providerId: 'token-hash',
    ftsWeight: 1,
    vectorWeight: 0,
    localRerankEnabled: false
  },
  'token-hash-vector': {
    providerId: 'token-hash',
    ftsWeight: 0,
    vectorWeight: 1,
    localRerankEnabled: false
  },
  'regression-alias-vector': {
    providerId: 'regression-alias',
    ftsWeight: 0,
    vectorWeight: 1,
    localRerankEnabled: false
  },
  hybrid: {
    providerId: 'regression-alias',
    ftsWeight: 1,
    vectorWeight: 1,
    localRerankEnabled: false
  },
  'hybrid-rerank': {
    providerId: 'regression-alias',
    ftsWeight: 1,
    vectorWeight: 1,
    localRerankEnabled: true
  }
}

async function safeOutputPath(rawPath: string, workingDirectory: string): Promise<string> {
  if (rawPath.includes('\0')) {
    throw new Error('GOODBUDDY_RETRIEVAL_EVAL_OUTPUT contains a null byte')
  }
  if (isAbsolute(rawPath)) {
    throw new Error('GOODBUDDY_RETRIEVAL_EVAL_OUTPUT must be a workspace-relative path')
  }
  const workspace = await realpath(workingDirectory)
  const output = resolve(workspace, rawPath)
  if (!isPathInside(workspace, output) || output === workspace) {
    throw new Error('GOODBUDDY_RETRIEVAL_EVAL_OUTPUT must be a workspace-relative file')
  }

  const relativeParent = relative(workspace, dirname(output))
  let current = workspace
  for (const component of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      const status = await lstat(current)
      if (status.isSymbolicLink()) {
        throw new Error('GOODBUDDY_RETRIEVAL_EVAL_OUTPUT may not traverse a symlink')
      }
      if (!status.isDirectory()) {
        throw new Error('GOODBUDDY_RETRIEVAL_EVAL_OUTPUT parent must be a directory')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      await mkdir(current)
    }
    const canonicalCurrent = await realpath(current)
    if (!isPathInside(workspace, canonicalCurrent)) {
      throw new Error('GOODBUDDY_RETRIEVAL_EVAL_OUTPUT escapes the workspace')
    }
  }

  try {
    if ((await lstat(output)).isSymbolicLink()) {
      throw new Error('GOODBUDDY_RETRIEVAL_EVAL_OUTPUT may not be a symlink')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  return output
}

async function writeWorkspaceReport(
  destination: string,
  report: RetrievalEvaluationReport
): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(dirname(destination), '.retrieval-eval-'))
  const temporaryPath = join(temporaryDirectory, 'report.json')
  try {
    await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    })
    await rename(temporaryPath, destination)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function metricsForLanguage(
  fixture: RetrievalFixture,
  rankings: ReadonlyMap<string, readonly RankedEvaluationItem[]>,
  language: 'en' | 'zh-CN'
): RetrievalMetrics {
  return computeRetrievalMetrics(
    {
      ...fixture,
      queries: fixture.queries.filter((query) => query.language === language)
    },
    rankings
  )
}

export function computeEvaluationDefinitionHash(
  fixture: RetrievalFixture
): string {
  return sha256(JSON.stringify({
    fixtureVersion: fixture.version,
    fixtureId: fixture.id,
    queries: fixture.queries.map((query) => ({
      id: query.id,
      language: query.language,
      query: query.query,
      noAnswer: query.noAnswer,
      judgments: query.judgments
    })),
    retrievalSettings,
    ablations: ablationSettings,
    providers: providerDefinitions,
    metricVersion
  }))
}

export async function runRetrievalEvaluation(options: {
  outputPath?: string
  workingDirectory?: string
} = {}): Promise<RetrievalEvaluationReport> {
  const fixture = await loadRetrievalFixture()
  const ablations: RetrievalEvaluationReport['ablations'] = []
  for (const id of Object.keys(ablationSettings) as RetrievalAblation[]) {
    const settings = ablationSettings[id]
    const seeded = await createSeededService(fixture, settings.providerId)
    try {
      const rankings = new Map<string, RankedEvaluationItem[]>()
      const latencies: number[] = []
      for (const query of fixture.queries) {
        const response = await seeded.service.retrieve({
          knowledgeBaseId: seeded.libraryId,
          query: query.query,
          settings: {
            ...retrievalSettings,
            ftsWeight: settings.ftsWeight,
            vectorWeight: settings.vectorWeight,
            localRerankEnabled: settings.localRerankEnabled
          }
        })
        latencies.push(response.durationMs)
        const contexts = new Map(
          response.context.groups.map((group) => [group.resultChunkId, group.content])
        )
        rankings.set(
          query.id,
          response.results.map((result) => ({
            chunkId: result.chunkId,
            context: contexts.get(result.chunkId)
          }))
        )
      }
      const failures: RetrievalEvaluationReport['ablations'][number]['failures'] = []
      for (const query of fixture.queries) {
        const ranking = rankings.get(query.id) ?? []
        if (query.noAnswer) {
          if (ranking.length > 0) {
            failures.push({
              queryId: query.id,
              reason: 'no-answer-false-positive'
            })
          }
          continue
        }
        const relevant = new Set(query.judgments.map((judgment) => judgment.chunkId))
        if (!ranking.slice(0, 10).some((item) => relevant.has(item.chunkId))) {
          failures.push({
            queryId: query.id,
            reason: 'no-relevant-result-at-10'
          })
        }
      }
      ablations.push({
        id,
        metrics: computeRetrievalMetrics(fixture, rankings),
        metricsByLanguage: {
          en: metricsForLanguage(fixture, rankings, 'en'),
          'zh-CN': metricsForLanguage(fixture, rankings, 'zh-CN')
        },
        latencyMs: summarizeLatencies(latencies),
        failures
      })
    } finally {
      await seeded.service.dispose()
      await rm(seeded.directory, { recursive: true, force: true })
    }
  }
  const report: RetrievalEvaluationReport = {
    schemaVersion: 1,
    fixtureId: fixture.id,
    corpusHash: sha256(canonicalFixtureCorpus(fixture)),
    evaluationDefinitionHash: computeEvaluationDefinitionHash(fixture),
    providerFingerprintHash: sha256(JSON.stringify(providerDefinitions)),
    queryIds: fixture.queries.map((query) => query.id),
    ablations
  }
  const outputPath = options.outputPath ?? process.env.GOODBUDDY_RETRIEVAL_EVAL_OUTPUT
  if (outputPath) {
    const destination = await safeOutputPath(
      outputPath,
      options.workingDirectory ?? process.cwd()
    )
    await writeWorkspaceReport(destination, report)
  }
  return report
}

export function deterministicReportProjection(report: RetrievalEvaluationReport) {
  return {
    schemaVersion: report.schemaVersion,
    fixtureId: report.fixtureId,
    corpusHash: report.corpusHash,
    evaluationDefinitionHash: report.evaluationDefinitionHash,
    providerFingerprintHash: report.providerFingerprintHash,
    queryIds: report.queryIds,
    ablations: report.ablations.map((ablation) => ({
      id: ablation.id,
      metrics: ablation.metrics,
      metricsByLanguage: ablation.metricsByLanguage,
      failures: ablation.failures
    }))
  }
}
