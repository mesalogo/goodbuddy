/* global AbortController, setTimeout */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chunks, pages, coverage, Store, extract, validateLeaf, validateNavigation } from './review-algorithm.mjs'

const message = (id, content) => ({ id, sequence: Number(id), role: 'user', content, created_at: '2026-09-24' })
const response = (spans) => ({ done: true, truncated: false, text: JSON.stringify({ reviewedTokens: spans.map((s) => s.token), facts: spans.filter((s) => s.text).map((s) => ({ claim: s.text, kind: 'claim', citations: [{ token: s.token, quote: s.text }] })) }) })
const pool = { run: (fn) => fn(new AbortController().signal) }

test('keyset pagination covers >20 messages including duplicate sequence keys', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE messages (id TEXT, conversation_id TEXT, sequence INTEGER, role TEXT, content TEXT, created_at TEXT)')
  for (let i = 0; i < 53; i++) db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(String(i), 'c', Math.floor(i / 2), 'user', 'text', 'now')
  const result = [...pages(db, 'c', 7)]
  assert.equal(result.length, 8)
  assert.equal(new Set(result.flat().map((m) => m.id)).size, 53)
  db.close()
})

test('long Unicode, combining characters, empty messages reconstruct without loss', () => {
  const messages = [message('0', ''), message('1', '中文😀e\u0301'.repeat(1003)), message('2', 'tail')]
  const batches = [...chunks([messages], 31)]
  assert(batches.every((b) => b.reduce((n, s) => n + s.text.length, 0) <= 31))
  for (const m of messages) assert.equal(batches.flat().filter((s) => s.messageId === m.id).map((s) => s.text).join(''), m.content)
  assert(coverage(batches.flat()).every((c) => c.complete))
})

test('out-of-order success never advances over a coverage gap', () => {
  const spans = [...chunks([[message('1', 'abcdefghij')]], 4)].flat()
  assert.equal(coverage([spans[0], spans[2]])[0].contiguous, 4)
  assert.equal(coverage([spans[0], spans[2]])[0].complete, false)
  assert.equal(coverage(spans)[0].contiguous, 10)
})

test('citation offsets are code points across emoji and combining marks, not UTF-16 indices', () => {
  const original = message('1', '😀前文e\u0301。保留否定😀。结束')
  const spans = [...chunks([[original]], 10)].flat()
  for (const span of spans) {
    const leaf = validateLeaf(response([span]), [span])
    for (const fact of leaf.facts) for (const citation of fact.citations) {
      assert.equal(Array.from(original.content).slice(citation.start, citation.end).join(''), citation.quote)
      assert.equal(citation.start, span.start)
      assert.equal(citation.end, span.end)
    }
  }
  const repeated = [...chunks([[message('2', 'same same')]])][0]
  const ambiguous = JSON.parse(response(repeated).text)
  ambiguous.facts[0].citations[0].quote = 'same'
  const candidates = validateLeaf({ done: true, text: JSON.stringify(ambiguous) }, repeated).facts[0].citations
  assert.deepEqual(candidates.map(c => [c.start, c.end]), [[0, 4], [5, 9]])
  assert(candidates.every(c => c.ambiguous && c.candidateCount === 2))
})

test('cancelled or truncated batches never persist success or advance coverage', async () => {
  const store = new Store(':memory:'), batches = [...chunks([[message('1', 'abcdefgh')]], 4)]
  const controller = new AbortController()
  const cancellingPool = { run: fn => fn(controller.signal) }
  await assert.rejects(extract(batches, store, cancellingPool, async spans => {
    controller.abort(Error('cancelled'))
    return response(spans)
  }, 1), /cancelled/)
  assert.equal(store.rows().length, 0)
  await assert.rejects(extract(batches, store, pool, async spans => ({ ...response(spans), truncated: true })), /Incomplete/)
  assert.equal(store.rows().length, 0)
  const resumed = await extract(batches, store, pool, async spans => response(spans))
  assert.equal(resumed.calls, 2)
  assert(resumed.coverage.every(c => c.complete))
  store.close()
})

