import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

type Fixture = { status?: number; body?: unknown; raw?: string; causeCode?: string }
type Outcome = { success: boolean; failure?: string; count?: number }
type Report = {
  catalog: Outcome
  detail: Outcome
  retrievals: Outcome[]
  features: Record<string, unknown>
  operations: Array<{ status: number | 'failed'; businessCode?: number | string; causeCode?: string }>
}

async function probe(provider: 'dify' | 'ragflow', fixtures: Fixture[]): Promise<Report> {
  const script = `
    const fixtures = ${JSON.stringify(fixtures)};
    globalThis.fetch = async () => {
      const fixture = fixtures.shift();
      if (!fixture) throw new Error('Unexpected request');
      if (fixture.causeCode) throw new TypeError('private network message', {
        cause: { code: fixture.causeCode, message: 'private cause' }
      });
      return new Response(fixture.raw ?? JSON.stringify(fixture.body), { status: fixture.status ?? 200 });
    };
    process.argv = [process.execPath, 'probe', '--provider=${provider}', '--extended'];
    await import(${JSON.stringify(pathToFileURL(resolve('scripts/external-knowledge-probe.mjs')).href)});
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], {
    env: {
      ...process.env,
      [`GOODBUDDY_${provider.toUpperCase()}_BASE_URL`]: 'https://fixture.invalid',
      [`GOODBUDDY_${provider.toUpperCase()}_API_KEY`]: 'fixture-only-key'
    },
    timeout: 10_000
  })
  expect(stdout).not.toMatch(/private|fixture.invalid|fixture-only-key|fixture-dataset/)
  return JSON.parse(stdout).providers[0] as Report
}

describe.each(['dify', 'ragflow'] as const)('%s probe outcomes', (provider) => {
  const catalog = { body: { code: 0, data: [{ id: 'fixture-dataset', retrieval_model_dict: {} }] } }
  const detail = { body: provider === 'dify' ? { id: 'fixture-dataset' } : catalog.body }
  const empty = { body: provider === 'dify' ? { records: [] } : { code: 0, data: { chunks: [] } } }

  it('reports successful empty catalogs without claiming uncalled features', async () => {
    const report = await probe(provider, [{ body: { code: 0, data: [] } }])
    expect(report.catalog).toMatchObject({ success: true, count: 0 })
    expect(report.detail).toMatchObject({ success: false, failure: 'not-probed' })
    expect(report.retrievals).toEqual([])
    expect(Object.values(report.features)).not.toContain(true)
    expect(report.operations).toHaveLength(1)
  })

  it.each([
    [{ status: 403, body: { code: 'forbidden', message: 'private message' } }, 'http-error'],
    [{ status: 502, raw: '<html>private body</html>' }, 'http-error'],
    [{ body: { code: 0, data: {} } }, 'invalid-shape'],
    [{ raw: '{broken' }, 'request-failed']
  ] as const)('does not turn catalog failure into an empty catalog: %j', async (fixture, failure) => {
    const report = await probe(provider, [fixture])
    expect(report.catalog).toMatchObject({ success: false, failure })
    expect(report.catalog).not.toHaveProperty('count')
    expect(report.detail).toMatchObject({ success: false, failure: 'not-probed' })
    expect(report.retrievals).toEqual([])
    expect(Object.values(report.features)).not.toContain(true)
    expect(report.operations[0]).toMatchObject({ status: (fixture as Fixture).status ?? 200 })
  })

  it('distinguishes successful empty retrievals from failed detail and retrievals', async () => {
    const failure = { status: 500, body: { code: 500, message: 'private error' } }
    const report = await probe(provider, [catalog, failure, empty, failure, failure])
    expect(report.catalog).toMatchObject({ success: true, count: 1 })
    expect(report.detail).toMatchObject({ success: false, failure: 'http-error' })
    expect(report.retrievals[0]).toMatchObject({ success: true, count: 0 })
    for (const retrieval of report.retrievals.slice(1)) {
      expect(retrieval).toMatchObject({ success: false, failure: 'http-error' })
      expect(retrieval).not.toHaveProperty('count')
    }
    expect(report.operations[1]).toMatchObject({ status: 500, businessCode: 500 })
  })

  it('validates detail and retrieval shapes', async () => {
    const invalid = { body: { code: 0, records: [null], data: { chunks: null } } }
    const report = await probe(provider, [catalog, invalid, invalid, invalid, invalid])
    expect(report.detail).toMatchObject({ success: false, failure: 'invalid-shape' })
    expect(report.retrievals.every((item) => !item.success && item.failure === 'invalid-shape')).toBe(true)
  })

  it('recognizes valid detail responses', async () => {
    const report = await probe(provider, [catalog, detail, empty, empty, empty])
    expect(report.detail.success).toBe(true)
  })

  it.each(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'private-code'])(
    'only exposes allowlisted network cause codes: %s', async (causeCode) => {
      const report = await probe(provider, [{ causeCode }])
      expect(report.operations[0]).toMatchObject({ status: 'failed' })
      expect(report.operations[0]?.causeCode).toBe(causeCode === 'private-code' ? undefined : causeCode)
      expect(report.catalog).toMatchObject({ success: false, failure: 'request-failed' })
    }
  )

  it.each(['forbidden', 'private-code'])('only exposes known string business codes: %s', async (code) => {
    const report = await probe(provider, [{ status: 403, body: { code, message: 'private message' } }])
    expect(report.operations[0]).toMatchObject({ status: 403 })
    expect(report.operations[0]?.businessCode).toBe(code === 'forbidden' ? code : undefined)
  })
})

it('rejects RAGFlow nonzero business codes in catalog, detail and retrieval', async () => {
  const failure = { body: { code: 102, data: [{ id: 'fixture-dataset' }] } }
  const catalogReport = await probe('ragflow', [failure])
  expect(catalogReport.catalog).toMatchObject({ success: false, failure: 'business-error' })
  expect(catalogReport.catalog).not.toHaveProperty('count')
  const report = await probe('ragflow', [
    { body: { code: 0, data: [{ id: 'fixture-dataset' }] } },
    failure, failure, failure, failure
  ])
  expect(report.detail).toMatchObject({ success: false, failure: 'business-error' })
  for (const retrieval of report.retrievals) {
    expect(retrieval).toMatchObject({ success: false, failure: 'business-error' })
    expect(retrieval).not.toHaveProperty('count')
  }
})
