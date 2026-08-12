// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDeterministicTokenHashEmbeddingProvider,
  deterministicReportProjection,
  loadRetrievalFixture,
  runRetrievalEvaluation
} from './support/knowledge-retrieval-evaluation'

describe('knowledge retrieval evaluation', () => {
  it('evaluates production retrieval ablations offline, privately, and deterministically', async () => {
    const fixture = await loadRetrievalFixture()
    expect(fixture.provenance.kind).toBe('synthetic')
    expect(fixture.queries.filter((query) => !query.noAnswer).length).toBeGreaterThanOrEqual(12)
    expect(new Set(fixture.queries.map((query) => query.language))).toEqual(
      new Set(['en', 'zh-CN'])
    )

    const first = await runRetrievalEvaluation()
    const second = await runRetrievalEvaluation()
    expect(deterministicReportProjection(second)).toEqual(
      deterministicReportProjection(first)
    )

    const byId = new Map(first.ablations.map((ablation) => [ablation.id, ablation]))
    const lexical = byId.get('lexical')!
    const tokenHash = byId.get('token-hash-vector')!
    const regressionVector = byId.get('regression-alias-vector')!
    const hybrid = byId.get('hybrid')!
    const rerank = byId.get('hybrid-rerank')!
    expect(first.corpusHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.evaluationDefinitionHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.providerFingerprintHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.evaluationDefinitionHash).not.toBe(first.corpusHash)
    expect(lexical.metrics.recallAt10).toBeGreaterThanOrEqual(0.2)
    expect(lexical.metrics.contextRecall).toBeGreaterThanOrEqual(0.2)
    expect(tokenHash.metrics.recallAt10).toBeGreaterThanOrEqual(0.15)
    expect(regressionVector.metrics.recallAt10).toBeGreaterThanOrEqual(0.9)
    expect(hybrid.metrics.recallAt5).toBeGreaterThanOrEqual(0.9)
    expect(rerank.metrics.mrrAt10).toBeGreaterThanOrEqual(0.78)
    expect(rerank.metrics.ndcgAt10).toBeGreaterThanOrEqual(0.75)
    expect(rerank.metrics.contextPrecision).toBeGreaterThanOrEqual(0.05)
    expect(rerank.metrics.contextRecall).toBeGreaterThanOrEqual(0.9)
    expect(rerank.metrics.noAnswerFalsePositiveRate).toBeLessThanOrEqual(0.34)
    for (const language of ['en', 'zh-CN'] as const) {
      expect(rerank.metricsByLanguage[language].recallAt10).toBeGreaterThanOrEqual(0.9)
      expect(rerank.metricsByLanguage[language].contextRecall).toBeGreaterThanOrEqual(0.85)
    }
    expect(
      rerank.metrics.ndcgAt10,
      'local rerank should not materially regress hybrid ranking quality'
    ).toBeGreaterThanOrEqual(hybrid.metrics.ndcgAt10 - 0.05)
    expect(rerank.failures, JSON.stringify(rerank.failures)).toEqual([])

    const serialized = JSON.stringify(first)
    expect(Object.keys(first).sort()).toEqual([
      'ablations',
      'corpusHash',
      'evaluationDefinitionHash',
      'fixtureId',
      'providerFingerprintHash',
      'queryIds',
      'schemaVersion'
    ])
    for (const ablation of first.ablations) {
      expect(Object.keys(ablation).sort()).toEqual([
        'failures',
        'id',
        'latencyMs',
        'metrics',
        'metricsByLanguage'
      ])
      expect(Object.keys(ablation.metrics).sort()).toEqual([
        'contextPrecision',
        'contextRecall',
        'mrrAt10',
        'ndcgAt10',
        'noAnswerFalsePositiveRate',
        'recallAt10',
        'recallAt5'
      ])
    }
    const forbiddenReportValues = [
      ...fixture.documents.map((document) => document.title),
      ...fixture.documents.flatMap((document) =>
        document.chunks.map((chunk) => chunk.content)
      ),
      ...fixture.queries.map((query) => query.query),
      'fixture://',
      'goodbuddy:retrieval-eval',
      'handcrafted-alias-hash-v1',
      'topic-agnostic-token-hash-v1'
    ]
    for (const value of forbiddenReportValues) {
      expect(serialized).not.toContain(value)
    }
    for (const document of fixture.documents) {
      expect(serialized).not.toContain(document.id.replace(/^doc-/u, 'fixture://'))
    }
    expect(serialized).not.toMatch(/[a-z]:[\\/]/iu)
  }, 30_000)

  it('provides a deterministic topic-agnostic token-hash vectorizer', async () => {
    const provider = createDeterministicTokenHashEmbeddingProvider()
    const [first, second, unrelated] = await provider.embed([
      'alpha beta alpha',
      'beta alpha',
      '凭据'
    ])

    expect(first).toEqual(second)
    expect(first).not.toEqual(unrelated)
    expect(provider.model).toBe('topic-agnostic-token-hash-v1')
    expect(provider.fingerprint).not.toContain('synthetic-bilingual')
  })

  it('writes only to non-symlink workspace-relative output paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-retrieval-output-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    await mkdir(workspace)
    await mkdir(outside)
    try {
      const outputPath = join('reports', 'retrieval.json')
      const report = await runRetrievalEvaluation({
        workingDirectory: workspace,
        outputPath
      })
      const persisted = JSON.parse(
        await readFile(join(workspace, outputPath), 'utf8')
      ) as { evaluationDefinitionHash: string }
      expect(persisted.evaluationDefinitionHash).toBe(
        report.evaluationDefinitionHash
      )

      await expect(runRetrievalEvaluation({
        workingDirectory: workspace,
        outputPath: join('..', 'outside.json')
      })).rejects.toThrow(/workspace-relative/u)

      const link = join(workspace, 'linked')
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(runRetrievalEvaluation({
        workingDirectory: workspace,
        outputPath: join('linked', 'escaped.json')
      })).rejects.toThrow(/symlink/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