test('failed batch survives reopen; resume and no-change do not duplicate evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-prototype-')), path = join(dir, 'test.sqlite')
  const batches = [...chunks([[message('1', 'abcdefghij')]], 4)]
  let store = new Store(path), n = 0
  await assert.rejects(extract(batches, store, pool, async (spans) => { if (++n === 2) throw Error('failure'); return response(spans) }))
  assert.equal(store.rows().length, 1)
  store.close(); store = new Store(path)
  const resumed = await extract(batches, store, pool, async (spans) => response(spans))
  assert.equal(resumed.calls, 2)
  assert.equal(store.rows().length, 3)
  assert(resumed.coverage.every((c) => c.complete))
  const unchanged = await extract(batches, store, pool, () => { throw Error('must not call') })
  assert.equal(unchanged.status, 'no_change')
  assert.equal(unchanged.calls, 0)
  store.close(); rmSync(dir, { recursive: true })
})

test('budget pause is incomplete; later success retained across gap', async () => {
  const store = new Store(':memory:'), batches = [...chunks([[message('1', 'abcdefghij')]], 4)]
  const first = await extract(batches, store, pool, async (s) => response(s), 2, 1)
  assert.equal(first.status, 'partial')
  assert.equal(first.coverage[0].complete, false)
  let n = 0
  await assert.rejects(extract(batches, store, pool, async (s) => { if (++n === 1) throw Error('gap'); return response(s) }))
  assert.equal(store.rows().length, 2)
  assert.equal(coverage(store.rows().flatMap((r) => r.spans))[0].contiguous, 4)
  const final = await extract(batches, store, pool, async (s) => response(s))
  assert.equal(final.calls, 1)
  store.close()
})

test('truncated, malformed, missing receipts and invalid citations are rejected', () => {
  const spans = [...chunks([[message('1', 'original')]])][0], good = response(spans)
  for (const bad of [{ ...good, done: false }, { ...good, truncated: true }, { ...good, text: good.text.slice(0, -2) },
    { ...good, text: JSON.stringify({ reviewedTokens: [], facts: [] }) }]) assert.throws(() => validateLeaf(bad, spans))
  const parsed = JSON.parse(good.text); parsed.facts[0].citations[0].quote = 'invented'
  assert.throws(() => validateLeaf({ ...good, text: JSON.stringify(parsed) }, spans))
})

test('conflicting leaves survive navigation and require association evidence', () => {
  const spans = [...chunks([[message('1', 'Use A.'), message('2', 'Do not use A; use B.')]])][0]
  const facts = validateLeaf(response(spans), spans).facts, before = JSON.stringify(facts)
  const nav = { summary: 'Use B.', groups: [{ title: 'Decision', factIds: facts.map((f) => f.id) }], associations: [{ from: facts[0].id, to: facts[1].id, kind: 'corrects', reason: 'Explicit reversal', evidenceFactIds: facts.map((f) => f.id) }] }
  validateNavigation(nav, facts)
  assert.equal(JSON.stringify(facts), before)
  assert.equal(facts.length, 2)
  assert.throws(() => validateNavigation({ ...nav, groups: [{ title: 'loss', factIds: [facts[1].id] }] }, facts))
  assert.throws(() => validateNavigation({ ...nav, associations: [{ ...nav.associations[0], evidenceFactIds: [] }] }, facts))
})

test('bounded admission and changed source version do not reuse stale facts', async () => {
  const store = new Store(':memory:')
  let active = 0, peak = 0
  const model = async (spans) => { peak = Math.max(peak, ++active); await new Promise((r) => setTimeout(r, 2)); active--; return response(spans) }
  await extract(chunks([[message('1', 'x'.repeat(100))]], 4), store, pool, model, 2)
  assert.equal(peak, 2)
  const changed = await extract(chunks([[message('1', 'new')]], 4), store, pool, model)
  assert.equal(changed.calls, 1)
  assert.equal(changed.rows.length, 1)
  store.close()
})
