// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  computeEvaluationDefinitionHash,
  computeRetrievalMetrics,
  retrievalFixtureSchema,
  summarizeLatencies,
  type RetrievalFixture
} from './support/knowledge-retrieval-evaluation'

const metricFixture: RetrievalFixture = retrievalFixtureSchema.parse({
  version: 1,
  id: 'metric-fixture',
  provenance: { kind: 'synthetic', license: 'CC0-1.0' },
  documents: Array.from({ length: 10 }, (_, index) => ({
    id: `document-${index}`,
    title: `Document ${index}`,
    chunks: [{
      id: `chunk-${index}`,
      content: `Synthetic content number ${index} with exact span ${index}.`
    }]
  })),
  queries: [
    {
      id: 'query-answer-one',
      language: 'en',
      query: 'first synthetic question',
      noAnswer: false,
      judgments: [
        { chunkId: 'chunk-0', relevance: 3, spans: [{ text: 'exact span 0' }] },
        { chunkId: 'chunk-1', relevance: 1, spans: [{ text: 'exact span 1' }] }
      ]
    },
    {
      id: 'query-answer-two',
      language: 'zh-CN',
      query: '第二个合成测试问题',
      noAnswer: false,
      judgments: [
        { chunkId: 'chunk-2', relevance: 2, spans: [{ text: 'exact span 2' }] }
      ]
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `query-padding-${index}`,
      language: (index === 0 ? 'zh-CN' : 'en') as 'en' | 'zh-CN',
      query: `padding synthetic query ${index}`,
      noAnswer: true,
      judgments: []
    })),
    {
      id: 'query-no-answer',
      language: 'en',
      query: 'unanswerable synthetic question',
      noAnswer: true,
      judgments: []
    }
  ]
})

