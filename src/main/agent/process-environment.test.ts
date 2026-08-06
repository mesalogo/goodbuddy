import { describe, expect, it } from 'vitest'
import {
  buildExplicitProfileRuntimeEnvironment,
  buildRuntimeEnvironment
} from './process-environment'

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

  it('propagates insecure TLS only when compatibility mode is enabled', () => {
    const source = {
      PATH: '/tools',
      NODE_TLS_REJECT_UNAUTHORIZED: '1'
    }

    expect(buildRuntimeEnvironment({}, source, true)).toEqual({
      PATH: '/tools',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    })
    expect(buildRuntimeEnvironment({}, source, false)).toEqual({
      PATH: '/tools'
    })
    expect(
      buildRuntimeEnvironment(
        { NODE_TLS_REJECT_UNAUTHORIZED: '1' },
        source,
        true
      )
    ).toEqual({
      PATH: '/tools',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    })
  })

  it('isolates an explicit profile from inherited provider and cloud credentials', () => {
    const source = {
      PATH: '/tools',
      ANTHROPIC_API_KEY: 'inherited-anthropic',
      OPENAI_API_KEY: 'inherited-openai',
      GOOGLE_GENERATIVE_AI_API_KEY: 'inherited-google',
      GEMINI_API_KEY: 'inherited-gemini',
      GROQ_API_KEY: 'inherited-groq',
      AZURE_OPENAI_API_KEY: 'inherited-azure',
      AWS_ACCESS_KEY_ID: 'inherited-aws-access',
      AWS_SECRET_ACCESS_KEY: 'inherited-aws-secret',
      AWS_SESSION_TOKEN: 'inherited-aws-session',
      AWS_REGION: 'inherited-aws-region',
      AWS_PROFILE: 'inherited-aws-profile',
      OPENROUTER_API_KEY: 'inherited-openrouter',
      XAI_API_KEY: 'inherited-xai',
      MISTRAL_API_KEY: 'inherited-mistral',
      COHERE_API_KEY: 'inherited-cohere'
    }

    expect(
      buildExplicitProfileRuntimeEnvironment(
        { GOODBUDDY_RUNTIME_TOKEN: 'scoped-token' },
        { name: 'OPENAI_API_KEY', value: 'selected-key' },
        source,
        false
      )
    ).toEqual({
      PATH: '/tools',
      GOODBUDDY_RUNTIME_TOKEN: 'scoped-token',
      OPENAI_API_KEY: 'selected-key'
    })
    expect(
      buildExplicitProfileRuntimeEnvironment(
        {},
        undefined,
        source,
        false
      )
    ).toEqual({
      PATH: '/tools'
    })
  })
})
