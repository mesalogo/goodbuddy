const { existsSync, readFileSync, rmSync } = require('node:fs')
const { gzipSync } = require('node:zlib')
const { resolve } = require('node:path')

// These are hard regression ceilings, not user-experience targets. In
// particular, do not lazy-load one peer tab solely to stay below a ceiling.
// The Settings ceiling is the validated 2026-08-23 production baseline
// (648.78 kB raw / 97.79 kB gzip), rounded up with about 15% review headroom.
const rendererBundleBudgets = Object.freeze({
  initial: Object.freeze({ raw: 3_500_000, gzip: 720_000 }),
  knowledge: Object.freeze({ raw: 330_000, gzip: 50_000 }),
  graph: Object.freeze({ raw: 3_500_000, gzip: 720_000 }),
  activity: Object.freeze({ raw: 55_000, gzip: 9_000 }),
  magicNotes: Object.freeze({ raw: 630_000, gzip: 130_000 }),
  settings: Object.freeze({ raw: 750_000, gzip: 115_000 })
})

function normalizePath(value) {
  return value.replaceAll('\\', '/')
}

function findEntryKey(manifest) {
  const entries = Object.entries(manifest).filter(
    ([, item]) => item && item.isEntry
  )
  if (entries.length !== 1) {
    throw new Error(
      `Expected one renderer entry in the manifest, found ${entries.length}`
    )
  }
  return entries[0][0]
}

