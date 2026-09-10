import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

type Fixture = {
  status?: number
  body?: unknown
  raw?: string
  error?: string
}
type ProviderReport = {
  catalog: { success: boolean; failure?: string; count?: number }
  retrievals: Array<{
    searchMode: string
    usingRerank?: boolean
    success: boolean
    failure?: string
    count?: number
    contentPresent?: boolean
  }>
  features: { searchModes: string[]; rerankProbed: boolean; rerankRequestSucceeded: boolean }
  operations: Array<{ name: string; status: number | 'failed' }>
}

const success = (list: unknown[] = []): Fixture => ({
  body: { code: 200, data: { list } }
})

async function probe(
  retrievalFixtures: Record<string, Fixture>,
  catalog: Fixture = { body: { code: 200, data: [{ _id: 'fixture-dataset', type: 'dataset' }] } }
): Promise<ProviderReport> {
  // Run the actual CLI with an entirely in-process fetch fixture. No server,
  // credentials file, external provider, or real knowledge request is used.
  const script = `
    const fixtures = ${JSON.stringify(retrievalFixtures)};
    const catalog = ${JSON.stringify(catalog)};
    globalThis.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      let fixture;
      if (path === '/prefix/api/core/dataset/list') {
        if (JSON.parse(init.body).parentId !== null) throw new Error('Invalid root parent');
        fixture = catalog;
      } else if (path.endsWith('/detail')) fixture = {body: {code: 200, data: {}}};
      else if (path.endsWith('/searchTest')) {
        const input = JSON.parse(init.body);
        fixture = fixtures[input.usingReRank ? 'rerank' : input.searchMode];
      } else throw new Error('Unexpected fixture request');
      if (!fixture) throw new Error('Missing fixture');
      if (fixture.error) throw new DOMException('fixture request failure', fixture.error);
      return new Response(fixture.raw ?? JSON.stringify(fixture.body), {
        status: fixture.status ?? 200, headers: {'Content-Type': 'application/json'}
      });
    };
    process.argv = [process.execPath, 'probe', '--provider=fastgpt', '--extended'];
    await import(${JSON.stringify(pathToFileURL(resolve('scripts/external-knowledge-probe.mjs')).href)});
  `
  const { stdout } = await promisify(execFile)(
    process.execPath, ['--input-type=module', '--eval', script],
    {
      env: {
        ...process.env,
        GOODBUDDY_FASTGPT_BASE_URL: 'http://fixture.invalid/prefix/api/core/dataset/',
        GOODBUDDY_FASTGPT_API_KEY: 'fixture-only-key'
      },
      timeout: 10_000
    }
  )
  expect(stdout).not.toContain('fixture-only-key')
  expect(stdout).not.toContain('fixture.invalid')
  expect(stdout).not.toContain('fixture-dataset')
  return JSON.parse(stdout).providers[0] as ProviderReport
}

describe('FastGPT probe success evidence', () => {
  it.each([
    [{ status: 401, body: { code: 200, data: [] } }, 'http-error'],
    [{ status: 500, body: { code: 200, data: { list: [] } } }, 'http-error'],
    [{ body: { code: 403, data: { list: [] } } }, 'business-error'],
    [{ body: { data: { list: [] } } }, 'business-error'],
    [{ body: { code: 200, data: {} } }, 'invalid-shape'],
    [{ body: { code: 200, data: { list: null } } }, 'invalid-shape'],
    [{ raw: '{malformed' }, 'request-failed'],
    [{ error: 'TimeoutError' }, 'request-failed'],
    [{ error: 'TypeError' }, 'request-failed']
  ] as const)('does not advertise failed retrievals: %j', async (fixture, failure) => {
    const report = await probe({
      embedding: fixture, fullTextRecall: fixture, mixedRecall: fixture, rerank: fixture
    })
    expect(report.features).toEqual({
      searchModes: [], rerankProbed: true, rerankRequestSucceeded: false,
      extensionQueryProbed: false
    })
    expect(report.retrievals).toHaveLength(4)
    for (const retrieval of report.retrievals) {
      expect(retrieval).toMatchObject({ success: false, failure })
      expect(retrieval).not.toHaveProperty('count')
      expect(retrieval).not.toHaveProperty('contentPresent')
    }
  })

  it('distinguishes successful empty lists from failures and successful nonempty results', async () => {
    const report = await probe({
      embedding: success(),
      fullTextRecall: { body: { code: 200, data: [] } },
      mixedRecall: { body: { code: 500, data: { list: [] } } },
      rerank: success([{ q: 'private fixture content', score: 0.9 }])
    })
    expect(report.features).toMatchObject({
      searchModes: ['embedding', 'fullTextRecall'],
      rerankProbed: true, rerankRequestSucceeded: true
    })
    expect(report.retrievals[0]).toMatchObject({ success: true, count: 0, contentPresent: false })
    expect(report.retrievals[1]).toMatchObject({ success: true, count: 0 })
    expect(report.retrievals[2]).toMatchObject({ success: false, failure: 'business-error' })
    expect(report.retrievals[3]).toMatchObject({ success: true, count: 1, contentPresent: true })
    expect(JSON.stringify(report)).not.toContain('private fixture content')
  })

  it('does not claim an extended rerank probe when catalog discovery fails', async () => {
    const report = await probe({}, {
      status: 403,
      body: { code: 200, data: [{ _id: 'fixture-dataset', type: 'dataset' }] }
    })
    expect(report.catalog).toMatchObject({ success: false, failure: 'http-error' })
    expect(report.catalog).not.toHaveProperty('count')
    expect(report.retrievals).toEqual([])
    expect(report.features).toMatchObject({
      searchModes: [], rerankProbed: false, rerankRequestSucceeded: false
    })
    expect(report.operations).toHaveLength(1)
  })

  it('reports both retrieval envelopes, score structures and actual rerank response separately', async () => {
    const report = await probe({
      embedding: { body: { code: 200, data: [{ score: 0.6, q: 'private text' }] } },
      fullTextRecall: { body: { code: 200, data: { list: [], usingReRank: true } } },
      mixedRecall: success(),
      rerank: { body: { code: 200, data: {
        usingReRank: false,
        list: [{ score: [{ type: 'private score type', value: 0.2, index: 1 }], q: 'private text' }]
      } } }
    })
    expect(report.retrievals[0]).toMatchObject({
      envelope: 'data-array', scoreTypes: ['number'], scoreRange: { minimum: 0.6, maximum: 0.6 }
    })
    expect(report.retrievals[3]).toMatchObject({
      envelope: 'data-list', scoreTypes: ['array'], scoreItemKeys: ['index', 'type', 'value'],
      scoreValueRange: { minimum: 0.2, maximum: 0.2 }, rerankEnabled: false
    })
    expect(report.retrievals[1]).toMatchObject({ rerankEnabled: true })
    expect(report.retrievals[0]).not.toHaveProperty('rerankEnabled')
    expect(report.features.rerankRequestSucceeded).toBe(true)
    expect(JSON.stringify(report)).not.toContain('private')
  })
})
