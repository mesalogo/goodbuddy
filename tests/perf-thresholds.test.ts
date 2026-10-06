// @vitest-environment node
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { ESLint } from 'eslint'
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
  maxRendererCpuThrottle: number
  scenarios: Record<string, Record<string, { max?: number; min?: number } | boolean>>
}

interface PerfCheckerModule {
  evaluate(report: unknown, thresholds: PerfThresholds): EvaluateResult
  defaultThresholdsPath: string
}

const require = createRequire(import.meta.url)
const checker = require('../build/check-perf-thresholds.cjs') as PerfCheckerModule
const thresholds = JSON.parse(readFileSync(checker.defaultThresholdsPath, 'utf8')) as PerfThresholds
const root = resolve(dirname(checker.defaultThresholdsPath), '..')
const committed = (path: string) => execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: 'utf8' })

function assertThresholdRatchet(current: PerfThresholds, baseline: PerfThresholds) {
  expect(current.requiredStatus).toBe(baseline.requiredStatus)
  expect(current.maxRendererCpuThrottle).toBeLessThanOrEqual(baseline.maxRendererCpuThrottle)
  for (const [id, limits] of Object.entries(baseline.scenarios)) {
    const next = current.scenarios[id]
    expect(next, `missing scenario ${id}`).toBeDefined()
    if (!next) throw new Error(`Missing scenario ${id}`)
    if (limits.optional !== true) expect(next.optional).not.toBe(true)
    for (const [metric, bound] of Object.entries(limits)) {
      if (metric === 'optional' || typeof bound === 'boolean') continue
      const value = next[metric]
      expect(value, `missing metric ${id}.${metric}`).toBeDefined()
      if (typeof value !== 'object') throw new Error(`Invalid bound ${id}.${metric}`)
      if (bound.max !== undefined) {
        expect(Number.isFinite(value.max)).toBe(true)
        expect(value.max).toBeLessThanOrEqual(bound.max)
      }
      if (bound.min !== undefined) {
        expect(Number.isFinite(value.min)).toBe(true)
        expect(value.min).toBeGreaterThanOrEqual(bound.min)
      }
    }
  }
}

// These were execution owners when SA-07 replaced the import-only guard. Older
// commits have no context list; subsequent baselines use their committed list.
const initialContexts = [
  'src/agent-daemon/agent-owned-acp-prompt.ts',
  'src/agent-daemon/daemon.ts',
  'src/agent-daemon/direct-linux-stdio-process-owner.ts',
  'src/agent-daemon/index.ts',
  'src/agent-daemon/runtime-composition.ts',
  'src/main/desktop-storage-owner.ts',
  'src/main/desktop-storage-files.ts',
  'src/main/desktop-storage-runtime-operations.ts',
  'src/main/desktop-storage-entry.ts',
  'src/main/desktop-storage-runtime-host-fixture.ts',
  'src/main/readonly-query-worker.ts',
  'src/main/assistant-storage-worker.ts',
  'src/main/agent/private-sqlite-database.ts'
]

