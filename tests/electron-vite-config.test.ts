// @vitest-environment node

import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  stableMainEntryFileName,
  sanitizeRendererModuleId,
  serializeDeepSeekHarnessBundleManifest
} from '../electron.vite.config'

describe('Electron Vite configuration', () => {
  it('keeps Utility Process bootstrap entry names stable', () => {
    expect(
      stableMainEntryFileName({
        name: 'embedding-inference-bootstrap'
      })
    ).toBe('embedding-inference-bootstrap.js')
    expect(
      stableMainEntryFileName({
        name: 'remote-package-installer'
      })
    ).toBe('remote-package-installer.mjs')
    expect(stableMainEntryFileName({ name: 'index' })).toBe(
      '[name].js'
    )
  })
  it('serializes the DeepSeek Harness bundle manifest', () => {
    const source = serializeDeepSeekHarnessBundleManifest('1.2.3')

    expect(JSON.parse(source)).toEqual({
      name: '@deepseek-ai/dsh-llm',
      version: '1.2.3',
      private: true,
      type: 'module'
    })
    expect(source.endsWith('\n')).toBe(true)
  })

  it('sanitizes host-native renderer paths without leaking the host root', () => {
    const projectRoot = resolve('test-fixtures', 'renderer-project')
    const appModule = join(
      projectRoot,
      'src',
      'renderer',
      'src',
      'App.tsx'
    )
    const g6Module = join(
      projectRoot,
      '..',
      'npm-cache',
      'node_modules',
      '@antv',
      'g6',
      'esm',
      'index.js'
    )
    const eventEmitterModule = join(
      projectRoot,
      'node_modules',
      'eventemitter3',
      'index.js'
    )

    expect(
      sanitizeRendererModuleId(appModule, projectRoot)
    ).toBe('src/renderer/src/App.tsx')
    expect(
      sanitizeRendererModuleId(g6Module, projectRoot)
    ).toBe('node_modules/@antv/g6/esm/index.js')
    expect(
      sanitizeRendererModuleId(
        '\0vite/preload-helper.js',
        projectRoot
      )
    ).toBe('virtual:vite/preload-helper.js')
    expect(
      sanitizeRendererModuleId(
        `\0${eventEmitterModule}?commonjs-module`,
        projectRoot
      )
    ).toBe(
      'virtual:node_modules/eventemitter3/index.js?commonjs-module'
    )
    for (const sanitized of [
      sanitizeRendererModuleId(appModule, projectRoot),
      sanitizeRendererModuleId(g6Module, projectRoot),
      sanitizeRendererModuleId(
        `\0${eventEmitterModule}?commonjs-module`,
        projectRoot
      )
    ]) {
      expect(sanitized).not.toContain(
        projectRoot.replaceAll('\\', '/')
      )
    }
  })

  it('handles foreign absolute path forms without host path parsing', () => {
    const projectRoot = resolve('test-fixtures', 'renderer-project')

    expect(
      sanitizeRendererModuleId(
        'C:\\npm-cache\\node_modules\\@antv\\g6\\esm\\index.js',
        projectRoot
      )
    ).toBe('node_modules/@antv/g6/esm/index.js')
    expect(() =>
      sanitizeRendererModuleId(
        'C:\\Users\\private\\outside.ts',
        projectRoot
      )
    ).toThrow(/outside the project/u)
    expect(() =>
      sanitizeRendererModuleId(
        'file:///C:/Users/private/outside.ts',
        projectRoot
      )
    ).toThrow(/outside the project/u)
    expect(() =>
      sanitizeRendererModuleId(
        '\\\\server\\private\\outside.ts',
        projectRoot
      )
    ).toThrow(/outside the project/u)
    expect(() =>
      sanitizeRendererModuleId(
        '/home/private/outside.ts',
        projectRoot
      )
    ).toThrow(/outside the project/u)
    expect(() =>
      sanitizeRendererModuleId(
        '\0file:///tmp/private/outside.ts',
        projectRoot
      )
    ).toThrow(/virtual module leaks a path/u)
  })
})
