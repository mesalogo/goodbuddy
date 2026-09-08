// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Plugin, UserConfig } from 'vite'
import config from '../electron.vite.config'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json')
const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher')
const { verifyOpenCodeConfig, verifyHarnessBundleImports } = require('../build/verify-desktop-runtimes.cjs')

describe('desktop Runtime packaging', () => {
  it('runs packaged Windows Runtime checks in CI before removing the unpacked output', () => {
    const release = readFileSync(join(process.cwd(), 'build', 'build-release.cjs'), 'utf8')
    const smoke = readFileSync(join(process.cwd(), 'build', 'run-packaged-deepseek-harness-smoke.cjs'), 'utf8')
    expect(release).toContain("process.env.GITHUB_ACTIONS === 'true'")
    expect(release.indexOf('run-packaged-deepseek-harness-smoke.cjs'))
      .toBeLessThan(release.indexOf('rmSync(unpackedDirectory'))
    expect(smoke).toContain('Packaged OpenCode offline plugin import: ready')
    expect(smoke).toContain("result.status !== 'ready'")
  })

  it('copies offline OpenCode dependencies through the real electron-builder resource copier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-desktop-runtime-copy-'))
    const output = join(root, 'output', 'resources')
    const source = join(root, '.runtime-resources', 'opencode-config')
    const files = {
      'package.json': '{"private":true}',
      '.gitignore': 'node_modules\n',
      'node_modules/@opencode-ai/plugin/package.json': '{"name":"@opencode-ai/plugin","version":"1.18.29"}',
      'node_modules/@opencode-ai/plugin/dist/index.js': 'export const tool = true\n',
      'node_modules/zod/package.json': '{"name":"zod","version":"4.1.8"}',
      'node_modules/zod/index.js': 'export const z = {}\n'
    }
    try {
      for (const [name, content] of Object.entries(files)) {
        const file = join(source, name)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, content)
      }
      const resource = packageJson.build.extraResources.find(
        (entry: { from: string }) => entry.from.includes('.runtime-resources') &&
          JSON.stringify(entry).includes('opencode-config')
      )
      expect(resource).toBeDefined()
      const matchers = getFileMatchers(
        { extraResources: [resource] }, 'extraResources', output,
        { defaultSrc: root, globalOutDir: join(root, 'output'), customBuildOptions: {}, macroExpander: (value: string) => value }
      )
      await copyFiles(matchers)
      for (const [name, content] of Object.entries(files)) {
        expect(readFileSync(join(output, 'runtimes', 'opencode-config', name), 'utf8')).toBe(content)
      }
      expect(verifyOpenCodeConfig(output, source)).toBe(Object.keys(files).length)
      rmSync(join(output, 'runtimes', 'opencode-config', 'node_modules', 'zod', 'index.js'))
      expect(() => verifyOpenCodeConfig(output, source)).toThrow('dependency is missing or changed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('bundles every direct DeepSeek dependency into the unpacked Host instead of leaving ASAR-only imports', () => {
    const plugin = (config.main?.plugins as Plugin[]).find(
      (entry) => entry.name === 'vite:externalize-deps'
    )
    expect(plugin).toBeDefined()
    const buildConfig: UserConfig = {}
    const hook = plugin!.config
    if (typeof hook !== 'function') throw new Error('Expected externalization config hook')
    Reflect.apply(hook, {}, [buildConfig, { command: 'build', mode: 'production' }])
    const external = buildConfig.build?.rollupOptions?.external as Array<string | RegExp>
    for (const dependency of Object.keys(packageJson.dependencies).filter(
      (name) => name.startsWith('@deepseek-ai/')
    )) {
      expect(external.some((entry) => typeof entry === 'string'
        ? entry === dependency
        : entry.test(dependency)), dependency).toBe(false)
    }
  })

  it.each([
    'import Registry from "@deepseek-ai/dsh-session-projection";',
    'export { Registry } from "@deepseek-ai/dsh-session-projection";',
    'await import("@deepseek-ai/dsh-session-projection");'
  ])('rejects an external DeepSeek dependency in a shipped bootstrap or chunk', (source) => {
    expect(() => verifyHarnessBundleImports(source, 'host.js')).toThrow('external DeepSeek dependency')
    expect(() => verifyHarnessBundleImports('import { x } from "./chunks/host.js";', 'host.js')).not.toThrow()
  })
})
