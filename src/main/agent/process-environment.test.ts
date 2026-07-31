import { describe, expect, it } from 'vitest'
import { buildRuntimeEnvironment } from './process-environment'

describe('buildRuntimeEnvironment', () => {
  it('keeps required runtime values and excludes unrelated parent secrets', () => {
    const environment = buildRuntimeEnvironment(
      {
        GOODBUDDY_RUNTIME_TOKEN: 'scoped-token'
      },
      {
        PATH: 'C:\\Tools',
        TEMP: 'C:\\Temp',
        ANTHROPIC_API_KEY: 'provider-key',
        GOODBUDDY_DELEGATION_TOKEN: 'must-not-leak',
        GITHUB_TOKEN: 'must-not-leak',
        NODE_OPTIONS: '--require malicious.js'
      }
    )

    expect(environment).toEqual({
      PATH: 'C:\\Tools',
      TEMP: 'C:\\Temp',
      ANTHROPIC_API_KEY: 'provider-key',
      GOODBUDDY_RUNTIME_TOKEN: 'scoped-token'
    })
  })
})
