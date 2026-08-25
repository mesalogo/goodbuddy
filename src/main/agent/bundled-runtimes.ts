import { join } from 'node:path'

export type BundledRuntimePaths = {
  opencode: string
  continue: string
  deepseekHarness: string
}

export const bundledContinueVersion = '1.5.47'
export const bundledDeepSeekHarnessVersion = '0.1.0-rc.8'

export function resolveBundledRuntimePaths(input: {
  appPath: string
  resourcesPath: string
  packaged: boolean
  platform?: NodeJS.Platform
}): BundledRuntimePaths {
  const packagedExecutable =
    (input.platform ?? process.platform) === 'win32'
      ? 'opencode.exe'
      : 'opencode'
  if (input.packaged) {
    return {
      opencode: join(
        input.resourcesPath,
        'runtimes',
        'opencode',
        packagedExecutable
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