describe('retrieval evaluation metrics', () => {
  it('computes cutoffs, reciprocal rank, graded nDCG, exact-span context, and no-answer rate', () => {
    const rankings = new Map([
      [
        'query-answer-one',
        [
          { chunkId: 'chunk-9', context: 'irrelevant' },
          { chunkId: 'chunk-1', context: 'exact span 1' },
          { chunkId: 'chunk-0', context: 'prefix exact span 0 suffix' }
        ]
      ],
      [
        'query-answer-two',
        [
          { chunkId: 'chunk-9', context: 'noise' },
          { chunkId: 'chunk-8', context: 'noise' },
          { chunkId: 'chunk-7', context: 'noise' },
          { chunkId: 'chunk-6', context: 'noise' },
          { chunkId: 'chunk-5', context: 'noise' },
          { chunkId: 'chunk-2', context: 'exact span 2' }
        ]
      ],
      ['query-no-answer', [{ chunkId: 'chunk-4', context: 'false positive' }]]
    ])

    const metrics = computeRetrievalMetrics(metricFixture, rankings)

    expect(metrics.recallAt5).toBeCloseTo(0.5)
    expect(metrics.recallAt10).toBe(1)
    expect(metrics.mrrAt10).toBeCloseTo((1 / 2 + 1 / 6) / 2)
    const firstQueryDcg =
      (2 ** 1 - 1) / Math.log2(3) +
      (2 ** 3 - 1) / Math.log2(4)
    const firstQueryIdeal =
      (2 ** 3 - 1) / Math.log2(2) +
      (2 ** 1 - 1) / Math.log2(3)
    const secondQueryNdcg =
      ((2 ** 2 - 1) / Math.log2(7)) /
      ((2 ** 2 - 1) / Math.log2(2))
    expect(metrics.ndcgAt10).toBeCloseTo(
      (firstQueryDcg / firstQueryIdeal + secondQueryNdcg) / 2,
      12
    )
    expect(metrics.contextRecall).toBe(1)
    expect(metrics.contextPrecision).toBeCloseTo(36 / 85)
    expect(metrics.noAnswerFalsePositiveRate).toBeCloseTo(0.1)
  })

  it('deduplicates rankings and unions overlapping evidence spans', () => {
    const fixture = structuredClone(metricFixture)
    fixture.queries[0]!.judgments[0]!.spans = [
      { text: 'exact span' },
      { text: 'span 0' },
      { text: 'exact span 0' }
    ]
    const rankings = new Map([
      [
        'query-answer-one',
        [
          { chunkId: 'chunk-0', context: 'exact span 0' },
          { chunkId: 'chunk-0', context: 'exact span 0' }
        ]
      ],
      ['query-answer-two', [{ chunkId: 'chunk-2', context: 'exact span 2' }]]
    ])

    const metrics = computeRetrievalMetrics(fixture, rankings)

    expect(metrics.recallAt5).toBeCloseTo(0.75)
    expect(metrics.mrrAt10).toBe(1)
    expect(metrics.ndcgAt10).toBeLessThanOrEqual(1)
    expect(metrics.contextRecall).toBeCloseTo(2 / 3)
    expect(metrics.contextPrecision).toBe(1)
  })

  it('uses deterministic nearest-rank latency summaries', () => {
    expect(summarizeLatencies([9, 1, 5, 3, 7])).toEqual({
      count: 5,
      min: 1,
      median: 5,
      p95: 9,
      max: 9,
      mean: 5
    })
    expect(summarizeLatencies([])).toEqual({
      count: 0,
      min: 0,
      median: 0,
      p95: 0,
      max: 0,
      mean: 0
    })
  })

  it('hashes fixture queries, judgments, settings, providers, and metric version', () => {
    const baseline = computeEvaluationDefinitionHash(metricFixture)
    const changedQuery = structuredClone(metricFixture)
    changedQuery.queries[0]!.query = 'changed synthetic question'
    const changedJudgment = structuredClone(metricFixture)
    changedJudgment.queries[0]!.judgments[0]!.relevance = 2

    expect(baseline).toMatch(/^[a-f0-9]{64}$/u)
    expect(computeEvaluationDefinitionHash(changedQuery)).not.toBe(baseline)
    expect(computeEvaluationDefinitionHash(changedJudgment)).not.toBe(baseline)
  })

  it('rejects unknown fields, unsafe provenance, and inexact spans', () => {
    const unsafe = structuredClone(metricFixture) as unknown as {
      documents: Array<{ chunks: Array<{ content: string }> }>
      queries: Array<{ judgments: Array<{ spans: Array<{ text: string }> }> }>
      endpoint?: string
    }
    unsafe.endpoint = 'https://example.invalid'
    unsafe.queries[0]!.judgments[0]!.spans[0]!.text = 'not in corpus'
    expect(() => retrievalFixtureSchema.parse(unsafe)).toThrow()
  })

  it('rejects all-answer, all-no-answer, and missing bilingual class coverage', () => {
    const allAnswer = structuredClone(metricFixture)
    allAnswer.queries = allAnswer.queries.map((query) => ({
      ...query,
      noAnswer: false,
      judgments: [{
        chunkId: 'chunk-0',
        relevance: 1,
        spans: [{ text: 'exact span 0' }]
      }]
    }))
    expect(() => retrievalFixtureSchema.parse(allAnswer)).toThrow(
      /must include a no-answer query/u
    )

    const allNoAnswer = structuredClone(metricFixture)
    allNoAnswer.queries = allNoAnswer.queries.map((query) => ({
      ...query,
      noAnswer: true,
      judgments: []
    }))
    expect(() => retrievalFixtureSchema.parse(allNoAnswer)).toThrow(
      /must include an answerable query/u
    )

    const noChineseNoAnswer = structuredClone(metricFixture)
    noChineseNoAnswer.queries = noChineseNoAnswer.queries.map((query) =>
      query.noAnswer ? { ...query, language: 'en' as const } : query
    )
    expect(() => retrievalFixtureSchema.parse(noChineseNoAnswer)).toThrow(
      /zh-CN: fixture must include a no-answer query/u
    )
  })
})
