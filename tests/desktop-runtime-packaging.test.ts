// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Plugin, UserConfig } from 'vite'
import config from '../electron.vite.config'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json')
const { getFileMatchers, getNodeModuleFileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher')
const { verifyOpenCodeConfig, verifyHarnessBundleImports } = require('../build/verify-desktop-runtimes.cjs')

describe('desktop Runtime packaging', () => {
  it('ships only production output even when validation builds remain in out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-production-output-'))
    const output = join(root, 'output')
    const included = ['out/main/index.js', 'out/main/chunks/shared.js', 'out/main/obsidian-mcpvault/server.js', 'out/preload/index.cjs', 'out/renderer/index.html', 'package.json']
    const excluded = ['out/chat-paste-validation/renderer/index.html', 'out/another-probe/main.js',
      'out/main/index.js.map', 'out/renderer/assets/index.css.map', 'out/main/chunks/types.d.mts']
    try {
      for (const file of [...included, ...excluded]) {
        mkdirSync(dirname(join(root, file)), { recursive: true })
        writeFileSync(join(root, file), file)
      }
      await copyFiles(getFileMatchers({ files: packageJson.build.files }, 'files', output, {
        defaultSrc: root, globalOutDir: output, customBuildOptions: {},
        macroExpander: (value: string) => value
      }))
      for (const file of included) expect(existsSync(join(output, file)), file).toBe(true)
      for (const file of excluded) expect(existsSync(join(output, file)), file).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('filters dependency development artifacts without dropping runtime source or assets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-dependency-filter-'))
    const output = join(root, 'output')
    const included = ['node_modules/openai/index.js', 'node_modules/openai/index.mjs',
      'node_modules/openai/LICENSE', 'node_modules/effect/dist/index.js',
      'node_modules/openai/src/_vendor/parser/LICENSE', 'node_modules/openai/src/README.md',
      'node_modules/@anthropic-ai/sdk/src/internal/qs/LICENSE.md',
      'node_modules/@mixmark-io/domino/lib/index.js', 'node_modules/@mixmark-io/domino/LICENSE',
      'node_modules/unrelated/src/runtime.ts', 'node_modules/unrelated/data.map']
    const excluded = ['node_modules/openai/src/index.ts', 'node_modules/openai/index.mjs.map',
      'node_modules/openai/index.d.mts', 'node_modules/effect/src/index.ts',
      'node_modules/@mixmark-io/domino/test/fixture.html',
      'node_modules/parent/node_modules/@anthropic-ai/sdk/src/index.ts']
    try {
      for (const file of [...included, ...excluded]) {
        mkdirSync(dirname(join(root, file)), { recursive: true })
        writeFileSync(join(root, file), file)
      }
      const matcher = getNodeModuleFileMatcher(root, output, (value: string) => value, {}, {
        config: packageJson.build, debugLogger: { isEnabled: false }
      })
      // Builder discovers production packages separately, then applies this
      // matcher to their files (the generic copier skips node_modules itself).
      const filter = matcher.createFilter()
      for (const file of included) expect(filter(join(root, file), statSync(join(root, file))), file).toBe(true)
      for (const file of excluded) expect(filter(join(root, file), statSync(join(root, file))), file).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

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
      'node_modules/@opencode-ai/plugin/package.json': '{"name":"@opencode-ai/plugin","version":"1.19.3"}',
      'node_modules/@opencode-ai/plugin/dist/index.js': 'export const tool = true\n',
      'node_modules/zod/package.json': '{"name":"zod","version":"4.1.8"}',
      'node_modules/zod/index.js': 'export const z = {}\n',
      'node_modules/effect/dist/index.js': 'export const effect = {}\n',
      'node_modules/effect/LICENSE': 'MIT',
      'node_modules/effect/src/LICENSE': 'MIT source notice'
    }
    const excluded = ['node_modules/effect/src/index.ts', 'node_modules/effect/dist/index.js.map',
      'node_modules/@opencode-ai/plugin/dist/index.d.ts']
    try {
      for (const [name, content] of Object.entries(files)) {
        const file = join(source, name)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, content)
      }
      for (const name of excluded) {
        mkdirSync(dirname(join(source, name)), { recursive: true })
        writeFileSync(join(source, name), 'development artifact')
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
      for (const name of excluded) expect(existsSync(join(output, 'runtimes/opencode-config', name))).toBe(false)
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
    'import spawn from "cross-spawn";',
    'const spawn = require("cross-spawn");',
    'await import("cross-spawn");'
  ])('rejects the external cross-spawn dependency that crashes the unpacked Host', (source) => {
    expect(() => verifyHarnessBundleImports(source, 'host.js')).toThrow('external cross-spawn')
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