describe('SA-07 architecture guards', () => {
  const eslint = new ESLint({ cwd: root })
  const lint = async (code: string, filePath = 'src/main/sa07-probe.ts') => {
    const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) })
    expect(result!.fatalErrorCount, code).toBe(0)
    return result!.messages.filter(message => message.ruleId === 'architecture/sqlite-execution-context')
  }

  const boundaries = [
    ['node:sqlite', 'DatabaseSync'],
    ['../shared/node/private-sqlite-database', 'openPrivateSqliteDatabase'],
    ['../shared/node/private-sqlite-database', 'PreparedPrivateSqliteDatabaseFile'],
    ['./agent/private-sqlite-database', 'openPrivateSqliteDatabase'],
    ['./assistant/assistant-database', 'AssistantDatabase'],
    ['./knowledge/knowledge-database', 'KnowledgeDatabase'],
    ['./knowledge/external/external-knowledge-store', 'ExternalKnowledgeStore'],
    ['./conversation-attachment-storage', 'ConversationAttachmentStorage'],
    ['./agent/runtime-session-binding-store', 'SqliteRuntimeSessionBindingStore'],
    ['../agent-daemon/agent-model-gateway', 'AgentModelCallLedger'],
    ['../agent-daemon/event-journal', 'EventJournal'],
    ['../agent-daemon/runtime-owner-registry', 'RuntimeOwnerRegistry'],
    ['../agent-daemon/semantic-prompt-store', 'SemanticPromptStore'],
    ['../agent-daemon/index.js', 'AgentModelCallLedger'],
    ['./assistant/assistant-storage-upgrade', 'upgradeAssistantStorage'],
    ['./desktop-storage-owner', 'DesktopStorageOwner'],
    ['./desktop-storage-files', 'openDesktopStorageFiles'],
    ['./desktop-storage-runtime-operations', 'DesktopStorageRuntimeOwner']
  ]

  it.each(boundaries)('restricts value imports from %s in Main, including indirect module access', async (source, name) => {
    for (const code of [
      `import { ${name} as value } from '${source}';`,
      `import * as value from '${source}';`,
      `import value from '${source}';`,
      `const value = await import('${source}');`,
      `const value = await import(\`${source}\`);`,
      `const value = require('${source}');`,
      `import value = require('${source}');`,
      `export { ${name} as value } from '${source}';`,
      `export * from '${source}';`,
      `export * as value from '${source}';`
    ]) expect(await lint(code), code).toHaveLength(1)
    for (const code of [
      `import type { ${name} } from '${source}';`,
      `import { type ${name} } from '${source}';`,
      `import type * as value from '${source}';`,
      `export type { ${name} } from '${source}';`,
      `export { type ${name} } from '${source}';`,
      `export type * from '${source}';`,
      `type Value = import('${source}').${name};`
    ]) expect(await lint(code), code).toEqual([])
  })

  it('allows actual owner/worker/test contexts but not similarly named Main files', async () => {
    const code = "import { AssistantDatabase } from './assistant/assistant-database'"
    for (const file of [...initialContexts, 'src/main/assistant/assistant-storage-upgrade.test.ts', 'src/agent-daemon/daemon.ts']) {
      expect(await lint(code, file), file).toEqual([])
    }
    for (const file of ['src/main/index.ts', 'src/main/fake-worker.ts', 'src/main/assistant-storage-startup.ts', 'src/renderer/src/probe.ts']) {
      expect(await lint(code, file), file).toHaveLength(1)
    }
    expect(await lint("import { MemoryRuntimeSessionBindingStore } from './agent/runtime-session-binding-store'")).toEqual([])
  })

  it('removes the paged output sync-fs exception and globally ignores generated temp files', async () => {
    const [result] = await eslint.lintText("import { readFileSync } from 'node:fs'", {
      filePath: resolve(root, 'src/main/agent/paged-output-store.ts')
    })
    expect(result!.messages.some(message => message.ruleId === 'no-restricted-imports')).toBe(true)
    expect(await eslint.isPathIgnored(resolve(root, 'temp/generated.test.ts'))).toBe(true)
    const { default: config } = await import('../vitest.config')
    expect(config.test?.exclude).toContain('temp/**')
    expect(config.test?.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ extends: true, test: expect.objectContaining({ name: 'unit' }) }),
      expect.objectContaining({ extends: true, test: expect.objectContaining({ name: 'integration' }) })
    ]))
  })

  it('only shrinks allowlists and the App ceiling relative to local committed HEAD', () => {
    const current = readFileSync(join(root, 'eslint.config.js'), 'utf8')
    const baseline = committed('eslint.config.js')
    const list = (source: string, name: string) => {
      const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`))
      if (!match) return undefined
      return [...match[1]!.matchAll(/'([^']+)'/g)].map(entry => entry[1]!)
    }
    for (const name of ['databaseSyncAllowlist', 'mainSyncFsAllowlist', 'rendererIpcSubscriptionAllowlist', 'sqliteExecutionContexts']) {
      const before = list(baseline, name) ?? (name === 'sqliteExecutionContexts' ? initialContexts : undefined)
      const after = list(current, name)
      expect(before, name).toBeDefined()
      expect(after, name).toBeDefined()
      expect(after!.filter(file => !before!.includes(file)), `${name} additions`).toEqual([])
    }
    const ceiling = (source: string) => Number(source.match(/const appTsxMaxLines = (\d+)/)?.[1])
    expect(ceiling(current)).toBeLessThanOrEqual(ceiling(baseline))
  })

  it('only tightens committed performance ceilings while allowing new checks', () => {
    assertThresholdRatchet(thresholds, JSON.parse(committed('build/perf-thresholds.json')))
    const baseline: PerfThresholds = { requiredStatus: 'passed', maxRendererCpuThrottle: 1, scenarios: { sample: { latency: { max: 10 } } } }
    const tightened = structuredClone(baseline)
    tightened.scenarios.sample!.latency = { max: 5 }
    tightened.scenarios.newScenario = { latency: { max: 20 } }
    assertThresholdRatchet(tightened, baseline)
    for (const mutate of [
      (value: PerfThresholds) => { value.scenarios.sample!.latency = { max: 11 } },
      (value: PerfThresholds) => { delete value.scenarios.sample!.latency },
      (value: PerfThresholds) => { delete value.scenarios.sample },
      (value: PerfThresholds) => { value.scenarios.sample!.optional = true },
      (value: PerfThresholds) => { value.maxRendererCpuThrottle = 4 }
    ]) {
      const loosened = structuredClone(baseline)
      mutate(loosened)
      expect(() => assertThresholdRatchet(loosened, baseline)).toThrow()
    }
  })
})

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