function findSourceKey(manifest, sourceSuffix) {
  const normalizedSuffix = normalizePath(sourceSuffix)
  let matches = Object.entries(manifest).filter(([key, item]) => {
    const source = normalizePath(item.src || key)
    return source.endsWith(normalizedSuffix)
  })
  if (matches.length === 0) {
    const sourceName = normalizedSuffix
      .split('/')
      .at(-1)
      ?.replace(/\.[^.]+$/u, '')
    matches = Object.entries(manifest).filter(
      ([, item]) =>
        item?.isDynamicEntry &&
        item.name === sourceName
    )
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one manifest entry for ${sourceSuffix}, found ${matches.length}`
    )
  }
  return matches[0][0]
}

function findModuleOwnerKeys(manifest, moduleManifest, pattern) {
  const keysByFile = new Map(
    Object.entries(manifest).map(([key, item]) => [item.file, key])
  )
  const keys = new Set()
  for (const [file, modules] of Object.entries(moduleManifest)) {
    if (modules.some((id) => pattern.test(normalizePath(id)))) {
      const key = keysByFile.get(normalizePath(file))
      if (!key) {
        throw new Error(`Module manifest chunk is missing: ${file}`)
      }
      keys.add(key)
    }
  }
  if (keys.size === 0) {
    throw new Error(`No renderer chunk owns modules matching ${pattern}`)
  }
  return keys
}

function assertSafeModuleManifest(moduleManifest) {
  for (const modules of Object.values(moduleManifest)) {
    for (const id of modules) {
      const normalized = normalizePath(id)
      if (
        normalized !== id ||
        normalized.startsWith('/') ||
        normalized.startsWith('../') ||
        /[A-Za-z]:\//u.test(normalized) ||
        normalized.includes('/Users/') ||
        normalized.includes('/home/')
      ) {
        throw new Error(`Unsafe renderer module manifest path: ${id}`)
      }
    }
  }
}

function collectSynchronousClosure(manifest, rootKey) {
  if (!manifest[rootKey]) {
    throw new Error(`Manifest entry is missing: ${rootKey}`)
  }
  const visited = new Set()
  const pending = [rootKey]
  while (pending.length > 0) {
    const key = pending.pop()
    if (visited.has(key)) {
      continue
    }
    const item = manifest[key]
    if (!item) {
      throw new Error(`Manifest import is missing: ${key}`)
    }
    visited.add(key)
    for (const imported of item.imports || []) {
      pending.push(imported)
    }
  }
  return visited
}

function collectAssetFiles(manifest, keys) {
  const files = new Set()
  for (const key of keys) {
    const item = manifest[key]
    if (!item) {
      throw new Error(`Manifest entry is missing: ${key}`)
    }
    files.add(normalizePath(item.file))
    for (const cssFile of item.css || []) {
      files.add(normalizePath(cssFile))
    }
  }
  return files
}

function measureFiles(files, readAsset, metricCache = new Map()) {
  let raw = 0
  let gzip = 0
  const measuredFiles = [...files].sort()
  for (const file of measuredFiles) {
    let metrics = metricCache.get(file)
    if (!metrics) {
      const bytes = Buffer.from(readAsset(file))
      metrics = {
        raw: bytes.byteLength,
        gzip: gzipSync(bytes).byteLength
      }
      metricCache.set(file, metrics)
    }
    raw += metrics.raw
    gzip += metrics.gzip
  }
  return { raw, gzip, files: measuredFiles }
}

function withoutItems(keys, excluded) {
  return new Set([...keys].filter((key) => !excluded.has(key)))
}

function describeEntry(
  manifest,
  key,
  initialKeys,
  initialFiles,
  readAsset,
  metricCache
) {
  const closureKeys = collectSynchronousClosure(manifest, key)
  const closureFiles = collectAssetFiles(manifest, closureKeys)
  const incrementalKeys = withoutItems(closureKeys, initialKeys)
  const incrementalFiles = withoutItems(closureFiles, initialFiles)
  const root = measureFiles(
    collectAssetFiles(manifest, new Set([key])),
    readAsset,
    metricCache
  )
  return {
    key,
    file: manifest[key].file,
    rootRaw: root.raw,
    rootGzip: root.gzip,
    closureKeys,
    incrementalKeys,
    ...measureFiles(incrementalFiles, readAsset, metricCache)
  }
}

function assertDisjoint(description, keys, forbiddenKeys) {
  const matches = [...forbiddenKeys].filter((key) => keys.has(key))
  if (matches.length > 0) {
    throw new Error(
      `${description} synchronously includes ${matches.join(', ')}`
    )
  }
}

/**
 * @typedef {object} RendererAnalysisKeys
 * @property {string} initial
 * @property {string} knowledge
 * @property {string} graph
 * @property {string} activity
 * @property {string} magicNotes
 * @property {string} settings
 * @property {string[]} g6
 */

/**
 * Analyzes one renderer manifest.
 *
 * `keys` is the authoritative set of discovered roots and module owners;
 * notably, `keys.g6` is always an array because G6 may span several chunks.
 *
 * @returns {{ keys: RendererAnalysisKeys, sections: Record<string, object> }}
 */
function analyzeRendererManifest(manifest, readAsset, moduleManifest) {
  assertSafeModuleManifest(moduleManifest)
  const metricCache = new Map()
  const keys = {
    initial: findEntryKey(manifest),
    knowledge: findSourceKey(manifest, 'KnowledgeWorkspace.tsx'),
    graph: findSourceKey(manifest, 'KnowledgeGraphChart.tsx'),
    activity: findSourceKey(manifest, 'ActivityPanel.tsx'),
    magicNotes: findSourceKey(manifest, 'MagicNotesWorkspace.tsx'),
    settings: findSourceKey(manifest, 'SettingsPanel.tsx')
  }
  const g6Keys = findModuleOwnerKeys(
    manifest,
    moduleManifest,
    /(?:^|\/)node_modules\/@antv\/g6\//u
  )
  const initialKeys = collectSynchronousClosure(manifest, keys.initial)
  const initialFiles = collectAssetFiles(manifest, initialKeys)
  const initialRoot = measureFiles(
    collectAssetFiles(manifest, new Set([keys.initial])),
    readAsset,
    metricCache
  )
  const initial = {
    key: keys.initial,
    file: manifest[keys.initial].file,
    rootRaw: initialRoot.raw,
    rootGzip: initialRoot.gzip,
    closureKeys: initialKeys,
    incrementalKeys: initialKeys,
    ...measureFiles(initialFiles, readAsset, metricCache)
  }
  const sections = {
    initial,
    knowledge: describeEntry(
      manifest,
      keys.knowledge,
      initialKeys,
      initialFiles,
      readAsset,
      metricCache
    ),
    graph: describeEntry(
      manifest,
      keys.graph,
      initialKeys,
      initialFiles,
      readAsset,
      metricCache
    ),
    activity: describeEntry(
      manifest,
      keys.activity,
      initialKeys,
      initialFiles,
      readAsset,
      metricCache
    ),
    magicNotes: describeEntry(
      manifest,
      keys.magicNotes,
      initialKeys,
      initialFiles,
      readAsset,
      metricCache
    ),
    settings: describeEntry(
      manifest,
      keys.settings,
      initialKeys,
      initialFiles,
      readAsset,
      metricCache
    )
  }

  assertDisjoint(
    'The renderer entry',
    initialKeys,
    new Set([keys.knowledge, keys.graph, keys.activity, ...g6Keys])
  )
  assertDisjoint(
    'The Knowledge shell',
    sections.knowledge.closureKeys,
    new Set([keys.graph, ...g6Keys])
  )
  for (const g6Key of g6Keys) {
    if (!sections.graph.closureKeys.has(g6Key)) {
      throw new Error('The graph chunk no longer synchronously owns G6')
    }
  }

  return { keys: { ...keys, g6: [...g6Keys] }, sections }
}

function checkBudgets(analysis, budgets = rendererBundleBudgets) {
  const failures = []
  for (const [name, budget] of Object.entries(budgets)) {
    const section = analysis.sections[name]
    if (!section) {
      failures.push(`Unknown budget section: ${name}`)
      continue
    }
    for (const metric of ['raw', 'gzip']) {
      if (section[metric] > budget[metric]) {
        failures.push(
          `${name} ${metric} ${section[metric]} exceeds ${budget[metric]}`
        )
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Renderer bundle budget failed:\n- ${failures.join('\n- ')}`)
  }
}

