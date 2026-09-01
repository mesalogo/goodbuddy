// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  stableMainEntryFileName,
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
})
