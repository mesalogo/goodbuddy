import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ThresholdRow {
  scenario: string
  metric: string
  value: number | string | null
  limit: string
  pass: boolean
  note?: string
}

interface EvaluateResult {
  ok: boolean
  refused: boolean
  reason?: string
  rows: ThresholdRow[]
}

interface PerfThresholds {
  requiredStatus: string
  scenarios: Record<string, Record<string, { max?: number } | boolean>>
}

interface PerfCheckerModule {
  evaluate(report: unknown, thresholds: PerfThresholds): EvaluateResult
  defaultThresholdsPath: string
}

const require = createRequire(import.meta.url)
const checker = require('../build/check-perf-thresholds.cjs') as PerfCheckerModule
const thresholds = JSON.parse(readFileSync(checker.defaultThresholdsPath, 'utf8')) as PerfThresholds

// A report shaped like tests/support/app-perf-driver.mjs output, with values
// close to the 2026-10-02 non-throttled baseline.
function scenario(id: string, overrides: { longTasks?: number, longTaskMs?: number, frameP95?: number, latencyP95?: number | null } = {}) {
  const latencyP95 = overrides.latencyP95 === undefined ? 10 : overrides.latencyP95
  return {
    id,
    durationMs: 3000,
    renderer: {
      longTasks: { count: overrides.longTasks ?? 0, totalMs: overrides.longTaskMs ?? 0, maxMs: overrides.longTaskMs ?? 0 },
      frames: { p50: 8.3, p95: overrides.frameP95 ?? 8.5, max: 17, jankRatio: 0.01 }
    },
    latency: latencyP95 === null ? null : { p50: latencyP95 / 2, p95: latencyP95, max: latencyP95 + 2, count: 10 },
    main: { eventLoopDelay: { p99: 20, max: 30 } }
  }
}

function passingReport() {
  return {
    status: 'passed',
    environment: { rendererCpuThrottle: 1 },
    scenarios: [
      scenario('idle', { latencyP95: null }),
      scenario('typing-small', { latencyP95: 8.5 }),
      scenario('idle-seeded', { latencyP95: null }),
      scenario('typing-seeded', { latencyP95: 8.7 }),
      scenario('switch-conversations', { longTasks: 1, longTaskMs: 120, latencyP95: 160 }),
      scenario('switch-conversations-warm', { latencyP95: 68 }),
      scenario('switch-conversations-hot', { latencyP95: 32 }),
      scenario('open-long-conversation', { longTasks: 1, longTaskMs: 104, latencyP95: 140 }),
      scenario('scroll-long-conversation', { latencyP95: null }),
      scenario('stream-seeded', { longTasks: 1, longTaskMs: 250, latencyP95: null }),
      scenario('stream-and-type', { longTasks: 1, longTaskMs: 230, frameP95: 16.6, latencyP95: 17 })
    ]
  }
}

describe('perf threshold checker', () => {
  it('accepts a report at baseline levels', () => {
    const result = checker.evaluate(passingReport(), thresholds)
    expect(result.refused).toBe(false)
    expect(result.rows.filter(row => !row.pass)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('every configured scenario has a check for each metric it lists', () => {
    const result = checker.evaluate(passingReport(), thresholds)
    for (const [id, limits] of Object.entries(thresholds.scenarios)) {
      const metrics = Object.keys(limits).filter(key => key !== 'optional')
      expect(result.rows.filter(row => row.scenario === id).map(row => row.metric).sort()).toEqual(metrics.sort())
    }
  })

  it('fails a streaming regression of the pre-PERF-12 size and a slow switch', () => {
    const report = passingReport()
    report.scenarios[9] = scenario('stream-seeded', { longTasks: 130, longTaskMs: 9000, frameP95: 83, latencyP95: null })
    report.scenarios[4] = scenario('switch-conversations', { longTasks: 1, longTaskMs: 120, latencyP95: 900 })
    const result = checker.evaluate(report, thresholds)
    expect(result.ok).toBe(false)
    const failures = result.rows.filter(row => !row.pass).map(row => `${row.scenario} ${row.metric}`)
    expect(failures).toEqual(expect.arrayContaining([
      'stream-seeded renderer.longTasks.count',
      'stream-seeded renderer.longTasks.totalMs',
      'stream-seeded renderer.frames.p95',
      'switch-conversations latency.p95'
    ]))
  })

  it('fails when the report status is not passed', () => {
    const report = { ...passingReport(), status: 'passed-with-renderer-errors' }
    const result = checker.evaluate(report, thresholds)
    expect(result.ok).toBe(false)
    expect(result.rows.find(row => row.metric === 'status')?.pass).toBe(false)
  })

  it('fails when a required scenario or metric is missing, but not an optional scenario', () => {
    const report = passingReport()
    report.scenarios = report.scenarios.filter(entry => entry.id !== 'stream-and-type' && entry.id !== 'switch-conversations-hot')
    report.scenarios[1] = { ...scenario('typing-small'), latency: null }
    const result = checker.evaluate(report, thresholds)
    expect(result.ok).toBe(false)
    const failures = result.rows.filter(row => !row.pass)
    expect(failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ scenario: 'stream-and-type', metric: '(present)', value: 'missing' }),
      expect.objectContaining({ scenario: 'typing-small', metric: 'latency.p95', value: null, note: 'metric missing' })
    ]))
    expect(failures.some(row => row.scenario === 'switch-conversations-hot')).toBe(false)
  })

  it('refuses to judge a throttled run', () => {
    const report = { ...passingReport(), environment: { rendererCpuThrottle: 4 } }
    const result = checker.evaluate(report, thresholds)
    expect(result.refused).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/throttle 4x/)
  })

  it('ships thresholds that require a clean, non-throttled report', () => {
    expect(thresholds.requiredStatus).toBe('passed')
    expect(join(checker.defaultThresholdsPath)).toMatch(/perf-thresholds\.json$/)
  })
})
