import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type ProbeOperation = {
  name: string
  method: string
  path: string
  status: number | 'failed'
}

type ProbeProvider = {
  provider: 'dify' | 'fastgpt' | 'ragflow'
  profile?: string
  catalog: Record<string, unknown>
  retrievals: Array<Record<string, unknown>>
  operations: ProbeOperation[]
}

type ProbeReport = {
  schemaVersion: number
  privacy: string
  providers: ProbeProvider[]
}

async function report(filename = 'external-knowledge-probe-baseline.json'): Promise<ProbeReport> {
  return JSON.parse(
    await readFile(
      resolve('docs/features/knowledge-base', filename),
      'utf8'
    )
  ) as ProbeReport
}

describe('external knowledge probe baseline', () => {
  it.each([
    'external-knowledge-probe-baseline.json',
    'external-knowledge-probe-2026-09-10-strict.json',
    'external-knowledge-probe-2026-09-10-extended.json'
  ])('%s contains no endpoint, credential, remote identifier, or mutation operation', async (filename) => {
    const value = await report(filename)
    const serialized = JSON.stringify(value)

    expect(serialized).not.toMatch(/https?:\/\//)
    expect(serialized).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
    )
    expect(serialized).not.toMatch(/\b[0-9a-f]{24}\b/i)
    expect(value.providers.flatMap((provider) => provider.operations))
      .toSatisfy((operations: ProbeOperation[]) =>
        operations.every((operation) =>
          ['GET', 'POST'].includes(operation.method)
        )
      )
  })

  it('records the verified provider-specific behavior', async () => {
    const value = await report()
    expect(value.schemaVersion).toBe(1)
    expect([...new Set(value.providers.map((provider) => provider.provider))]).toEqual([
      'dify', 'fastgpt', 'ragflow'
    ])

    const difyProfiles = value.providers.filter((provider) => provider.provider === 'dify')
    expect(difyProfiles.length).toBeGreaterThanOrEqual(2)
    expect(difyProfiles.flatMap((provider) => provider.operations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'retrieve-explicit-config', status: 200 })
      ])
    )
    expect(difyProfiles.find((provider) => provider.profile === '0.x'))
      .toMatchObject({
        detectedVersion: '0.15.8',
        features: { detailSupported: false, nonEmptyResultObserved: false }
      })
    expect(difyProfiles.find((provider) => provider.profile === '1.x'))
      .toMatchObject({
        detectedVersion: '1.17.0',
        catalog: { summaryIndexConfiguredCount: 1 },
        features: { detailSupported: true, nonEmptyResultObserved: true }
      })

    const fastGpt = value.providers.find((provider) => provider.provider === 'fastgpt')
    expect(fastGpt?.retrievals).toEqual(expect.arrayContaining([
      expect.objectContaining({ searchMode: 'embedding', contentPresent: true }),
      expect.objectContaining({ searchMode: 'fullTextRecall', contentPresent: true }),
      expect.objectContaining({ searchMode: 'mixedRecall', usingRerank: true, contentPresent: true })
    ]))

    const ragflow = value.providers.find((provider) => provider.provider === 'ragflow')
    expect(ragflow?.catalog).toMatchObject({
      graphConfiguredCount: 17,
      graphCompletedCount: 15,
      knowledgeCompilationConfiguredCount: 0
    })
    expect(ragflow?.retrievals).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: 'graph', contentPresent: true }),
      expect.objectContaining({ feature: 'knowledge-compilation' })
    ]))
  })
})