function formatBytes(bytes) {
  return `${(bytes / 1000).toFixed(2)} kB`
}

function formatReport(analysis) {
  return [
    'Renderer bundle budget:',
    ...Object.entries(analysis.sections).map(
      ([name, section]) =>
        `- ${name}: root ${formatBytes(section.rootRaw)} raw / ` +
        `${formatBytes(section.rootGzip)} gzip, ` +
        `incremental closure ${formatBytes(section.raw)} raw / ` +
        `${formatBytes(section.gzip)} gzip`
    )
  ].join('\n')
}

function checkRendererBundle(root = process.cwd()) {
  const rendererRoot = resolve(root, 'out', 'renderer')
  const manifestPath = resolve(rendererRoot, '.vite', 'manifest.json')
  const moduleManifestPath = resolve(
    rendererRoot,
    '.vite',
    'module-manifest.json'
  )
  if (!existsSync(manifestPath)) {
    throw new Error(`Renderer manifest not found: ${manifestPath}`)
  }
  if (!existsSync(moduleManifestPath)) {
    throw new Error(
      `Renderer module manifest not found: ${moduleManifestPath}`
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const moduleManifest = JSON.parse(
    readFileSync(moduleManifestPath, 'utf8')
  )
  const analysis = analyzeRendererManifest(
    manifest,
    (file) => readFileSync(resolve(rendererRoot, file)),
    moduleManifest
  )
  checkBudgets(analysis)
  rmSync(moduleManifestPath)
  return analysis
}

module.exports = {
  analyzeRendererManifest,
  checkBudgets,
  checkRendererBundle,
  collectAssetFiles,
  collectSynchronousClosure,
  findEntryKey,
  findModuleOwnerKeys,
  findSourceKey,
  formatReport,
  assertSafeModuleManifest,
  measureFiles,
  rendererBundleBudgets
}

if (require.main === module) {
  try {
    const analysis = checkRendererBundle()
    console.log(formatReport(analysis))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
