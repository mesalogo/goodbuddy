import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { dedupeNodeModules } = require('../build/dedupe-node-modules.cjs')

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'goodbuddy-dedupe-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function pkg(path: string, manifest: Record<string, unknown>, files: Record<string, string> = { 'index.js': 'module.exports = 1' }): void {
  const directory = join(root, path)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true })
    writeFileSync(join(directory, name), content)
  }
}
const exists = (path: string): boolean => existsSync(join(root, path))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const lib = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'lib', version: '1.0.0', ...extra })
const consumer = (name: string): Record<string, unknown> => ({ name, version: '1.0.0', dependencies: { lib: '1.0.0' } })

it('keeps one root copy of identical nested libraries and every consumer still finds it', async () => {
  pkg('node_modules/a', consumer('a'))
  pkg('node_modules/a/node_modules/lib', lib())
  pkg('node_modules/b', consumer('b'))
  pkg('node_modules/b/node_modules/lib', lib())
  const stats = await dedupeNodeModules(root)
  expect(stats.removedPackages).toBeGreaterThanOrEqual(1)
  expect(exists('node_modules/lib/package.json')).toBe(true)
  expect(exists('node_modules/a/node_modules/lib')).toBe(false)
  expect(exists('node_modules/b/node_modules/lib')).toBe(false)
  expect(read('node_modules/lib/index.js')).toBe('module.exports = 1')
})

it('does not merge copies whose content differs', async () => {
  pkg('node_modules/a', consumer('a'))
  pkg('node_modules/a/node_modules/lib', lib(), { 'index.js': 'one' })
  pkg('node_modules/b', consumer('b'))
  pkg('node_modules/b/node_modules/lib', lib(), { 'index.js': 'two' })
  await dedupeNodeModules(root)
  expect(read('node_modules/a/node_modules/lib/index.js')).toBe('one')
  expect(read('node_modules/b/node_modules/lib/index.js')).toBe('two')
})

it('does not hoist over a different version that already owns the root slot', async () => {
  pkg('node_modules/lib', { name: 'lib', version: '2.0.0' })
  pkg('node_modules/a', consumer('a'))
  pkg('node_modules/a/node_modules/lib', lib())
  pkg('node_modules/b', consumer('b'))
  pkg('node_modules/b/node_modules/lib', lib())
  await dedupeNodeModules(root)
  expect(JSON.parse(read('node_modules/lib/package.json')).version).toBe('2.0.0')
  expect(exists('node_modules/a/node_modules/lib/package.json')).toBe(true)
  expect(exists('node_modules/b/node_modules/lib/package.json')).toBe(true)
})

it('never moves plugins, binaries or packages carrying their own node_modules', async () => {
  pkg('node_modules/a', { name: 'a', version: '1.0.0' })
  pkg('node_modules/b', { name: 'b', version: '1.0.0' })
  for (const holder of ['a', 'b']) {
    pkg(`node_modules/${holder}/node_modules/plugin`, { name: 'plugin', version: '1.0.0', dsh: { client: {} } })
    pkg(`node_modules/${holder}/node_modules/tool`, { name: 'tool', version: '1.0.0', bin: 'cli.js' })
    pkg(`node_modules/${holder}/node_modules/nested`, { name: 'nested', version: '1.0.0' })
    pkg(`node_modules/${holder}/node_modules/nested/node_modules/inner`, { name: 'inner', version: '1.0.0' }, { 'index.js': holder })
  }
  await dedupeNodeModules(root)
  for (const holder of ['a', 'b']) {
    expect(exists(`node_modules/${holder}/node_modules/plugin`)).toBe(true)
    expect(exists(`node_modules/${holder}/node_modules/tool`)).toBe(true)
    expect(exists(`node_modules/${holder}/node_modules/nested`)).toBe(true)
  }
  expect(exists('node_modules/plugin')).toBe(false)
  expect(exists('node_modules/tool')).toBe(false)
})

it('keeps copies whose own dependencies would resolve differently from the root', async () => {
  // Both "lib" copies are identical, but each is wired to its own sibling "dep".
  for (const holder of ['a', 'b']) {
    pkg(`node_modules/${holder}`, consumer(holder))
    pkg(`node_modules/${holder}/node_modules/lib`, lib({ dependencies: { dep: '1.0.0' } }))
    pkg(`node_modules/${holder}/node_modules/dep`, { name: 'dep', version: '1.0.0' }, { 'index.js': `dep-${holder}` })
  }
  await dedupeNodeModules(root)
  for (const holder of ['a', 'b']) {
    expect(read(`node_modules/${holder}/node_modules/dep/index.js`)).toBe(`dep-${holder}`)
    // A hoisted "lib" would see no "dep" or the wrong one, so each holder keeps its own.
    expect(exists(`node_modules/${holder}/node_modules/lib/package.json`)).toBe(true)
  }
  expect(exists('node_modules/lib')).toBe(false)
})

it('leaves packages alone when nothing is duplicated', async () => {
  pkg('node_modules/a', consumer('a'))
  pkg('node_modules/a/node_modules/lib', lib())
  const stats = await dedupeNodeModules(root)
  expect(stats.removedPackages).toBe(0)
  expect(exists('node_modules/a/node_modules/lib/package.json')).toBe(true)
})
