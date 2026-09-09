import { join } from 'node:path'

export type BundledRuntimePaths = {
  opencode: string
  opencodeConfig?: string
  ripgrep: string
  continue: string
  deepseekHarness: string
}

export const bundledContinueVersion = '1.5.47'
export const bundledDeepSeekHarnessVersion = '0.1.2-rc.1'

export function resolveBundledRuntimePaths(input: {
  appPath: string
  resourcesPath: string
  packaged: boolean
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
}): BundledRuntimePaths {
  const packagedExecutable =
    (input.platform ?? process.platform) === 'win32'
      ? 'opencode.exe'
      : 'opencode'
  const ripgrepExecutable =
    (input.platform ?? process.platform) === 'win32' ? 'rg.exe' : 'rg'
  if (input.packaged) {
    return {
      opencode: join(
        input.resourcesPath,
        'runtimes',
        'opencode',
        packagedExecutable
      ),
      opencodeConfig: join(
        input.resourcesPath,
        'runtimes',
        'opencode-config'
      ),
      ripgrep: join(
        input.resourcesPath,
        'runtimes',
        'opencode',
        ripgrepExecutable
      ),
      continue: join(
        input.resourcesPath,
        'runtimes',
        'continue',
        'dist',
        'cn.js'
      ),
      deepseekHarness: join(
        input.resourcesPath,
        'app.asar.unpacked',
        'out',
        'main',
        'deepseek-harness-host-bootstrap.js'
      )
    }
  }

  return {
    opencode: join(
      input.appPath,
      'node_modules',
      'opencode-ai',
      'bin',
      'opencode.exe'
    ),
    ripgrep: join(
      input.appPath,
      'node_modules',
      '@vscode',
      `ripgrep-${input.platform ?? process.platform}-${input.arch ?? process.arch}`,
      'bin',
      ripgrepExecutable
    ),
    continue: join(
      input.appPath,
      'node_modules',
      '@continuedev',
      'cli',
      'dist',
      'cn.js'
    ),
    deepseekHarness: join(
      input.appPath,
      'out',
      'main',
      'deepseek-harness-host-bootstrap.js'
    )
  }
}
