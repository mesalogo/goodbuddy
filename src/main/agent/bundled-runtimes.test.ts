import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveBundledRuntimePaths } from './bundled-runtimes'

describe('bundled runtime paths', () => {
  it('resolves development runtimes from fixed npm packages', () => {
    const paths = resolveBundledRuntimePaths({
      appPath: join('workspace', 'app'),
      resourcesPath: join('electron', 'resources'),
      packaged: false,
      platform: 'linux'
    })

    expect(paths).toEqual({
      opencode: join(
        'workspace',
        'app',
        'node_modules',
        'opencode-ai',
        'bin',
        'opencode.exe'
      ),
      continue: join(
        'workspace',
        'app',
        'node_modules',
        '@continuedev',
        'cli',
        'dist',
        'cn.js'
      ),
      deepseekHarness: join(
        'workspace',
        'app',
        'out',
        'main',
        'deepseek-harness-host-bootstrap.js'
      )
    })
  })

  it('resolves packaged runtimes outside the application archive', () => {
    const paths = resolveBundledRuntimePaths({
      appPath: join('installed', 'app.asar'),
      resourcesPath: join('installed', 'resources'),
      packaged: true,
      platform: 'win32'
    })

    expect(paths).toEqual({
      opencode: join(
        'installed',
        'resources',
        'runtimes',
        'opencode',
        'opencode.exe'
      ),
      continue: join(
        'installed',
        'resources',
        'runtimes',
        'continue',
        'dist',
        'cn.js'
      ),
      deepseekHarness: join(
        'installed',
        'resources',
        'app.asar.unpacked',
        'out',
        'main',
        'deepseek-harness-host-bootstrap.js'
      )
    })
  })
})
