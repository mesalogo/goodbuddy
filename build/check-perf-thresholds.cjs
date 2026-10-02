// PERF-17 regression gate for the PERF-11 full-App benchmark report.
// Usage: node build/check-perf-thresholds.cjs <result.json | report directory> [thresholds.json]
// Exit codes: 0 all limits met, 1 a limit, scenario or status failed,
// 2 the report cannot be judged (throttled run, unreadable input).
const { existsSync, readFileSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

const defaultThresholdsPath = join(__dirname, 'perf-thresholds.json')

function metricValue(scenario, path) {
  let value = scenario
  for (const key of path.split('.')) {
    if (value === null || value === undefined) return undefined
    value = value[key]
  }
  return value
}

// Pure: judges a parsed report against parsed thresholds.
// Returns { ok, refused, reason?, rows: [{ scenario, metric, value, limit, pass, note? }] }.
function evaluate(report, thresholds) {
  const rows = []
  const throttle = Number(report?.environment?.rendererCpuThrottle ?? 1)
  const maxThrottle = Number(thresholds.maxRendererCpuThrottle ?? 1)
  if (!(throttle <= maxThrottle)) {
    return { ok: false, refused: true, reason: `renderer CPU throttle ${throttle}x exceeds ${maxThrottle}x; thresholds apply to non-throttled runs only`, rows }
  }
  const requiredStatus = thresholds.requiredStatus ?? 'passed'
  rows.push({ scenario: '(report)', metric: 'status', value: report?.status ?? null, limit: `= ${requiredStatus}`, pass: report?.status === requiredStatus })
  const scenarios = Array.isArray(report?.scenarios) ? report.scenarios : []
  for (const [id, limits] of Object.entries(thresholds.scenarios ?? {})) {
    const scenario = scenarios.find(entry => entry?.id === id)
    if (!scenario) {
      const optional = limits.optional === true
      rows.push({ scenario: id, metric: '(present)', value: 'missing', limit: optional ? 'optional' : 'required', pass: optional })
      continue
    }
    for (const [metric, bound] of Object.entries(limits)) {
      if (metric === 'optional') continue
      const raw = metricValue(scenario, metric)
      const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
      let pass = value !== null
      const limitParts = []
      if (typeof bound.max === 'number') { limitParts.push(`<= ${bound.max}`); pass = pass && value <= bound.max }
      if (typeof bound.min === 'number') { limitParts.push(`>= ${bound.min}`); pass = pass && value >= bound.min }
      rows.push({ scenario: id, metric, value, limit: limitParts.join(', '), pass, ...(value === null ? { note: 'metric missing' } : {}) })
    }
  }
  return { ok: rows.every(row => row.pass), refused: false, rows }
}

function resolveReportPath(input) {
  const path = resolve(input)
  return existsSync(path) && statSync(path).isDirectory() ? join(path, 'result.json') : path
}

function formatValue(value) {
  if (typeof value !== 'number') return String(value)
  return Number.isInteger(value) ? String(value) : value.toFixed(value < 1 ? 3 : 1)
}

function run(argv) {
  const [input, thresholdsArg] = argv
  if (!input) {
    console.error('usage: node build/check-perf-thresholds.cjs <result.json | report directory> [thresholds.json]')
    return 2
  }
  const reportPath = resolveReportPath(input)
  const thresholdsPath = resolve(thresholdsArg || defaultThresholdsPath)
  let report
  let thresholds
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
    thresholds = JSON.parse(readFileSync(thresholdsPath, 'utf8'))
  } catch (error) {
    console.error(`cannot read report or thresholds: ${error instanceof Error ? error.message : error}`)
    return 2
  }
  const result = evaluate(report, thresholds)
  console.log(`\nperf thresholds: ${reportPath}`)
  if (result.refused) {
    console.error(`refused: ${result.reason}`)
    return 2
  }
  console.table(result.rows.map(row => ({
    scenario: row.scenario,
    metric: row.metric,
    value: formatValue(row.value),
    limit: row.limit,
    pass: row.pass ? 'ok' : `FAIL${row.note ? ` (${row.note})` : ''}`
  })))
  const failed = result.rows.filter(row => !row.pass).length
  console.log(failed ? `${failed} of ${result.rows.length} checks failed` : `all ${result.rows.length} checks passed`)
  return result.ok ? 0 : 1
}

module.exports = { evaluate, run, defaultThresholdsPath }

if (require.main === module) process.exitCode = run(process.argv.slice(2))
