import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const modulePath = require.resolve('../build/opencode-config.cjs')
const spawnSync = vi.fn()
let directory: string
let target: string
let config: {
  opencodeVersion: string
  prepareBundledOpenCodeConfig(projectDir: string): string
}

function installPlugin(root: string, version: string) {
  const path = join(root, 'node_modules', '@opencode-ai', 'plugin', 'package.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ name: '@opencode-ai/plugin', version }))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'goodbuddy-opencode-config-'))
  target = join(directory, '.runtime-resources', 'opencode-config')
  spawnSync.mockReset()
  vi.spyOn(require('node:child_process'), 'spawnSync').mockImplementation(spawnSync)
  vi.stubEnv('npm_execpath', 'npm-cli.js')
  delete require.cache[modulePath]
  config = require(modulePath)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  delete require.cache[modulePath]
  rmSync(directory, { recursive: true, force: true })
})

describe('bundled OpenCode config', () => {
  it('reuses the installed version without a root lock or ready marker', () => {
    installPlugin(target, config.opencodeVersion)
    expect(config.prepareBundledOpenCodeConfig(directory)).toBe(target)
    expect(spawnSync).not.toHaveBeenCalled()
    expect(existsSync(join(directory, 'package-lock.json'))).toBe(false)
    expect(existsSync(join(target, '.goodbuddy-ready.json'))).toBe(false)
  })

  it.each(['missing', 'old', 'invalid'])('installs a %s cache through staging', (state) => {
    if (state !== 'missing') {
      installPlugin(target, '0.0.1')
      if (state === 'invalid') {
        writeFileSync(join(target, 'node_modules', '@opencode-ai', 'plugin', 'package.json'), '{')
      }
    }
    spawnSync.mockImplementation((_command, args, options) => {
      expect(args).toContain('--ignore-scripts')
      expect(args).toContain('--bin-links=false')
      expect(options.cwd).toBe(`${target}.staging-${process.pid}`)
      expect(JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8')).dependencies)
        .toEqual({ '@opencode-ai/plugin': config.opencodeVersion })
      installPlugin(options.cwd, config.opencodeVersion)
      return { status: 0 }
    })
    expect(config.prepareBundledOpenCodeConfig(directory)).toBe(target)
    expect(readFileSync(join(target, 'node_modules', '@opencode-ai', 'plugin', 'package.json'), 'utf8'))
      .toContain(config.opencodeVersion)
    expect(existsSync(`${target}.staging-${process.pid}`)).toBe(false)
    expect(existsSync(join(target, '.goodbuddy-ready.json'))).toBe(false)
  })

  it('keeps the old cache and removes staging after a failed install, then retries', () => {
    installPlugin(target, '0.0.1')
    spawnSync.mockImplementation((_command, _args, options) => {
      installPlugin(options.cwd, config.opencodeVersion)
      return { status: 1, stderr: 'install failed' }
    })
    expect(() => config.prepareBundledOpenCodeConfig(directory)).toThrow('install failed')
    expect(readFileSync(join(target, 'node_modules', '@opencode-ai', 'plugin', 'package.json'), 'utf8'))
      .toContain('0.0.1')
    expect(existsSync(`${target}.staging-${process.pid}`)).toBe(false)
    spawnSync.mockImplementation((_command, _args, options) => {
      installPlugin(options.cwd, config.opencodeVersion)
      return { status: 0 }
    })
    expect(config.prepareBundledOpenCodeConfig(directory)).toBe(target)
    expect(spawnSync).toHaveBeenCalledTimes(2)
  })
})
