// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  rendererAssetInlineLimit,
  stableMainEntryFileName,
  serializeDeepSeekHarnessBundleManifest
} from '../electron.vite.config'

describe('Electron Vite configuration', () => {
  it('never inlines renderer fonts as data URLs blocked by the CSP', () => {
    expect(rendererAssetInlineLimit('/n/katex/dist/fonts/KaTeX_Size4-Regular.woff2')).toBe(false)
    expect(rendererAssetInlineLimit('/n/katex/dist/fonts/KaTeX_Size4-Regular.woff')).toBe(false)
    expect(rendererAssetInlineLimit('/n/katex/dist/fonts/KaTeX_Size4-Regular.ttf')).toBe(false)
    expect(rendererAssetInlineLimit('/n/inter.woff2?url')).toBe(false)
    expect(rendererAssetInlineLimit('/src/renderer/src/assets/logo.png')).toBeUndefined()
  })
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
