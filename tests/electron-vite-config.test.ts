// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { serializeDeepSeekHarnessBundleManifest } from '../electron.vite.config'

describe('Electron Vite configuration', () => {
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
